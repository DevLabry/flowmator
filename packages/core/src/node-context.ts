import {
  createExpressionContext,
  evaluateExpression,
  getNodeParametersWithDefaults,
  isExpression,
  NodeApiError,
  NodeOperationError,
  resolveParameterValue,
  type ConnectionType,
  type IBinaryData,
  type IDataObject,
  type IExecuteData,
  type IExecuteFunctions,
  type IExecuteWorkflowInfo,
  type IExecuteWorkflowResult,
  type IGetNodeParameterOptions,
  type IHelpers,
  type IHttpRequestOptions,
  type INode,
  type INodeExecutionData,
  type INodeParameters,
  type IPairedItem,
  type IRunData,
  type ISupplyDataFunctions,
  type IWebhookResponse,
  type IWorkflowMeta,
  type Workflow,
} from '@8n8/workflow';
import type { IWorkflowExecuteAdditionalData } from './additional-data';
import { consoleLogger } from './additional-data';
import { MemoryBinaryDataStore, mimeFromFileName, extensionFromMime } from './binary-data';
import { HttpError, httpRequest } from './http';

const memoryStore = new MemoryBinaryDataStore();

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as IDataObject)[key] : undefined), obj);
}


/** Copy for credentials to sign; the body is shared because FormData and streams can't be cloned. */
function cloneRequest(options: IHttpRequestOptions): IHttpRequestOptions {
  const { body, ...rest } = options;
  return { ...structuredClone(rest), ...(body !== undefined ? { body } : {}) };
}

export interface BaseContextParams {
  workflow: Workflow;
  node: INode;
  additionalData: IWorkflowExecuteAdditionalData;
  runData?: IRunData;
  contextData?: Record<string, IDataObject>;
}

/** Shared pieces used by execute, trigger, poll, webhook and load-options contexts. */
export class BaseNodeContext {
  readonly workflow: Workflow;
  readonly node: INode;
  readonly additionalData: IWorkflowExecuteAdditionalData;
  readonly logger = consoleLogger;
  private paramsWithDefaults?: INodeParameters;

  constructor(p: BaseContextParams) {
    this.workflow = p.workflow;
    this.node = p.node;
    this.additionalData = p.additionalData;
    if (p.additionalData.logger) this.logger = p.additionalData.logger;
  }

  getNode(): INode {
    return this.node;
  }

  getWorkflow(): IWorkflowMeta {
    return { id: this.workflow.id, name: this.workflow.name, active: this.workflow.active };
  }

  getMode() {
    return this.additionalData.mode;
  }

