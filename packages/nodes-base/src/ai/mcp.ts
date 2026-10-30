import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type {
  IDataObject,
  ILoadOptionsFunctions,
  INodeProperties,
  INodeType,
  ISupplyDataFunctions,
  IWebhookFunctions,
  IWebhookResult,
} from '@flowmator/workflow';
import { toToolName, type ToolSpec } from './llm';
import { subNode } from './subnodes';

/* ---------------- shared auth ---------------- */

const authProps: INodeProperties[] = [
  {
    displayName: 'Authentication',
    name: 'authentication',
    type: 'options',
    default: 'none',
    options: [
      { name: 'None', value: 'none' },
      { name: 'Bearer Auth', value: 'bearerAuth' },
      { name: 'Header Auth', value: 'headerAuth' },
    ],
  },
];
const authCredentials = [
  { name: 'httpBearerAuth', required: true, displayOptions: { show: { authentication: ['bearerAuth'] } } },
  { name: 'httpHeaderAuth', required: true, displayOptions: { show: { authentication: ['headerAuth'] } } },
];

type AnyContext = ISupplyDataFunctions | ILoadOptionsFunctions | IWebhookFunctions;

/** Sub-node contexts take an item index, load-options and webhook contexts do not. */
const param = (ctx: AnyContext, name: string, fallback: unknown) =>
  'getInputData' in ctx ? (ctx as ISupplyDataFunctions).getNodeParameter(name, 0, fallback) : (ctx as ILoadOptionsFunctions).getNodeParameter(name, fallback);

async function authHeaders(ctx: AnyContext): Promise<Record<string, string>> {
  const auth = param(ctx, 'authentication', 'none') as string;
  if (auth === 'bearerAuth') return { authorization: `Bearer ${(await ctx.getCredentials<{ token: string }>('httpBearerAuth')).token}` };
  if (auth === 'headerAuth') {
    const c = await ctx.getCredentials<{ name: string; value: string }>('httpHeaderAuth');
    return { [c.name.toLowerCase()]: c.value };
  }
  return {};
}

/* ---------------- MCP Client Tool ---------------- */

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

async function connect(endpoint: string, transport: string, headers: Record<string, string>, timeoutMs: number) {
  if (!/^https?:\/\//.test(endpoint)) throw new Error('The SSE / HTTP endpoint must be an http(s) URL');
  const client = new Client({ name: 'flowmator-mcp-client', version: '1.0.0' });
  const url = new URL(endpoint);
  const requestInit = { headers };
  const t =
    transport === 'sse'
      ? new SSEClientTransport(url, { requestInit, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } }) } })
      : new StreamableHTTPClientTransport(url, { requestInit });
  try {
    await client.connect(t, { timeout: timeoutMs });
  } catch (e) {
    throw new Error(`Could not connect to the MCP server at ${endpoint}: ${(e as Error).message}`);
  }
  return client;
}

async function listAllTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(page.tools as McpTool[]));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

/** MCP tool results are content blocks: text stays text, everything else is described as JSON. */
function resultText(result: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; toolResult?: unknown }) {
  if (result.content?.length) return result.content.map((c) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c))).join('\n');
  return JSON.stringify(result.structuredContent ?? result.toolResult ?? '');
}

const clientParams = (ctx: AnyContext) => ({
  endpoint: String(param(ctx, 'endpointUrl', '') ?? '').trim(),
  transport: param(ctx, 'serverTransport', 'httpStreamable') as string,
  timeout: Number(param(ctx, 'options.timeout', 60000)),
});

export const McpClientTool: INodeType = {
  description: {
    ...subNode('mcpClientTool', 'MCP Client Tool', 'Gives the agent the tools of an MCP server', 'ai_tool', 'fa:plug'),
    credentials: authCredentials,
    codex: { categories: ['AI'], alias: ['MCP', 'Model Context Protocol'] },
    properties: [
      { displayName: 'Endpoint', name: 'endpointUrl', type: 'string', default: '', required: true, placeholder: 'https://mcp.example.com/mcp' },
      {
        displayName: 'Server Transport',
        name: 'serverTransport',
        type: 'options',
        default: 'httpStreamable',
        options: [
          { name: 'HTTP Streamable', value: 'httpStreamable' },
          { name: 'Server Sent Events (Deprecated)', value: 'sse' },
        ],
      },
      ...authProps,
      {
        displayName: 'Tools to Include',
        name: 'include',
        type: 'options',
        default: 'all',
        options: [
          { name: 'All', value: 'all' },
          { name: 'Selected', value: 'selected' },
          { name: 'All Except', value: 'except' },
        ],
      },
      { displayName: 'Tools to Include', name: 'includeTools', type: 'multiOptions', default: [], typeOptions: { loadOptionsMethod: 'getTools' }, displayOptions: { show: { include: ['selected'] } } },
      { displayName: 'Tools to Exclude', name: 'excludeTools', type: 'multiOptions', default: [], typeOptions: { loadOptionsMethod: 'getTools' }, displayOptions: { show: { include: ['except'] } } },
      { displayName: 'Options', name: 'options', type: 'collection', default: {}, options: [{ displayName: 'Timeout', name: 'timeout', type: 'number', default: 60000, description: 'Milliseconds to wait for each request to the server' }] },
    ],
  },
  methods: {
    loadOptions: {
      async getTools(this: ILoadOptionsFunctions) {
        const { endpoint, transport, timeout } = clientParams(this);
        const client = await connect(endpoint, transport, await authHeaders(this), timeout);
        try {
          return (await listAllTools(client)).map((t) => ({ name: t.name, value: t.name, description: t.description }));
        } finally {
          await client.close();
        }
      },
    },
  },
  async supplyData(this: ISupplyDataFunctions) {
    const { endpoint, transport, timeout } = clientParams(this);
    const client = await connect(endpoint, transport, await authHeaders(this), timeout);
    const include = this.getNodeParameter('include', 0, 'all') as string;
    const picked = new Set((this.getNodeParameter(include === 'selected' ? 'includeTools' : 'excludeTools', 0, []) as string[]) ?? []);
    const all = await listAllTools(client);
    const chosen = all.filter((t) => (include === 'selected' ? picked.has(t.name) : include === 'except' ? !picked.has(t.name) : true));
    if (!chosen.length) throw new Error(all.length ? 'No tools selected' : 'The MCP server offers no tools');
    const signal = this.getExecutionCancelSignal();
    const tools: ToolSpec[] = chosen.map((t) => ({
      name: toToolName(t.name),
      description: t.description ?? t.name,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      async invoke(input) {
        const result = await client.callTool({ name: t.name, arguments: input }, undefined, { timeout, signal });
        const text = resultText(result as never);
        // a tool error goes back to the agent as an error so it can react
        if (result.isError) throw new Error(text);
        return text;
      },
    }));
    return { response: tools, closeFunction: () => client.close() };
  },
};

