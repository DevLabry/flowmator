import { HookContext, WebhookContext, type NodeTypesRegistry } from '@8n8/core';
import {
  evaluateExpression,
  getNodeParametersWithDefaults,
  isExpression,
  type IDataObject,
  type INode,
  type INodeExecutionData,
  type IWebhookDescription,
  type IWebhookRequest,
  type IWebhookResponse,
  type IWorkflowBase,
} from '@8n8/workflow';
import { parseSubmission, renderForm, renderSubmitted, type FormField } from '@8n8/nodes-base';
import type { ServerConfig } from './config';
import type { ExecutionService } from './execution-service';
import type { PushSender } from './push';

export interface WebhookRegistration {
  workflowId: string;
  nodeName: string;
  webhookName: string;
  method: string;
  path: string;
  /** Segments with ":param" placeholders, for dynamic paths like users/:id */
  segments: string[];
  isDynamic: boolean;
}

interface TestWebhook extends WebhookRegistration {
  workflowData: IWorkflowBase;
  pushRef?: string;
  destinationNode?: string;
  timeout: NodeJS.Timeout;
}

export class WebhookError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const trimSlashes = (p: string) => p.replace(/^\/+|\/+$/g, '');
/** Form triggers are served under /form and /form-test instead of /webhook. */
export const isFormNode = (node: INode) => node.type.endsWith('formTrigger');

/** Resolves a node's webhook description (method/path may be expressions over $parameter). */
export function resolveWebhook(nodeTypes: NodeTypesRegistry, node: INode, description: IWebhookDescription) {
  const type = nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
  const params = getNodeParametersWithDefaults(type.description.properties, node.parameters, node.typeVersion);
  const resolve = (v: string) => (isExpression(v) ? String(evaluateExpression(v, { $parameter: params }) ?? '') : v);
  const method = resolve(description.httpMethod).toUpperCase() || 'GET';
  let path = trimSlashes(resolve(description.path));
  if (!description.isFullPath) path = [node.webhookId ?? node.id, path].filter(Boolean).join('/');
  else if (!path) path = node.webhookId ?? node.id;
  const segments = path.split('/');
  return { method, path, segments, isDynamic: segments.some((s) => s.startsWith(':')) };
}

export function webhookNodesOf(nodeTypes: NodeTypesRegistry, nodes: INode[]) {
  const out: Array<{ node: INode; description: IWebhookDescription }> = [];
  for (const node of nodes) {
    if (node.disabled || !nodeTypes.has(node.type)) continue;
    const type = nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
    if (!type.webhook || !type.description.group.includes('trigger')) continue;
    for (const d of type.description.webhooks ?? []) if (!d.restartWebhook) out.push({ node, description: d });
  }
  return out;
}

function matchPath(reg: { segments: string[] }, requestSegments: string[]): IDataObject | null {
  if (reg.segments.length !== requestSegments.length) return null;
  const params: IDataObject = {};
  for (let i = 0; i < reg.segments.length; i++) {
    const s = reg.segments[i];
    if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(requestSegments[i]);
    else if (s !== requestSegments[i]) return null;
  }
  return params;
}

export class WebhookService {
  private readonly production = new Map<string, WebhookRegistration>();
  private readonly test = new Map<string, TestWebhook>();

  constructor(
    private readonly config: ServerConfig,
    private readonly nodeTypes: NodeTypesRegistry,
    private readonly executions: ExecutionService,
    private readonly push: PushSender,
    private readonly loadWorkflow: (id: string) => IWorkflowBase | null,
  ) {}

  /* ---------- registration ---------- */

  registerProduction(reg: WebhookRegistration) {
    const key = `${reg.method} ${reg.path}`;
    const existing = this.production.get(key);
    if (existing && existing.workflowId !== reg.workflowId) {
      throw new WebhookError(409, `The URL path "${reg.path}" (${reg.method}) is already used by workflow ${existing.workflowId}`);
    }
    this.production.set(key, reg);
  }

  removeProductionForWorkflow(workflowId: string) {
    for (const [k, r] of this.production) if (r.workflowId === workflowId) this.production.delete(k);
  }

  listProduction() {
    return [...this.production.values()];
  }

