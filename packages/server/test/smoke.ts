// Live smoke test: real HTTP + WebSocket. Run: npx tsx packages/server/test/smoke.ts <dataDir>
import { createApp } from '../src';

const dir = process.argv[2];
const { start, stop } = await createApp({ userFolder: dir, port: 5699, webhookUrl: 'http://localhost:5699/' });
const base = await start();
const url = 'http://localhost:5699';
const post = (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const events: string[] = [];
const ws = new WebSocket('ws://localhost:5699/rest/push?pushRef=smoke');
ws.onmessage = (m) => events.push(JSON.parse(String(m.data)).type);
await new Promise((r) => (ws.onopen = r));

const node = (name: string, type: string, parameters = {}) => ({ id: name, name, type: `8n8.${type}`, typeVersion: 1, position: [0, 0], parameters });
const wf = (await post('/rest/workflows', {
  name: 'Smoke',
  nodes: [node('Hook', 'webhook', { path: 'smoke', httpMethod: 'POST', responseMode: 'lastNode' }), node('Code', 'code', { jsCode: 'return [{ sum: $input.first().json.body.a + $input.first().json.body.b }]' })],
  connections: { Hook: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
})).data;

const manual = await fetch(`${url}/rest/workflows/${wf.id}/run?pushRef=smoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
const testResp = await post('/webhook-test/smoke', { a: 1, b: 2 });
await post(`/rest/workflows/${wf.id}/activate`, {});
const prodResp = await post('/webhook/smoke', { a: 20, b: 22 });
await new Promise((r) => setTimeout(r, 200));

console.log(JSON.stringify({ base, manual: manual.data, testResp, prodResp, pushEvents: events }, null, 1));
ws.close();
await stop();
