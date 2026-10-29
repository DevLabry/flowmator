import vm from 'node:vm';
import type { IDataObject, ILoadOptionsFunctions, INodeType, ISupplyDataFunctions } from '@8n8/workflow';
import { anthropicModel, listAnthropicModels, ollamaModel, openAiModel, toToolName, type HistoryMessage, type ToolSpec } from './llm';

const MAX_TOOL_OUTPUT = 20_000;
const clip = (s: string) => (s.length > MAX_TOOL_OUTPUT ? `${s.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated ${s.length - MAX_TOOL_OUTPUT} characters]` : s);
const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

const subNode = (name: string, displayName: string, description: string, output: string, icon: string, extra: Partial<INodeType['description']> = {}) => ({
  name: `8n8-ai.${name}`,
  displayName,
  description,
  group: ['transform' as const],
  version: 1,
  defaults: { name: displayName, color: '#7b61ff' },
  icon,
  inputs: [],
  outputs: [{ type: output as 'ai_tool', displayName: output.replace('ai_', '') }],
  codex: { categories: ['AI'] },
  ...extra,
});

/* ---------------- chat models ---------------- */

interface AnthropicCreds { apiKey: string; url?: string }
interface OpenAiCreds { apiKey: string; url?: string; organizationId?: string }
interface OllamaCreds { baseUrl: string; apiKey?: string }

export const AnthropicChatModel: INodeType = {
  description: {
    ...subNode('lmChatAnthropic', 'Anthropic Chat Model', 'Claude models for AI Agent and chains', 'ai_languageModel', 'fa:brain'),
    credentials: [{ name: 'anthropicApi', required: true }],
    properties: [
      { displayName: 'Model', name: 'model', type: 'options', default: 'claude-opus-5-5', typeOptions: { loadOptionsMethod: 'listModels' } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Maximum Tokens', name: 'maxTokens', type: 'number', default: 16000, description: 'Upper limit for each response' },
          {
            displayName: 'Effort',
            name: 'effort',
            type: 'options',
            default: '',
            description: 'How much the model thinks before answering. Lower is faster and cheaper.',
            options: [
              { name: 'Model Default', value: '' },
              { name: 'Low', value: 'low' },
              { name: 'Medium', value: 'medium' },
              { name: 'High', value: 'high' },
              { name: 'Extra High', value: 'xhigh' },
              { name: 'Max', value: 'max' },
            ],
          },
          { displayName: 'Refusal Fallback', name: 'refusalFallback', type: 'boolean', default: true, description: 'If Claude declines a request, let the API retry it on a fallback model (Opus 5.5, Opus 5, Fable 5.1, Sonnet 5.5)' },
        ],
      },
    ],
  },
  methods: {
    loadOptions: {
      async listModels(this: ILoadOptionsFunctions) {
        const c = await this.getCredentials<AnthropicCreds>('anthropicApi');
        return listAnthropicModels(c.apiKey, c.url || undefined);
      },
    },
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const c = await this.getCredentials<AnthropicCreds>('anthropicApi');
    const o = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
    return {
      response: anthropicModel({
        apiKey: c.apiKey,
        baseURL: c.url || undefined,
        model: this.getNodeParameter('model', itemIndex) as string,
        maxTokens: Number(o.maxTokens ?? 16000),
        effort: (o.effort as 'low') || undefined,
        refusalFallback: o.refusalFallback !== false,
        signal: this.getExecutionCancelSignal(),
      }),
    };
  },
};