  /**
   * Arms test webhooks for a manual run of a workflow whose start node is a webhook trigger.
   * Returns the URLs waiting for a call (they expire after two minutes).
   */
  async registerTest(workflowData: IWorkflowBase, opts: { pushRef?: string; destinationNode?: string; triggerNode?: string }) {
    this.cancelTest(workflowData.id!);
    const urls: string[] = [];
    const cleanups: Array<() => Promise<unknown>> = [];
    const workflow = this.executions.buildWorkflow(workflowData);
    for (const { node, description } of webhookNodesOf(this.nodeTypes, workflowData.nodes)) {
      if (opts.triggerNode && node.name !== opts.triggerNode) continue;
      const r = resolveWebhook(this.nodeTypes, node, description);
      const key = `${r.method} ${r.path}`;
      const timeout = setTimeout(() => this.cancelTest(workflowData.id!), 120_000);
      this.test.set(key, {
        workflowId: workflowData.id!,
        nodeName: node.name,
        webhookName: description.name,
        ...r,
        workflowData,
        pushRef: opts.pushRef,
        destinationNode: opts.destinationNode,
        timeout,
      });
      const endpoint = isFormNode(node) ? this.config.endpoints.formTest : this.config.endpoints.webhookTest;
      urls.push(`${this.config.webhookUrl}${endpoint}/${r.path}`);

      // services that push to us (Telegram, GitHub…) must be told about the test URL
      const methods = this.nodeTypes.getByNameAndVersion(node.type, node.typeVersion).webhookMethods?.[description.name];
      if (methods) {
        const hookCtx = new HookContext(
          {
            workflow,
            node: workflow.getNode(node.name)!,
            additionalData: { executionId: '', mode: 'manual', credentialsHelper: this.executions.credentialsHelper, timezone: this.config.timezone },
          },
          description.name,
          () => this.webhookUrlFor(node, 'test'),
        );
        try {
          await methods.create.call(hookCtx);
        } catch (e) {
          this.cancelTest(workflowData.id!, false);
          throw new WebhookError(400, `Could not register the test webhook for "${node.name}": ${(e as Error).message}`);
        }
        cleanups.push(() => methods.delete.call(hookCtx));
      }
    }
    if (cleanups.length) this.testCleanups.set(workflowData.id!, cleanups);
    return [...new Set(urls)];
  }

  private readonly testCleanups = new Map<string, Array<() => Promise<unknown>>>();

  /** `notify` is false when a test call consumed the registration: the editor then gets executionStarted instead. */
  cancelTest(workflowId: string, notify = true) {
    let removed = false;
    for (const [k, t] of this.test) {
      if (t.workflowId !== workflowId) continue;
      clearTimeout(t.timeout);
      this.test.delete(k);
      removed = true;
    }
    for (const cleanup of this.testCleanups.get(workflowId) ?? []) cleanup().catch((e) => console.warn(`Removing test webhook failed: ${(e as Error).message}`));
    this.testCleanups.delete(workflowId);
    if (removed && notify) this.push.send({ type: 'testWebhookDeleted', data: { workflowId } });
    return removed;
  }

  private find<T extends WebhookRegistration>(map: Map<string, T>, method: string, path: string): { reg: T; params: IDataObject } | null {
    const clean = trimSlashes(path);
    const exact = map.get(`${method} ${clean}`);
    if (exact) return { reg: exact, params: {} };
    const segments = clean.split('/');
    for (const reg of map.values()) {
      if (!reg.isDynamic || reg.method !== method) continue;
      const params = matchPath(reg, segments);
      if (params) return { reg, params };
    }
    return null;
  }

  private allowedMethods<T extends WebhookRegistration>(map: Map<string, T>, path: string) {
    const segments = trimSlashes(path).split('/');
    return [...map.values()].filter((r) => matchPath(r, segments)).map((r) => r.method);
  }

  /* ---------- handling ---------- */

  async handleProduction(method: string, path: string, request: IWebhookRequest): Promise<IWebhookResponse> {
    const found = this.find(this.production, method, path);
    if (!found) {
      const methods = this.allowedMethods(this.production, path);
      if (methods.length) throw new WebhookError(405, `This webhook is not registered for ${method} requests. Did you mean to make a ${methods.join(' or ')} request?`);
      throw new WebhookError(404, `The requested webhook "${method} ${trimSlashes(path)}" is not registered.`, 'The workflow must be active for a production URL to run successfully.');
    }
    const workflowData = this.loadWorkflow(found.reg.workflowId);
    if (!workflowData) throw new WebhookError(404, 'Workflow not found');
    return this.execute(workflowData, found.reg.nodeName, found.reg.webhookName, { ...request, params: found.params }, 'webhook');
  }

