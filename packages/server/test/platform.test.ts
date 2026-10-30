import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src';
import { CommunityPackagesService } from '../src/community-packages';
import { sentryEndpoint, syslogMessage } from '../src/log-streaming';

let app: App;
let dir: string;
const servers: Server[] = [];

/** A local HTTP server; handler returns [status, body]. */
async function serve(handler: (req: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }) => [number, unknown]) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const [status, out] = handler({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.writeHead(status, { 'content-type': 'application/json' }).end(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flowmator-platform-'));
  app = await createApp({ userFolder: dir, port: 0, webhookUrl: 'http://localhost:5678/', encryptionKey: 'test-key' });
  await app.ctx.executions.start();
});

afterAll(async () => {
  await app.stop();
  for (const s of servers) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const api = async (method: string, url: string, payload?: unknown) => {
  const res = await app.app.inject({ method: method as 'GET', url, payload: payload as never });
  let body: any = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {}
  return { status: res.statusCode, body };
};

let n = 0;
const node = (name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id: `n${++n}`, name, type: type.includes('.') ? type : `flowmator.${type}`, typeVersion: 1, position: [0, 0], parameters });
const chain = (...names: string[]) => Object.fromEntries(names.slice(0, -1).map((name, i) => [name, { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] }]));

async function waitFor<T>(fn: () => T | undefined | false, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

describe('event bus and log streaming', () => {
  it('formats syslog lines and Sentry endpoints', () => {
    const line = syslogMessage({ facility: 16, app_name: 'flowmator' }, { __type: '$$EventMessageWorkflow', id: 'e1', ts: '2026-10-29T10:00:00.000Z', eventName: 'n8n.workflow.failed', message: '', payload: { workflowId: 'w1' } });
    expect(line).toMatch(/^<131>1 2026-10-29T10:00:00.000Z \S+ flowmator \d+ n8n\.workflow\.failed - \{"workflowId":"w1"/);
    expect(sentryEndpoint('https://abc123@o1.ingest.sentry.io/42')).toMatchObject({ url: 'https://o1.ingest.sentry.io/api/42/envelope/', auth: expect.stringContaining('sentry_key=abc123') });
  });

  it('streams workflow, node and audit events to a webhook destination', async () => {
    const received: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
    const url = await serve((req) => {
      received.push(JSON.parse(req.body));
      return [200, {}];
    });
    const dest = (await api('POST', '/rest/eventbus/destination', { type: '$$MessageEventBusDestinationWebhook', label: 'hook', url, subscribedEvents: ['n8n.workflow', 'n8n.audit.workflow.created', 'n8n.node.finished'] })).body.data;
    expect(dest.id).toBeTruthy();

    const wf = (await api('POST', '/rest/workflows', { name: 'Streamed', nodes: [node('Start', 'manualTrigger'), node('Set', 'set', { assignments: { assignments: [{ id: 'a', name: 'x', value: 1, type: 'number' }] } })], connections: chain('Start', 'Set') })).body.data;
    await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {});
    await app.ctx.logStreaming.flush();

    const names = received.map((e) => e.eventName);
    expect(names).toContain('n8n.audit.workflow.created');
    expect(names).toContain('n8n.workflow.started');
    expect(names).toContain('n8n.workflow.success');
    expect(names.filter((x) => x === 'n8n.node.finished')).toHaveLength(2);
    expect(names).not.toContain('n8n.node.started');
    expect(received.find((e) => e.eventName === 'n8n.audit.workflow.created')!.payload).toMatchObject({ workflowId: wf.id, workflowName: 'Streamed' });
    expect(received.find((e) => e.eventName === 'n8n.workflow.success')!.payload).toMatchObject({ workflowId: wf.id, mode: 'manual', status: 'success' });

    expect((await api('GET', `/rest/eventbus/testmessage?id=${dest.id}`)).body.data).toBe(true);
    expect(received.at(-1)!.eventName).toBe('n8n.destination.test');
    await api('DELETE', `/rest/eventbus/destination?id=${dest.id}`);
    expect((await api('GET', '/rest/eventbus/destination')).body.data).toHaveLength(0);
  });

  it('sends syslog over UDP and reports delivery errors', async () => {
    const socket = createSocket('udp4');
    const lines: string[] = [];
    socket.on('message', (m) => lines.push(m.toString()));
    await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
    const d = app.ctx.logStreaming.save({ type: '$$MessageEventBusDestinationSyslog', host: '127.0.0.1', port: socket.address().port, subscribedEvents: ['n8n.audit'] });
    app.ctx.events.emit('n8n.audit.variable.created', { variableId: 'v1' });
    await app.ctx.logStreaming.flush();
    await waitFor(() => lines.length > 0);
    expect(lines[0]).toContain('n8n.audit.variable.created');
    socket.close();
    app.ctx.logStreaming.delete(d.id);

    const bad = app.ctx.logStreaming.save({ type: '$$MessageEventBusDestinationWebhook', url: 'http://127.0.0.1:1/', subscribedEvents: ['*'] });
    app.ctx.events.emit('n8n.audit.variable.deleted', {});
    await app.ctx.logStreaming.flush();
    expect(app.ctx.logStreaming.errors.get(bad.id)?.message).toBeTruthy();
    app.ctx.logStreaming.delete(bad.id);
  });
});

describe('insights', () => {
  it('counts production executions only, with time saved and failure rate', async () => {
    const before = (await api('GET', '/rest/insights/summary?days=7')).body.data.total.value;
    const wf = (await api('POST', '/rest/workflows', { name: 'Counted', settings: { timeSavedPerExecution: 5 }, nodes: [node('Start', 'manualTrigger')], connections: {} })).body.data;
    const emit = (status: string, mode: string, runtimeMs: number) =>
      app.ctx.events.emit(`n8n.workflow.${status}`, { workflowId: wf.id, workflowName: wf.name, mode, runtimeMs, timeSavedPerExecution: 5 });
    emit('success', 'trigger', 100);
    emit('success', 'webhook', 300);
    emit('failed', 'trigger', 200);
    emit('success', 'manual', 999); // not counted
    const s = (await api('GET', '/rest/insights/summary?days=7')).body.data;
    expect(s.total.value - before).toBe(3);
    const row = (await api('GET', '/rest/insights/by-workflow?days=7')).body.data.find((r: { workflowId: string }) => r.workflowId === wf.id);
    expect(row).toMatchObject({ total: 3, succeeded: 2, failed: 1, timeSaved: 10, averageRunTime: 200 });
    expect(row.failureRate).toBeCloseTo(1 / 3);
    const days = (await api('GET', '/rest/insights/by-time?days=7')).body.data;
    expect(days).toHaveLength(7);
    expect(days.at(-1).total).toBeGreaterThanOrEqual(3);

    // deviation against the previous period
    const now = Date.now();
    app.ctx.insights.record({ workflowId: 'old', workflowName: 'old', status: 'success', runtimeMs: 10, timeSavedMin: 0, timestamp: new Date(now - 10 * 86_400_000).toISOString() });
    expect((await api('GET', '/rest/insights/summary?days=7')).body.data.total.deviation).not.toBeNull();
  });

  it('records the real executions a trigger starts', async () => {
    const wf = (await api('POST', '/rest/workflows', { name: 'Hooked', nodes: [node('Hook', 'webhook', { path: 'insights-hook', httpMethod: 'GET', responseMode: 'onReceived' })], connections: {}, active: true })).body.data;
    const res = await app.app.inject({ method: 'GET', url: '/webhook/insights-hook' });
    expect(res.statusCode).toBe(200);
    await waitFor(() => (app.ctx.insights.byWorkflow(1) as Array<{ workflowId: string }>).find((r) => r.workflowId === wf.id));
  });
});

describe('external secrets', () => {
  it('reads a Vault KV v2 store and resolves $secrets in credentials', async () => {
    const vault = await serve((req) => {
      if (req.headers['x-vault-token'] !== 's.root') return [403, { errors: ['permission denied'] }];
      if (req.url === '/v1/secret/metadata/?list=true') return [200, { data: { keys: ['db', 'team/'] } }];
      if (req.url === '/v1/secret/metadata/team/?list=true') return [200, { data: { keys: ['api'] } }];
      if (req.url === '/v1/secret/data/db') return [200, { data: { data: { password: 'hunter2', user: 'app' } } }];
      if (req.url === '/v1/secret/data/team/api') return [200, { data: { data: { key: 'k-123' } } }];
      return [404, {}];
    });
    await api('POST', '/rest/external-secrets/providers/vault', { url: vault, token: 'wrong' });
    expect((await api('POST', '/rest/external-secrets/providers/vault/test', {})).body.data).toMatchObject({ success: false, error: expect.stringContaining('403') });
    await api('POST', '/rest/external-secrets/providers/vault', { token: 's.root' });
    expect((await api('POST', '/rest/external-secrets/providers/vault/test', {})).body.data).toEqual({ success: true, count: 2 });
    const p = (await api('POST', '/rest/external-secrets/providers/vault/connect', { connected: true })).body.data;
    expect(p).toMatchObject({ connected: true, state: 'connected', secrets: ['db', 'team/api'] });
    expect(p.settings.token).toBe('__FLOWMATOR_REDACTED__');
    expect((await api('GET', '/rest/external-secrets/secrets')).body.data).toEqual({ vault: ['db', 'team/api'] });

    const cred = (await api('POST', '/rest/credentials', { name: 'From vault', type: 'httpBasicAuth', data: { user: '={{ $secrets.vault.db.user }}', password: "={{ $secrets.vault['team/api'].key }}" } })).body.data;
    const resolved = await app.ctx.credentialsHelper.getDecrypted({ id: 'x', name: 'n', type: 't', typeVersion: 1, position: [0, 0], parameters: {}, credentials: { httpBasicAuth: { id: cred.id, name: cred.name } } }, 'httpBasicAuth');
    expect(resolved).toMatchObject({ user: 'app', password: 'k-123' });

    await api('POST', '/rest/external-secrets/providers/vault/connect', { connected: false });
    expect((await api('GET', '/rest/external-secrets/secrets')).body.data).toEqual({});
  });
});

describe('source control', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  let remote: string;
  let other: string;

  beforeAll(() => {
    remote = path.join(dir, 'remote.git');
    mkdirSync(remote);
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    other = path.join(dir, 'other');
  });

  it('connects, pushes workflows and stubs, and reports a clean status', async () => {
    const wf = (await api('POST', '/rest/workflows', { name: 'Versioned', nodes: [node('Start', 'manualTrigger')], connections: {}, tags: ['prod'] })).body.data;
    await api('POST', '/rest/credentials', { name: 'Secret token', type: 'httpHeaderAuth', data: { name: 'X-Key', value: 'super-secret' } });
    await api('POST', '/rest/variables', { key: 'REGION', value: 'eu' });

    const prefs = await api('POST', '/rest/source-control/preferences', { repositoryUrl: `file://${remote}`, branchName: 'main', connectionType: 'https', connected: true });
    expect(prefs.status).toBe(200);
    expect(prefs.body.data).toMatchObject({ connected: true, branchName: 'main' });

    const status = (await api('GET', '/rest/source-control/get-status')).body.data;
    expect(status.find((s: { id: string }) => s.id === wf.id)).toMatchObject({ type: 'workflow', status: 'created', location: 'local', conflict: false });
    expect(status.map((s: { type: string }) => s.type)).toEqual(expect.arrayContaining(['credential', 'variables', 'tags']));

    const pushed = await api('POST', '/rest/source-control/push-workfolder', { commitMessage: 'first' });
    expect(pushed.status).toBe(200);
    expect(pushed.body.data.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await api('GET', '/rest/source-control/get-status')).body.data).toEqual([]);

    git(dir, 'clone', '-q', remote, other);
    expect(git(other, 'log', '--format=%s')).toContain('first');
    const file = JSON.parse(readFileSync(path.join(other, 'workflows', `${wf.id}.json`), 'utf8'));
    expect(file).toMatchObject({ id: wf.id, name: 'Versioned' });
    expect(file).not.toHaveProperty('active');
    const stubs = readdirSync(path.join(other, 'credential_stubs')).map((f) => readFileSync(path.join(other, 'credential_stubs', f), 'utf8')).join('\n');
    expect(stubs).not.toContain('super-secret');
    // secret references survive in the stub
    expect(stubs).toContain('$secrets.vault.db.user');
    expect(readFileSync(path.join(other, 'variable_stubs.json'), 'utf8')).not.toContain('eu');
    expect((await api('GET', '/rest/source-control/get-branches')).body.data).toEqual({ branches: ['main'], currentBranch: 'main' });
  });

  it('pulls remote changes, keeps active state and detects conflicts', async () => {
    const wfId = (await api('GET', '/rest/workflows')).body.data.find((w: { name: string }) => w.name === 'Versioned').id;
    const filePath = path.join(other, 'workflows', `${wfId}.json`);
    const edit = (name: string) => {
      const f = JSON.parse(readFileSync(filePath, 'utf8'));
      writeFileSync(filePath, JSON.stringify({ ...f, name }, null, 2) + '\n');
    };
    // a workflow created elsewhere and an edit to ours
    edit('Versioned (remote)');
    mkdirSync(path.join(other, 'workflows'), { recursive: true });
    writeFileSync(path.join(other, 'workflows', 'remote-wf.json'), JSON.stringify({ id: 'remote-wf', name: 'From git', nodes: [node('Start', 'manualTrigger')], connections: {}, settings: {} }, null, 2));
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'remote edit');
    git(other, 'push', '-q', 'origin', 'main');

    const status = (await api('GET', '/rest/source-control/get-status')).body.data;
    expect(status).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: wfId, status: 'modified', location: 'remote', conflict: false }),
        expect.objectContaining({ id: 'remote-wf', status: 'created', location: 'remote' }),
      ]),
    );
    const pulled = await api('POST', '/rest/source-control/pull-workfolder', {});
    expect(pulled.status).toBe(200);
    expect(app.ctx.db.getWorkflow(wfId)!.name).toBe('Versioned (remote)');
    expect(app.ctx.db.getWorkflow('remote-wf')!.name).toBe('From git');
    expect((await api('GET', '/rest/source-control/get-status')).body.data).toEqual([]);

    // both sides change the same workflow
    await api('PATCH', `/rest/workflows/${wfId}`, { name: 'Local name' });
    git(other, 'pull', '-q', 'origin', 'main');
    edit('Remote name');
    git(other, 'commit', '-qam', 'conflicting');
    git(other, 'push', '-q', 'origin', 'main');
    const conflict = (await api('GET', '/rest/source-control/get-status')).body.data.find((s: { id: string }) => s.id === wfId);
    expect(conflict).toMatchObject({ conflict: true, location: 'local' });
    expect((await api('POST', '/rest/source-control/push-workfolder', {})).status).toBe(409);
    expect((await api('POST', '/rest/source-control/pull-workfolder', {})).status).toBe(409);
    expect((await api('POST', '/rest/source-control/pull-workfolder', { force: true })).status).toBe(200);
    expect(app.ctx.db.getWorkflow(wfId)!.name).toBe('Remote name');

    // deleted on the remote: archived here
    git(other, 'pull', '-q', 'origin', 'main');
    git(other, 'rm', '-q', 'workflows/remote-wf.json');
    git(other, 'commit', '-qm', 'remove');
    git(other, 'push', '-q', 'origin', 'main');
    await api('POST', '/rest/source-control/pull-workfolder', {});
    expect(app.ctx.db.getWorkflow('remote-wf')!.isArchived).toBe(true);
  });

  it('blocks pushes on a read-only branch and disconnects', async () => {
    await api('PATCH', '/rest/source-control/preferences', { branchReadOnly: true });
    await api('POST', '/rest/workflows', { name: 'Another', nodes: [], connections: {} });
    const res = await api('POST', '/rest/source-control/push-workfolder', {});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/read-only/);
    expect((await api('POST', '/rest/source-control/disconnect')).body.data.connected).toBe(false);
    expect((await api('GET', '/rest/source-control/get-status')).status).toBe(400);
  });
});