  getTimezone(): string {
    return this.workflow.settings.timezone ?? this.additionalData.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  getRestApiUrl(): string {
    return this.additionalData.restApiUrl ?? '';
  }

  getInstanceBaseUrl(): string {
    return this.additionalData.instanceBaseUrl ?? '';
  }

  getWorkflowStaticData(type: 'global' | 'node'): IDataObject {
    const key = type === 'global' ? 'global' : `node:${this.node.name}`;
    const data = this.workflow.staticData;
    return ((data[key] as IDataObject) ??= {});
  }

  async getCredentials<T extends object = IDataObject>(type: string): Promise<T> {
    if (!this.node.credentials?.[type]) {
      throw new NodeOperationError(this.node, `Node does not have credentials of type "${type}" set`);
    }
    if (!this.additionalData.credentialsHelper) throw new NodeOperationError(this.node, 'No credentials helper configured');
    return (await this.additionalData.credentialsHelper.getDecrypted(this.node, type)) as T;
  }

  /** Raw parameter value (dotted paths allowed), falling back to description defaults. */
  protected getRawParameter(name: string): unknown {
    let value = getPath(this.node.parameters, name);
    if (value === undefined) {
      if (!this.paramsWithDefaults) {
        const type = this.workflow.nodeTypes.getByNameAndVersion(this.node.type, this.node.typeVersion);
        this.paramsWithDefaults = getNodeParametersWithDefaults(type.description.properties, this.node.parameters, this.node.typeVersion);
      }
      value = getPath(this.paramsWithDefaults, name);
    }
    return value;
  }

  protected finalizeParameter(value: unknown, options?: IGetNodeParameterOptions): unknown {
    if (options?.extractValue && value && typeof value === 'object' && '__rl' in (value as object)) {
      return (value as IDataObject).value;
    }
    return value;
  }

  get helpers(): IHelpers {
    const self = this;
    const signal = this.additionalData.signal;
    const binaryStore = this.additionalData.binaryData ?? memoryStore;
    return {
      httpRequest: (options: IHttpRequestOptions) => httpRequest(options, signal).catch((e) => self.wrapHttpError(e)),
      async httpRequestWithAuthentication(credentialType: string, options: IHttpRequestOptions) {
        const helper = self.additionalData.credentialsHelper;
        if (!helper) throw new NodeOperationError(self.node, 'No credentials helper configured');
        let credentials = await helper.getDecrypted(self.node, credentialType);
        const authed = await helper.authenticate(credentialType, credentials, cloneRequest(options), self.node);
        try {
          return await httpRequest(authed, signal);
        } catch (e) {
          if (e instanceof HttpError && e.statusCode === 401 && helper.refresh) {
            const refreshed = await helper.refresh(self.node, credentialType, credentials);
            if (refreshed) {
              credentials = refreshed;
              const retry = await helper.authenticate(credentialType, credentials, cloneRequest(options), self.node);
              return httpRequest(retry, signal).catch((err) => self.wrapHttpError(err));
            }
          }
          return self.wrapHttpError(e);
        }
      },
      returnJsonArray(data: IDataObject | IDataObject[]): INodeExecutionData[] {
        return (Array.isArray(data) ? data : [data]).map((json) => ({ json: json && typeof json === 'object' ? json : { data: json } }));
      },
      constructExecutionMetaData(items: INodeExecutionData[], options: { itemData: IPairedItem | IPairedItem[] }) {
        return items.map((item) => ({ ...item, pairedItem: options.itemData }));
      },
      async prepareBinaryData(data: Buffer | Uint8Array, fileName?: string, mimeType?: string): Promise<IBinaryData> {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const mime = mimeType ?? mimeFromFileName(fileName) ?? 'application/octet-stream';
        const ext = fileName?.includes('.') ? fileName.split('.').pop() : extensionFromMime(mime);
        return binaryStore.store(buffer, { mimeType: mime, fileName, fileExtension: ext }, self.additionalData.executionId);
      },
      async getBinaryDataBuffer(itemIndex: number, propertyName: string, inputIndex = 0): Promise<Buffer> {
        const items = (self as unknown as ExecuteContext).getInputData?.(inputIndex) ?? [];
        const bin = items[itemIndex]?.binary?.[propertyName];
        if (!bin) throw new NodeOperationError(self.node, `No binary data property "${propertyName}" on item ${itemIndex}`, { itemIndex });
        return binaryStore.get(bin);
      },
      assertBinaryData(itemIndex: number, propertyName: string): IBinaryData {
        const items = (self as unknown as ExecuteContext).getInputData?.(0) ?? [];
        const bin = items[itemIndex]?.binary?.[propertyName];
        if (!bin) {
          throw new NodeOperationError(self.node, `This operation expects the node's input data to contain a binary file '${propertyName}', but none was found`, { itemIndex });
        }
        return bin;
      },
      binaryToString: (body: Buffer, encoding: BufferEncoding = 'utf8') => body.toString(encoding),
    };
  }

  wrapHttpError(e: unknown): never {
    if (e instanceof HttpError) throw new NodeApiError(this.node, e);
    if (e instanceof Error) throw new NodeOperationError(this.node, e);
    throw e;
  }
}

export interface ExecuteContextParams extends BaseContextParams {
  runData: IRunData;
  executeData: IExecuteData;
  runIndex: number;
  contextData: Record<string, IDataObject>;
}

export class ExecuteContext extends BaseNodeContext implements IExecuteFunctions {
  waitTill?: Date;
  private readonly runData: IRunData;
  private readonly executeData: IExecuteData;
  private readonly runIndex: number;
  private readonly contextData: Record<string, IDataObject>;