  async handleTest(method: string, path: string, request: IWebhookRequest): Promise<IWebhookResponse> {
    const found = this.find(this.test, method, path);
    if (!found) {
      throw new WebhookError(404, `The requested webhook "${trimSlashes(path)}" is not registered.`, "Click the 'Execute workflow' button on the canvas, then try again. (In test mode, the webhook only works for one call after you click this button)");
    }
    const t = found.reg;
    // GET on a form only renders it; the submission (POST) is the test event
    // consumed only once the trigger accepts the call: a rejected request (bad secret, form page view) leaves it armed
    return this.execute(t.workflowData, t.nodeName, t.webhookName, { ...request, params: found.params }, 'manual', t.pushRef, t.destinationNode, () =>
      this.cancelTest(t.workflowId, false),
    );
  }

  /** /webhook-waiting/:executionId — resumes an execution paused in a Wait node set to "On Webhook Call". */
  async handleWaiting(executionId: string, method: string, request: IWebhookRequest): Promise<IWebhookResponse> {
    const waiting = this.executions.getWaitingNode(executionId);
    if (!waiting) throw new WebhookError(404, `The execution "${executionId}" is not waiting for a webhook`);
    const workflowData = waiting.execution.workflowData;
    const node = workflowData.nodes.find((n) => n.name === waiting.nodeName)!;
    const nodeType = this.nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
    if (node.parameters.resume === 'form') return this.handleWaitingForm(executionId, node, method, request);
    const wanted = String(node.parameters.httpMethod ?? 'POST').toUpperCase();
    if (nodeType.webhook && wanted !== method && node.parameters.resume === 'webhook') {
      throw new WebhookError(405, `This webhook expects ${wanted} requests`);
    }
    const ctx = this.webhookContext(workflowData, node, 'default', request, waiting.execution.mode);
    const result = nodeType.webhook ? await nodeType.webhook.call(ctx) : { workflowData: [[{ json: { body: request.body as IDataObject } }]] };
    if (result.webhookResponse && !result.workflowData) return result.webhookResponse;
    const resumeItems = result.workflowData?.[0] as INodeExecutionData[] | undefined;
    // respond right away; the execution continues in the background
    this.executions.resume(executionId, resumeItems).catch((e) => console.error(`Resume of ${executionId} failed:`, e));
    return result.webhookResponse ?? { statusCode: 200, body: { message: 'Workflow was resumed' } };
  }

  /** Wait node "On Form Submitted": GET shows the form, POST resumes the execution with the answers. */
  private async handleWaitingForm(executionId: string, node: INode, method: string, request: IWebhookRequest): Promise<IWebhookResponse> {
    const p = node.parameters as { formTitle?: string; formDescription?: string; formFields?: { values?: FormField[] } };
    const fields = p.formFields?.values ?? [];
    const html = { 'content-type': 'text/html; charset=utf-8' };
    if (method === 'GET') {
      return { statusCode: 200, headers: html, body: renderForm({ title: p.formTitle, description: p.formDescription, fields }) };
    }
    if (method !== 'POST') throw new WebhookError(405, 'Forms accept GET and POST only');
    const item = await parseSubmission(request.body, request.files, fields, (data, fileName, mimeType) =>
      this.executions.binaryData.store(data, { fileName, mimeType, fileExtension: fileName.split('.').pop() }, executionId),
    );
    this.executions.resume(executionId, [item]).catch((e) => console.error(`Resume of ${executionId} failed:`, e));
    return { statusCode: 200, headers: html, body: renderSubmitted(p.formTitle ?? 'Form') };
  }

  webhookUrlFor(node: INode, mode: 'production' | 'test') {
    const type = this.nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
    const d = type.description.webhooks?.find((w) => w.name === 'default') ?? type.description.webhooks?.[0];
    if (!d) return '';
    const { path } = resolveWebhook(this.nodeTypes, node, d);
    const e = this.config.endpoints;
    const endpoint = isFormNode(node) ? (mode === 'test' ? e.formTest : e.form) : mode === 'test' ? e.webhookTest : e.webhook;
    return `${this.config.webhookUrl}${endpoint}/${path}`;
  }