describe('community packages', () => {
  const pkgSource = () => {
    const src = path.join(dir, 'n8n-nodes-shout');
    mkdirSync(path.join(src, 'dist'), { recursive: true });
    writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'n8n-nodes-shout', version: '1.2.0', main: 'index.js', n8n: { nodes: ['dist/Shout.node.js'], credentials: ['dist/ShoutApi.credentials.js'] } }));
    writeFileSync(
      path.join(src, 'dist', 'Shout.node.js'),
      `const { NodeConnectionTypes, NodeOperationError, jsonParse } = require('n8n-workflow');
class Shout {
  description = { displayName: 'Shout', name: 'shout', group: ['transform'], version: 1, description: 'Uppercases a field', defaults: { name: 'Shout' },
    inputs: [NodeConnectionTypes.Main], outputs: [NodeConnectionTypes.Main],
    properties: [{ displayName: 'Field', name: 'field', type: 'string', default: 'text' }] };
  async execute() {
    const items = this.getInputData();
    return [items.map((item, i) => {
      const field = this.getNodeParameter('field', i);
      if (typeof item.json[field] !== 'string') throw new NodeOperationError(this.getNode(), 'Not a string', { itemIndex: i });
      return { json: { ...item.json, [field]: item.json[field].toUpperCase(), extra: jsonParse('{"ok":true}') } };
    })];
  }
}
module.exports = { Shout };`,
    );
    writeFileSync(path.join(src, 'dist', 'ShoutApi.credentials.js'), `class ShoutApi { name = 'shoutApi'; displayName = 'Shout API'; properties = [{ displayName: 'Key', name: 'key', type: 'string', default: '' }]; }\nmodule.exports = { ShoutApi };`);
    return src;
  };

  /** "npm" that copies the package folder into node_modules and records it */
  const fakeNpm = (src: string) => async (args: string[], cwd: string) => {
    const manifest = path.join(cwd, 'package.json');
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    if (args[0] === 'install') {
      cpSync(src, path.join(cwd, 'node_modules', 'n8n-nodes-shout'), { recursive: true });
      m.dependencies['n8n-nodes-shout'] = '^1.2.0';
    } else if (args[0] === 'uninstall') {
      rmSync(path.join(cwd, 'node_modules', 'n8n-nodes-shout'), { recursive: true, force: true });
      delete m.dependencies['n8n-nodes-shout'];
    } else if (args[0] === 'view') return '1.3.0\n';
    writeFileSync(manifest, JSON.stringify(m));
    return '';
  };

  it('installs a package, runs its node through the n8n-workflow shim and reloads it at startup', async () => {
    const src = pkgSource();
    const svc = new CommunityPackagesService(dir, app.ctx.nodeTypes, app.ctx.credentialTypes, app.ctx.events, fakeNpm(src));
    await expect(svc.install('left-pad')).rejects.toThrow(/n8n-nodes-/);
    const info = await svc.install('n8n-nodes-shout');
    expect(info).toMatchObject({ packageName: 'n8n-nodes-shout', installedVersion: '1.2.0', installedNodes: [{ name: 'Shout', type: 'n8n-nodes-shout.shout', latestVersion: 1 }], credentials: ['shoutApi'] });
    expect(app.ctx.credentialTypes.get('shoutApi').displayName).toBe('Shout API');

    const wf = (
      await api('POST', '/rest/workflows', {
        name: 'Community',
        nodes: [node('Start', 'manualTrigger'), node('Data', 'set', { assignments: { assignments: [{ id: 'a', name: 'text', value: 'hello', type: 'string' }] } }), node('Shout', 'n8n-nodes-shout.shout', { field: 'text' })],
        connections: chain('Start', 'Data', 'Shout'),
      })
    ).body.data;
    const r = (await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {})).body.data;
    expect(r.status).toBe('success');
    expect(r.data.runData.Shout[0].data.main[0][0].json).toMatchObject({ text: 'HELLO', extra: { ok: true } });

    expect((await svc.checkUpdates())[0].updateAvailable).toBe('1.3.0');

    // a fresh process finds it in <userFolder>/nodes
    const { NodeTypesRegistry, CredentialTypesRegistry } = await import('@flowmator/core');
    const fresh = new CommunityPackagesService(dir, new NodeTypesRegistry(), new CredentialTypesRegistry());
    fresh.loadAll();
    expect(fresh.list().map((p) => p.packageName)).toEqual(['n8n-nodes-shout']);

    await svc.uninstall('n8n-nodes-shout');
    expect(svc.list()).toEqual([]);
  });

  it('lists packages over REST', async () => {
    expect((await api('GET', '/rest/community-packages')).body.data).toEqual([]);
    expect((await api('POST', '/rest/community-packages', { name: 'not-a-node' })).status).toBe(400);
  });
});

describe('templates', () => {
  it('proxies the template library', async () => {
    const lib = await serve((req) => {
      if (req.url!.startsWith('/api/templates/search')) return [200, { totalWorkflows: 1, workflows: [{ id: 7, name: 'Slack alerts', query: req.url }] }];
      if (req.url === '/api/workflows/templates/7') return [200, { id: 7, name: 'Slack alerts', workflow: { nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger' }], connections: {} } }];
      return [404, {}];
    });
    process.env.N8N_TEMPLATES_HOST = `${lib}/api/`;
    try {
      const search = (await api('GET', '/rest/templates/search?search=slack&page=1&rows=20')).body;
      expect(search.workflows[0]).toMatchObject({ id: 7, query: '/api/templates/search?search=slack&page=1&rows=20' });
      expect((await api('GET', '/rest/templates/workflows/7/workflow')).body.workflow.nodes[0].type).toBe('n8n-nodes-base.manualTrigger');
      expect((await api('GET', '/rest/templates/workflows/99')).status).toBe(404);
    } finally {
      delete process.env.N8N_TEMPLATES_HOST;
    }
  });
});