  constructor(p: ExecuteContextParams) {
    super(p);
    this.runData = p.runData;
    this.executeData = p.executeData;
    this.runIndex = p.runIndex;
    this.contextData = p.contextData;
  }

  getInputData(inputIndex = 0, type: ConnectionType = 'main'): INodeExecutionData[] {
    return this.executeData.data[type]?.[inputIndex] ?? [];
  }

  getInputSourceData(inputIndex = 0) {
    return this.executeData.source?.main?.[inputIndex] ?? null;
  }

  getRunIndex() {
    return this.runIndex;
  }

  getExecutionId() {
    return this.additionalData.executionId;
  }

  getRunData() {
    return this.runData;
  }

  getResumeData() {
    return this.executeData.resume;
  }

  getContext(type: 'flow' | 'node'): IDataObject {
    const key = type === 'flow' ? 'flow' : `node:${this.node.name}`;
    return (this.contextData[key] ??= {});
  }

  getParentNodes(nodeName: string) {
    return this.workflow.getParentNodes(nodeName);
  }

  getChildNodes(nodeName: string) {
    return this.workflow.getChildNodes(nodeName);
  }

  getExecutionCancelSignal() {
    return this.additionalData.signal;
  }

  continueOnFail(): boolean {
    const mode = this.node.onError ?? (this.node.continueOnFail ? 'continueRegularOutput' : 'stopWorkflow');
    return mode !== 'stopWorkflow';
  }

  getWorkflowDataProxy(itemIndex: number) {
    return createExpressionContext({
      workflow: this.workflow,
      runData: this.runData,
      activeNodeName: this.node.name,
      itemIndex,
      runIndex: this.runIndex,
      inputData: this.getInputData(0),
      executeData: this.executeData,
      mode: this.additionalData.mode,
      executionId: this.additionalData.executionId,
      timezone: this.getTimezone(),
      variables: this.additionalData.variables,
      env: process.env.N8N_BLOCK_ENV_ACCESS_IN_NODE === 'true' ? {} : (process.env as IDataObject),
      resumeUrl: `${this.additionalData.webhookWaitingBaseUrl ?? ''}/${this.additionalData.executionId}`,
      resumeFormUrl: `${this.additionalData.formWaitingBaseUrl ?? ''}/${this.additionalData.executionId}`,
      customData: this.additionalData.executionCustomData,
      getContext: (type, nodeName) => (this.contextData[type === 'flow' ? 'flow' : `node:${nodeName ?? this.node.name}`] ??= {}),
    });
  }

  evaluateExpression(expression: string, itemIndex: number, additionalKeys?: Record<string, unknown>): unknown {
    const expr = expression.startsWith('=') ? expression : `=${expression}`;
    return evaluateExpression(expr, { ...this.getWorkflowDataProxy(itemIndex), ...additionalKeys });
  }

  getNodeParameter(name: string, itemIndex: number, fallback?: unknown, options?: IGetNodeParameterOptions): any {
    const raw = this.getRawParameter(name);
    if (raw === undefined) {
      if (fallback !== undefined) return fallback;
      throw new NodeOperationError(this.node, `Could not get parameter "${name}"`, { itemIndex });
    }
    if (options?.rawExpressions) return raw;
    let ctx: Record<string, unknown> | undefined;
    try {
      const value = resolveParameterValue(raw, (expr) => evaluateExpression(expr, (ctx ??= this.getWorkflowDataProxy(itemIndex))));
      return this.finalizeParameter(value, options);
    } catch (error) {
      const e = error as Error & { description?: string };
      throw new NodeOperationError(this.node, e, {
        itemIndex,
        description: e.description ?? `Problem in parameter "${name}"${isExpression(raw) ? `: ${raw}` : ''}`,
      });
    }
  }

