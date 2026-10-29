import type { FastifyInstance } from 'fastify';
import type { ExecutionStatus } from '@8n8/workflow';
import { normalizeWorkflow, type AppContext } from '../context';
import { HttpError } from './errors';

/**
 * Public REST API (/api/v1), authenticated with an API key in the X-N8N-API-KEY header.
 * Mirrors the shape of n8n's public API so existing scripts keep working.
 */
export async function publicApiRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, activeWorkflows } = ctx;

  await app.register(async (api) => {
    api.addHook('onRequest', async (req) => {
      const key = req.headers['x-n8n-api-key'] ?? req.headers['x-8n8-api-key'];
      if (!key || !db.findApiKey(String(key))) throw new HttpError(401, 'unauthorized');
    });

    const page = <T extends { id: string }>(items: T[], limit: number, cursor?: string) => {
      const start = cursor ? Number(Buffer.from(cursor, 'base64').toString()) : 0;
      const data = items.slice(start, start + limit);
      const next = start + limit < items.length ? Buffer.from(String(start + limit)).toString('base64') : null;
      return { data, nextCursor: next };
    };

    api.get('/workflows', async (req) => {
      const q = req.query as { active?: string; name?: string; tags?: string; limit?: string; cursor?: string };
      const list = db.listWorkflows({ active: q.active === undefined ? undefined : q.active === 'true', name: q.name, tag: q.tags?.split(',')[0] });
      return page(list, Number(q.limit ?? 100), q.cursor);
    });
    api.get('/workflows/:id', async (req) => {
      const wf = db.getWorkflow((req.params as { id: string }).id);
      if (!wf) throw new HttpError(404, 'Not Found');
      return wf;
    });
    api.post('/workflows', async (req) => {
      const body = normalizeWorkflow(req.body as { name: string });
      return db.createWorkflow({ ...body, name: body.name });
    });
    api.put('/workflows/:id', async (req) => {
      const { id } = req.params as { id: string };
      const { active: _a, id: _id, ...body } = normalizeWorkflow(req.body as Record<string, unknown>) as Record<string, unknown>;
      const wf = db.updateWorkflow(id, body);
      if (wf.active) await activeWorkflows.add(wf, 'update');
      return wf;
    });
    api.delete('/workflows/:id', async (req) => {
      const { id } = req.params as { id: string };
      const wf = db.getWorkflow(id);
      if (!wf) throw new HttpError(404, 'Not Found');
      await activeWorkflows.remove(id);
      db.deleteWorkflow(id);
      return wf;
    });
    api.post('/workflows/:id/activate', async (req) => {
      const { id } = req.params as { id: string };
      const wf = db.getWorkflow(id);
      if (!wf) throw new HttpError(404, 'Not Found');
      try {
        await activeWorkflows.add(wf);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return db.updateWorkflow(id, { active: true });
    });
    api.post('/workflows/:id/deactivate', async (req) => {
      const { id } = req.params as { id: string };
      await activeWorkflows.remove(id);
      return db.updateWorkflow(id, { active: false });
    });

    api.get('/executions', async (req) => {
      const q = req.query as { workflowId?: string; status?: string; limit?: string; cursor?: string; includeData?: string };
      const statusMap: Record<string, ExecutionStatus> = { success: 'success', error: 'error', waiting: 'waiting', canceled: 'canceled', running: 'running' };
      const limit = Number(q.limit ?? 100);
      const { results } = db.listExecutions({ workflowId: q.workflowId, status: q.status ? [statusMap[q.status]] : undefined, limit, lastId: q.cursor });
      const data = q.includeData === 'true' ? results.map((r) => db.getExecution(r.id)) : results;
      return { data, nextCursor: results.length === limit ? results.at(-1)!.id : null };
    });
    api.get('/executions/:id', async (req) => {
      const e = db.getExecution((req.params as { id: string }).id);
      if (!e) throw new HttpError(404, 'Not Found');
      return e;
    });
    api.delete('/executions/:id', async (req) => {
      const { id } = req.params as { id: string };
      const e = db.getExecution(id);
      if (!e) throw new HttpError(404, 'Not Found');
      db.deleteExecutions([id]);
      return e;
    });

    api.get('/tags', async () => ({ data: db.listTags() }));
    api.get('/variables', async () => ({ data: db.listVariables() }));
    api.post('/credentials', async (req) => {
      const { name, type, data } = req.body as { name: string; type: string; data: Record<string, unknown> };
      return ctx.credentials.create(name, type, data as never);
    });
    api.delete('/credentials/:id', async (req) => {
      ctx.credentials.delete((req.params as { id: string }).id);
      return { success: true };
    });
  }, { prefix: '/api/v1' });
}
