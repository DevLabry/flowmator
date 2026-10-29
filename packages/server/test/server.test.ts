import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src';

let app: App;
let dir: string;
let echo: Server;
let echoUrl: string;

/** Echo server for HTTP Request tests: returns method, headers, query, body; /pages?page=N paginates 3 pages. */
function startEcho() {
  return new Promise<void>((resolve) => {
    echo = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const url = new URL(req.url!, 'http://x');
        res.setHeader('content-type', 'application/json');
        if (url.pathname === '/pages') {
          const page = Number(url.searchParams.get('page') ?? 1);
          return res.end(JSON.stringify(page <= 3 ? [{ page }] : []));
        }
        if (url.pathname === '/fail') {
          res.statusCode = 503;
          return res.end(JSON.stringify({ message: 'down' }));
        }
        res.end(JSON.stringify({ method: req.method, headers: req.headers, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null }));
      });
    }).listen(0, () => {
      echoUrl = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), '8n8-test-'));
  app = await createApp({ userFolder: dir, port: 0, webhookUrl: 'http://localhost:5678/', encryptionKey: 'test-key' });
  app.ctx.executions.start();
  await startEcho();
});

afterAll(async () => {
  await app.stop();
  echo.close();
  rmSync(dir, { recursive: true, force: true });
});

const api = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.app.inject({ method: method as 'GET', url, payload: payload as never, headers });
  return { status: res.statusCode, body: res.body ? safeJson(res.body) : undefined, headers: res.headers };
};
const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

let n = 0;
const node = (name: string, type: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id: `n${++n}`,
  name,
  type: `8n8.${type}`,
  typeVersion: 1,
  position: [0, 0],
  parameters,
  ...extra,
});
const chain = (...names: string[]) => {
  const c: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }> = {};
  for (let i = 0; i < names.length - 1; i++) c[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] };
  return c;
};
const setNode = (name: string, assignments: Array<[string, string, string?]>) =>
  node(name, 'set', { mode: 'manual', includeOtherFields: true, assignments: { assignments: assignments.map(([k, v, t]) => ({ name: k, value: v, type: t ?? 'string' })) } });

async function createWorkflow(body: Record<string, unknown>) {
  const res = await api('POST', '/rest/workflows', body);
  expect(res.status).toBe(200);
  return res.body.data as { id: string; versionId: string; active: boolean };
}

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timed out');
}

const executionsOf = (workflowId: string) => app.ctx.db.listExecutions({ workflowId }).results;

describe('workflows', () => {
  it('creates, updates and keeps version history', async () => {
    const wf = await createWorkflow({ name: 'History', nodes: [node('Start', 'manualTrigger')], connections: {}, tags: ['demo'] });
    const updated = await api('PATCH', `/rest/workflows/${wf.id}`, { nodes: [node('Start', 'manualTrigger'), node('Noop', 'noOp')], connections: chain('Start', 'Noop') });
    expect(updated.body.data.tags).toEqual(['demo']);
    const history = (await api('GET', `/rest/workflow-history/workflow/${wf.id}`)).body.data;
    expect(history).toHaveLength(2);
    const restored = await api('POST', `/rest/workflow-history/workflow/${wf.id}/version/${history[1].versionId}/restore`);
    expect(restored.body.data.nodes).toHaveLength(1);
  });

  it('rejects saving over a newer version', async () => {
    const wf = await createWorkflow({ name: 'Conflict', nodes: [], connections: {} });
    await api('PATCH', `/rest/workflows/${wf.id}`, { nodes: [node('A', 'manualTrigger')] });
    const stale = await api('PATCH', `/rest/workflows/${wf.id}`, { versionId: wf.versionId, name: 'x' });
    expect(stale.status).toBe(409);
  });

  it('imports n8n exported JSON', async () => {
    const res = await api('POST', '/rest/workflows/import', {
      name: 'From n8n',
      nodes: [{ id: 'a', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
      tags: [{ name: 'imported' }],
    });
    expect(res.body.data[0].nodes[0].type).toBe('8n8.manualTrigger');
    expect(res.body.data[0].tags).toEqual(['imported']);
  });
});

describe('manual runs', () => {
  it('runs from the editor and stores the execution', async () => {
    const wf = await createWorkflow({ name: 'Manual', nodes: [node('Start', 'manualTrigger'), setNode('Set', [['hello', 'world']])], connections: chain('Start', 'Set') });
    const res = await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {});
    expect(res.body.data.status).toBe('success');
    expect(res.body.data.data.runData.Set[0].data.main[0][0].json).toEqual({ hello: 'world' });
    const list = (await api('GET', `/rest/executions?workflowId=${wf.id}`)).body.data;
    expect(list.count).toBe(1);
    expect(list.results[0]).toMatchObject({ status: 'success', mode: 'manual', workflowName: 'Manual' });
  });

  it('runs unsaved editor changes passed in the body', async () => {
    const wf = await createWorkflow({ name: 'Unsaved', nodes: [node('Start', 'manualTrigger')], connections: {} });
    const res = await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {
      workflowData: { name: 'Unsaved', nodes: [node('Start', 'manualTrigger'), setNode('Set', [['x', '={{ 1 + 1 }}', 'number']])], connections: chain('Start', 'Set') },
    });
    expect(res.body.data.data.runData.Set[0].data.main[0][0].json).toEqual({ x: 2 });
  });
});