export const OpenAiChatModel: INodeType = {
  description: {
    ...subNode('lmChatOpenAi', 'OpenAI Chat Model', 'OpenAI (or any OpenAI-compatible API) chat models', 'ai_languageModel', 'fa:robot'),
    credentials: [{ name: 'openAiApi', required: true }],
    properties: [
      { displayName: 'Model', name: 'model', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'listModels' } },
      { displayName: 'Options', name: 'options', type: 'collection', default: {}, options: [{ displayName: 'Maximum Tokens', name: 'maxTokens', type: 'number', default: 0, description: '0 = provider default' }] },
    ],
  },
  methods: {
    loadOptions: {
      async listModels(this: ILoadOptionsFunctions) {
        const c = await this.getCredentials<OpenAiCreds>('openAiApi');
        const res = (await this.helpers.httpRequest({ url: `${(c.url || 'https://api.openai.com/v1').replace(/\/$/, '')}/models`, headers: { authorization: `Bearer ${c.apiKey}` }, json: true })) as { data: Array<{ id: string }> };
        return res.data.map((m) => ({ name: m.id, value: m.id })).sort((a, b) => a.name.localeCompare(b.name));
      },
    },
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const c = await this.getCredentials<OpenAiCreds>('openAiApi');
    const model = this.getNodeParameter('model', itemIndex) as string;
    if (!model) throw new Error('Select a model in the OpenAI Chat Model node');
    const o = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
    return {
      response: openAiModel({ apiKey: c.apiKey, baseURL: c.url || 'https://api.openai.com/v1', organization: c.organizationId, model, maxTokens: Number(o.maxTokens) || undefined, signal: this.getExecutionCancelSignal() }),
    };
  },
};

export const OllamaChatModel: INodeType = {
  description: {
    ...subNode('lmChatOllama', 'Ollama Chat Model', 'Local models served by Ollama', 'ai_languageModel', 'fa:server'),
    credentials: [{ name: 'ollamaApi', required: true }],
    properties: [
      { displayName: 'Model', name: 'model', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'listModels' } },
      { displayName: 'Options', name: 'options', type: 'collection', default: {}, options: [{ displayName: 'Context Length', name: 'numCtx', type: 'number', default: 0, description: '0 = model default' }] },
    ],
  },
  methods: {
    loadOptions: {
      async listModels(this: ILoadOptionsFunctions) {
        const c = await this.getCredentials<OllamaCreds>('ollamaApi');
        const res = (await this.helpers.httpRequest({ url: `${c.baseUrl.replace(/\/$/, '')}/api/tags`, json: true })) as { models: Array<{ name: string }> };
        return res.models.map((m) => ({ name: m.name, value: m.name }));
      },
    },
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const c = await this.getCredentials<OllamaCreds>('ollamaApi');
    const model = this.getNodeParameter('model', itemIndex) as string;
    if (!model) throw new Error('Select a model in the Ollama Chat Model node');
    const o = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
    return { response: ollamaModel({ baseURL: c.baseUrl, apiKey: c.apiKey, model, numCtx: Number(o.numCtx) || undefined, signal: this.getExecutionCancelSignal() }) };
  },
};

/* ---------------- memory ---------------- */

export interface AgentMemory {
  load(): Promise<HistoryMessage[]>;
  save(input: string, output: string): Promise<void>;
  clear(): Promise<void>;
}

/** In-process conversation buffers, keyed by workflow and session. Lost on restart, like n8n's Simple Memory. */
const buffers = new Map<string, HistoryMessage[]>();

export const SimpleMemory: INodeType = {
  description: {
    ...subNode('memoryBufferWindow', 'Simple Memory', 'Remembers the last messages of each chat session (in memory, cleared on restart)', 'ai_memory', 'fa:database'),
    properties: [
      { displayName: 'Session Key', name: 'sessionKey', type: 'string', default: '={{ $json.sessionId }}', description: 'Messages are stored per value of this key' },
      { displayName: 'Context Window Length', name: 'contextWindowLength', type: 'number', default: 5, description: 'How many past exchanges (user + reply) to send to the model' },
    ],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const session = String(this.getNodeParameter('sessionKey', itemIndex) ?? '') || 'default';
    const window = Math.max(1, Number(this.getNodeParameter('contextWindowLength', itemIndex, 5)));
    const key = `${this.getWorkflow().id ?? 'unsaved'}:${session}`;
    const memory: AgentMemory = {
      async load() {
        return (buffers.get(key) ?? []).slice(-window * 2);
      },
      async save(input, output) {
        const list = buffers.get(key) ?? [];
        list.push({ role: 'user', text: input }, { role: 'assistant', text: output });
        buffers.set(key, list.slice(-200));
      },
      async clear() {
        buffers.delete(key);
      },
    };
    return { response: memory };
  },
};

