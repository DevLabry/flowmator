import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IDataObject } from '@flowmator/workflow';
import type { CredentialScope } from '../access';
import type { AppContext } from '../context';
import { testCredential } from '../credentials';
import { HttpError } from './errors';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function credentialRoutes(app: FastifyInstance, ctx: AppContext) {
  const { credentials, credentialsHelper, credentialTypes, config, access, users } = ctx;
  const userOf = (req: FastifyRequest) => req.user!;

  /** Adds the home project, the projects it is shared with and the user's scopes. */
  const view = <T extends { id: string }>(c: T, req: FastifyRequest, lookups?: { homes: Map<string, string>; shares: Map<string, string[]> }) => {
    const homeId = lookups ? lookups.homes.get(c.id) : access.homeProject('credential', c.id)?.id;
    const shared = lookups ? (lookups.shares.get(c.id) ?? []) : access.sharedWith('credential', c.id).map((p) => p.id);
    const project = (id: string | undefined) => {
      const p = id ? users.getProject(id) : null;
      return p ? { id: p.id, name: p.name, type: p.type, icon: p.icon } : null;
    };
    return { ...c, homeProject: project(homeId), sharedWithProjects: shared.map(project).filter(Boolean), scopes: access.credentialScopes(userOf(req), c.id) };
  };
  const allowed = (req: FastifyRequest, id: string, scope: CredentialScope) => {
    if (!credentials.get(id)) throw new HttpError(404, 'Credential not found');
    access.requireCredential(userOf(req), id, scope);
  };

  app.get('/rest/credential-types', async () => ({ data: credentialTypes.getAll() }));

  /**
   * Credentials the user can see. With `projectId`, those a workflow of that project can use
   * (owned by or shared with it), as the node credential picker needs.
   */
  app.get('/rest/credentials', async (req) => {
    const q = req.query as { type?: string; projectId?: string; filter?: string };
    const projectId = q.projectId ?? (q.filter ? (JSON.parse(q.filter) as { projectId?: string }).projectId : undefined);
    if (projectId) access.requireProject(userOf(req), projectId, 'read');
    const visible = access.visible('credential', userOf(req), projectId);
    const lookups = { homes: access.homeProjects('credential'), shares: access.sharesOf('credential') };
    return { data: credentials.list(q.type).filter((c) => !visible || visible.has(c.id)).map((c) => view(c, req, lookups)) };
  });

  app.get('/rest/credentials/:id', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'read');
    // only those who may edit it see the (redacted) data
    const includeData = (req.query as { includeData?: string }).includeData === 'true' && access.credentialScopes(userOf(req), id).includes('update');
    return { data: view(credentials.get(id, includeData)!, req) };
  });

  app.post('/rest/credentials', async (req) => {
    const { name, type, data, projectId } = req.body as { name: string; type: string; data: IDataObject; projectId?: string };
    if (!name || !type) throw new HttpError(400, 'name and type are required');
    const home = projectId || users.personalProject(userOf(req).id).id;
    access.requireProject(userOf(req), home, 'create');
    let created;
    try {
      created = credentials.create(name, type, data ?? {});
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    access.setOwner('credential', created.id, home);
    return { data: view(created, req) };
  });

  app.patch('/rest/credentials/:id', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'update');
    const body = req.body as { name?: string; data?: IDataObject };
    return { data: view(credentials.update(id, body), req) };
  });

  app.delete('/rest/credentials/:id', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'delete');
    credentials.delete(id);
    access.forget('credential', id);
    return { data: true };
  });

  /** Shares the credential with these projects (their workflows may use it), replacing the previous shares. */
  app.put('/rest/credentials/:id/share', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'share');
    const { shareWithIds = [] } = (req.body ?? {}) as { shareWithIds?: string[] };
    access.share('credential', id, shareWithIds);
    return { data: view(credentials.get(id)!, req) };
  });

  app.put('/rest/credentials/:id/transfer', async (req) => {
    const { id } = req.params as { id: string };
    allowed(req, id, 'move');
    const { destinationProjectId } = (req.body ?? {}) as { destinationProjectId?: string };
    if (!destinationProjectId) throw new HttpError(400, 'destinationProjectId is required');
    access.requireProject(userOf(req), destinationProjectId, 'create');
    access.setOwner('credential', id, destinationProjectId);
    return { data: view(credentials.get(id)!, req) };
  });

  /** Test a credential before or after saving; with an id, redacted fields are filled from the stored value. */
  app.post('/rest/credentials/test', async (req) => {
    const { credentials: input } = req.body as { credentials: { id?: string; type: string; data: IDataObject } };
    let data = input.data ?? {};
    if (input.id) {
      allowed(req, input.id, 'update');
      const { __type, __name, ...stored } = credentials.getDecrypted(input.id);
      data = { ...stored, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== '__FLOWMATOR_REDACTED__')) };
    }
    return { data: await testCredential(credentials, credentialsHelper, input.type, data) };
  });

  /* ----- OAuth2 authorization code / PKCE ----- */
  const callbackUrl = `${config.webhookUrl}${config.endpoints.rest}/oauth2-credential/callback`;

  app.get('/rest/oauth2-credential/auth', async (req) => {
    const { id } = req.query as { id: string };
    allowed(req, id, 'update');
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
