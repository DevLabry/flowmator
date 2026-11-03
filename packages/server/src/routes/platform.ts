import type { FastifyInstance } from 'fastify';
import type { IDataObject } from '@flowmator/workflow';
import type { AppContext } from '../context';
import { EVENT_NAMES } from '../events';
import { SECRET_PROVIDERS } from '../external-secrets';
import type { Destination } from '../log-streaming';
import { SourceControlError } from '../source-control';
import { HttpError } from './errors';

/** Template library API base URL; templates are off until it is set. */
const templatesHost = () => process.env.FLOWMATOR_TEMPLATES_HOST?.replace(/\/?$/, '/');

/** Audit events derived from the REST calls that change things (n8n.audit.*). */
const AUDIT: Array<[string, RegExp, string]> = [
  ['POST', /^\/rest\/workflows(\/import)?$/, 'n8n.audit.workflow.created'],
  ['PATCH', /^\/rest\/workflows\/[^/]+$/, 'n8n.audit.workflow.updated'],
  ['DELETE', /^\/rest\/workflows\/[^/]+$/, 'n8n.audit.workflow.deleted'],
  ['POST', /^\/rest\/workflows\/[^/]+\/activate$/, 'n8n.audit.workflow.activated'],
  ['POST', /^\/rest\/workflows\/[^/]+\/deactivate$/, 'n8n.audit.workflow.deactivated'],
  ['POST', /^\/rest\/credentials$/, 'n8n.audit.user.credentials.created'],
  ['PATCH', /^\/rest\/credentials\/[^/]+$/, 'n8n.audit.user.credentials.updated'],
  ['DELETE', /^\/rest\/credentials\/[^/]+$/, 'n8n.audit.user.credentials.deleted'],
  ['POST', /^\/rest\/variables$/, 'n8n.audit.variable.created'],
  ['PATCH', /^\/rest\/variables\/[^/]+$/, 'n8n.audit.variable.updated'],
  ['DELETE', /^\/rest\/variables\/[^/]+$/, 'n8n.audit.variable.deleted'],
];

function sourceControlError(e: unknown): never {
  if (e instanceof SourceControlError) {
    const err = new HttpError(e.statusCode, e.message) as HttpError & { details?: unknown };
    throw err;
  }
  throw new HttpError(400, (e as Error).message);
}

