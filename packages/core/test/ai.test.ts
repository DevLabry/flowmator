import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { calculate, extractJson, schemaFromExample } from '@flowmator/nodes-base';
import type { IConnections, INode } from '@flowmator/workflow';
import type { ICredentialsHelper } from '../src';
import { items, makeWorkflow, node, out, run } from './helpers';

/* ---------- fake model server: Claude, OpenAI and Ollama wire formats ---------- */

interface Captured {
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}
let server: Server;
let base: string;
const requests: Captured[] = [];
/** Next responses per route; each entry is the JSON body to return. */
const queue: Record<string, unknown[]> = { anthropic: [], openai: [], ollama: [] };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      res.setHeader('content-type', 'application/json');
      if (url.pathname.startsWith('/weather/')) return res.end(JSON.stringify({ city: decodeURIComponent(url.pathname.split('/')[2]), tempC: 21 }));
      const route = url.pathname.startsWith('/v1/messages') ? 'anthropic' : url.pathname.endsWith('/chat/completions') ? 'openai' : url.pathname === '/api/chat' ? 'ollama' : '';
      requests.push({ path: url.pathname + url.search, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const next = queue[route]?.shift();
      if (!next) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: { message: `no scripted response for ${route}` } }));
      }
      res.end(JSON.stringify(next));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  requests.length = 0;
  for (const k of Object.keys(queue)) queue[k] = [];
});

const claude = (content: unknown[], stop_reason: string, extra: Record<string, unknown> = {}) => ({
  id: `msg_${Math.random().toString(36).slice(2)}`,
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
  ...extra,
});

/** Credentials come straight from this map; no encryption needed for engine tests. */
const credentialsHelper: ICredentialsHelper = {
  async getDecrypted(_node, type) {
    const all: Record<string, Record<string, unknown>> = {
      anthropicApi: { apiKey: 'test-key', url: base },
      openAiApi: { apiKey: 'sk-test', url: `${base}/v1` },
      ollamaApi: { baseUrl: base },
    };
    return all[type] as never;
  },
  async authenticate(_type, _creds, request) {
    return request;
  },
};

/** Trigger → Agent, with sub-nodes attached through their AI connection types. */
function agentWorkflow(subNodes: Array<{ node: INode; type: string }>, agentParams: Record<string, unknown> = {}) {
  const connections: IConnections = { Trigger: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] } };
  for (const s of subNodes) connections[s.node.name] = { [s.type]: [[{ node: 'Agent', type: s.type, index: 0 }]] };
  return makeWorkflow([node('Trigger', 'manualTrigger'), node('Agent', 'flowmator-ai.agent', agentParams), ...subNodes.map((s) => s.node)], connections);
}
const cred = (type: string) => ({ credentials: { [type]: { id: 'c1', name: 'test' } } });
const claudeModel = (params: Record<string, unknown> = {}) => ({ node: node('Claude', 'flowmator-ai.lmChatAnthropic', { model: 'claude-opus-5-5', ...params }, cred('anthropicApi')), type: 'ai_languageModel' });
const calculator = { node: node('Calc', 'flowmator-ai.toolCalculator'), type: 'ai_tool' };
const runAgent = (wf: ReturnType<typeof makeWorkflow>, input = items({ chatInput: 'What is 2+3*4?', sessionId: 's1' })) =>
  run(wf, { triggerData: input, additional: { credentialsHelper } });