/* ---------------- MCP Server Trigger ---------------- */

type JsonRpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: IDataObject };

const rpcResult = (id: JsonRpcRequest['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: JsonRpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * A stateless MCP server over Streamable HTTP: every POST carries one JSON-RPC message (or a batch) and
 * gets a plain JSON answer. No session ids and no server-initiated stream, which the spec allows.
 */
export const McpServerTrigger: INodeType = {
  description: {
    name: 'flowmator-ai.mcpTrigger',
    displayName: 'MCP Server Trigger',
    description: 'Lets MCP clients (Claude, IDEs, other agents) call the tools connected to this node',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'MCP Server Trigger', color: '#7b61ff' },
    icon: 'fa:plug',
    inputs: [{ type: 'ai_tool', displayName: 'Tools' }],
    outputs: [],
    credentials: authCredentials,
    codex: { categories: ['AI'], alias: ['MCP', 'Model Context Protocol', 'Server'] },
    webhooks: [
      { name: 'default', httpMethod: 'POST', path: '={{$parameter["path"]}}', isFullPath: true },
      { name: 'setup', httpMethod: 'GET', path: '={{$parameter["path"]}}', isFullPath: true },
    ],
    properties: [
      ...authProps,
      { displayName: 'Path', name: 'path', type: 'string', default: '', placeholder: 'my-tools', description: 'Leave empty to use the node id. MCP clients connect to the URL above.' },
    ],
  },
  async webhook(this: IWebhookFunctions): Promise<IWebhookResult> {
    const json = (statusCode: number, body: unknown, headers: Record<string, string> = {}) => ({ webhookResponse: { statusCode, headers: { 'content-type': 'application/json', ...headers }, body } });
    if (this.getWebhookName() === 'setup') {
      // no server-to-client stream: tell the client to use POST only
      return { webhookResponse: { statusCode: 405, headers: { allow: 'POST' }, body: '' } };
    }

    const expected = await authHeaders(this);
    const got = this.getHeaderData();
    for (const [name, value] of Object.entries(expected)) {
      if (got[name] !== value) return json(401, rpcError(null, -32001, 'Unauthorized'), { 'www-authenticate': 'Bearer' });
    }

    const body = this.getBodyData() as unknown;
    const messages = (Array.isArray(body) ? body : [body]) as JsonRpcRequest[];
    if (!messages.length || messages.some((m) => !m || typeof m !== 'object' || m.jsonrpc !== '2.0')) return json(400, rpcError(null, -32600, 'Invalid JSON-RPC message'));

    let tools: ToolSpec[] | undefined;
    const loadTools = async () => (tools ??= ((await this.getInputConnectionData('ai_tool', 0)) as Array<ToolSpec | ToolSpec[]>).flat());

    const handle = async (m: JsonRpcRequest) => {
      switch (m.method) {
        case 'initialize': {
          const asked = String(m.params?.protocolVersion ?? '');
          return rpcResult(m.id, {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: `flowmator · ${this.getWorkflow().name}`, version: '1.0.0' },
          });
        }
        case 'ping':
          return rpcResult(m.id, {});
        case 'tools/list':
          return rpcResult(m.id, { tools: (await loadTools()).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
        case 'tools/call': {
          const name = String(m.params?.name ?? '');
          const tool = (await loadTools()).find((t) => t.name === name);
          if (!tool) return rpcError(m.id, -32602, `Unknown tool: ${name}`);
          try {
            const text = await tool.invoke((m.params?.arguments ?? {}) as Record<string, unknown>);
            return rpcResult(m.id, { content: [{ type: 'text', text }] });
          } catch (e) {
            return rpcResult(m.id, { content: [{ type: 'text', text: (e as Error).message }], isError: true });
          }
        }
        default:
          return rpcError(m.id, -32601, `Method not found: ${m.method}`);
      }
    };

    const answers = [];
    for (const m of messages) {
      // notifications and responses get no answer
      if (m.id === undefined || !m.method) continue;
      answers.push(await handle(m));
    }
    if (!answers.length) return { webhookResponse: { statusCode: 202, body: '' } };
    return json(200, Array.isArray(body) ? answers : answers[0]);
  },
};