describe('production webhooks', () => {
  it('responds with the last node data once the workflow is active', async () => {
    const wf = await createWorkflow({
      name: 'Hook',
      nodes: [node('Webhook', 'webhook', { httpMethod: 'POST', path: 'hello', responseMode: 'lastNode' }), setNode('Set', [['greeting', '=Hi {{ $json.body.name }}']])],
      connections: chain('Webhook', 'Set'),
    });
    expect((await api('POST', '/webhook/hello', { name: 'Ada' })).status).toBe(404);

    const activated = await api('POST', `/rest/workflows/${wf.id}/activate`);
    expect(activated.body.data.active).toBe(true);
    const res = await api('POST', '/webhook/hello', { name: 'Ada' });
    expect(res.status).toBe(200);
    expect(res.body.greeting).toBe('Hi Ada');

    expect((await api('GET', '/webhook/hello')).status).toBe(405);
    await api('POST', `/rest/workflows/${wf.id}/deactivate`);
    expect((await api('POST', '/webhook/hello', {})).status).toBe(404);
  });

  it('matches dynamic paths and responds immediately by default', async () => {
    const wf = await createWorkflow({ name: 'Dynamic', nodes: [node('Webhook', 'webhook', { path: 'users/:id' }), node('Noop', 'noOp')], connections: chain('Webhook', 'Noop') });
    await api('POST', `/rest/workflows/${wf.id}/activate`);
    const res = await api('GET', '/webhook/users/42?x=1');
    expect(res.body).toEqual({ message: 'Workflow was started' });
    const exec = await waitFor(() => executionsOf(wf.id).find((e) => e.status === 'success'));
    const full = app.ctx.db.getExecution(exec.id)!;
    expect(full.data!.resultData.runData.Webhook![0]!.data!.main![0]![0]!.json).toMatchObject({ params: { id: '42' }, query: { x: '1' } });
  });

  it('uses the Respond to Webhook node in responseNode mode', async () => {
    const wf = await createWorkflow({
      name: 'Respond',
      nodes: [
        node('Webhook', 'webhook', { httpMethod: 'POST', path: 'respond', responseMode: 'responseNode' }),
        node('Respond', 'respondToWebhook', {
          respondWith: 'json',
          responseBody: '={{ JSON.stringify({ doubled: $json.body.n * 2 }) }}',
          options: { responseCode: 201, responseHeaders: { entries: [{ name: 'X-Custom', value: 'yes' }] } },
        }),
      ],
      connections: chain('Webhook', 'Respond'),
    });
    await api('POST', `/rest/workflows/${wf.id}/activate`);
    const res = await api('POST', '/webhook/respond', { n: 21 });
    expect(res.status).toBe(201);
    expect(res.headers['x-custom']).toBe('yes');
    expect(res.body).toEqual({ doubled: 42 });
  });

  it('checks header auth credentials', async () => {
    const cred = (await api('POST', '/rest/credentials', { name: 'Hook auth', type: 'httpHeaderAuth', data: { name: 'X-Token', value: 's3cret' } })).body.data;
    const wf = await createWorkflow({
      name: 'Protected',
      nodes: [node('Webhook', 'webhook', { path: 'protected', authentication: 'headerAuth' }, { credentials: { httpHeaderAuth: { id: cred.id, name: cred.name } } }), node('Noop', 'noOp')],
      connections: chain('Webhook', 'Noop'),
    });
    await api('POST', `/rest/workflows/${wf.id}/activate`);
    expect((await api('GET', '/webhook/protected')).status).toBe(403);
    expect((await api('GET', '/webhook/protected', undefined, { 'x-token': 's3cret' })).status).toBe(200);
  });

  it('turns multipart uploads into binary data', async () => {
    const wf = await createWorkflow({ name: 'Upload', nodes: [node('Webhook', 'webhook', { httpMethod: 'POST', path: 'upload', responseMode: 'lastNode' })], connections: {} });
    await api('POST', `/rest/workflows/${wf.id}/activate`);
    const boundary = '----8n8test';
    const payload =
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nReport\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello file\r\n--${boundary}--\r\n`;
    const res = await api('POST', '/webhook/upload', payload, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    expect(res.body.body).toEqual({ title: 'Report' });
    const exec = executionsOf(wf.id)[0];
    const item = app.ctx.db.getExecution(exec.id)!.data!.resultData.runData.Webhook![0]!.data!.main![0]![0]!;
    expect(item.binary!.data).toMatchObject({ fileName: 'a.txt', mimeType: 'text/plain', fileSize: 10 });
    expect((await app.ctx.executions.binaryData.get(item.binary!.data)).toString()).toBe('hello file');
  });
});

describe('test webhooks', () => {
  it('waits for one test call after clicking execute', async () => {
    const wf = await createWorkflow({ name: 'TestHook', nodes: [node('Webhook', 'webhook', { httpMethod: 'POST', path: 'try-me', responseMode: 'lastNode' }), setNode('Set', [['ok', 'yes']])], connections: chain('Webhook', 'Set') });
    expect((await api('POST', '/webhook-test/try-me', {})).status).toBe(404);
    const run = await api('POST', `/rest/workflows/${wf.id}/run`, {});
    expect(run.body.data).toEqual({ waitingForWebhook: true, testUrls: ['http://localhost:5678/webhook-test/try-me'] });
    const res = await api('POST', '/webhook-test/try-me', { a: 1 });
    expect(res.body).toMatchObject({ ok: 'yes', body: { a: 1 } });
    expect(executionsOf(wf.id)[0].mode).toBe('manual');
    expect((await api('POST', '/webhook-test/try-me', {})).status).toBe(404);
  });
});

describe('wait and resume', () => {
  it('resumes a Wait node through /webhook-waiting', async () => {
    const wf = await createWorkflow({
      name: 'Approval',
      nodes: [node('Webhook', 'webhook', { httpMethod: 'POST', path: 'approval' }), node('Wait', 'wait', { resume: 'webhook', httpMethod: 'POST' }), setNode('After', [['decision', '={{ $json.body.approved }}', 'boolean']])],
      connections: chain('Webhook', 'Wait', 'After'),
    });
    await api('POST', `/rest/workflows/${wf.id}/activate`);
    await api('POST', '/webhook/approval', {});
    const waiting = await waitFor(() => executionsOf(wf.id).find((e) => e.status === 'waiting'));

    const res = await api('POST', `/webhook-waiting/${waiting.id}`, { approved: true });
    expect(res.status).toBe(200);
    const done = await waitFor(() => app.ctx.db.getExecution(waiting.id)?.status === 'success' && app.ctx.db.getExecution(waiting.id));
    expect(done!.data!.resultData.runData.After![0]!.data!.main![0]![0]!.json).toMatchObject({ decision: true });
    expect((await api('POST', `/webhook-waiting/${waiting.id}`, {})).status).toBe(404);
  });

  it('resumes timed waits from the database', async () => {
    const wf = await createWorkflow({
      name: 'Timed',
      nodes: [node('Start', 'manualTrigger'), node('Wait', 'wait', { resume: 'timeInterval', amount: 5, unit: 'minutes' }), node('After', 'noOp')],
      connections: chain('Start', 'Wait', 'After'),
    });
    const r = await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {});
    expect(r.body.data.status).toBe('waiting');
    const id = r.body.data.executionId;
    // pretend the time passed
    app.ctx.db.updateExecution(id, { waitTill: new Date(Date.now() - 1000) });
    (app.ctx.executions as unknown as { checkWaiting(): void }).checkWaiting();
    await waitFor(() => app.ctx.db.getExecution(id)?.status === 'success');
  });
});

describe('credentials and HTTP Request', () => {
  it('never returns secrets and keeps them when saving the redacted form', async () => {
    const created = (await api('POST', '/rest/credentials', { name: 'API', type: 'httpBearerAuth', data: { token: 'abc123' } })).body.data;
    const read = (await api('GET', `/rest/credentials/${created.id}?includeData=true`)).body.data;
    expect(read.data.token).toBe('__8N8_REDACTED__');
    await api('PATCH', `/rest/credentials/${created.id}`, { name: 'API 2', data: { token: '__8N8_REDACTED__' } });
    expect(app.ctx.credentials.getDecrypted(created.id).token).toBe('abc123');
  });

  it('signs requests with credentials and paginates', async () => {
    const cred = (await api('POST', '/rest/credentials', { name: 'Bearer', type: 'httpBearerAuth', data: { token: 'tok-1' } })).body.data;
    const wf = await createWorkflow({
      name: 'HTTP',
      nodes: [
        node('Start', 'manualTrigger'),
        node(
          'Call',
          'httpRequest',
          { method: 'POST', url: `${echoUrl}/echo`, authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth', sendQuery: true, queryParameters: { parameters: [{ name: 'q', value: '={{ 40 + 2 }}' }] }, sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '{"a": 1}' },
          { credentials: { httpBearerAuth: { id: cred.id, name: cred.name } } },
        ),
        node('Pages', 'httpRequest', {
          url: `${echoUrl}/pages`,
          options: { pagination: { pagination: { paginationMode: 'updateAParameterInEachRequest', parameters: { parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }] }, paginationCompleteWhen: 'responseIsEmpty' } } },
        }),
      ],
      connections: chain('Start', 'Call', 'Pages'),
    });
    const r = await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {});
    expect(r.body.data.status).toBe('success');
    const call = r.body.data.data.runData.Call[0].data.main[0][0].json;
    expect(call).toMatchObject({ method: 'POST', query: { q: '42' }, body: { a: 1 } });
    expect(call.headers.authorization).toBe('Bearer tok-1');
    expect(r.body.data.data.runData.Pages[0].data.main[0].map((i: { json: unknown }) => i.json)).toEqual([{ page: 1 }, { page: 2 }, { page: 3 }]);
  });

  it('reports HTTP errors with the status code', async () => {
    const wf = await createWorkflow({ name: 'HTTP fail', nodes: [node('Start', 'manualTrigger'), node('Call', 'httpRequest', { url: `${echoUrl}/fail` })], connections: chain('Start', 'Call') });
    const r = await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {});
    expect(r.body.data.status).toBe('error');
    expect(r.body.data.data.error).toMatchObject({ httpCode: '503', node: 'Call' });
  });
});

describe('error workflows, retries and sub-workflows', () => {
  it('runs the error workflow when a production execution fails', async () => {
    const handler = await createWorkflow({ name: 'On error', nodes: [node('Error Trigger', 'errorTrigger'), setNode('Log', [['msg', '={{ $json.execution.error.message }}']])], connections: chain('Error Trigger', 'Log') });
    const failing = await createWorkflow({
      name: 'Fails',
      nodes: [node('Webhook', 'webhook', { path: 'boom' }), node('Boom', 'stopAndError', { errorMessage: 'kaboom' })],
      connections: chain('Webhook', 'Boom'),
      settings: { executionOrder: 'v1', errorWorkflow: handler.id },
    });
    await api('POST', `/rest/workflows/${failing.id}/activate`);
    await api('GET', '/webhook/boom');
    const handled = await waitFor(() => executionsOf(handler.id).find((e) => e.status === 'success'));
    expect(app.ctx.db.getExecution(handled.id)!.data!.resultData.runData.Log![0]!.data!.main![0]![0]!.json.msg).toBe('kaboom');
  });

  it('retries a failed execution from the failed node with the fixed workflow', async () => {
    const wf = await createWorkflow({
      name: 'Retry',
      nodes: [node('Start', 'manualTrigger'), setNode('Prep', [['v', '7']]), node('Code', 'code', { jsCode: 'throw new Error("broken")' })],
      connections: chain('Start', 'Prep', 'Code'),
    });
    const first = await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {});
    expect(first.body.data.status).toBe('error');
    const stored = app.ctx.db.getWorkflow(wf.id)!;
    stored.nodes[2].parameters.jsCode = 'return $input.all().map(i => ({ json: { v: i.json.v + "!" } }))';
    await api('PATCH', `/rest/workflows/${wf.id}`, { nodes: stored.nodes });

    const retry = await api('POST', `/rest/executions/${first.body.data.executionId}/retry`, { loadWorkflow: true });
    expect(retry.body.data.status).toBe('success');
    const retried = executionsOf(wf.id).find((e) => e.mode === 'retry')!;
    const runData = app.ctx.db.getExecution(retried.id)!.data!.resultData.runData;
    expect(runData.Prep).toHaveLength(1);
    expect(runData.Code![0]!.data!.main![0]![0]!.json).toEqual({ v: '7!' });
    expect(app.ctx.db.getExecution(first.body.data.executionId)!.retrySuccessId).toBe(retried.id);
  });

  it('executes a sub-workflow by ID', async () => {
    const sub = await createWorkflow({ name: 'Sub', nodes: [node('In', 'executeWorkflowTrigger'), setNode('Tag', [['fromSub', 'true', 'boolean']])], connections: chain('In', 'Tag') });
    const parent = await createWorkflow({
      name: 'Parent',
      nodes: [node('Start', 'manualTrigger'), node('Call', 'executeWorkflow', { source: 'database', workflowId: { __rl: true, mode: 'id', value: sub.id } })],
      connections: chain('Start', 'Call'),
    });
    const r = await api('POST', `/rest/workflows/${parent.id}/run?wait=true`, {});
    expect(r.body.data.data.runData.Call[0].data.main[0][0].json).toEqual({ fromSub: true });
    expect(executionsOf(sub.id)[0].mode).toBe('integrated');
  });
});

describe('schedule trigger', () => {
  it('fires while active and stops when deactivated', async () => {
    const wf = await createWorkflow({
      name: 'Every second',
      nodes: [node('Schedule', 'scheduleTrigger', { rule: { interval: [{ field: 'seconds', secondsInterval: 1 }] } }), node('Noop', 'noOp')],
      connections: chain('Schedule', 'Noop'),
    });
    await api('POST', `/rest/workflows/${wf.id}/activate`);
    const exec = await waitFor(() => executionsOf(wf.id).find((e) => e.status === 'success'), 3000);
    expect(exec.mode).toBe('trigger');
    await api('POST', `/rest/workflows/${wf.id}/deactivate`);
    const count = executionsOf(wf.id).length;
    await new Promise((r) => setTimeout(r, 1300));
    expect(executionsOf(wf.id).length).toBe(count);
  });

  it('refuses to activate a workflow without a trigger', async () => {
    const wf = await createWorkflow({ name: 'No trigger', nodes: [node('Start', 'manualTrigger')], connections: {} });
    const res = await api('POST', `/rest/workflows/${wf.id}/activate`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no node to start/);
  });
});

describe('public API', () => {
  it('requires an API key', async () => {
    expect((await api('GET', '/api/v1/workflows')).status).toBe(401);
    const key = (await api('POST', '/rest/api-keys', { label: 'cli' })).body.data.apiKey;
    const res = await api('GET', '/api/v1/workflows?limit=2', undefined, { 'x-n8n-api-key': key });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.nextCursor).toBeTruthy();
  });
});

describe('variables', () => {
  it('exposes variables as $vars in expressions', async () => {
    await api('POST', '/rest/variables', { key: 'BASE', value: 'https://example.com' });
    const wf = await createWorkflow({ name: 'Vars', nodes: [node('Start', 'manualTrigger'), setNode('Set', [['url', '={{ $vars.BASE }}/x']])], connections: chain('Start', 'Set') });
    const r = await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {});
    expect(r.body.data.data.runData.Set[0].data.main[0][0].json.url).toBe('https://example.com/x');
  });
});
