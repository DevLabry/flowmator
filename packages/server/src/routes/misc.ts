import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LoadOptionsContext } from '@flowmator/core';
import { Workflow, type INode, type INodeParameters } from '@flowmator/workflow';
import type { AppContext } from '../context';
import { Mailer } from '../mailer';
import { HttpError } from './errors';

export const VERSION = '0.1.0';

export function miscRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, nodeTypes, config, access, users } = ctx;
  const userOf = (req: FastifyRequest) => req.user!;
  const mailer = new Mailer();
  /** Loading options with a credential needs permission to use it. */
  const checkCredentials = (req: FastifyRequest, credentials: INode['credentials']) => {
    for (const c of Object.values(credentials ?? {})) if (c?.id) access.requireCredential(userOf(req), c.id, 'use');
  };

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/rest/settings', async () => ({
    data: {
      version: VERSION,
      timezone: config.timezone,
      urlBaseWebhook: config.webhookUrl,
      endpointWebhook: config.endpoints.webhook,
      endpointWebhookTest: config.endpoints.webhookTest,
      endpointWebhookWaiting: config.endpoints.webhookWaiting,
      endpointForm: config.endpoints.form,
      endpointFormTest: config.endpoints.formTest,
      endpointFormWaiting: config.endpoints.formWaiting,
      saveManualExecutions: config.executions.saveManual,
      executionTimeout: config.executions.timeoutSeconds,
      executionMode: config.executions.mode,
      userManagement: { showSetupOnFirstLoad: !users.isSetUp(), smtpSetup: mailer.enabled },
    },
  }));

  /** Node descriptions. Functions (dynamic outputs) can't be serialized; use /rest/node-types/io for those. */
  app.get('/rest/node-types', async () => ({
    data: nodeTypes.getAll().map((t) => ({
      ...t.description,
      hasDynamicIO: !!(t.description.dynamicInputs || t.description.dynamicOutputs || t.description.dynamicOutputNames),
      isTrigger: t.description.group.includes('trigger'),
      hasWebhook: !!t.webhook,
      supplyData: !!t.supplyData,
      loadOptionsMethods: Object.keys(t.methods?.loadOptions ?? {}),
    })),
  }));

  /** Inputs/outputs for a node given its current parameters (Switch rules, Merge input count, error output...). */
  app.post('/rest/node-types/io', async (req) => {
    const { type, parameters, onError } = req.body as { type: string; parameters: INodeParameters; onError?: string };
    const d = nodeTypes.getByNameAndVersion(type).description;
    const outputs = d.dynamicOutputs?.(parameters) ?? d.outputs;
    const outputNames = d.dynamicOutputNames?.(parameters) ?? d.outputNames ?? [];
    return {
      data: {
        inputs: d.dynamicInputs?.(parameters) ?? d.inputs,
        inputNames: d.inputNames ?? [],
        outputs: onError === 'continueErrorOutput' ? [...outputs, 'main'] : outputs,
        outputNames: onError === 'continueErrorOutput' ? [...outputNames, 'error'] : outputNames,
      },
    };
  });

  /** Dynamic dropdown values (loadOptions / listSearch methods on a node type). */
  app.post('/rest/dynamic-node-parameters/options', async (req) => {
    const body = req.body as { nodeTypeAndVersion: { name: string; version?: number }; methodName: string; currentNodeParameters: INodeParameters; credentials?: INode['credentials']; filter?: string; paginationToken?: string };
    checkCredentials(req, body.credentials);
    const type = nodeTypes.getByNameAndVersion(body.nodeTypeAndVersion.name);
    const node: INode = { id: 'tmp', name: 'tmp', type: type.description.name, typeVersion: body.nodeTypeAndVersion.version ?? 1, position: [0, 0], parameters: body.currentNodeParameters ?? {}, credentials: body.credentials };
    const workflow = new Workflow({ name: 'tmp', nodes: [node], connections: {}, nodeTypes });
    const lctx = new LoadOptionsContext({ workflow, node, additionalData: { executionId: '', mode: 'internal', credentialsHelper: ctx.credentialsHelper, timezone: config.timezone, dataTables: ctx.dataTables } });
    const loader = type.methods?.loadOptions?.[body.methodName];
    if (loader) return { data: await loader.call(lctx) };
    const search = type.methods?.listSearch?.[body.methodName];
    if (search) return { data: await search.call(lctx, body.filter, body.paginationToken) };
    throw new HttpError(404, `Method "${body.methodName}" not found on ${type.description.name}`);
  });

  /** Fields for a resourceMapper parameter (table columns, sheet headers...). */
  app.post('/rest/dynamic-node-parameters/resource-mapper-fields', async (req) => {
    const body = req.body as { nodeTypeAndVersion: { name: string; version?: number }; methodName: string; currentNodeParameters: INodeParameters; credentials?: INode['credentials'] };
    const type = nodeTypes.getByNameAndVersion(body.nodeTypeAndVersion.name);
    const method = type.methods?.resourceMapping?.[body.methodName];
    if (!method) throw new HttpError(404, `Method "${body.methodName}" not found on ${type.description.name}`);
    checkCredentials(req, body.credentials);
    const node: INode = { id: 'tmp', name: 'tmp', type: type.description.name, typeVersion: body.nodeTypeAndVersion.version ?? 1, position: [0, 0], parameters: body.currentNodeParameters ?? {}, credentials: body.credentials };
    const workflow = new Workflow({ name: 'tmp', nodes: [node], connections: {}, nodeTypes });
    const lctx = new LoadOptionsContext({ workflow, node, additionalData: { executionId: '', mode: 'internal', credentialsHelper: ctx.credentialsHelper, timezone: config.timezone, dataTables: ctx.dataTables } });
    return { data: await method.call(lctx) };
  });

  /* tags */
  app.get('/rest/tags', async (req) => ({ data: db.listTags((req.query as { withUsageCount?: string }).withUsageCount === 'true') }));
  app.post('/rest/tags', async (req) => {
    const id = db.upsertTag((req.body as { name: string }).name);
    return { data: db.listTags().find((t) => t.id === id) };
  });
  app.patch('/rest/tags/:id', async (req) => {
    db.renameTag((req.params as { id: string }).id, (req.body as { name: string }).name);
    return { data: db.listTags().find((t) => t.id === (req.params as { id: string }).id) };
  });
  app.delete('/rest/tags/:id', async (req) => {
    db.deleteTag((req.params as { id: string }).id);
    return { data: true };
  });

  /* folders (each belongs to a project) */
  app.get('/rest/folders', async (req) => {
    const { projectId } = req.query as { projectId?: string };
    if (projectId) access.requireProject(userOf(req), projectId, 'read');
    const visible = access.projectItems('folders', userOf(req), projectId);
    return { data: db.listFolders().filter((f) => !visible || visible.has(f.id as string)) };
  });
  app.post('/rest/folders', async (req) => {
    const b = req.body as { name: string; parentFolderId?: string; projectId?: string };
    const projectId = b.projectId || users.personalProject(userOf(req).id).id;
    access.requireProject(userOf(req), projectId, 'create');
    if (b.parentFolderId) access.requireProjectItem(userOf(req), 'folders', b.parentFolderId, 'create');
    const folder = db.createFolder(b.name, b.parentFolderId ?? null);
    access.setItemProject('folders', folder.id, projectId);
    return { data: { ...folder, projectId } };
  });
  app.patch('/rest/folders/:id', async (req) => {
    const { id } = req.params as { id: string };
    access.requireProjectItem(userOf(req), 'folders', id, 'create');
    db.updateFolder(id, req.body as { name?: string; parentFolderId?: string | null });
    return { data: true };
  });
  app.delete('/rest/folders/:id', async (req) => {
    const { id } = req.params as { id: string };
    access.requireProjectItem(userOf(req), 'folders', id, 'create');
    db.deleteFolder(id);
    return { data: true };
  });

  /* variables ($vars): everyone reads them, owners and admins change them */
  app.get('/rest/variables', async () => ({ data: db.listVariables() }));
  app.addHook('preHandler', async (req) => {
    if (req.method !== 'GET' && req.routeOptions.url?.startsWith('/rest/variables')) access.requireAdmin(userOf(req));
  });
  app.post('/rest/variables', async (req) => {
    const b = req.body as { key: string; value: string };
    try {
      return { data: db.createVariable(b.key, String(b.value ?? '')) };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });
  app.patch('/rest/variables/:id', async (req) => ({ data: db.updateVariable((req.params as { id: string }).id, req.body as { key?: string; value?: string }) }));
  app.delete('/rest/variables/:id', async (req) => {
    db.deleteVariable((req.params as { id: string }).id);
    return { data: true };
  });

  /* API keys for the public API: each user has their own and the API acts as them */
  app.get('/rest/api-keys', async (req) => ({ data: db.listApiKeys(userOf(req).id) }));
  app.post('/rest/api-keys', async (req) => {
    const label = (req.body as { label?: string })?.label ?? 'My API key';
    return { data: db.createApiKey(label, `flowmator_api_${randomBytes(24).toString('hex')}`, userOf(req).id) };
  });
  app.delete('/rest/api-keys/:id', async (req) => {
    db.deleteApiKey((req.params as { id: string }).id, userOf(req).id);
    return { data: true };
  });
}
