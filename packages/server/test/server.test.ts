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
  dir = mkdtempSync(path.join(os.tmpdir(), 'flowmator-test-'));
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
  type: `flowmator.${type}`,
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
    expect(res.body.data[0].nodes[0].type).toBe('flowmator.manualTrigger');
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
    const boundary = '----flowmatortest';
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
    expect(read.data.token).toBe('__FLOWMATOR_REDACTED__');
    await api('PATCH', `/rest/credentials/${created.id}`, { name: 'API 2', data: { token: '__FLOWMATOR_REDACTED__' } });
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

describe('forms', () => {
  const multipart = (fields: Array<[string, string]>) => {
    const boundary = '----flowmatorform';
    const body = fields.map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') + `--${boundary}--\r\n`;
    return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
  };
  const contactFields = {
    values: [
      { fieldLabel: 'Name', fieldType: 'text', requiredField: true },
      { fieldLabel: 'Age', fieldType: 'number' },
      { fieldLabel: 'Topics', fieldType: 'checkbox', fieldOptions: { values: [{ option: 'A' }, { option: 'B' }] } },
    ],
  };

  it('serves the form and starts the workflow on submit', async () => {
    const wf = await createWorkflow({
      name: 'Contact form',
      nodes: [node('Form', 'formTrigger', { path: 'contact', formTitle: 'Contact <us>', formFields: contactFields }), node('Noop', 'noOp')],
      connections: chain('Form', 'Noop'),
    });
    await api('POST', `/rest/workflows/${wf.id}/activate`);
    const page = await api('GET', '/form/contact');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Contact &#60;us&#62;');
    expect(page.body).toContain('name="field-2" value="B"');

    const { body, headers } = multipart([['field-0', 'Ada'], ['field-1', '36'], ['field-2', 'A'], ['field-2', 'B']]);
    const submitted = await api('POST', '/form/contact', body, headers);
    expect(submitted.body).toContain('Your response has been recorded');
    const exec = await waitFor(() => executionsOf(wf.id).find((e) => e.status === 'success'));
    const json = app.ctx.db.getExecution(exec.id)!.data!.resultData.runData.Noop![0]!.data!.main![0]![0]!.json;
    expect(json).toMatchObject({ Name: 'Ada', Age: 36, Topics: ['A', 'B'], formMode: 'production' });
  });

  it('keeps the test form open until it is submitted', async () => {
    const wf = await createWorkflow({ name: 'Test form', nodes: [node('Form', 'formTrigger', { path: 'try-form', formTitle: 'Try', formFields: contactFields })], connections: {} });
    const run = await api('POST', `/rest/workflows/${wf.id}/run`, {});
    expect(run.body.data.testUrls).toEqual(['http://localhost:5678/form-test/try-form']);
    expect((await api('GET', '/form-test/try-form')).status).toBe(200);
    expect((await api('GET', '/form-test/try-form')).status).toBe(200);
    const { body, headers } = multipart([['field-0', 'Bob']]);
    expect((await api('POST', '/form-test/try-form', body, headers)).status).toBe(200);
    await waitFor(() => executionsOf(wf.id).find((e) => e.status === 'success' && e.mode === 'manual'));
    expect((await api('GET', '/form-test/try-form')).status).toBe(404);
  });

  it('resumes a Wait node from a submitted form', async () => {
    const wf = await createWorkflow({
      name: 'Form approval',
      nodes: [
        node('Webhook', 'webhook', { path: 'needs-approval' }),
        node('Wait', 'wait', { resume: 'form', formTitle: 'Approve?', formFields: { values: [{ fieldLabel: 'Decision', fieldType: 'text' }] } }),
        node('After', 'noOp'),
      ],
      connections: chain('Webhook', 'Wait', 'After'),
    });
    await api('POST', `/rest/workflows/${wf.id}/activate`);
    await api('GET', '/webhook/needs-approval');
    const waiting = await waitFor(() => executionsOf(wf.id).find((e) => e.status === 'waiting'));
    const page = await api('GET', `/form-waiting/${waiting.id}`);
    expect(page.body).toContain('Approve?');
    const { body, headers } = multipart([['field-0', 'yes']]);
    expect((await api('POST', `/form-waiting/${waiting.id}`, body, headers)).body).toContain('Your response has been recorded');
    const done = await waitFor(() => app.ctx.db.getExecution(waiting.id)?.status === 'success' && app.ctx.db.getExecution(waiting.id));
    expect(done!.data!.resultData.runData.After![0]!.data!.main![0]![0]!.json).toMatchObject({ Decision: 'yes' });
  });

  it('walks through the pages of a multi-page form', async () => {
    const wf = await createWorkflow({
      name: 'Sign-up wizard',
      nodes: [
        node('Start', 'formTrigger', { path: 'sign-up', formTitle: 'Sign up', formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] } }),
        node('Step 2', 'form', { operation: 'page', formFields: { values: [{ fieldLabel: 'Age', fieldType: 'number' }] }, options: { formTitle: 'About you', formDescription: '=Hi {{ $json.Name }}' } }),
        node('End', 'form', { operation: 'completion', respondWith: 'text', completionTitle: 'All set', completionMessage: "={{ $('Start').item.json.Name }} is {{ $json.Age }}" }),
      ],
      connections: chain('Start', 'Step 2', 'End'),
    });
    await api('POST', `/rest/workflows/${wf.id}/activate`);

    // submitting the first page leads to the next one
    const first = multipart([['field-0', 'Ana']]);
    const started = await api('POST', '/form/sign-up', first.body, first.headers);
    expect(started.status).toBe(303);
    const next = new URL(String(started.headers.location)).pathname;
    expect(next).toMatch(/^\/form-waiting\/\d+$/);
    const page = await api('GET', next);
    expect(page.body).toContain('About you');
    expect(page.body).toContain('Hi Ana');

    const second = multipart([['field-0', '30']]);
    const submitted = await api('POST', next, second.body, second.headers);
    expect(submitted.status).toBe(303);
    expect(new URL(String(submitted.headers.location)).pathname).toBe(next);
    const ending = await api('GET', next);
    expect(ending.body).toContain('All set');
    expect(ending.body).toContain('Ana is 30');

    const id = next.split('/').pop()!;
    const done = await waitFor(() => app.ctx.db.getExecution(id)?.status === 'success' && app.ctx.db.getExecution(id));
    expect(done!.data!.resultData.runData['Step 2']![0]!.data!.main![0]![0]!.json).toMatchObject({ Age: 30 });
    expect((await api('GET', next)).status).toBe(404);
  });
});

