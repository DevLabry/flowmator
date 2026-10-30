import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { ConfigOverrides } from './config';
import { createContext, type AppContext } from './context';
import { credentialRoutes } from './routes/credentials';
import { dataTableRoutes } from './routes/data-tables';
import { evaluationRoutes } from './routes/evaluations';
import { HttpError } from './routes/errors';
import { executionRoutes } from './routes/executions';
import { miscRoutes } from './routes/misc';
import { platformRoutes } from './routes/platform';
import { publicApiRoutes } from './routes/public-api';
import { webhookRoutes } from './routes/webhooks';
import { workflowRoutes } from './routes/workflows';

export interface App {
  app: FastifyInstance;
  ctx: AppContext;
  /** Activates workflows, starts the wait/prune timers and listens. Returns the bound URL. */
  start(): Promise<string>;
  stop(): Promise<void>;
}

/**
 * Optional HTTP basic auth for the editor and REST API (N8N_BASIC_AUTH_USER / N8N_BASIC_AUTH_PASSWORD).
 * Webhooks and the public API are never behind it (they have their own auth).
 */
function basicAuthHook(app: FastifyInstance) {
  const user = process.env.N8N_BASIC_AUTH_USER;
  const password = process.env.N8N_BASIC_AUTH_PASSWORD;
  if (!user || !password) return;
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/rest') && req.url !== '/' && !req.url.startsWith('/workflow')) return;
    if (req.url.startsWith('/rest/oauth2-credential/callback')) return;
    if (req.headers.authorization !== expected) {
      reply.header('WWW-Authenticate', 'Basic realm="8n8"').code(401).send({ message: 'Unauthorized' });
    }
  });
}

function errorHandler(error: Error, _req: unknown, reply: FastifyReply) {
  const status = error instanceof HttpError ? error.statusCode : ((error as { statusCode?: number }).statusCode ?? 500);
  if (status >= 500) console.error(error);
  reply.code(status).send({ code: status, message: error.message, ...(error instanceof HttpError && error.hint ? { hint: error.hint } : {}) });
}

/**
 * Queue mode webhook process: only production webhooks, forms and waiting-execution URLs.
 * Executions go to the workers; triggers, the editor and the API stay on main.
 */
export async function createWebhookApp(overrides: ConfigOverrides = {}): Promise<App> {
  const ctx = createContext(overrides, 'webhook');
  if (!ctx.scaling) throw new Error('The webhook process needs queue mode: set EXECUTIONS_MODE=queue');
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  await app.register(cors, { origin: true });
  app.setErrorHandler(errorHandler);
  app.get('/healthz', async () => ({ status: 'ok' }));
  await webhookRoutes(app, ctx);

  const load = (workflowId: string) => {
    const wf = ctx.db.getWorkflow(workflowId);
    try {
      if (wf) ctx.activeWorkflows.registerWebhooksOnly(wf);
      else ctx.webhooks.removeProductionForWorkflow(workflowId);
    } catch (e) {
      console.error(`Webhooks of workflow ${workflowId} not registered: ${(e as Error).message}`);
    }
  };

  let started = false;
  return {
    app,
    ctx,
    async start() {
      await ctx.executions.connectQueue();
      await ctx.scaling!.subscribe((m) => m.type === 'workflowChanged' && load(m.workflowId));
      for (const wf of ctx.db.listWorkflows({ active: true })) load(wf.id);
      const url = await app.listen({ port: ctx.config.port, host: process.env.N8N_LISTEN_ADDRESS ?? '0.0.0.0' });
      started = true;
      return url;
    },
    async stop() {
      if (started) await app.close();
      await ctx.scaling!.close();
      ctx.db.close();
    },
  };
}

export async function createApp(overrides: ConfigOverrides = {}): Promise<App> {
  const ctx = createContext(overrides);
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket);
  basicAuthHook(app);

  app.setErrorHandler(errorHandler);

  app.get('/rest/push', { websocket: true }, (socket, req) => {
    const pushRef = String((req.query as { pushRef?: string }).pushRef ?? Math.random().toString(36).slice(2));
    ctx.push.add(pushRef, socket);
  });

  workflowRoutes(app, ctx);
  executionRoutes(app, ctx);
  credentialRoutes(app, ctx);
  miscRoutes(app, ctx);
  dataTableRoutes(app, ctx);
  evaluationRoutes(app, ctx);
  platformRoutes(app, ctx);
  await webhookRoutes(app, ctx);
  await publicApiRoutes(app, ctx);

  // Built editor (pnpm --filter @8n8/editor build). In development, Vite serves it on :5173 instead.
  const editorDir = ctx.config.editorDistDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../editor/dist');
  if (existsSync(path.join(editorDir, 'index.html'))) {
    // wildcard: files are looked up per request, so a rebuilt editor is served without a restart
    await app.register(fastifyStatic, { root: editorDir, wildcard: true });
    // client-side routes fall back to index.html
    app.setNotFoundHandler((req, reply) => {
      const apiPath = /^\/(rest|api|webhook|webhook-test|webhook-waiting|form|form-test|form-waiting|healthz)(\/|$)/.test(req.url);
      if (req.method === 'GET' && !apiPath) return reply.sendFile('index.html');
      return reply.code(404).send({ code: 404, message: 'Not found' });
    });
  }

  let started = false;
  let pruneTimer: NodeJS.Timeout | undefined;
  return {
    app,
    ctx,
    async start() {
      // secrets first: active workflows' credentials may reference them
      await ctx.externalSecrets.start();
      await ctx.executions.start();
      await ctx.activeWorkflows.init();
      ctx.insights.prune();
      pruneTimer = setInterval(() => ctx.insights.prune(), 3_600_000);
      pruneTimer.unref();
      const url = await app.listen({ port: ctx.config.port, host: process.env.N8N_LISTEN_ADDRESS ?? '0.0.0.0' });
      started = true;
      return url;
    },
    async stop() {
      await ctx.activeWorkflows.shutdown();
      await ctx.evaluations.stopAll();
      await ctx.executions.stopAll();
      ctx.externalSecrets.stop();
      clearInterval(pruneTimer);
      await ctx.logStreaming.flush();
      await ctx.scaling?.close();
      ctx.push.closeAll();
      if (started) await app.close();
      ctx.db.close();
    },
  };
}