/* ---------------- tools ---------------- */

/** Tiny arithmetic evaluator (no eval): + - * / % ^, parentheses, functions and constants. */
export function calculate(expression: string): number {
  const src = expression.replace(/\s+/g, '').replace(/\*\*/g, '^').replace(/,(?=\d{3}\b)/g, '');
  let pos = 0;
  const fns: Record<string, (...a: number[]) => number> = {
    sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, sin: Math.sin, cos: Math.cos, tan: Math.tan,
    log: Math.log10, ln: Math.log, exp: Math.exp, min: Math.min, max: Math.max, pow: Math.pow,
  };
  const consts: Record<string, number> = { pi: Math.PI, e: Math.E };
  const peek = () => src[pos];
  const expect = (c: string) => {
    if (src[pos] !== c) throw new Error(`Expected "${c}" at position ${pos}`);
    pos++;
  };
  const primary = (): number => {
    if (peek() === '(') {
      pos++;
      const v = expr();
      expect(')');
      return v;
    }
    if (peek() === '-') {
      pos++;
      return -factor();
    }
    if (peek() === '+') {
      pos++;
      return factor();
    }
    const num = src.slice(pos).match(/^\d*\.?\d+(e[+-]?\d+)?/i);
    if (num) {
      pos += num[0].length;
      return Number(num[0]);
    }
    const id = src.slice(pos).match(/^[a-z]+/i);
    if (id) {
      pos += id[0].length;
      const name = id[0].toLowerCase();
      if (peek() === '(') {
        pos++;
        const args = [expr()];
        while (peek() === ',') {
          pos++;
          args.push(expr());
        }
        expect(')');
        if (!fns[name]) throw new Error(`Unknown function ${name}`);
        return fns[name](...args);
      }
      if (name in consts) return consts[name];
      throw new Error(`Unknown name ${name}`);
    }
    throw new Error(`Unexpected "${peek() ?? 'end'}" at position ${pos}`);
  };
  const factor = (): number => {
    let v = primary();
    while (peek() === '%' && !/[\d(a-z]/i.test(src[pos + 1] ?? '')) {
      pos++;
      v /= 100;
    }
    if (peek() === '^') {
      pos++;
      return v ** factor();
    }
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = src[pos++];
      const r = factor();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = src[pos++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const result = expr();
  if (pos < src.length) throw new Error(`Unexpected "${src[pos]}" at position ${pos}`);
  return result;
}

export const CalculatorTool: INodeType = {
  description: { ...subNode('toolCalculator', 'Calculator', 'Lets the agent do exact arithmetic', 'ai_tool', 'fa:calculator'), properties: [] },
  async supplyData(this: ISupplyDataFunctions) {
    const tool: ToolSpec = {
      name: 'calculator',
      description: 'Evaluates an arithmetic expression exactly. Supports + - * / % ^, parentheses, sqrt, abs, round, floor, ceil, min, max, pow, sin, cos, tan, log (base 10), ln, exp, pi, e.',
      inputSchema: { type: 'object', properties: { expression: { type: 'string', description: 'e.g. (12.5 * 4) / 3' } }, required: ['expression'] },
      async invoke(input) {
        return String(calculate(String(input.expression ?? '')));
      },
    };
    return { response: tool };
  },
};

const toolDescriptionProp = { displayName: 'Description', name: 'toolDescription', type: 'string' as const, typeOptions: { rows: 2 }, default: '', required: true, description: 'Tells the agent what this tool does and when to use it' };

export const CodeTool: INodeType = {
  description: {
    ...subNode('toolCode', 'Code Tool', 'Runs your JavaScript when the agent calls it', 'ai_tool', 'fa:code'),
    properties: [
      toolDescriptionProp,
      { displayName: 'JavaScript', name: 'jsCode', type: 'string', typeOptions: { editor: 'codeNodeEditor', editorLanguage: 'javaScript' }, default: '// `query` holds what the agent sent\nreturn `You asked: ${query}`;' },
      { displayName: 'Specify Input Schema', name: 'specifyInputSchema', type: 'boolean', default: false },
      { displayName: 'Input Schema (JSON Schema)', name: 'inputSchema', type: 'json', default: '{\n  "type": "object",\n  "properties": {\n    "query": { "type": "string" }\n  },\n  "required": ["query"]\n}', displayOptions: { show: { specifyInputSchema: [true] } } },
    ],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const code = this.getNodeParameter('jsCode', itemIndex) as string;
    const custom = this.getNodeParameter('specifyInputSchema', itemIndex, false) as boolean;
    const rawSchema = custom ? this.getNodeParameter('inputSchema', itemIndex) : null;
    const schema = rawSchema ? (typeof rawSchema === 'string' ? JSON.parse(rawSchema) : rawSchema) : { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
    const tool: ToolSpec = {
      name: toToolName(this.getNode().name),
      description: this.getNodeParameter('toolDescription', itemIndex) as string,
      inputSchema: schema,
      invoke: async (input) => {
        const sandbox = { ...input, query: custom ? input : input.query, console, fetch, URL, Buffer, JSON, Math, Date };
        const result = await new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'CodeTool' }).runInContext(vm.createContext(sandbox));
        return clip(asText(result ?? ''));
      },
    };
    return { response: tool };
  },
};

type Placeholder = { name: string; description?: string; type?: 'string' | 'number' | 'boolean' };

export const HttpRequestTool: INodeType = {
  description: {
    ...subNode('toolHttpRequest', 'HTTP Request Tool', 'Lets the agent call an API', 'ai_tool', 'fa:globe'),
    credentials: [
      { name: 'httpHeaderAuth', displayOptions: { show: { authentication: ['httpHeaderAuth'] } } },
      { name: 'httpBearerAuth', displayOptions: { show: { authentication: ['httpBearerAuth'] } } },
      { name: 'httpQueryAuth', displayOptions: { show: { authentication: ['httpQueryAuth'] } } },
      { name: 'httpBasicAuth', displayOptions: { show: { authentication: ['httpBasicAuth'] } } },
    ],
    properties: [
      toolDescriptionProp,
      { displayName: 'Method', name: 'method', type: 'options', default: 'GET', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ name: m, value: m })) },
      { displayName: 'URL', name: 'url', type: 'string', default: '', required: true, placeholder: 'https://api.example.com/users/{userId}', hint: 'Use {name} for values the agent fills in' },
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'none',
        options: [
          { name: 'None', value: 'none' },
          { name: 'Header Auth', value: 'httpHeaderAuth' },
          { name: 'Bearer Auth', value: 'httpBearerAuth' },
          { name: 'Query Auth', value: 'httpQueryAuth' },
          { name: 'Basic Auth', value: 'httpBasicAuth' },
        ],
      },
      { displayName: 'JSON Body', name: 'jsonBody', type: 'json', default: '', displayOptions: { show: { method: ['POST', 'PUT', 'PATCH'] } }, hint: 'Placeholders like {name} are replaced with JSON values' },
      {
        displayName: 'Placeholders',
        name: 'placeholders',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        options: [
          {
            name: 'values',
            displayName: 'Placeholder',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              { displayName: 'Description', name: 'description', type: 'string', default: '' },
              { displayName: 'Type', name: 'type', type: 'options', default: 'string', options: ['string', 'number', 'boolean'].map((t) => ({ name: t, value: t })) },
            ],
          },
        ],
      },
    ],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const method = this.getNodeParameter('method', itemIndex) as 'GET';
    const urlTemplate = this.getNodeParameter('url', itemIndex) as string;
    const bodyTemplate = method === 'GET' || method === 'DELETE' ? '' : String(this.getNodeParameter('jsonBody', itemIndex, '') ?? '');
    const auth = this.getNodeParameter('authentication', itemIndex, 'none') as string;
    const placeholders = ((this.getNodeParameter('placeholders.values', itemIndex, []) as Placeholder[]) ?? []).filter((p) => p.name);
    const helpers = this.helpers;
    const tool: ToolSpec = {
      name: toToolName(this.getNode().name),
      description: this.getNodeParameter('toolDescription', itemIndex) as string,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(placeholders.map((p) => [p.name, { type: p.type ?? 'string', ...(p.description ? { description: p.description } : {}) }])),
        required: placeholders.map((p) => p.name),
      },
      async invoke(input) {
        let url = urlTemplate;
        let body = bodyTemplate;
        for (const p of placeholders) {
          const v = input[p.name];
          url = url.replaceAll(`{${p.name}}`, encodeURIComponent(String(v ?? '')));
          body = body.replaceAll(`"{${p.name}}"`, JSON.stringify(v ?? null)).replaceAll(`{${p.name}}`, typeof v === 'string' ? v : JSON.stringify(v ?? null));
        }
        const request = { method, url, ...(body.trim() ? { body: JSON.parse(body) } : {}), returnFullResponse: true, ignoreHttpStatusErrors: true, encoding: 'text' as const };
        const res = (auth === 'none' ? await helpers.httpRequest(request) : await helpers.httpRequestWithAuthentication(auth, request)) as { statusCode: number; body: string };
        return clip(res.statusCode >= 400 ? `HTTP ${res.statusCode}: ${res.body}` : res.body);
      },
    };
    return { response: tool };
  },
};