describe('chat trigger', () => {
  const chatWorkflow = (isPublic: boolean) => ({
    nodes: [
      node('Chat', 'chatTrigger', { public: isPublic, title: 'Help desk' }, { webhookId: `hook-${isPublic}` }),
      node('Reply', 'code', { mode: 'runOnceForEachItem', jsCode: 'return { output: `echo: ${$json.chatInput} (${$json.sessionId})` };' }),
    ],
    connections: chain('Chat', 'Reply'),
  });
  // chat nodes live in the AI package (flowmator-ai.*)
  const asAi = (wf: ReturnType<typeof chatWorkflow>) => ({ ...wf, nodes: wf.nodes.map((n) => (n.name === 'Chat' ? { ...n, type: 'flowmator-ai.chatTrigger' } : n)) });

  it('serves a public chat page and answers messages', async () => {
    const wf = await createWorkflow({ name: 'Public chat', ...asAi(chatWorkflow(true)) });
    await api('POST', `/rest/workflows/${wf.id}/activate`);
    const page = await api('GET', '/webhook/hook-true/chat');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>Help desk</title>');
    const reply = await api('POST', '/webhook/hook-true/chat', { action: 'sendMessage', sessionId: 'abc', chatInput: 'hello' });
    expect(reply.body).toEqual({ output: 'echo: hello (abc)' });
  });

  it('keeps a private chat closed to the outside but usable from the editor', async () => {
    const wf = await createWorkflow({ name: 'Private chat', ...asAi(chatWorkflow(false)) });
    await api('POST', `/rest/workflows/${wf.id}/activate`);
    expect((await api('GET', '/webhook/hook-false/chat')).status).toBe(404);
    expect((await api('POST', '/webhook/hook-false/chat', { chatInput: 'hi' })).status).toBe(404);
    // the editor's chat panel runs the workflow with the message as trigger data
    const r = await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {
      triggerToStartFrom: { name: 'Chat', data: { main: [[{ json: { sessionId: 'ed', action: 'sendMessage', chatInput: 'from editor' } }]] } },
    });
    expect(r.body.data.data.runData.Reply[0].data.main[0][0].json).toEqual({ output: 'echo: from editor (ed)' });
  });
});

