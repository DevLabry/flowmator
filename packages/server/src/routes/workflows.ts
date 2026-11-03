import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IDataObject, INodeExecutionData, IPinData, IRunData, IWorkflowBase } from '@flowmator/workflow';
import { normalizeWorkflow, type AppContext } from '../context';
import type { WorkflowScope } from '../access';
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
  const { db, activeWorkflows, executions, webhooks, nodeTypes, access, users } = ctx;
  const userOf = (req: FastifyRequest) => req.user!;

  /** Adds the activation error, the home project, the projects it is shared with and the user's scopes. */
  const view = (wf: WorkflowEntity, req: FastifyRequest, lookups?: { homes: Map<string, string>; shares: Map<string, string[]> }) => {
    const homeId = lookups ? lookups.homes.get(wf.id) : access.homeProject('workflow', wf.id)?.id;
    const shared = lookups ? (lookups.shares.get(wf.id) ?? []) : access.sharedWith('workflow', wf.id).map((p) => p.id);
    const project = (id: string | undefined) => {
      const p = id ? users.getProject(id) : null;
      return p ? { id: p.id, name: p.name, type: p.type, icon: p.icon } : null;
    };
    return {
      ...wf,
      activationError: activeWorkflows.activationError(wf.id) ?? null,
      homeProject: project(homeId),
      sharedWithProjects: shared.map(project).filter(Boolean),
      scopes: access.workflowScopes(userOf(req), wf.id),
    };
  };
  const mustGet = (id: string) => {
    const wf = db.getWorkflow(id);
    if (!wf) throw new HttpError(404, `Workflow with ID "${id}" not found`);
    return wf;
  };
  /** The workflow, when the user has `scope` on it (404 when they can't see it). */
  const allowed = (req: FastifyRequest, id: string, scope: WorkflowScope) => {
    const wf = mustGet(id);
    access.requireWorkflow(userOf(req), id, scope);
    return wf;
  };
  /** Where new workflows go: the project asked for (if the user may create there) or their personal project. */
  const targetProject = (req: FastifyRequest, projectId?: string) => {
    const user = userOf(req);
    const id = projectId || users.personalProject(user.id).id;
    access.requireProject(user, id, 'create');
    return id;
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
    const q = req.query as { filter?: string; active?: string; name?: string; tag?: string; folderId?: string; archived?: string; projectId?: string };
    const f = q.filter ? (JSON.parse(q.filter) as IDataObject) : {};
    const projectId = q.projectId ?? (f.projectId as string | undefined);
    if (projectId) access.requireProject(userOf(req), projectId, 'read');
    const visible = access.visible('workflow', userOf(req), projectId);
    const lookups = { homes: access.homeProjects('workflow'), shares: access.sharesOf('workflow') };
    const list = db.listWorkflows({
      active: q.active !== undefined ? q.active === 'true' : (f.active as boolean | undefined),
      name: q.name ?? (f.name as string | undefined),
      tag: q.tag ?? (f.tag as string | undefined),
      folderId: q.folderId === undefined ? undefined : q.folderId === 'root' ? null : q.folderId,
      archived: q.archived === 'true' || f.isArchived === true,
    }).filter((wf) => !visible || visible.has(wf.id));
    return { data: list.map((wf) => view(wf, req, lookups)), count: list.length };
  });

  app.get('/rest/workflows/:id', async (req) => ({ data: view(allowed(req, (req.params as { id: string }).id, 'read'), req) }));

  app.post('/rest/workflows', async (req) => {
    const { projectId, ...body } = normalizeWorkflow((req.body ?? {}) as WorkflowBody & { projectId?: string });
    const home = targetProject(req, projectId);
    const wf = db.createWorkflow({ ...body, name: body.name || 'My workflow' });
    access.setOwner('workflow', wf.id, home);
    if (body.active) return { data: view(await setActive(wf.id, true), req) };
    return { data: view(wf, req) };
  });

  /** Import workflow JSON; accepts one workflow or an array. */
  app.post('/rest/workflows/import', async (req) => {
    const body = req.body as WorkflowBody | WorkflowBody[];
    const list = Array.isArray(body) ? body : [body];
    const home = targetProject(req, (req.query as { projectId?: string }).projectId);
    const created = list.map((w) => {
      const { active: _ignored, ...rest } = normalizeWorkflow(w);
      const wf = db.createWorkflow({ ...rest, name: rest.name || 'Imported workflow', tags: (rest.tags as unknown as Array<string | { name: string }> | undefined)?.map((t) => (typeof t === 'string' ? t : t.name)) });
      access.setOwner('workflow', wf.id, home);
      return view(wf, req);
    });
    return { data: created };
  });

  app.patch('/rest/workflows/:id', async (req) => {
    const { id } = req.params as { id: string };
    const current = allowed(req, id, 'update');
    const body = normalizeWorkflow((req.body ?? {}) as WorkflowBody);
    if (body.versionId && body.versionId !== current.versionId && (req.query as { forceSave?: string }).forceSave !== 'true') {
      throw new HttpError(409, 'Your most recent changes may be lost, because someone else just updated this workflow. Open this workflow in a new tab to see those new updates.');
    }
    const { active, id: _id, createdAt: _c, updatedAt: _u, versionId: _v, ...changes } = body;
    let wf = db.updateWorkflow(id, changes);
    if (active !== undefined && active !== current.active) wf = await setActive(id, active);
    else if (wf.active && (changes.nodes || changes.connections || changes.settings)) wf = await setActive(id, true);
    return { data: view(wf, req) };
  });

  app.delete('/rest/workflows/:id', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'delete');
    await ctx.deleteWorkflow(id);
    return { data: true };
  });

  app.post('/rest/workflows/:id/activate', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'update');
    return { data: view(await setActive(id, true), req) };
  });
  app.post('/rest/workflows/:id/deactivate', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'update');
    return { data: view(await setActive(id, false), req) };
  });

  app.post('/rest/workflows/:id/archive', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'delete');
    await setActive(id, false);
    return { data: view(db.updateWorkflow(id, { isArchived: true }), req) };
  });
  app.post('/rest/workflows/:id/unarchive', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'delete');
    return { data: view(db.updateWorkflow(id, { isArchived: false }), req) };
  });

  /** Duplicate (into the user's personal project, or the project asked for) */
  app.post('/rest/workflows/:id/copy', async (req) => {
    const src = allowed(req, (req.params as { id: string }).id, 'read');
    const home = targetProject(req, (req.body as { projectId?: string } | undefined)?.projectId ?? access.homeProject('workflow', src.id)?.id);
    const { id: _id, active: _a, ...rest } = src;
    const wf = db.createWorkflow({ ...rest, name: `${src.name} (copy)` });
    access.setOwner('workflow', wf.id, home);
    return { data: view(wf, req) };
  });

  /* ----- sharing ----- */

  /** Shares the workflow with these projects (editors), replacing the previous shares. */
  app.put('/rest/workflows/:id/share', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'share');
    const { shareWithIds = [] } = (req.body ?? {}) as { shareWithIds?: string[] };
    access.share('workflow', id, shareWithIds);
    return { data: view(mustGet(id), req) };
  });

  /** Moves the workflow to another project; the old home keeps it shared only when asked to. */
  app.put('/rest/workflows/:id/transfer', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'move');
    const { destinationProjectId } = (req.body ?? {}) as { destinationProjectId?: string };
    if (!destinationProjectId) throw new HttpError(400, 'destinationProjectId is required');
    access.requireProject(userOf(req), destinationProjectId, 'create');
    access.setOwner('workflow', id, destinationProjectId);
    // the credentials it uses must be usable in the new project
    const wf = mustGet(id);
    if (wf.active) await setActive(id, true).catch(() => setActive(id, false));
    return { data: view(mustGet(id), req) };
  });

  /* ----- version history ----- */
  app.get('/rest/workflow-history/workflow/:id', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'read');
    return { data: db.listHistory(id) };
  });
  app.get('/rest/workflow-history/workflow/:id/version/:versionId', async (req) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    allowed(req, id, 'read');
    const v = db.getHistoryVersion(id, versionId);
    if (!v) throw new HttpError(404, 'Version not found');
    return { data: v };
  });
  app.post('/rest/workflow-history/workflow/:id/version/:versionId/restore', async (req) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    allowed(req, id, 'update');
    const v = db.getHistoryVersion(id, versionId);
    if (!v) throw new HttpError(404, 'Version not found');
    const wf = db.updateWorkflow(id, { nodes: v.nodes, connections: v.connections });
    if (wf.active) await setActive(id, true);
    return { data: view(db.getWorkflow(id)!, req) };
  });

  /* ----- manual runs from the editor ----- */
  app.post('/rest/workflows/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { pushRef?: string; wait?: string };
    const pushRef = (req.headers['push-ref'] as string | undefined) ?? q.pushRef;
    const body = (req.body ?? {}) as RunBody;
    allowed(req, id, 'execute');
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

  app.delete('/rest/workflows/:id/test-webhook', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'execute');
    return { data: webhooks.cancelTest(id) };
  });

  /** Webhook URLs of a workflow's trigger nodes (for the node panel). */
  app.get('/rest/workflows/:id/webhook-urls', async (req) => {
    const wf = allowed(req, (req.params as { id: string }).id, 'read');
    return {
      data: wf.nodes
        .filter((n) => nodeTypes.has(n.type) && nodeTypes.getByNameAndVersion(n.type).description.webhooks?.length)
        .map((n) => ({ node: n.name, test: webhooks.webhookUrlFor(n, 'test'), production: webhooks.webhookUrlFor(n, 'production') })),
    };
  });
}
