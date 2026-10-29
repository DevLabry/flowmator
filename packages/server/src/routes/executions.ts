import type { FastifyInstance } from 'fastify';
import type { ExecutionStatus } from '@8n8/workflow';
import type { AppContext } from '../context';
import { HttpError } from './errors';

export function executionRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, executions } = ctx;

  app.get('/rest/executions', async (req) => {
    const q = req.query as { workflowId?: string; status?: string; limit?: string; lastId?: string; filter?: string; startedAfter?: string; startedBefore?: string };
    const f = q.filter ? JSON.parse(q.filter) : {};
    const status = (q.status ?? f.status) as string | string[] | undefined;
    return {
      data: db.listExecutions({
        workflowId: q.workflowId ?? f.workflowId,
        status: status ? ((Array.isArray(status) ? status : status.split(',')) as ExecutionStatus[]) : undefined,
        limit: q.limit ? Number(q.limit) : 50,
        lastId: q.lastId,
        startedAfter: q.startedAfter ?? f.startedAfter,
        startedBefore: q.startedBefore ?? f.startedBefore,
      }),
    };
  });

  app.get('/rest/executions/active', async () => ({ data: executions.getRunning() }));

  app.get('/rest/executions/:id', async (req) => {
    const e = db.getExecution((req.params as { id: string }).id);
    if (!e) throw new HttpError(404, 'Execution not found');
    return { data: e };
  });

  app.delete('/rest/executions/:id', async (req) => {
    const { id } = req.params as { id: string };
    db.deleteExecutions([id]);
    await executions.binaryData.deleteForExecution(id);
    return { data: true };
  });

  app.post('/rest/executions/delete', async (req) => {
    const body = req.body as { ids?: string[]; deleteBefore?: string; filters?: { workflowId?: string } };
    let ids = body.ids ?? [];
    if (body.deleteBefore || (!ids.length && body.filters)) {
      ids = db
        .listExecutions({ workflowId: body.filters?.workflowId, startedBefore: body.deleteBefore, limit: 1_000_000 })
        .results.filter((e) => e.status !== 'running' && e.status !== 'waiting')
        .map((e) => e.id);
    }
    db.deleteExecutions(ids);
    for (const id of ids) await executions.binaryData.deleteForExecution(id);
    return { data: { deleted: ids.length } };
  });

  app.post('/rest/executions/:id/retry', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { loadWorkflow?: boolean };
    try {
      const run = await executions.retry(id, !!body.loadWorkflow);
      return { data: { status: run.status, finished: run.status === 'success' } };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  app.post('/rest/executions/:id/stop', async (req) => {
    try {
      return { data: await executions.stop((req.params as { id: string }).id) };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  app.post('/rest/executions/prune', async () => ({ data: { deleted: executions.prune() } }));
}
