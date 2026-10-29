import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createContext, createWebhookApp, type App, type AppContext, type ConfigOverrides, type PushEvent } from '../src';

/** Queue mode needs a real Redis: these tests start a throwaway redis-server and skip without one. */
const redisBinary = process.env.REDIS_SERVER ?? spawnSync('which', ['redis-server'], { encoding: 'utf8' }).stdout.trim();

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

let redis: ChildProcess;
let dir: string;
let overrides: ConfigOverrides;
let main: App;
let worker: AppContext | undefined;
let webhookApp: App | undefined;
const pushed: PushEvent[] = [];

async function startWorker() {
  worker = createContext(overrides, 'worker');
  await worker.executions.startWorker(4);
}

async function stopWorker() {
  await worker!.scaling!.close(5);
  await worker!.executions.stopAll();
  worker!.db.close();
  worker = undefined;
}

describe.skipIf(!redisBinary)('queue mode', () => {
  beforeAll(async () => {
    const port = await freePort();
    redis = spawn(redisBinary, ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    dir = mkdtempSync(path.join(os.tmpdir(), '8n8-queue-'));
    overrides = {
      userFolder: dir,
      port: 0,
      webhookUrl: 'http://localhost:5678/',
      encryptionKey: 'test-key',
      executions: { mode: 'queue' },
      queue: { redis: { host: '127.0.0.1', port }, prefix: `test${port}` },
    };
    // redis takes a moment to accept connections
    const end = Date.now() + 5000;
    for (;;) {
      main = await createApp(overrides);
      try {
        await main.ctx.scaling!.ping();
        break;
      } catch (e) {
        await main.stop();
        if (Date.now() > end) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const send = main.ctx.push.send.bind(main.ctx.push);
    main.ctx.push.send = (event, pushRef) => {
      pushed.push(event);
      send(event, pushRef);
    };
    await main.ctx.executions.start();
  });

  afterAll(async () => {
    if (worker) await stopWorker();
    await webhookApp?.stop();
    await main?.stop();
    redis?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  const api = async (method: string, url: string, payload?: unknown, target = main) => {
    const res = await target.app.inject({ method: method as 'GET', url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, headers: res.headers };
  };

  let n = 0;
  const node = (name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id: `q${++n}`, name, type: `8n8.${type}`, typeVersion: 1, position: [0, 0], parameters });
  const chain = (...names: string[]) =>
    Object.fromEntries(names.slice(0, -1).map((name, i) => [name, { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] }]));
  const setNode = (name: string, assignments: Array<[string, string]>) =>
    node(name, 'set', { mode: 'manual', includeOtherFields: true, assignments: { assignments: assignments.map(([k, v]) => ({ name: k, value: v, type: 'string' })) } });

  async function activeWorkflow(body: Record<string, unknown>) {
    const wf = (await api('POST', '/rest/workflows', body)).body.data;
    const activated = await api('POST', `/rest/workflows/${wf.id}/activate`);
    expect(activated.body.data.active).toBe(true);
    return wf as { id: string };
  }

  async function waitFor<T>(fn: () => T | undefined | false, timeout = 8000): Promise<T> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('waitFor timed out');
  }

  const executionsOf = (workflowId: string) => main.ctx.db.listExecutions({ workflowId }).results;

  it('queues production executions until a worker picks them up', async () => {
    const wf = await activeWorkflow({ name: 'Queued', nodes: [node('Webhook', 'webhook', { path: 'queued' }), node('Noop', 'noOp')], connections: chain('Webhook', 'Noop') });
    const res = await api('GET', '/webhook/queued');
    expect(res.body).toEqual({ message: 'Workflow was started' });
    const [queued] = executionsOf(wf.id);
    expect(queued.status).toBe('new');
    expect((await api('GET', '/rest/executions/active')).body.data.map((e: { id: string }) => e.id)).toContain(queued.id);

    await startWorker();
    await waitFor(() => main.ctx.db.getExecution(queued.id)?.status === 'success');
    // the worker's editor events reach main's WebSocket clients through Redis
    await waitFor(() => pushed.some((e) => e.type === 'executionFinished' && e.data.executionId === queued.id));
    expect(pushed.some((e) => e.type === 'nodeExecuteAfter' && e.data.executionId === queued.id && e.data.nodeName === 'Noop')).toBe(true);
  });

  it('answers lastNode webhooks with the data the worker produced', async () => {
    await activeWorkflow({
      name: 'Hello',
      nodes: [node('Webhook', 'webhook', { httpMethod: 'POST', path: 'hello', responseMode: 'lastNode' }), setNode('Set', [['greeting', '=Hi {{ $json.body.name }}']])],
      connections: chain('Webhook', 'Set'),
    });
    const res = await api('POST', '/webhook/hello', { name: 'Ada' });
    expect(res.status).toBe(200);
    expect(res.body.greeting).toBe('Hi Ada');
  });

  it('relays Respond to Webhook output from the worker', async () => {
    await activeWorkflow({
      name: 'Respond',
      nodes: [
        node('Webhook', 'webhook', { httpMethod: 'POST', path: 'respond', responseMode: 'responseNode' }),
        node('Respond', 'respondToWebhook', { respondWith: 'json', responseBody: '={{ JSON.stringify({ doubled: $json.body.n * 2 }) }}', options: { responseCode: 201 } }),
      ],
      connections: chain('Webhook', 'Respond'),
    });
    const res = await api('POST', '/webhook/respond', { n: 21 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ doubled: 42 });
  });

  it('keeps manual runs on main unless they are offloaded', async () => {
    const wf = (await api('POST', '/rest/workflows', { name: 'Manual', nodes: [node('Start', 'manualTrigger'), setNode('Set', [['x', '1']])], connections: chain('Start', 'Set') })).body.data;
    // pause the worker: a manual run must still finish
    await worker!.scaling!.queue.pause();
    try {
      const r = await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {});
      expect(r.body.data.status).toBe('success');
    } finally {
      await worker!.scaling!.queue.resume();
    }
  });

  it('resumes waiting executions on a worker', async () => {
    const wf = await activeWorkflow({
      name: 'Wait',
      nodes: [node('Webhook', 'webhook', { path: 'wait-start' }), node('Wait', 'wait', { resume: 'webhook', httpMethod: 'POST' }), setNode('After', [['done', 'yes']])],
      connections: chain('Webhook', 'Wait', 'After'),
    });
    await api('GET', '/webhook/wait-start');
    const waiting = await waitFor(() => executionsOf(wf.id).find((e) => e.status === 'waiting'));
    const resumed = await api('POST', `/webhook-waiting/${waiting.id}`, { ok: true });
    expect(resumed.status).toBe(200);
    await waitFor(() => main.ctx.db.getExecution(waiting.id)?.status === 'success');
    expect(main.ctx.db.getExecution(waiting.id)!.data!.resultData.runData.After).toBeDefined();
  });

  it('stops an execution running on a worker', async () => {
    const wf = await activeWorkflow({
      name: 'Slow',
      nodes: [node('Webhook', 'webhook', { path: 'slow' }), node('Wait', 'wait', { resume: 'timeInterval', amount: 30, unit: 'seconds' }), node('After', 'noOp')],
      connections: chain('Webhook', 'Wait', 'After'),
    });
    await api('GET', '/webhook/slow');
    const running = await waitFor(() => executionsOf(wf.id).find((e) => e.status === 'running'));
    const stopped = await api('POST', `/rest/executions/${running.id}/stop`);
    expect(stopped.body.data.status).toBe('canceled');
    await waitFor(() => ['canceled', 'error'].includes(main.ctx.db.getExecution(running.id)!.status));
    expect(main.ctx.db.getExecution(running.id)!.data!.resultData.runData.After).toBeUndefined();
  });

  it('takes executions no worker has picked up off the queue when stopped', async () => {
    const wf = await activeWorkflow({ name: 'Unpicked', nodes: [node('Webhook', 'webhook', { path: 'unpicked' }), node('Noop', 'noOp')], connections: chain('Webhook', 'Noop') });
    await worker!.scaling!.queue.pause();
    try {
      await api('GET', '/webhook/unpicked');
      const [queued] = executionsOf(wf.id);
      expect(queued.status).toBe('new');
      expect((await api('POST', `/rest/executions/${queued.id}/stop`)).body.data.status).toBe('canceled');
      expect(main.ctx.db.getExecution(queued.id)!.status).toBe('canceled');
    } finally {
      await worker!.scaling!.queue.resume();
    }
  });

  it('retries failed executions on a worker', async () => {
    const wf = await activeWorkflow({
      name: 'Flaky',
      nodes: [node('Webhook', 'webhook', { path: 'flaky' }), node('Code', 'code', { jsCode: 'throw new Error("broken")' })],
      connections: chain('Webhook', 'Code'),
    });
    await api('GET', '/webhook/flaky');
    const failed = await waitFor(() => executionsOf(wf.id).find((e) => e.status === 'error'));
    const stored = main.ctx.db.getWorkflow(wf.id)!;
    stored.nodes[1].parameters.jsCode = 'return [{ json: { fixed: true } }]';
    await api('PATCH', `/rest/workflows/${wf.id}`, { nodes: stored.nodes });
    const retried = await api('POST', `/rest/executions/${failed.id}/retry`, { loadWorkflow: true });
    expect(retried.body.data.status).toBe('success');
    const retry = executionsOf(wf.id).find((e) => e.retryOf === failed.id)!;
    expect(retry.mode).toBe('retry');
    expect(main.ctx.db.getExecution(failed.id)!.retrySuccessId).toBe(retry.id);
  });

  it('serves production webhooks from a separate webhook process', async () => {
    webhookApp = await createWebhookApp(overrides);
    await webhookApp.start();
    const wf = await activeWorkflow({
      name: 'Via webhook process',
      nodes: [node('Webhook', 'webhook', { httpMethod: 'POST', path: 'external', responseMode: 'lastNode' }), setNode('Set', [['seen', '={{ $json.body.v }}']])],
      connections: chain('Webhook', 'Set'),
    });
    // activation reaches the webhook process through Redis
    await waitFor(() => webhookApp!.ctx.webhooks.listProduction().some((r) => r.path === 'external'));
    const res = await api('POST', '/webhook/external', { v: 'from-webhook-process' }, webhookApp);
    expect(res.body.seen).toBe('from-webhook-process');
    expect(executionsOf(wf.id).at(0)?.mode).toBe('webhook');

    await api('POST', `/rest/workflows/${wf.id}/deactivate`);
    await waitFor(() => !webhookApp!.ctx.webhooks.listProduction().some((r) => r.path === 'external'));
    expect((await api('POST', '/webhook/external', {}, webhookApp)).status).toBe(404);
  });

  it('marks executions lost with their process as crashed, but not queued ones', async () => {
    const lost = main.ctx.db.createExecution({ mode: 'webhook', status: 'running', workflowData: { name: 'x', nodes: [], connections: {} } });
    await worker!.scaling!.queue.pause();
    try {
      const wf = await activeWorkflow({ name: 'Still queued', nodes: [node('Webhook', 'webhook', { path: 'still-queued' }), node('Noop', 'noOp')], connections: chain('Webhook', 'Noop') });
      await api('GET', '/webhook/still-queued');
      const [queued] = executionsOf(wf.id);
      const ids = await main.ctx.scaling!.queuedExecutionIds();
      expect(main.ctx.db.markCrashedExecutions(ids)).toBe(1);
      expect(main.ctx.db.getExecution(lost)!.status).toBe('crashed');
      expect(main.ctx.db.getExecution(queued.id)!.status).toBe('new');
    } finally {
      await worker!.scaling!.queue.resume();
    }
  });
});