describe('integration triggers and credentials', () => {
  type Fake = { method: string; url: URL; body: any; headers: Record<string, string> };
  let external: Fake[] = [];
  /** Fakes third-party hosts; local requests (echo server, the app) still go through. */
  const fakeExternal = (respond: (c: Fake) => unknown) => {
    external = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
      let body: any = init.body;
      if (typeof body === 'string') body = body.startsWith('{') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
      else if (body instanceof URLSearchParams) body = Object.fromEntries(body);
      const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const call = { method: init.method ?? 'GET', url, body, headers };
      external.push(call);
      return new Response(JSON.stringify(respond(call) ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return () => (globalThis.fetch = real);
  };

  it('registers a Telegram test webhook with its secret and only accepts calls carrying it', async () => {
    const restore = fakeExternal(() => ({ ok: true, result: true }));
    try {
      const cred = (await api('POST', '/rest/credentials', { name: 'Bot', type: 'telegramApi', data: { accessToken: '9:XYZ' } })).body.data;
      const wf = await createWorkflow({
        name: 'Telegram bot',
        nodes: [node('Telegram Trigger', 'telegramTrigger', { updates: ['message'] }, { webhookId: 'tg-hook', credentials: { telegramApi: { id: cred.id, name: cred.name } } }), node('Noop', 'noOp')],
        connections: chain('Telegram Trigger', 'Noop'),
      });
      const run = await api('POST', `/rest/workflows/${wf.id}/run`, {});
      expect(run.body.data.testUrls).toEqual(['http://localhost:5678/webhook-test/tg-hook/webhook']);
      const setWebhook = external.find((c) => c.url.pathname.endsWith('/setWebhook'))!;
      expect(setWebhook.url.pathname).toBe('/bot9:XYZ/setWebhook');
      expect(setWebhook.body).toMatchObject({ url: 'http://localhost:5678/webhook-test/tg-hook/webhook', allowed_updates: ['message'] });
      const secret = setWebhook.body.secret_token;
      expect(secret).toMatch(/^[a-f0-9]{48}$/);

      const update = { update_id: 1, message: { message_id: 1, chat: { id: 7 }, from: { id: 3 }, text: 'hi' } };
      expect((await api('POST', '/webhook-test/tg-hook/webhook', update)).status).toBe(403);
      // the 403 did not consume the test registration: a call with the secret still works
      const ok = await api('POST', '/webhook-test/tg-hook/webhook', update, { 'x-telegram-bot-api-secret-token': secret });
      expect(ok.body).toEqual({ ok: true });
      const exec = await waitFor(() => executionsOf(wf.id).find((e) => e.status === 'success'));
      expect(app.ctx.db.getExecution(exec.id)!.data!.resultData.runData.Noop![0]!.data!.main![0]![0]!.json).toMatchObject({ message: { text: 'hi' } });
      await waitFor(() => external.some((c) => c.url.pathname.endsWith('/deleteWebhook')));
    } finally {
      restore();
    }
  });

  it('creates the GitHub hook on activation and verifies delivery signatures', async () => {
    const restore = fakeExternal((c) => (c.method === 'POST' && c.url.pathname.endsWith('/hooks') ? { id: 99 } : {}));
    try {
      const cred = (await api('POST', '/rest/credentials', { name: 'GH', type: 'githubApi', data: { accessToken: 'ghp_x' } })).body.data;
      const wf = await createWorkflow({
        name: 'On push',
        nodes: [node('GitHub Trigger', 'githubTrigger', { owner: 'octo', repository: 'demo', events: ['push'] }, { webhookId: 'gh-hook', credentials: { githubApi: { id: cred.id, name: cred.name } } }), node('Noop', 'noOp')],
        connections: chain('GitHub Trigger', 'Noop'),
      });
      await api('POST', `/rest/workflows/${wf.id}/activate`);
      const create = external.find((c) => c.method === 'POST')!;
      expect(create.url.href).toBe('https://api.github.com/repos/octo/demo/hooks');
      expect(create.headers.authorization).toBe('Bearer ghp_x');
      expect(create.body.config.url).toBe('http://localhost:5678/webhook/gh-hook/webhook');
      const secret = create.body.config.secret;
      expect(app.ctx.db.getWorkflow(wf.id)!.staticData).toMatchObject({ 'node:GitHub Trigger': { webhookId: 99, secret } });

      const payload = JSON.stringify({ ref: 'refs/heads/main' });
      const { createHmac } = await import('node:crypto');
      const sign = (s: string) => `sha256=${createHmac('sha256', s).update(payload).digest('hex')}`;
      const send = (sig: string) => app.app.inject({ method: 'POST', url: '/webhook/gh-hook/webhook', payload, headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sig } });
      expect((await send(sign('wrong'))).statusCode).toBe(401);
      expect((await send(sign(secret))).statusCode).toBe(200);
      const exec = await waitFor(() => executionsOf(wf.id).find((e) => e.status === 'success'));
      expect(app.ctx.db.getExecution(exec.id)!.data!.resultData.runData.Noop![0]!.data!.main![0]![0]!.json).toMatchObject({ event: 'push', body: { ref: 'refs/heads/main' } });

      await api('POST', `/rest/workflows/${wf.id}/deactivate`);
      expect(external.at(-1)).toMatchObject({ method: 'DELETE' });
      expect(external.at(-1)!.url.pathname).toBe('/repos/octo/demo/hooks/99');
    } finally {
      restore();
    }
  });

  it('signs in Google service accounts with a JWT and caches the token', async () => {
    const { generateKeyPairSync, createVerify } = await import('node:crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const restore = fakeExternal((c) => (c.url.hostname === 'oauth2.googleapis.com' ? { access_token: 'ya29.sa', expires_in: 3600 } : { values: [['a'], ['1']] }));
    try {
      const cred = (await api('POST', '/rest/credentials', { name: 'SA', type: 'googleApi', data: { email: 'bot@p.iam.gserviceaccount.com', privateKey: privateKey.replace(/\n/g, '\\n') } })).body.data;
      const wf = await createWorkflow({
        name: 'Sheets SA',
        nodes: [node('Start', 'manualTrigger'), node('Sheet', 'googleSheets', { authentication: 'serviceAccount', resource: 'sheet', operation: 'read', documentId: 'doc', sheetName: 'S' }, { credentials: { googleApi: { id: cred.id, name: cred.name } } })],
        connections: chain('Start', 'Sheet'),
      });
      await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {});
      await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {});
      const tokenCalls = external.filter((c) => c.url.hostname === 'oauth2.googleapis.com');
      expect(tokenCalls).toHaveLength(1);
      const [h, claims, sig] = tokenCalls[0].body.assertion.split('.');
      expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({ iss: 'bot@p.iam.gserviceaccount.com', aud: 'https://oauth2.googleapis.com/token' });
      expect(createVerify('RSA-SHA256').update(`${h}.${claims}`).verify(publicKey, sig, 'base64url')).toBe(true);
      const sheetCalls = external.filter((c) => c.url.hostname === 'sheets.googleapis.com');
      expect(sheetCalls.map((c) => c.headers.authorization)).toEqual(['Bearer ya29.sa', 'Bearer ya29.sa']);
    } finally {
      restore();
    }
  });

  it('builds the Gmail OAuth consent URL from the built-in Google settings', async () => {
    const cred = (await api('POST', '/rest/credentials', { name: 'Mail', type: 'gmailOAuth2', data: { clientId: 'cid', clientSecret: 'cs' } })).body.data;
    const url = new URL((await api('GET', `/rest/oauth2-credential/auth?id=${cred.id}`)).body.data);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5678/rest/oauth2-credential/callback');
  });
});
