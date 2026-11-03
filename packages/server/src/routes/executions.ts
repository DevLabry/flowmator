import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ExecutionStatus } from '@flowmator/workflow';
import type { AppContext } from '../context';
import { HttpError } from './errors';

export function executionRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, executions, access } = ctx;

  /** The workflows whose executions the user can see; undefined means all. */
  const visibleIds = (req: FastifyRequest) => {
    const set = access.visible('workflow', req.user!);
    return set && [...set];
  };
  /** The execution, when the user has `scope` on its workflow. */
  const allowed = (req: FastifyRequest, id: string, scope: 'read' | 'execute' | 'delete') => {
    const e = db.getExecution(id);
    if (!e) throw new HttpError(404, 'Execution not found');
    const user = req.user!;
    if (e.workflowId && db.getWorkflow(e.workflowId)) access.requireWorkflow(user, e.workflowId, scope === 'delete' ? 'execute' : scope);
    else access.requireAdmin(user);
    return e;
  };

  app.get('/rest/executions', async (req) => {
    const q = req.query as { workflowId?: string; status?: string; limit?: string; lastId?: string; filter?: string; startedAfter?: string; startedBefore?: string };
    const f = q.filter ? JSON.parse(q.filter) : {};
    const status = (q.status ?? f.status) as string | string[] | undefined;
    return {
      data: db.listExecutions({
        workflowId: q.workflowId ?? f.workflowId,
        workflowIds: visibleIds(req),
        status: status ? ((Array.isArray(status) ? status : status.split(',')) as ExecutionStatus[]) : undefined,
        limit: q.limit ? Number(q.limit) : 50,
        lastId: q.lastId,
        startedAfter: q.startedAfter ?? f.startedAfter,
        startedBefore: q.startedBefore ?? f.startedBefore,
      }),
    };
  });

  app.get('/rest/executions/active', async (req) => {
    const ids = visibleIds(req);
    return { data: executions.getRunning().filter((e) => !ids || ids.includes(e.workflowId as string)) };
  });

  app.get('/rest/executions/:id', async (req) => ({ data: allowed(req, (req.params as { id: string }).id, 'read') }));

  app.delete('/rest/executions/:id', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'delete');
    db.deleteExecutions([id]);
    await executions.binaryData.deleteForExecution(id);
    return { data: true };
  });

  app.post('/rest/executions/delete', async (req) => {
    const body = req.body as { ids?: string[]; deleteBefore?: string; filters?: { workflowId?: string } };
    let ids = body.ids ?? [];
    if (body.deleteBefore || (!ids.length && body.filters)) {
      ids = db
        .listExecutions({ workflowId: body.filters?.workflowId, workflowIds: visibleIds(req), startedBefore: body.deleteBefore, limit: 1_000_000 })
        .results.filter((e) => e.status !== 'running' && e.status !== 'waiting')
        .map((e) => e.id);
    }
    for (const id of ids) allowed(req, id, 'delete');
    db.deleteExecutions(ids);
    for (const id of ids) await executions.binaryData.deleteForExecution(id);
    return { data: { deleted: ids.length } };
  });

  app.post('/rest/executions/:id/retry', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { loadWorkflow?: boolean };
    allowed(req, id, 'execute');
    try {
      const run = await executions.retry(id, !!body.loadWorkflow);
      return { data: { status: run.status, finished: run.status === 'success' } };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  app.post('/rest/executions/:id/stop', async (req) => {
    allowed(req, (req.params as { id: string }).id, 'execute');
    try {
      return { data: await executions.stop((req.params as { id: string }).id) };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  app.post('/rest/executions/prune', async (req) => {
    access.requireAdmin(req.user!);
    return { data: { deleted: executions.prune() } };
  });
}