type WorkflowField = { name: string; type?: string; description?: string };

export const WorkflowTool: INodeType = {
  description: {
    ...subNode('toolWorkflow', 'Call Workflow Tool', 'Lets the agent run one of your workflows', 'ai_tool', 'fa:sign-in-alt'),
    properties: [
      toolDescriptionProp,
      { displayName: 'Workflow', name: 'workflowId', type: 'resourceLocator', default: { __rl: true, mode: 'id', value: '' }, modes: [{ displayName: 'By ID', name: 'id', type: 'string', placeholder: 'Workflow ID' }] },
      {
        displayName: 'Workflow Inputs',
        name: 'fields',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        options: [
          {
            name: 'values',
            displayName: 'Input',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              { displayName: 'Description', name: 'description', type: 'string', default: '' },
              { displayName: 'Type', name: 'type', type: 'options', default: 'string', options: ['string', 'number', 'boolean', 'object', 'array'].map((t) => ({ name: t, value: t })) },
            ],
          },
        ],
      },
    ],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const workflowId = this.getNodeParameter('workflowId', itemIndex, undefined, { extractValue: true }) as string;
    if (!workflowId) throw new Error(`Select the workflow for tool "${this.getNode().name}"`);
    const fields = ((this.getNodeParameter('fields.values', itemIndex, []) as WorkflowField[]) ?? []).filter((f) => f.name);
    const ctx = this;
    const tool: ToolSpec = {
      name: toToolName(this.getNode().name),
      description: this.getNodeParameter('toolDescription', itemIndex) as string,
      inputSchema: fields.length
        ? { type: 'object', properties: Object.fromEntries(fields.map((f) => [f.name, { type: f.type ?? 'string', ...(f.description ? { description: f.description } : {}) }])), required: fields.map((f) => f.name) }
        : { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async invoke(input) {
        const result = await ctx.executeWorkflow({ id: String(workflowId) }, [{ json: input as IDataObject }], { waitForSubWorkflow: true });
        const items = result.data?.[0] ?? [];
        return clip(asText(items.length === 1 ? items[0].json : items.map((i) => i.json)));
      },
    };
    return { response: tool };
  },
};

