import { createServer } from 'node:http';
import { createApp, createWebhookApp } from '../app';
import type { ConfigOverrides } from '../config';
import { createContext } from '../context';

/** Stops cleanly on Ctrl+C / SIGTERM; a second signal exits right away. */
function onShutdown(label: string, stop: () => Promise<void>) {
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      if (stopping) process.exit(1);
      stopping = true;
      console.log(`\nStopping ${label} (waiting for running executions)…`);
      await stop();
      process.exit(0);
    });
  }
}

/** `flowmator start`: editor, REST/public API, webhooks and triggers. */
export async function startMain(overrides: ConfigOverrides = {}) {
  const { start, stop, ctx } = await createApp(overrides);
  const url = await start();
  const active = ctx.activeWorkflows;
  const activeCount = ctx.db.listWorkflows({ active: true }).filter((w) => active.isActive(w.id)).length;
  const { redis } = ctx.config.queue;

  console.log(`Flowmator ready on ${url}`);
  console.log(`  data folder:  ${ctx.config.userFolder}`);
  console.log(`  webhook base: ${ctx.config.webhookUrl}${ctx.config.endpoints.webhook}/`);
  console.log(`  active workflows: ${activeCount}`);
  if (ctx.scaling) console.log(`  queue mode: executions run on workers (redis ${redis.host}:${redis.port})`);
  onShutdown('flowmator', stop);
}

/** `flowmator worker`: runs queued executions. Start as many as you like, on any machine sharing the data folder. */
export async function startWorker(opts: { concurrency: number }, overrides: ConfigOverrides = {}) {
  const ctx = createContext(overrides, 'worker');
  if (!ctx.scaling) throw new Error('Workers need queue mode: set EXECUTIONS_MODE=queue');
  const scaling = ctx.scaling;
  await ctx.executions.startWorker(opts.concurrency);

  // optional health endpoint for container orchestrators
  let health: ReturnType<typeof createServer> | undefined;
  const hc = ctx.config.queue.healthCheck;
  if (hc.active) {
    health = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/healthz') return res.end(JSON.stringify({ status: 'ok' }));
      if (req.url === '/healthz/readiness') {
        try {
          await scaling.ping();
          ctx.db.listVariables();
          return res.end(JSON.stringify({ status: 'ok' }));
        } catch (e) {
          res.statusCode = 503;
          return res.end(JSON.stringify({ status: 'error', message: (e as Error).message }));
        }
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ status: 'not found' }));
    }).listen(hc.port, process.env.N8N_LISTEN_ADDRESS ?? '0.0.0.0');
  }

  const { redis } = ctx.config.queue;
  console.log(`Flowmator worker ready (concurrency ${opts.concurrency}, redis ${redis.host}:${redis.port})`);
  console.log(`  data folder: ${ctx.config.userFolder}`);
  if (health) console.log(`  health check: http://localhost:${hc.port}/healthz`);

  const stop = async () => {
    // finish what's running (up to N8N_GRACEFUL_SHUTDOWN_TIMEOUT), then abort the rest
    // (aborted executions still report back, so the worker closes after they settle)
    const graceful = ctx.config.queue.gracefulShutdownSeconds;
    const aborting = setTimeout(() => ctx.executions.stopAll(), graceful * 1000);
    await scaling.close(graceful + 5);
    clearTimeout(aborting);
    health?.close();
    ctx.db.close();
  };
  onShutdown('flowmator worker', stop);
  return { ctx, stop };
}

/** `flowmator webhook`: production webhooks only, handing executions to the workers. */
export async function startWebhookProcess(overrides: ConfigOverrides = {}) {
  const { start, stop, ctx } = await createWebhookApp(overrides);
  const url = await start();
  console.log(`Flowmator webhook process ready on ${url}`);
  console.log(`  webhook base: ${ctx.config.webhookUrl}${ctx.config.endpoints.webhook}/`);
  console.log(`  production webhooks: ${ctx.webhooks.listProduction().length}`);
  onShutdown('flowmator webhook process', stop);
}
