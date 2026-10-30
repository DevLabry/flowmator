import type { FastifyInstance } from 'fastify';
import type { IDataObject, INodeExecutionData, IPinData, IRunData, IWorkflowBase } from '@flowmator/workflow';
import { normalizeWorkflow, type AppContext } from '../context';
import type { WorkflowEntity } from '../db';
import { HttpError } from './errors';

type WorkflowBody = Partial<WorkflowEntity> & { name?: string };

interface RunBody {
  workflowData?: IWorkflowBase;
  destinationNode?: string;
  /** Start from this trigger (when the workflow has several) */
  triggerToStartFrom?: { name: string; data?: { main?: INodeExecutionData[][] } };
  runData?: IRunData;
  dirtyNodeNames?: string[];
  pinData?: IPinData;
}

export function workflowRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, activeWorkflows, executions, webhooks, nodeTypes } = ctx;

  const withStatus = (wf: WorkflowEntity) => ({ ...wf, activationError: activeWorkflows.activationError(wf.id) ?? null });
  const mustGet = (id: string) => {
    const wf = db.getWorkflow(id);
    if (!wf) throw new HttpError(404, `Workflow with ID "${id}" not found`);
    return wf;
  };

  /** Turns a workflow on/off, keeping the DB flag and the running triggers in sync. */
  const setActive = async (id: string, active: boolean) => {
    const wf = mustGet(id);
    if (active) {
      try {
        await activeWorkflows.add(wf, wf.active ? 'update' : 'activate');
      } catch (e) {
        db.updateWorkflow(id, { active: false });
        throw new HttpError(400, (e as Error).message);
      }
    } else await activeWorkflows.remove(id);
    return db.updateWorkflow(id, { active });
  };

  app.get('/rest/workflows', async (req) => {
    const q = req.query as { filter?: string; active?: string; name?: string; tag?: string; folderId?: string; archived?: string };
    const f = q.filter ? (JSON.parse(q.filter) as IDataObject) : {};
    const list = db.listWorkflows({
      active: q.active !== undefined ? q.active === 'true' : (f.active as boolean | undefined),
      name: q.name ?? (f.name as string | undefined),
      tag: q.tag ?? (f.tag as string | undefined),
      folderId: q.folderId === undefined ? undefined : q.folderId === 'root' ? null : q.folderId,
      archived: q.archived === 'true' || f.isArchived === true,
    });
    return { data: list.map(withStatus), count: list.length };
  });

  app.get('/rest/workflows/:id', async (req) => ({ data: withStatus(mustGet((req.params as { id: string }).id)) }));

  app.post('/rest/workflows', async (req) => {
    const body = normalizeWorkflow((req.body ?? {}) as WorkflowBody);
    const wf = db.createWorkflow({ ...body, name: body.name || 'My workflow' });
    if (body.active) return { data: withStatus(await setActive(wf.id, true)) };
    return { data: withStatus(wf) };
  });

  /** Import workflow JSON (n8n exports work as-is); accepts one workflow or an array. */
  app.post('/rest/workflows/import', async (req) => {
    const body = req.body as WorkflowBody | WorkflowBody[];
    const list = Array.isArray(body) ? body : [body];
    const created = list.map((w) => {
      const { active: _ignored, ...rest } = normalizeWorkflow(w);
      return db.createWorkflow({ ...rest, name: rest.name || 'Imported workflow', tags: (rest.tags as unknown as Array<string | { name: string }> | undefined)?.map((t) => (typeof t === 'string' ? t : t.name)) });
    });
    return { data: created };
  });

  app.patch('/rest/workflows/:id', async (req) => {
    const { id } = req.params as { id: string };
    const current = mustGet(id);
    const body = normalizeWorkflow((req.body ?? {}) as WorkflowBody);
    if (body.versionId && body.versionId !== current.versionId && (req.query as { forceSave?: string }).forceSave !== 'true') {
      throw new HttpError(409, 'Your most recent changes may be lost, because someone else just updated this workflow. Open this workflow in a new tab to see those new updates.');
    }
    const { active, id: _id, createdAt: _c, updatedAt: _u, versionId: _v, ...changes } = body;
    let wf = db.updateWorkflow(id, changes);
    if (active !== undefined && active !== current.active) wf = await setActive(id, active);
    else if (wf.active && (changes.nodes || changes.connections || changes.settings)) wf = await setActive(id, true);
    return { data: withStatus(wf) };
  });

  app.delete('/rest/workflows/:id', async (req) => {
    const { id } = req.params as { id: string };
    mustGet(id);
    await activeWorkflows.remove(id);
    webhooks.cancelTest(id);
    db.deleteWorkflow(id);
    return { data: true };
  });

  app.post('/rest/workflows/:id/activate', async (req) => ({ data: withStatus(await setActive((req.params as { id: string }).id, true)) }));
  app.post('/rest/workflows/:id/deactivate', async (req) => ({ data: withStatus(await setActive((req.params as { id: string }).id, false)) }));

  app.post('/rest/workflows/:id/archive', async (req) => {
    const { id } = req.params as { id: string };
    await setActive(id, false);
    return { data: db.updateWorkflow(id, { isArchived: true }) };
  });
  app.post('/rest/workflows/:id/unarchive', async (req) => ({ data: db.updateWorkflow((req.params as { id: string }).id, { isArchived: false }) }));

  /** Duplicate */
  app.post('/rest/workflows/:id/copy', async (req) => {
    const src = mustGet((req.params as { id: string }).id);
    const { id: _id, active: _a, ...rest } = src;
    return { data: db.createWorkflow({ ...rest, name: `${src.name} (copy)` }) };
  });

  /* ----- version history ----- */
  app.get('/rest/workflow-history/workflow/:id', async (req) => ({ data: db.listHistory((req.params as { id: string }).id) }));
  app.get('/rest/workflow-history/workflow/:id/version/:versionId', async (req) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    const v = db.getHistoryVersion(id, versionId);
    if (!v) throw new HttpError(404, 'Version not found');
    return { data: v };
  });
  app.post('/rest/workflow-history/workflow/:id/version/:versionId/restore', async (req) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    const v = db.getHistoryVersion(id, versionId);
    if (!v) throw new HttpError(404, 'Version not found');
    const wf = db.updateWorkflow(id, { nodes: v.nodes, connections: v.connections });
    if (wf.active) await setActive(id, true);
    return { data: withStatus(db.getWorkflow(id)!) };
  });

  /* ----- manual runs from the editor ----- */
  app.post('/rest/workflows/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { pushRef?: string; wait?: string };
    const pushRef = (req.headers['push-ref'] as string | undefined) ?? q.pushRef;
    const body = (req.body ?? {}) as RunBody;
    const stored = db.getWorkflow(id);
    const workflowData = normalizeWorkflow(body.workflowData ? { ...body.workflowData, id } : stored!);
    if (!workflowData) throw new HttpError(404, `Workflow with ID "${id}" not found`);

    const workflow = executions.buildWorkflow(workflowData);
    const pinData = body.pinData ?? workflowData.pinData;
    const triggerName = body.triggerToStartFrom?.name;
    const start = triggerName ? workflow.getNode(triggerName) : workflow.getStartNode(body.destinationNode);
    if (!start) throw new HttpError(400, 'The workflow has no trigger node to start from');

    // A webhook trigger without data waits for a test call (unless its output is pinned or reused)
    const startType = nodeTypes.getByNameAndVersion(start.type, start.typeVersion);
    const hasData = !!pinData?.[start.name] || !!body.runData?.[start.name] || !!body.triggerToStartFrom?.data;
    if (startType.webhook && startType.description.group.includes('trigger') && !hasData) {
      let testUrls: string[];
      try {
        testUrls = await webhooks.registerTest(workflowData, { pushRef, destinationNode: body.destinationNode, triggerNode: start.name });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return { data: { waitingForWebhook: true, testUrls } };
    }

    const triggerData = body.triggerToStartFrom?.data?.main?.[0];
    const { executionId, promise } = executions.run({
      workflowData,
      mode: 'manual',
      startNode: start.name,
      destinationNode: body.destinationNode,
      runData: body.runData && body.destinationNode ? body.runData : undefined,
      dirtyNodes: body.dirtyNodeNames,
      pinData,
      triggerData,
      pushRef,
    });
    if (q.wait === 'true') {
      const run = await promise;
      return { data: { executionId, status: run.status, data: run.data.resultData } };
    }
    promise.catch(() => {});
    return { data: { executionId } };
  });

  app.delete('/rest/workflows/:id/test-webhook', async (req) => ({ data: webhooks.cancelTest((req.params as { id: string }).id) }));

  /** Webhook URLs of a workflow's trigger nodes (for the node panel). */
  app.get('/rest/workflows/:id/webhook-urls', async (req) => {
    const wf = mustGet((req.params as { id: string }).id);
    return {
      data: wf.nodes
        .filter((n) => nodeTypes.has(n.type) && nodeTypes.getByNameAndVersion(n.type).description.webhooks?.length)
        .map((n) => ({ node: n.name, test: webhooks.webhookUrlFor(n, 'test'), production: webhooks.webhookUrlFor(n, 'production') })),
    };
  });
}
