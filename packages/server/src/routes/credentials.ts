import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IDataObject } from '@flowmator/workflow';
import type { AppContext } from '../context';
import { testCredential } from '../credentials';
import { HttpError } from './errors';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function credentialRoutes(app: FastifyInstance, ctx: AppContext) {
  const { credentials, credentialsHelper, credentialTypes, config } = ctx;

  app.get('/rest/credential-types', async () => ({ data: credentialTypes.getAll() }));

  app.get('/rest/credentials', async (req) => ({ data: credentials.list((req.query as { type?: string }).type) }));

  app.get('/rest/credentials/:id', async (req) => {
    const c = credentials.get((req.params as { id: string }).id, (req.query as { includeData?: string }).includeData === 'true');
    if (!c) throw new HttpError(404, 'Credential not found');
    return { data: c };
  });

  app.post('/rest/credentials', async (req) => {
    const { name, type, data } = req.body as { name: string; type: string; data: IDataObject };
    if (!name || !type) throw new HttpError(400, 'name and type are required');
    try {
      return { data: credentials.create(name, type, data ?? {}) };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  app.patch('/rest/credentials/:id', async (req) => {
    const body = req.body as { name?: string; data?: IDataObject };
    return { data: credentials.update((req.params as { id: string }).id, body) };
  });

  app.delete('/rest/credentials/:id', async (req) => {
    credentials.delete((req.params as { id: string }).id);
    return { data: true };
  });

  /** Test a credential before or after saving; with an id, redacted fields are filled from the stored value. */
  app.post('/rest/credentials/test', async (req) => {
    const { credentials: input } = req.body as { credentials: { id?: string; type: string; data: IDataObject } };
    let data = input.data ?? {};
    if (input.id) {
      const { __type, __name, ...stored } = credentials.getDecrypted(input.id);
      data = { ...stored, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== '__FLOWMATOR_REDACTED__')) };
    }
    return { data: await testCredential(credentials, credentialsHelper, input.type, data) };
  });

  /* ----- OAuth2 authorization code / PKCE ----- */
  const callbackUrl = `${config.webhookUrl}${config.endpoints.rest}/oauth2-credential/callback`;

  app.get('/rest/oauth2-credential/auth', async (req) => {
    const { id } = req.query as { id: string };
    const { __type, __name, ...data } = credentials.getDecrypted(id);
    if (!data.authUrl) throw new HttpError(400, 'The credential has no Authorization URL');
    const csrf = randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      client_id: String(data.clientId ?? ''),
      redirect_uri: callbackUrl,
      response_type: 'code',
      state: Buffer.from(JSON.stringify({ cid: id, token: csrf })).toString('base64url'),
    });
    if (data.scope) params.set('scope', String(data.scope));
    const stored: IDataObject = { ...data, csrfSecret: csrf };
    if (data.grantType === 'pkce') {
      const verifier = randomBytes(32).toString('base64url');
      stored.codeVerifier = verifier;
      params.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      params.set('code_challenge_method', 'S256');
    }
    credentials.saveData(id, stored);
    const extra = String(data.authQueryParameters ?? '');
    const url = `${data.authUrl}${String(data.authUrl).includes('?') ? '&' : '?'}${params.toString()}${extra ? `&${extra.replace(/^[?&]/, '')}` : ''}`;
    return { data: url };
  });

  app.get('/rest/oauth2-credential/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    const page = (title: string, msg: string, ok: boolean) =>
      reply
        .type('text/html')
        .send(`<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(msg)}</p>${ok ? '<script>window.opener&&window.opener.postMessage("flowmator-oauth-success","*");setTimeout(()=>window.close(),800)</script>' : ''}</body></html>`);
    if (q.error) return page('Authorization failed', q.error_description ?? q.error, false);
    try {
      const state = JSON.parse(Buffer.from(String(q.state), 'base64url').toString()) as { cid: string; token: string };
      const { __type, __name, ...data } = credentials.getDecrypted(state.cid);
      if (!data.csrfSecret || data.csrfSecret !== state.token) return page('Authorization failed', 'The state parameter does not match (CSRF check failed).', false);
      const token = await credentialsHelper.exchangeCode(data, String(q.code), callbackUrl, data.codeVerifier as string | undefined);
      const { csrfSecret: _c, codeVerifier: _v, ...rest } = data;
      credentials.saveData(state.cid, { ...rest, oauthTokenData: token });
      return page('Connection successful', 'You can close this window.', true);
    } catch (e) {
      return page('Authorization failed', (e as Error).message, false);
    }
  });
}
