import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config';
import { createContext, type AppContext } from './context';
import { credentialRoutes } from './routes/credentials';
import { HttpError } from './routes/errors';
import { executionRoutes } from './routes/executions';
import { miscRoutes } from './routes/misc';
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

export async function createApp(overrides: Partial<ServerConfig> = {}): Promise<App> {
  const ctx = createContext(overrides);
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket);
  basicAuthHook(app);

  app.setErrorHandler((error: Error, _req, reply) => {
    const status = error instanceof HttpError ? error.statusCode : ((error as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) console.error(error);
    reply.code(status).send({ code: status, message: error.message, ...(error instanceof HttpError && error.hint ? { hint: error.hint } : {}) });
  });

  app.get('/rest/push', { websocket: true }, (socket, req) => {
    const pushRef = String((req.query as { pushRef?: string }).pushRef ?? Math.random().toString(36).slice(2));
    ctx.push.add(pushRef, socket);
  });

  workflowRoutes(app, ctx);
  executionRoutes(app, ctx);
  credentialRoutes(app, ctx);
  miscRoutes(app, ctx);
  await webhookRoutes(app, ctx);
  await publicApiRoutes(app, ctx);

  // Built editor (pnpm --filter @8n8/editor build). In development, Vite serves it on :5173 instead.
  const editorDir = ctx.config.editorDistDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../editor/dist');
  if (existsSync(path.join(editorDir, 'index.html'))) {
    // wildcard: files are looked up per request, so a rebuilt editor is served without a restart
    await app.register(fastifyStatic, { root: editorDir, wildcard: true });
    // client-side routes fall back to index.html
    app.setNotFoundHandler((req, reply) => {
      const apiPath = /^\/(rest|api|webhook|webhook-test|webhook-waiting|healthz)(\/|$)/.test(req.url);
      if (req.method === 'GET' && !apiPath) return reply.sendFile('index.html');
      return reply.code(404).send({ code: 404, message: 'Not found' });
    });
  }

  let started = false;
  return {
    app,
    ctx,
    async start() {
      ctx.executions.start();
      await ctx.activeWorkflows.init();
      const url = await app.listen({ port: ctx.config.port, host: process.env.N8N_LISTEN_ADDRESS ?? '0.0.0.0' });
      started = true;
      return url;
    },
    async stop() {
      await ctx.activeWorkflows.shutdown();
      await ctx.executions.stopAll();
      ctx.push.closeAll();
      if (started) await app.close();
      ctx.db.close();
    },
  };
}
