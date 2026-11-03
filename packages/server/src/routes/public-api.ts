import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ExecutionStatus } from '@flowmator/workflow';
import type { WorkflowScope } from '../access';
import { normalizeWorkflow, type AppContext } from '../context';
import { dataTableRowRoutes, guardDataTables, visibleTables } from './data-tables';
import { HttpError } from './errors';

/**
 * Public REST API (/api/v1), authenticated with an API key in the X-N8N-API-KEY header.
 * Mirrors the shape of n8n's public API so existing scripts keep working.
 */
export async function publicApiRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, activeWorkflows, access, users } = ctx;

  await app.register(async (api) => {
    // the API acts as the key's user (keys made before user management act as the owner)
    api.addHook('onRequest', async (req) => {
      const key = req.headers['x-n8n-api-key'] ?? req.headers['x-flowmator-api-key'];
      const found = key ? db.findApiKey(String(key)) : null;
      const user = found ? (found.userId ? users.get(found.userId) : users.owner()) : null;
      if (!user || user.disabled) throw new HttpError(401, 'unauthorized');
      req.user = user;
    });
    guardDataTables(api, access, '/data-tables');
    const workflow = (req: FastifyRequest, id: string, scope: WorkflowScope) => {
      const wf = db.getWorkflow(id);
      if (!wf) throw new HttpError(404, 'Not Found');
      access.requireWorkflow(req.user!, id, scope);
      return wf;
    };
    const execution = (req: FastifyRequest, id: string, scope: 'read' | 'execute') => {
      const e = db.getExecution(id);
      if (!e) throw new HttpError(404, 'Not Found');
      if (e.workflowId && db.getWorkflow(e.workflowId)) access.requireWorkflow(req.user!, e.workflowId, scope);
      else access.requireAdmin(req.user!);
      return e;
    };

    const page = <T extends { id: string }>(items: T[], limit: number, cursor?: string) => {
      const start = cursor ? Number(Buffer.from(cursor, 'base64').toString()) : 0;
      const data = items.slice(start, start + limit);
      const next = start + limit < items.length ? Buffer.from(String(start + limit)).toString('base64') : null;
      return { data, nextCursor: next };
    };

    api.get('/workflows', async (req) => {
      const q = req.query as { active?: string; name?: string; tags?: string; limit?: string; cursor?: string };
      const q2 = req.query as { projectId?: string };
      if (q2.projectId) access.requireProject(req.user!, q2.projectId, 'read');
      const visible = access.visible('workflow', req.user!, q2.projectId);
      const list = db.listWorkflows({ active: q.active === undefined ? undefined : q.active === 'true', name: q.name, tag: q.tags?.split(',')[0] }).filter((wf) => !visible || visible.has(wf.id));
      return page(list, Number(q.limit ?? 100), q.cursor);
    });
    api.get('/workflows/:id', async (req) => workflow(req, (req.params as { id: string }).id, 'read'));
    api.post('/workflows', async (req) => {
      const { projectId, ...body } = normalizeWorkflow(req.body as { name: string; projectId?: string });
      const home = projectId || users.personalProject(req.user!.id).id;
      access.requireProject(req.user!, home, 'create');
      const wf = db.createWorkflow({ ...body, name: body.name });
      access.setOwner('workflow', wf.id, home);
      return wf;
    });
    api.put('/workflows/:id/transfer', async (req) => {
      const { id } = req.params as { id: string };
      workflow(req, id, 'move');
      const { destinationProjectId } = (req.body ?? {}) as { destinationProjectId?: string };
      if (!destinationProjectId) throw new HttpError(400, 'destinationProjectId is required');
      access.requireProject(req.user!, destinationProjectId, 'create');
      access.setOwner('workflow', id, destinationProjectId);
      return db.getWorkflow(id);
    });
    api.put('/workflows/:id', async (req) => {
      const { id } = req.params as { id: string };
      workflow(req, id, 'update');
      const { active: _a, id: _id, ...body } = normalizeWorkflow(req.body as Record<string, unknown>) as Record<string, unknown>;
      const wf = db.updateWorkflow(id, body);
      if (wf.active) await activeWorkflows.add(wf, 'update');
      return wf;
    });
    api.delete('/workflows/:id', async (req) => {
      const { id } = req.params as { id: string };
      const wf = workflow(req, id, 'delete');
      await ctx.deleteWorkflow(id);
      return wf;
    });
    api.post('/workflows/:id/activate', async (req) => {
      const { id } = req.params as { id: string };
      const wf = workflow(req, id, 'update');
      try {
        await activeWorkflows.add(wf);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return db.updateWorkflow(id, { active: true });
    });
    api.post('/workflows/:id/deactivate', async (req) => {
      const { id } = req.params as { id: string };
      workflow(req, id, 'update');
      await activeWorkflows.remove(id);
      return db.updateWorkflow(id, { active: false });
    });

    api.get('/executions', async (req) => {
      const q = req.query as { workflowId?: string; status?: string; limit?: string; cursor?: string; includeData?: string };
      const statusMap: Record<string, ExecutionStatus> = { success: 'success', error: 'error', waiting: 'waiting', canceled: 'canceled', running: 'running' };
      const limit = Number(q.limit ?? 100);
      const visible = access.visible('workflow', req.user!);
      const { results } = db.listExecutions({ workflowId: q.workflowId, workflowIds: visible && [...visible], status: q.status ? [statusMap[q.status]] : undefined, limit, lastId: q.cursor });
      const data = q.includeData === 'true' ? results.map((r) => db.getExecution(r.id)) : results;
      return { data, nextCursor: results.length === limit ? results.at(-1)!.id : null };
    });
    api.get('/executions/:id', async (req) => execution(req, (req.params as { id: string }).id, 'read'));
    api.delete('/executions/:id', async (req) => {
      const { id } = req.params as { id: string };
      const e = execution(req, id, 'execute');
      db.deleteExecutions([id]);
      return e;
    });

    api.get('/data-tables', async (req) => {
      const q = req.query as { limit?: string; cursor?: string; name?: string; projectId?: string };
      return page(visibleTables(access, req, ctx.dataTables.listTablesSync({ name: q.name }), q.projectId), Number(q.limit ?? 100), q.cursor);
    });
    api.post('/data-tables', async (req) => {
      const b = req.body as { name: string; columns?: Array<{ name: string; type: 'string' }>; projectId?: string };
      const projectId = b.projectId || users.personalProject(req.user!.id).id;
      access.requireProject(req.user!, projectId, 'create');
      const table = ctx.dataTables.createTableSync(b.name, b.columns ?? []);
      access.setItemProject('data_tables', table.id, projectId);
      return table;
    });
    api.get('/data-tables/:id', async (req) => ctx.dataTables.requireTable((req.params as { id: string }).id));
    api.delete('/data-tables/:id', async (req) => {
      await ctx.dataTables.deleteTable((req.params as { id: string }).id);
      return { success: true };
    });
    dataTableRowRoutes(api, ctx.dataTables, '/data-tables');

    api.get('/tags', async () => ({ data: db.listTags() }));
    api.get('/variables', async () => ({ data: db.listVariables() }));
    api.post('/credentials', async (req) => {
      const { name, type, data, projectId } = req.body as { name: string; type: string; data: Record<string, unknown>; projectId?: string };
      const home = projectId || users.personalProject(req.user!.id).id;
      access.requireProject(req.user!, home, 'create');
      const created = ctx.credentials.create(name, type, data as never);
      access.setOwner('credential', created.id, home);
      return created;
    });
    api.delete('/credentials/:id', async (req) => {
      const { id } = req.params as { id: string };
      access.requireCredential(req.user!, id, 'delete');
      ctx.credentials.delete(id);
      access.forget('credential', id);
      return { success: true };
    });
  }, { prefix: '/api/v1' });
}