/* ---------------- output parser ---------------- */

export interface OutputParser {
  instructions: string;
  parse(text: string): unknown;
}

/** JSON Schema guessed from an example value. */
export function schemaFromExample(v: unknown): Record<string, unknown> {
  if (Array.isArray(v)) return { type: 'array', items: v.length ? schemaFromExample(v[0]) : {} };
  if (v === null) return { type: ['string', 'null'] };
  if (typeof v === 'object') {
    const props = Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, schemaFromExample(x)]));
    return { type: 'object', properties: props, required: Object.keys(props) };
  }
  return { type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string' };
}

function checkSchema(value: unknown, schema: Record<string, unknown>, path = '$'): string[] {
  const types = ([] as unknown[]).concat(schema.type ?? []);
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const numberOk = actual === 'number' && types.includes('integer') && Number.isInteger(value);
  if (types.length && !types.includes(actual) && !numberOk) return [`${path} should be ${types.join(' or ')}, got ${actual}`];
  const errors: string[] = [];
  if (actual === 'object') {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const r of (schema.required as string[]) ?? []) if (!(r in (value as object))) errors.push(`${path}.${r} is missing`);
    for (const [k, s] of Object.entries(props)) if (k in (value as object)) errors.push(...checkSchema((value as Record<string, unknown>)[k], s, `${path}.${k}`));
  }
  if (actual === 'array' && schema.items) (value as unknown[]).forEach((x, i) => errors.push(...checkSchema(x, schema.items as Record<string, unknown>, `${path}[${i}]`)));
  return errors;
}

