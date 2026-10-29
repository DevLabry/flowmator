import {
  NodeOperationError,
  type ICredentialType,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type IWebhookFunctions,
  type IWebhookResult,
} from '@8n8/workflow';
import { errorItem } from '../utils/object';
import type { ChatModel, ToolSpec } from './llm';
import type { AgentMemory, OutputParser } from './subnodes';

interface Step {
  action: { tool: string; toolInput: Record<string, unknown> };
  observation: string;
  isError?: boolean;
}

/* ---------------- AI Agent ---------------- */

export const AiAgent: INodeType = {
  description: {
    name: '8n8-ai.agent',
    displayName: 'AI Agent',
    description: 'An agent that answers using a chat model, calling tools until it has an answer',
    group: ['transform'],
    version: [1, 2],
    defaults: { name: 'AI Agent', color: '#7b61ff' },
    icon: 'fa:robot',
    inputs: [
      'main',
      { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 },
      { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 },
      { type: 'ai_tool', displayName: 'Tool' },
      { type: 'ai_outputParser', displayName: 'Output Parser', maxConnections: 1 },
    ],
    outputs: ['main'],
    codex: { categories: ['AI'], alias: ['LLM', 'Agent', 'Claude', 'GPT', 'Chatbot'] },
    properties: [
      {
        displayName: 'Source for Prompt (User Message)',
        name: 'promptType',
        type: 'options',
        default: 'auto',
        options: [
          { name: 'Connected Chat Trigger Node', value: 'auto', description: 'Uses the chatInput field from the previous node' },
          { name: 'Define Below', value: 'define' },
        ],
      },
      { displayName: 'Prompt (User Message)', name: 'text', type: 'string', typeOptions: { rows: 2 }, default: '', required: true, displayOptions: { show: { promptType: ['define'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'System Message', name: 'systemMessage', type: 'string', typeOptions: { rows: 4 }, default: 'You are a helpful assistant.' },
          { displayName: 'Max Iterations', name: 'maxIterations', type: 'number', default: 10, description: 'Maximum model calls per item (each tool round counts as one)' },
          { displayName: 'Return Intermediate Steps', name: 'returnIntermediateSteps', type: 'boolean', default: false },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    const node = this.getNode();

    for (let i = 0; i < items.length; i++) {
      try {
        const model = (await this.getInputConnectionData('ai_languageModel', i)) as ChatModel;
        const memory = (await this.getInputConnectionData('ai_memory', i)) as AgentMemory | undefined;
        const tools = ((await this.getInputConnectionData('ai_tool', i)) as Array<ToolSpec | ToolSpec[]>).flat();
        const parser = (await this.getInputConnectionData('ai_outputParser', i)) as OutputParser | undefined;
        const options = this.getNodeParameter('options', i, {}) as IDataObject;

        const prompt =
          this.getNodeParameter('promptType', i, 'auto') === 'define'
            ? String(this.getNodeParameter('text', i) ?? '')
            : String(items[i].json.chatInput ?? '');
        if (!prompt.trim()) {
          throw new NodeOperationError(node, 'No prompt given', {
            itemIndex: i,
            description: 'Connect a Chat Trigger (it sends "chatInput") or set "Source for Prompt" to "Define Below"',
          });
        }

        const names = new Set<string>();
        for (const t of tools) {
          if (names.has(t.name)) throw new NodeOperationError(node, `Two tools are named "${t.name}". Rename one of the tool nodes.`, { itemIndex: i });
          names.add(t.name);
        }
        const byName = new Map(tools.map((t) => [t.name, t]));
        const system = [String(options.systemMessage ?? 'You are a helpful assistant.'), parser?.instructions].filter(Boolean).join('\n\n');
        const session = model.createSession({ system, history: memory ? await memory.load() : [], tools });
        const maxIterations = Math.max(1, Number(options.maxIterations ?? 10));
        const steps: Step[] = [];
        const usage = { inputTokens: 0, outputTokens: 0 };

        let turn = await session.sendUser(prompt);
        let iterations = 1;
        const add = (u: typeof usage) => {
          usage.inputTokens += u.inputTokens;
          usage.outputTokens += u.outputTokens;
        };
        add(turn.usage);

        while (!turn.done && turn.toolCalls.length) {
          if (iterations >= maxIterations) {
            throw new NodeOperationError(node, `Agent stopped after ${maxIterations} iterations without a final answer`, { itemIndex: i, description: 'Raise "Max Iterations" or simplify the task' });
          }
          // tools of one turn run concurrently; failures go back to the model as errors
          const results = await Promise.all(
            turn.toolCalls.map(async (call) => {
              const tool = byName.get(call.name);
              try {
                if (!tool) throw new Error(`Unknown tool "${call.name}"`);
                const content = await tool.invoke(call.input);
                steps.push({ action: { tool: call.name, toolInput: call.input }, observation: content });
                return { id: call.id, content };
              } catch (e) {
                const content = (e as Error).message ?? String(e);
                steps.push({ action: { tool: call.name, toolInput: call.input }, observation: content, isError: true });
                return { id: call.id, content, isError: true };
              }
            }),
          );
          turn = await session.sendToolResults(results);
          add(turn.usage);
          iterations++;
        }

        let output: unknown = turn.text;
        if (parser) {
          try {
            output = parser.parse(turn.text);
          } catch (e) {
            // one correction round, then give up
            const retry = await session.sendUser(`${(e as Error).message}. Reply again with only the JSON.`);
            add(retry.usage);
            output = parser.parse(retry.text);
          }
        }
        if (memory) await memory.save(prompt, typeof output === 'string' ? output : JSON.stringify(output));

        out.push({
          json: {
            output: output as never,
            ...(options.returnIntermediateSteps ? { intermediateSteps: steps as never, usage } : {}),
          },
          pairedItem: { item: i },
        });
      } catch (e) {
        if (this.continueOnFail()) {
          out.push(errorItem(e, i));
          continue;
        }
        throw e instanceof NodeOperationError ? e : new NodeOperationError(node, e as Error, { itemIndex: i });
      }
    }
    return [out];
  },
};

/* ---------------- Chat Trigger ---------------- */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function chatPage(o: { title: string; subtitle: string; initialMessages: string[] }) {
  // everything user-provided is escaped into the HTML or passed through JSON.stringify
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title>
<style>
:root{--bg:#f6f6f9;--card:#fff;--text:#1d1d27;--muted:#5b5b6e;--border:#dcdce5;--accent:#5b5bd6;--bot:#f0f0f6;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#15151c;--card:#1e1e27;--text:#ececf3;--muted:#a9a9bb;--border:#33333f;--accent:#7b7bf0;--bot:#2a2a36;color-scheme:dark}}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;justify-content:center}
.wrap{display:flex;flex-direction:column;width:100%;max-width:720px;height:100%;background:var(--card);border-left:1px solid var(--border);border-right:1px solid var(--border)}
header{padding:16px 20px;border-bottom:1px solid var(--border)}h1{font-size:18px;margin:0}header p{margin:2px 0 0;color:var(--muted);font-size:13px}
#log{flex:1;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:80%;padding:9px 13px;border-radius:12px;white-space:pre-wrap;word-break:break-word}.bot{background:var(--bot);align-self:flex-start;border-bottom-left-radius:4px}.me{background:var(--accent);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}.err{color:#d63e3e}
form{display:flex;gap:8px;padding:14px;border-top:1px solid var(--border)}textarea{flex:1;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px;resize:none;height:44px}
button{background:var(--accent);color:#fff;border:none;border-radius:10px;padding:0 18px;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.5}
</style></head><body><div class="wrap"><header><h1>${esc(o.title)}</h1>${o.subtitle ? `<p>${esc(o.subtitle)}</p>` : ''}</header><div id="log"></div>
<form id="f"><textarea id="t" placeholder="Type your message…" required></textarea><button id="b">Send</button></form></div>
<script>
const initial = ${JSON.stringify(o.initialMessages).replace(/</g, '\\u003c')};
const log = document.getElementById('log'), t = document.getElementById('t'), b = document.getElementById('b');
let sessionId;
try { sessionId = localStorage.getItem('8n8-chat-session') || crypto.randomUUID(); localStorage.setItem('8n8-chat-session', sessionId); } catch { sessionId = crypto.randomUUID(); }
const add = (text, cls) => { const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; };
initial.forEach((m) => add(m, 'bot'));
t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('f').requestSubmit(); } });
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = t.value.trim(); if (!text) return;
  add(text, 'me'); t.value = ''; b.disabled = true;
  const pending = add('…', 'bot');
  try {
    const res = await fetch(location.href, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'sendMessage', sessionId, chatInput: text }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || res.statusText);
    const out = data.output ?? data.text ?? data;
    pending.textContent = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
  } catch (err) { pending.textContent = 'Error: ' + err.message; pending.classList.add('err'); }
  b.disabled = false; t.focus();
});
</script></body></html>`;
}

export const ChatTrigger: INodeType = {
  description: {
    name: '8n8-ai.chatTrigger',
    displayName: 'When Chat Message Received',
    description: 'Starts the workflow from a chat, in the editor or on a hosted chat page',
    group: ['trigger'],
    version: [1, 1.1],
    defaults: { name: 'When chat message received', color: '#7b61ff' },
    icon: 'fa:comments',
    inputs: [],
    outputs: ['main'],
    codex: { categories: ['AI'], alias: ['Chat', 'Chatbot', 'Conversation'] },
    webhooks: [
      { name: 'setup', httpMethod: 'GET', path: 'chat', isFullPath: false },
      { name: 'default', httpMethod: 'POST', path: 'chat', isFullPath: false },
    ],
    properties: [
      { displayName: 'Make Chat Publicly Available', name: 'public', type: 'boolean', default: false, description: 'Serve a chat page at the production URL while the workflow is active' },
      { displayName: 'Title', name: 'title', type: 'string', default: 'Hi there!', displayOptions: { show: { public: [true] } } },
      { displayName: 'Subtitle', name: 'subtitle', type: 'string', default: 'Start a chat. We are here to help.', displayOptions: { show: { public: [true] } } },
      { displayName: 'Initial Message(s)', name: 'initialMessages', type: 'string', typeOptions: { rows: 3 }, default: 'Hi there!\nHow can I help you today?', description: 'One message per line', displayOptions: { show: { public: [true] } } },
      {
        displayName: 'Respond',
        name: 'responseMode',
        type: 'options',
        default: 'lastNode',
        options: [
          { name: 'When Last Node Finishes', value: 'lastNode', description: 'Replies with the output of the last node' },
          { name: "Using 'Respond to Webhook' Node", value: 'responseNode' },
        ],
      },
    ],
  },
  async webhook(this: IWebhookFunctions): Promise<IWebhookResult> {
    const isPublic = this.getNodeParameter('public', false) as boolean;
    if (!isPublic && this.getMode() !== 'manual') {
      return { webhookResponse: { statusCode: 404, body: { message: 'This chat is not public. Turn on "Make Chat Publicly Available" in the chat trigger.' } } };
    }
    if (this.getWebhookName() === 'setup') {
      const initial = String(this.getNodeParameter('initialMessages', '') ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
      return {
        webhookResponse: {
          statusCode: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: chatPage({ title: this.getNodeParameter('title', 'Chat') as string, subtitle: this.getNodeParameter('subtitle', '') as string, initialMessages: initial }),
        },
      };
    }
    const body = this.getBodyData();
    const chatInput = String(body.chatInput ?? body.message ?? '');
    if (!chatInput) return { webhookResponse: { statusCode: 400, body: { message: 'Send JSON with a "chatInput" field' } } };
    return { workflowData: [[{ json: { sessionId: String(body.sessionId ?? 'default'), action: String(body.action ?? 'sendMessage'), chatInput } }]] };
  },
};

/* ---------------- credentials ---------------- */

const password = { password: true };

export const aiCredentials: ICredentialType[] = [
  {
    name: 'anthropicApi',
    displayName: 'Anthropic',
    documentationUrl: 'https://platform.claude.com/settings/keys',
    properties: [
      { displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: password, default: '' },
      { displayName: 'Base URL', name: 'url', type: 'string', default: '', placeholder: 'https://api.anthropic.com', description: 'Leave empty for the Claude API' },
    ],
  },
  {
    name: 'openAiApi',
    displayName: 'OpenAI',
    properties: [
      { displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: password, default: '' },
      { displayName: 'Base URL', name: 'url', type: 'string', default: 'https://api.openai.com/v1', description: 'Any OpenAI-compatible endpoint works' },
      { displayName: 'Organization ID', name: 'organizationId', type: 'string', default: '' },
    ],
    test: { request: { url: '={{$credentials.url || "https://api.openai.com/v1"}}/models', headers: { authorization: '=Bearer {{$credentials.apiKey}}' } } },
  },
  {
    name: 'ollamaApi',
    displayName: 'Ollama',
    properties: [
      { displayName: 'Base URL', name: 'baseUrl', type: 'string', default: 'http://localhost:11434' },
      { displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: password, default: '', description: 'Only for Ollama behind an authenticating proxy' },
    ],
    test: { request: { url: '={{$credentials.baseUrl}}/api/tags' } },
  },
];