describe('AI Agent with Claude', () => {
  it('runs the tool loop and sends thinking blocks back unchanged', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' };
    queue.anthropic.push(
      claude([thinking, { type: 'tool_use', id: 'toolu_1', name: 'calculator', input: { expression: '2+3*4' } }], 'tool_use'),
      claude([{ type: 'text', text: 'The answer is 14.' }], 'end_turn'),
    );
    const r = await runAgent(agentWorkflow([claudeModel(), calculator], { options: { systemMessage: 'Be brief.', returnIntermediateSteps: true } }));
    expect(r.status).toBe('success');
    expect(out(r, 'Agent')![0]).toMatchObject({
      output: 'The answer is 14.',
      intermediateSteps: [{ action: { tool: 'calculator', toolInput: { expression: '2+3*4' } }, observation: '14' }],
      usage: { inputTokens: 20, outputTokens: 10 },
    });

    const [first, second] = requests;
    expect(first.path).toBe('/v1/messages');
    expect(first.headers.authorization).toBe('Bearer test-key');
    expect(first.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(first.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, system: 'Be brief.', fallbacks: 'default', messages: [{ role: 'user', content: 'What is 2+3*4?' }] });
    expect(first.body).not.toHaveProperty('temperature');
    expect(first.body).not.toHaveProperty('thinking');
    expect(first.body.tools[0]).toMatchObject({ name: 'calculator', input_schema: { required: ['expression'] } });
    // assistant turn echoed verbatim, then all tool results in one user message
    expect(second.body.messages[1]).toEqual({ role: 'assistant', content: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'calculator', input: { expression: '2+3*4' } }] });
    expect(second.body.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '14' }] });
  });

  it('passes effort and leaves out the fallback when disabled or unsupported', async () => {
    queue.anthropic.push(claude([{ type: 'text', text: 'ok' }], 'end_turn'), claude([{ type: 'text', text: 'ok' }], 'end_turn'));
    await runAgent(agentWorkflow([claudeModel({ options: { effort: 'low', refusalFallback: false } })]));
    await runAgent(agentWorkflow([claudeModel({ model: 'claude-haiku-5-5' })]));
    expect(requests[0].body.output_config).toEqual({ effort: 'low' });
    expect(requests[0].body).not.toHaveProperty('fallbacks');
    expect(requests[1].body).not.toHaveProperty('fallbacks');
    expect(requests[1].headers['anthropic-beta']).toBeUndefined();
  });

  it('reports refusals with their category', async () => {
    queue.anthropic.push(claude([], 'refusal', { stop_details: { type: 'refusal', category: 'cyber', explanation: 'Not allowed' } }));
    const r = await runAgent(agentWorkflow([claudeModel()]));
    expect(r.status).toBe('error');
    expect(r.data.resultData.error?.message).toBe('Claude declined the request (cyber): Not allowed');
  });

  it('feeds tool errors back to the model and stops at max iterations', async () => {
    queue.anthropic.push(
      claude([{ type: 'tool_use', id: 't1', name: 'calculator', input: { expression: '2+' } }], 'tool_use'),
      claude([{ type: 'tool_use', id: 't2', name: 'calculator', input: { expression: '1' } }], 'tool_use'),
    );
    const r = await runAgent(agentWorkflow([claudeModel(), calculator], { options: { maxIterations: 2 } }));
    expect(requests[1].body.messages[2].content[0]).toMatchObject({ tool_use_id: 't1', is_error: true });
    expect(r.status).toBe('error');
    expect(r.data.resultData.error?.message).toContain('stopped after 2 iterations');
  });

  it('remembers the conversation per session with Simple Memory', async () => {
    const memory = { node: node('Memory', 'flowmator-ai.memoryBufferWindow', { contextWindowLength: 5 }), type: 'ai_memory' };
    queue.anthropic.push(claude([{ type: 'text', text: 'Hi Ada!' }], 'end_turn'), claude([{ type: 'text', text: 'Your name is Ada.' }], 'end_turn'), claude([{ type: 'text', text: 'Who?' }], 'end_turn'));
    const wf = agentWorkflow([claudeModel(), memory]);
    await runAgent(wf, items({ chatInput: 'I am Ada', sessionId: 'mem-1' }));
    await runAgent(wf, items({ chatInput: 'What is my name?', sessionId: 'mem-1' }));
    await runAgent(wf, items({ chatInput: 'What is my name?', sessionId: 'other' }));
    expect(requests[1].body.messages).toEqual([
      { role: 'user', content: 'I am Ada' },
      { role: 'assistant', content: 'Hi Ada!' },
      { role: 'user', content: 'What is my name?' },
    ]);
    expect(requests[2].body.messages).toHaveLength(1);
  });

  it('parses structured output and asks once more when it does not match', async () => {
    const parser = { node: node('Parser', 'flowmator-ai.outputParserStructured', { schemaType: 'fromJson', jsonSchemaExample: '{"city": "Paris", "population": 1}' }), type: 'ai_outputParser' };
    queue.anthropic.push(
      claude([{ type: 'text', text: 'Sure! {"city": "Paris"}' }], 'end_turn'),
      claude([{ type: 'text', text: '```json\n{"city": "Paris", "population": 2100000}\n```' }], 'end_turn'),
    );
    const r = await runAgent(agentWorkflow([claudeModel(), parser], { promptType: 'define', text: 'Biggest city in France?' }));
    expect(out(r, 'Agent')).toEqual([{ output: { city: 'Paris', population: 2100000 } }]);
    expect(requests[0].body.system).toContain('"population"');
    expect(requests[1].body.messages.at(-1).content).toContain('$.population is missing');
  });

  it('calls an API through the HTTP Request Tool', async () => {
    const http = { node: node('Weather', 'flowmator-ai.toolHttpRequest', { toolDescription: 'Weather by city', url: `${base}/weather/{city}`, placeholders: { values: [{ name: 'city', description: 'City name' }] } }), type: 'ai_tool' };
    queue.anthropic.push(
      claude([{ type: 'tool_use', id: 't1', name: 'Weather', input: { city: 'São Paulo' } }], 'tool_use'),
      claude([{ type: 'text', text: 'It is 21°C.' }], 'end_turn'),
    );
    const r = await runAgent(agentWorkflow([claudeModel(), http]));
    expect(r.status).toBe('success');
    expect(requests[0].body.tools[0]).toMatchObject({ name: 'Weather', input_schema: { properties: { city: { type: 'string', description: 'City name' } } } });
    expect(requests[1].body.messages[2].content[0].content).toBe('{"city":"São Paulo","tempC":21}');
  });

  it('explains a missing prompt', async () => {
    const r = await runAgent(agentWorkflow([claudeModel()]), items({ other: 1 }));
    expect(r.data.resultData.error?.message).toBe('No prompt given');
  });
});