  async putExecutionToWait(waitTill: Date): Promise<void> {
    this.waitTill = waitTill;
  }

  async executeWorkflow(
    info: IExecuteWorkflowInfo,
    items: INodeExecutionData[],
    options?: { waitForSubWorkflow?: boolean },
  ): Promise<IExecuteWorkflowResult> {
    const wait = options?.waitForSubWorkflow ?? true;
    if (this.additionalData.executeWorkflow) {
      return this.additionalData.executeWorkflow(info, items, { parentExecutionId: this.additionalData.executionId, waitForSubWorkflow: wait });
    }
    if (!info.code) throw new NodeOperationError(this.node, 'Executing workflows by id requires the server runtime');
    // In-process fallback (used by tests and the CLI)
    const { Workflow } = await import('@8n8/workflow');
    const { WorkflowExecute } = await import('./workflow-execute');
    const sub = new Workflow({ ...info.code, nodeTypes: this.workflow.nodeTypes });
    const run = await new WorkflowExecute({ ...this.additionalData, executionId: `${this.additionalData.executionId}-sub`, mode: 'integrated' }).run({
      workflow: sub,
      triggerData: items,
    });
    if (run.data.resultData.error) throw new NodeOperationError(this.node, run.data.resultData.error.message);
    const last = run.data.resultData.lastNodeExecuted;
    const lastRun = last ? run.data.resultData.runData[last]?.at(-1) : undefined;
    return { data: (lastRun?.data?.main as INodeExecutionData[][]) ?? null };
  }

  sendMessageToUI(...args: unknown[]): void {
    this.additionalData.hooks?.sendMessageToUI?.(this.node.name, args);
  }

  sendResponse(response: IWebhookResponse): void {
    this.additionalData.sendResponse?.(response);
  }

  /** Collects what the sub-nodes connected through `type` supply (AI models, tools, memory, ...). */
  async getInputConnectionData(type: ConnectionType, itemIndex: number): Promise<unknown> {
    const parents = this.workflow.getDirectParents(this.node.name, type);
    const nodeType = this.workflow.nodeTypes.getByNameAndVersion(this.node.type, this.node.typeVersion);
    const inputConfig = nodeType.description.inputs.find((i) => typeof i !== 'string' && i.type === type);
    const results: unknown[] = [];
    for (const parent of parents) {
      const subNode = this.workflow.getNode(parent.node);
      if (!subNode || subNode.disabled) continue;
      const subType = this.workflow.nodeTypes.getByNameAndVersion(subNode.type, subNode.typeVersion);
      if (!subType.supplyData) throw new NodeOperationError(this.node, `Node "${subNode.name}" cannot supply ${type} data`);
      const subContext = new ExecuteContext({
        workflow: this.workflow,
        node: subNode,
        additionalData: this.additionalData,
        runData: this.runData,
        executeData: { node: subNode, data: this.executeData.data, source: this.executeData.source },
        runIndex: this.runIndex,
        contextData: this.contextData,
      }) as unknown as ISupplyDataFunctions;
      let supplied;
      try {
        supplied = await subType.supplyData.call(subContext, itemIndex);
      } catch (e) {
        // the error surfaces on the root node, so say which sub-node it came from
        const err = e as Error & { description?: string };
        throw new NodeOperationError(this.node, `${subNode.name}: ${err.message}`, { description: err.description, itemIndex });
      }
      results.push(supplied.response);
    }
    if (typeof inputConfig === 'object' && inputConfig.required && results.length === 0) {
      throw new NodeOperationError(this.node, `A ${inputConfig.displayName ?? type} sub-node must be connected`);
    }
    if (typeof inputConfig === 'object' && inputConfig.maxConnections === 1) return results[0];
    return results;
  }
}
