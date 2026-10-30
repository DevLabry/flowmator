import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src';

/**
 * The MCP Server Trigger serves the tools connected to it; the MCP Client Tool gives an agent the tools
 * of an MCP server. Here one Flowmator instance does both, with a fake Claude answering the agent.
 */

let app: App;
let dir: string;
let base: string;
let claude: Server;
let claudeUrl: string;
const claudeRequests: any[] = [];
const claudeAnswers: unknown[] = [];

beforeAll(async () => {
  claude = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      claudeRequests.push(JSON.parse(raw));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(claudeAnswers.shift() ?? { error: { message: 'no answer scripted' } }));
    });
  });
  await new Promise<void>((r) => claude.listen(0, '127.0.0.1', r));
  claudeUrl = `http://127.0.0.1:${(claude.address() as AddressInfo).port}`;

  dir = mkdtempSync(path.join(os.tmpdir(), 'flowmator-mcp-'));
  app = await createApp({ userFolder: dir, port: 0, host: '127.0.0.1', webhookUrl: 'http://localhost:5678/', encryptionKey: 'test-key' });
  base = (await app.start()).replace(/\/$/, '');
});

afterAll(async () => {
  await app.stop();
  claude.close();
  rmSync(dir, { recursive: true, force: true });
});

const api = async (method: string, url: string, payload?: unknown) => {
  const res = await app.app.inject({ method: method as 'GET', url, payload: payload as never });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
};

let n = 0;
const node = (name: string, type: string, parameters: Record<string, unknown> = {}, credentials?: Record<string, { id: string; name: string }>) => ({
  id: `n${++n}`,
  name,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters,
  ...(credentials ? { credentials } : {}),
});
const toTarget = (target: string, type: string) => ({ [type]: [[{ node: target, type, index: 0 }]] });

const claudeMessage = (content: unknown[], stop_reason: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

let token: { id: string; name: string };

describe('MCP', () => {
  beforeAll(async () => {
    const cred = (await api('POST', '/rest/credentials', { name: 'MCP token', type: 'httpBearerAuth', data: { token: 's3cret' } })).body.data;
    token = { id: cred.id, name: cred.name };
    const wf = (
      await api('POST', '/rest/workflows', {
        name: 'MCP tools',
        nodes: [
          node('MCP Server', 'flowmator-ai.mcpTrigger', { path: 'my-tools', authentication: 'bearerAuth' }, { httpBearerAuth: token }),
          node('calculator', 'flowmator-ai.toolCalculator'),
          node('shout', 'flowmator-ai.toolCode', { toolDescription: 'Upper-cases text', jsCode: 'return query.toUpperCase();' }),
        ],
        connections: { calculator: toTarget('MCP Server', 'ai_tool'), shout: toTarget('MCP Server', 'ai_tool') },
      })
    ).body.data;
    const activated = await api('POST', `/rest/workflows/${wf.id}/activate`);
    expect(activated.body.data.active).toBe(true);
  });

  const connect = async (headers: Record<string, string>) => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/webhook/my-tools`), { requestInit: { headers } }));
    return client;
  };

  it('serves the connected tools to an MCP client', async () => {
    const client = await connect({ authorization: 'Bearer s3cret' });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['calculator', 'shout']);
    expect(tools.find((t) => t.name === 'shout')).toMatchObject({ description: 'Upper-cases text', inputSchema: { required: ['query'] } });

    expect(await client.callTool({ name: 'calculator', arguments: { expression: '6*7' } })).toEqual({ content: [{ type: 'text', text: '42' }] });
    expect(await client.callTool({ name: 'shout', arguments: { query: 'hi' } })).toEqual({ content: [{ type: 'text', text: 'HI' }] });
    // tool failures are results with isError, not protocol errors
    const failed = await client.callTool({ name: 'calculator', arguments: { expression: '2 +' } });
    expect(failed.isError).toBe(true);
    await client.close();
  });

  it('rejects clients without the token and answers GET with 405', async () => {
    await expect(connect({ authorization: 'Bearer wrong' })).rejects.toThrow(/401|Unauthorized/);
    const get = await fetch(`${base}/webhook/my-tools`);
    expect(get.status).toBe(405);
    const unknown = await fetch(`${base}/webhook/my-tools`, {
      method: 'POST',
      headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'resources/list' }),
    });
    expect(await unknown.json()).toEqual({ jsonrpc: '2.0', id: 9, error: { code: -32601, message: 'Method not found: resources/list' } });
  });

  it('lists the server tools in the MCP Client Tool node', async () => {
    const res = await api('POST', '/rest/dynamic-node-parameters/options', {
      nodeTypeAndVersion: { name: 'flowmator-ai.mcpClientTool', version: 1 },
      methodName: 'getTools',
      currentNodeParameters: { endpointUrl: `${base}/webhook/my-tools`, authentication: 'bearerAuth' },
      credentials: { httpBearerAuth: token },
    });
    expect(res.body.data.map((o: { value: string }) => o.value).sort()).toEqual(['calculator', 'shout']);
  });

  it('lets an agent call the tools of an MCP server', async () => {
    const anthropic = (await api('POST', '/rest/credentials', { name: 'Claude', type: 'anthropicApi', data: { apiKey: 'k', url: claudeUrl } })).body.data;
    claudeRequests.length = 0;
    claudeAnswers.push(claudeMessage([{ type: 'tool_use', id: 'c1', name: 'calculator', input: { expression: '12*12' } }], 'tool_use'), claudeMessage([{ type: 'text', text: '144' }], 'end_turn'));
    const wf = (
      await api('POST', '/rest/workflows', {
        name: 'MCP agent',
        nodes: [
          node('Start', 'flowmator.manualTrigger'),
          node('Agent', 'flowmator-ai.agent', { promptType: 'define', text: '12 squared?' }),
          node('Model', 'flowmator-ai.lmChatAnthropic', { model: 'claude-opus-5-5', options: { refusalFallback: false } }, { anthropicApi: { id: anthropic.id, name: anthropic.name } }),
          node('MCP', 'flowmator-ai.mcpClientTool', { endpointUrl: `${base}/webhook/my-tools`, authentication: 'bearerAuth', include: 'selected', includeTools: ['calculator'] }, { httpBearerAuth: token }),
        ],
        connections: { Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] }, Model: toTarget('Agent', 'ai_languageModel'), MCP: toTarget('Agent', 'ai_tool') },
      })
    ).body.data;
    const res = (await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {})).body.data;
    expect(res.status).toBe('success');
    expect(res.data.runData.Agent[0].data.main[0][0].json).toEqual({ output: '144' });
    expect(claudeRequests[0].tools.map((t: { name: string }) => t.name)).toEqual(['calculator']);
    expect(claudeRequests[1].messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', content: '144' });
  });
});