describe('other providers', () => {
  it('runs tools with an OpenAI-compatible API', async () => {
    queue.openai.push(
      { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"6*7"}' } }] } }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '42' } }] },
    );
    const model = { node: node('GPT', 'flowmator-ai.lmChatOpenAi', { model: 'some-model' }, cred('openAiApi')), type: 'ai_languageModel' };
    const r = await runAgent(agentWorkflow([model, calculator]));
    expect(out(r, 'Agent')).toEqual([{ output: '42' }]);
    expect(requests[0].headers.authorization).toBe('Bearer sk-test');
    expect(requests[0].body.tools[0]).toMatchObject({ type: 'function', function: { name: 'calculator' } });
    expect(requests[1].body.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '42' });
  });

  it('runs tools with Ollama', async () => {
    queue.ollama.push(
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'calculator', arguments: { expression: '10/4' } } }] } },
      { message: { role: 'assistant', content: '2.5' }, done_reason: 'stop' },
    );
    const model = { node: node('Llama', 'flowmator-ai.lmChatOllama', { model: 'llama3.2' }, cred('ollamaApi')), type: 'ai_languageModel' };
    const r = await runAgent(agentWorkflow([model, calculator]));
    expect(out(r, 'Agent')).toEqual([{ output: '2.5' }]);
    expect(requests[0].body).toMatchObject({ model: 'llama3.2', stream: false });
    expect(requests[1].body.messages.at(-1)).toEqual({ role: 'tool', tool_name: 'calculator', content: '2.5' });
  });
});

describe('helpers', () => {
  it('calculates without eval', () => {
    expect(calculate('2+3*4')).toBe(14);
    expect(calculate('(1+2)^2 / 3')).toBe(3);
    expect(calculate('sqrt(16) + max(1, 5) - -2')).toBe(11);
    expect(calculate('50%')).toBe(0.5);
    expect(calculate('7 % 3')).toBe(1);
    expect(() => calculate('process.exit()')).toThrow();
  });

  it('extracts JSON and builds schemas from examples', () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('text {"a":[1,2]} more')).toEqual({ a: [1, 2] });
    expect(schemaFromExample({ a: 'x', b: [1] })).toEqual({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'number' } } }, required: ['a', 'b'] });
  });
});