export function platformRoutes(app: FastifyInstance, ctx: AppContext) {
  const { events, insights, logStreaming, externalSecrets, sourceControl, communityPackages, access } = ctx;

  // instance settings are for owners and admins; members may only read what the editor needs
  const ADMIN_ONLY = /^\/rest\/(eventbus|insights|external-secrets|source-control|community-packages)(\/|$)/;
  const MEMBER_READS = new Set(['/rest/external-secrets/secrets', '/rest/source-control/preferences', '/rest/community-packages']);
  app.addHook('preHandler', async (req) => {
    const url = req.routeOptions.url ?? '';
    if (!ADMIN_ONLY.test(url) || (req.method === 'GET' && MEMBER_READS.has(url))) return;
    access.requireAdmin(req.user!);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode >= 400) return payload;
    const path = req.url.split('?')[0];
    const match = AUDIT.find(([method, re]) => method === req.method && re.test(path));
    if (!match) return payload;
    let data: IDataObject = {};
    try {
      const parsed = JSON.parse(String(payload)).data;
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first && typeof first === 'object') data = { id: first.id, name: first.name ?? first.key };
    } catch {}
    const id = data.id ?? path.split('/')[3];
    const kind = match[2].split('.')[2] === 'user' ? 'credentialId' : match[2].includes('variable') ? 'variableId' : 'workflowId';
    const user = req.user ? { userId: req.user.id, userEmail: req.user.email } : {};
    events.emit(match[2], { [kind]: id, ...(data.name ? { [kind.replace('Id', 'Name')]: data.name } : {}), ...user });
    return payload;
  });

  /* ---------------- log streaming (/rest/eventbus) ---------------- */

  app.get('/rest/eventbus/eventnames', async () => ({ data: EVENT_NAMES }));
  app.get('/rest/eventbus/destination', async () => ({
    data: logStreaming.list().map((d) => ({ ...d, lastError: logStreaming.errors.get(d.id) ?? null })),
  }));
  app.post('/rest/eventbus/destination', async (req) => {
    try {
      return { data: logStreaming.save(req.body as Destination) };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });
  app.delete('/rest/eventbus/destination', async (req) => {
    logStreaming.delete(String((req.query as { id?: string }).id));
    return { data: true };
  });
  app.get('/rest/eventbus/testmessage', async (req) => ({ data: await logStreaming.test(String((req.query as { id?: string }).id)) }));

  /* ---------------- insights ---------------- */

  const days = (q: unknown) => Math.min(Math.max(Number((q as { days?: string }).days ?? 7) || 7, 1), 365);
  app.get('/rest/insights/summary', async (req) => ({ data: insights.summary(days(req.query)) }));
  app.get('/rest/insights/by-workflow', async (req) => ({ data: insights.byWorkflow(days(req.query), (req.query as { sortBy?: string }).sortBy) }));
  app.get('/rest/insights/by-time', async (req) => ({ data: insights.byTime(days(req.query)) }));

  /* ---------------- external secrets ---------------- */

  app.get('/rest/external-secrets/providers', async () => ({ data: externalSecrets.list() }));
  app.get('/rest/external-secrets/secrets', async () => ({
    data: Object.fromEntries(Object.entries(externalSecrets.secrets()).map(([p, s]) => [p, Object.keys(s as object)])),
  }));
  app.post('/rest/external-secrets/providers/:name', async (req) => {
    const { name } = req.params as { name: string };
    externalSecrets.saveSettings(name, req.body as IDataObject);
    return { data: externalSecrets.list().find((p) => p.name === name) };
  });
  app.post('/rest/external-secrets/providers/:name/test', async (req) => {
    const { name } = req.params as { name: string };
    if (!SECRET_PROVIDERS.some((p) => p.name === name)) throw new HttpError(404, `Unknown provider ${name}`);
    return { data: await externalSecrets.test(name, req.body as IDataObject | undefined) };
  });
  app.post('/rest/external-secrets/providers/:name/connect', async (req) => {
    const { name } = req.params as { name: string };
    await externalSecrets.setConnected(name, (req.body as { connected?: boolean })?.connected !== false);
    return { data: externalSecrets.list().find((p) => p.name === name) };
  });
  app.post('/rest/external-secrets/providers/:name/update', async (req) => {
    const { name } = req.params as { name: string };
    await externalSecrets.refreshProvider(name);
    return { data: externalSecrets.list().find((p) => p.name === name) };
  });

  /* ---------------- source control ---------------- */

  const sc = async <T>(fn: () => Promise<T> | T) => {
    try {
      return { data: await fn() };
    } catch (e) {
      if (e instanceof SourceControlError && e.details) {
        // conflicts go back with their files so the editor can list them
        throw Object.assign(new HttpError(e.statusCode, e.message), { hint: JSON.stringify(e.details) });
      }
      return sourceControlError(e);
    }
  };
  app.get('/rest/source-control/preferences', async () => ({ data: sourceControl.publicPreferences() }));
  app.post('/rest/source-control/preferences', async (req) => sc(() => sourceControl.setPreferences(req.body as IDataObject)));
  app.patch('/rest/source-control/preferences', async (req) => sc(() => sourceControl.setPreferences(req.body as IDataObject)));
  app.post('/rest/source-control/generate-key-pair', async (req) => sc(() => sourceControl.generateKeyPair((req.body as { keyGeneratorType?: 'ed25519' | 'rsa' })?.keyGeneratorType)));
  app.get('/rest/source-control/get-branches', async () => sc(() => sourceControl.branches()));
  app.get('/rest/source-control/get-status', async () => sc(() => sourceControl.status()));
  app.get('/rest/source-control/diff', async (req) => sc(() => sourceControl.diff(String((req.query as { file?: string }).file))));
  app.post('/rest/source-control/push-workfolder', async (req) => sc(() => sourceControl.push(req.body as { commitMessage?: string; fileNames?: string[]; force?: boolean })));
  // pulled workflows and credentials nobody owns yet go to the owner
  app.post('/rest/source-control/pull-workfolder', async (req) => sc(() => sourceControl.pull(req.body as { force?: boolean }).finally(() => access.claimOrphans())));
  app.post('/rest/source-control/disconnect', async () => sc(() => sourceControl.disconnect().then(() => sourceControl.publicPreferences())));

  /* ---------------- community packages ---------------- */

  app.get('/rest/community-packages', async () => ({ data: communityPackages.list() }));
  app.post('/rest/community-packages/check-updates', async () => ({ data: await communityPackages.checkUpdates() }));
  app.post('/rest/community-packages', async (req) => {
    const { name, version } = req.body as { name: string; version?: string };
    if (!name) throw new HttpError(400, 'Package name is required');
    try {
      return { data: await communityPackages.install(name.trim(), version) };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });
  app.patch('/rest/community-packages', async (req) => {
    const { name, version } = req.body as { name: string; version?: string };
    try {
      return { data: await communityPackages.update(name, version) };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });
  app.delete('/rest/community-packages', async (req) => {
    try {
      await communityPackages.uninstall(String((req.query as { name?: string }).name));
      return { data: true };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  /* ---------------- templates (proxied to the template library at FLOWMATOR_TEMPLATES_HOST) ---------------- */

  const templates = async (path: string, query: Record<string, string> = {}) => {
    const host = templatesHost();
    if (!host) throw new HttpError(404, 'No template library is set up. Set FLOWMATOR_TEMPLATES_HOST to use templates.');
    const url = new URL(path, host);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch((e: Error) => {
      throw new HttpError(502, `Template library unreachable: ${e.message}`);
    });
    if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `Template library returned ${res.status}`);
    return res.json();
  };
  app.get('/rest/templates/categories', async () => templates('templates/categories'));
  app.get('/rest/templates/collections', async (req) => templates('templates/collections', req.query as Record<string, string>));
  app.get('/rest/templates/collections/:id', async (req) => templates(`templates/collections/${encodeURIComponent((req.params as { id: string }).id)}`));
  app.get('/rest/templates/search', async (req) => templates('templates/search', req.query as Record<string, string>));
  app.get('/rest/templates/workflows/:id', async (req) => templates(`templates/workflows/${encodeURIComponent((req.params as { id: string }).id)}`));
  /** The importable workflow (nodes + connections) of a template. */
  app.get('/rest/templates/workflows/:id/workflow', async (req) => templates(`workflows/templates/${encodeURIComponent((req.params as { id: string }).id)}`));
}