  private webhookContext(workflowData: IWorkflowBase, node: INode, webhookName: string, request: IWebhookRequest, mode: 'manual' | 'webhook' | string) {
    const workflow = this.executions.buildWorkflow(workflowData);
    return new WebhookContext(
      {
        workflow,
        node: workflow.getNode(node.name)!,
        additionalData: {
          executionId: '',
          mode: mode as 'manual',
          credentialsHelper: this.executions.credentialsHelper,
          timezone: this.config.timezone,
          binaryData: this.executions.binaryData,
        },
      },
      request,
      webhookName,
      () => this.webhookUrlFor(node, mode === 'manual' ? 'test' : 'production'),
    );
  }

  private async execute(
    workflowData: IWorkflowBase,
    nodeName: string,
    webhookName: string,
    request: IWebhookRequest,
    mode: 'manual' | 'webhook',
    pushRef?: string,
    destinationNode?: string,
    onAccepted?: () => void,
  ): Promise<IWebhookResponse> {
    const node = workflowData.nodes.find((n) => n.name === nodeName);
    if (!node) throw new WebhookError(404, `Node "${nodeName}" not found`);
    const nodeType = this.nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
    const ctx = this.webhookContext(workflowData, node, webhookName, request, mode);
    const result = await nodeType.webhook!.call(ctx);
    if (!result.workflowData) return result.webhookResponse ?? { statusCode: 200, body: { message: 'Webhook call received' } };
    onAccepted?.();

    const params = getNodeParametersWithDefaults(nodeType.description.properties, node.parameters, node.typeVersion);
    const options = (params.options ?? {}) as IDataObject;
    const responseMode = String(params.responseMode ?? 'onReceived');
    const responseCode = Number(params.responseCode ?? 200);
    const headers: Record<string, string> = {};
    for (const h of ((options.responseHeaders as IDataObject)?.entries as Array<{ name: string; value: string }>) ?? []) if (h.name) headers[h.name.toLowerCase()] = h.value;
    if (options.responseContentType) headers['content-type'] = String(options.responseContentType);

    let respond!: (r: IWebhookResponse) => void;
    const responded = new Promise<IWebhookResponse>((r) => (respond = r));
    const { executionId, promise } = this.executions.run({
      workflowData,
      mode,
      startNode: nodeName,
      destinationNode,
      triggerData: result.workflowData[0],
      pushRef,
      onResponse: (r) => respond({ ...r, headers: { ...headers, ...(r.headers ?? {}) } }),
    });
    if (mode === 'manual') this.push.send({ type: 'testWebhookReceived', data: { workflowId: workflowData.id!, executionId } }, pushRef);

    if (result.webhookResponse) return result.webhookResponse;

    if (responseMode === 'onReceived') {
      promise.catch(() => {});
      if (options.noResponseBody) return { statusCode: responseCode, headers };
      const custom = options.responseData;
      return { statusCode: responseCode, headers, body: custom ? custom : { message: 'Workflow was started' } };
    }

    if (responseMode === 'responseNode') {
      const outcome = await Promise.race([responded, promise.then((run) => ({ run }))]);
      if ('run' in outcome) {
        if (outcome.run.status === 'error') return { statusCode: 500, body: { code: 0, message: 'Error in workflow' } };
        return { statusCode: 200, body: { message: 'Workflow executed successfully but no Respond to Webhook node was reached' } };
      }
      return outcome;
    }

    // lastNode
    const run = await promise;
    if (run.status === 'error') return { statusCode: 500, headers, body: { code: 0, message: 'Error in workflow' } };
    if (run.status === 'waiting') return { statusCode: responseCode, headers, body: { message: 'Workflow is waiting' } };
    const last = run.data.resultData.lastNodeExecuted;
    const items = (last ? run.data.resultData.runData[last]?.at(-1)?.data?.main?.[0] : undefined) ?? [];
    switch (params.responseData) {
      case 'noData':
        return { statusCode: responseCode, headers };
      case 'allEntries':
        return { statusCode: responseCode, headers, body: items.map((i) => i.json) };
      case 'firstEntryBinary': {
        const prop = String(params.responseBinaryPropertyName ?? 'data');
        const bin = items[0]?.binary?.[prop];
        if (!bin) return { statusCode: 500, body: { message: `No binary data in property "${prop}"` } };
        return { statusCode: responseCode, headers: { 'content-type': bin.mimeType, ...headers }, body: await this.executions.binaryData.get(bin) };
      }
      default:
        return { statusCode: responseCode, headers, body: items[0]?.json ?? {} };
    }
  }
}
