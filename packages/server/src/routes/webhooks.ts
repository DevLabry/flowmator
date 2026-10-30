import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IDataObject, IWebhookRequest, IWebhookResponse } from '@flowmator/workflow';
import type { AppContext } from '../context';
import { WebhookError } from '../webhooks';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** Parses the raw body by content type; uploaded files become `files`. */
async function toWebhookRequest(req: FastifyRequest, path: string): Promise<IWebhookRequest> {
  const raw = Buffer.isBuffer(req.body) ? req.body : undefined;
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  let body: unknown = {};
  let files: IWebhookRequest['files'];

  if (raw?.length) {
    if (contentType.includes('json')) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = raw.toString('utf8');
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      const out: IDataObject = {};
      for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) {
        out[k] = out[k] === undefined ? v : ([] as unknown[]).concat(out[k], v) as never;
      }
      body = out;
    } else if (contentType.includes('multipart/form-data')) {
      // undici's Response can parse multipart bodies
      const form = await new Response(new Uint8Array(raw), { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
      const fields: IDataObject = {};
      files = [];
      for (const [key, value] of form.entries()) {
        // repeated keys (checkboxes, multi-selects) become arrays
        if (typeof value === 'string') fields[key] = fields[key] === undefined ? value : ([] as unknown[]).concat(fields[key], value) as never;
        else files.push({ fieldName: key, fileName: value.name, mimeType: value.type || 'application/octet-stream', data: Buffer.from(await value.arrayBuffer()) });
      }
      body = fields;
    } else if (contentType.startsWith('text/') || contentType.includes('xml')) {
      body = raw.toString('utf8');
    } else {
      body = {};
    }
  }

  return {
    method: req.method,
    path,
    headers: req.headers,
    query: req.query as IDataObject,
    params: {},
    body,
    rawBody: raw,
    files,
    ip: req.ip,
  };
}

function send(reply: FastifyReply, res: IWebhookResponse) {
  reply.code(res.statusCode ?? 200);
  for (const [k, v] of Object.entries(res.headers ?? {})) reply.header(k, v);
  if (res.body === undefined || res.body === null) return reply.send();
  if (Buffer.isBuffer(res.body) || typeof res.body === 'string') return reply.send(res.body);
  return reply.type(res.headers?.['content-type'] ?? 'application/json').send(JSON.stringify(res.body));
}

export async function webhookRoutes(app: FastifyInstance, ctx: AppContext) {
  const { webhooks, config } = ctx;

  // Encapsulated plugin: webhook bodies arrive raw so the node sees exactly what was sent.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    const handle = (kind: 'production' | 'test' | 'waiting') => async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { '*': string; executionId?: string };
      const path = params['*'] ?? '';
      if (req.method === 'OPTIONS') {
        // CORS preflight
        reply.header('access-control-allow-origin', String(req.headers.origin ?? '*'));
        reply.header('access-control-allow-methods', METHODS.join(', '));
        reply.header('access-control-allow-headers', String(req.headers['access-control-request-headers'] ?? '*'));
        return reply.code(204).send();
      }
      try {
        const request = await toWebhookRequest(req, path);
        const res =
          kind === 'production' ? await webhooks.handleProduction(req.method, path, request)
          : kind === 'test' ? await webhooks.handleTest(req.method, path, request)
          : await webhooks.handleWaiting(params.executionId!, req.method, request);
        reply.header('access-control-allow-origin', '*');
        return send(reply, res);
      } catch (e) {
        const status = e instanceof WebhookError ? e.statusCode : 500;
        return reply.code(status).send({ code: status, message: (e as Error).message, ...(e instanceof WebhookError && e.hint ? { hint: e.hint } : {}) });
      }
    };

    scope.route({ method: [...METHODS], url: `/${config.endpoints.webhook}/*`, handler: handle('production') });
    scope.route({ method: [...METHODS], url: `/${config.endpoints.webhookTest}/*`, handler: handle('test') });
    scope.route({ method: [...METHODS], url: `/${config.endpoints.webhookWaiting}/:executionId`, handler: handle('waiting') });
    scope.route({ method: [...METHODS], url: `/${config.endpoints.webhookWaiting}/:executionId/*`, handler: handle('waiting') });
    // forms share the webhook registry; only the URL prefix differs
    scope.route({ method: [...METHODS], url: `/${config.endpoints.form}/*`, handler: handle('production') });
    scope.route({ method: [...METHODS], url: `/${config.endpoints.formTest}/*`, handler: handle('test') });
    scope.route({ method: [...METHODS], url: `/${config.endpoints.formWaiting}/:executionId`, handler: handle('waiting') });
  });
}