/** Pulls JSON out of a reply that may wrap it in a code fence or surrounding text. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('The reply did not contain JSON');
  }
}

export const StructuredOutputParser: INodeType = {
  description: {
    ...subNode('outputParserStructured', 'Structured Output Parser', 'Makes the agent answer with JSON in a given shape', 'ai_outputParser', 'fa:code'),
    properties: [
      { displayName: 'Schema Type', name: 'schemaType', type: 'options', default: 'fromJson', options: [{ name: 'Generate From JSON Example', value: 'fromJson' }, { name: 'Define Using JSON Schema', value: 'manual' }] },
      { displayName: 'JSON Example', name: 'jsonSchemaExample', type: 'json', default: '{\n  "state": "California",\n  "cities": ["Los Angeles", "San Francisco"]\n}', displayOptions: { show: { schemaType: ['fromJson'] } } },
      { displayName: 'Input Schema', name: 'inputSchema', type: 'json', default: '{\n  "type": "object",\n  "properties": {\n    "state": { "type": "string" }\n  },\n  "required": ["state"]\n}', displayOptions: { show: { schemaType: ['manual'] } } },
    ],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const type = this.getNodeParameter('schemaType', itemIndex) as string;
    const raw = this.getNodeParameter(type === 'fromJson' ? 'jsonSchemaExample' : 'inputSchema', itemIndex);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const schema = type === 'fromJson' ? schemaFromExample(parsed) : (parsed as Record<string, unknown>);
    const parser: OutputParser = {
      instructions: `Your final answer must be only a JSON value (no other text) that matches this JSON Schema:\n${JSON.stringify(schema, null, 2)}`,
      parse(text) {
        const value = extractJson(text);
        const errors = checkSchema(value, schema);
        if (errors.length) throw new Error(`The reply does not match the schema: ${errors.slice(0, 5).join('; ')}`);
        return value;
      },
    };
    return { response: parser };
  },
};
