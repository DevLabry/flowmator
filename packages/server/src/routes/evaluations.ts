import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { HttpError } from './errors';

type Params = { id: string; runId: string };

/** Evaluations (test runs) of a workflow, as the editor's Evaluations tab uses them. */
export function evaluationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { evaluations, access } = ctx;
  const base = '/rest/workflows/:id/test-runs';

  // every route needs the workflow: reading for listing, executing for anything else
  app.addHook('preHandler', async (req: FastifyRequest) => {
    const url = req.routeOptions.url ?? '';
    if (!url.startsWith(base)) return;
    access.requireWorkflow(req.user!, (req.params as Params).id, req.method === 'GET' ? 'read' : 'execute');
  });

  const runOf = (p: Params) => {
    const run = evaluations.getRun(p.id, p.runId);
    if (!run) throw new HttpError(404, 'Test run not found');
    return run;
  };

  app.get(base, async (req) => ({ data: evaluations.listRuns((req.params as Params).id) }));
  app.post(`${base}/new`, async (req) => {
    const { run } = evaluations.startRun((req.params as Params).id);
    return { data: run };
  });
  app.get(`${base}/:runId`, async (req) => ({ data: runOf(req.params as Params) }));
  app.get(`${base}/:runId/test-cases`, async (req) => ({ data: evaluations.listCases(runOf(req.params as Params).id) }));
  app.post(`${base}/:runId/cancel`, async (req) => {
    const p = req.params as Params;
    return { data: await evaluations.cancelRun(p.id, p.runId) };
  });
  app.delete(`${base}/:runId`, async (req) => {
    const p = req.params as Params;
    evaluations.deleteRun(p.id, p.runId);
    return { data: { success: true } };
  });
}
