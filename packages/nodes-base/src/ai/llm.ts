import Anthropic from '@anthropic-ai/sdk';

/** A tool the agent can call. `invoke` returns the text sent back to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke(input: Record<string, unknown>): Promise<string>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  /** false while the model is waiting for tool results */
  done: boolean;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * One conversation with a model. Each provider keeps its own native message history, so
 * provider-specific blocks (e.g. Claude's thinking blocks) are sent back unchanged.
 */
export interface ChatSession {
  sendUser(text: string): Promise<ModelTurn>;
  sendToolResults(results: Array<{ id: string; content: string; isError?: boolean }>): Promise<ModelTurn>;
}

export interface ChatModel {
  provider: 'anthropic' | 'openai' | 'ollama';
  model: string;
  createSession(opts: { system?: string; history?: HistoryMessage[]; tools: ToolSpec[] }): ChatSession;
}

/** Drops leading assistant turns and merges same-role neighbours so histories are valid for every provider. */
function normalizeHistory(history: HistoryMessage[] = []): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of history) {
    if (!out.length && m.role !== 'user') continue;
    const last = out.at(-1);
    if (last && last.role === m.role) last.text += `\n\n${m.text}`;
    else out.push({ ...m });
  }
  return out;
}

/* ---------------- Claude (Anthropic SDK) ---------------- */

/** Models that accept the server-side refusal fallback ("default" routing). */
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'];

export interface AnthropicOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Re-run declined requests on a fallback model (server side). */
  refusalFallback: boolean;
  signal?: AbortSignal;
}

export function anthropicModel(o: AnthropicOptions): ChatModel {
  const client = new Anthropic({ apiKey: o.apiKey, ...(o.baseURL ? { baseURL: o.baseURL } : {}) });
  const fallback = o.refusalFallback && FALLBACK_MODELS.includes(o.model);
  return {
    provider: 'anthropic',
    model: o.model,
    createSession({ system, history, tools }) {
      const messages: Anthropic.Beta.BetaMessageParam[] = normalizeHistory(history).map((m) => ({ role: m.role, content: m.text }));
      const toolDefs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      }));

      const call = async (): Promise<ModelTurn> => {
        let inputTokens = 0;
        let outputTokens = 0;
        // pause_turn: append the paused assistant turn and ask again
        for (let resumes = 0; ; resumes++) {
          const response = await client.beta.messages.create(
            {
              model: o.model,
              max_tokens: o.maxTokens,
              ...(system ? { system } : {}),
              messages,
              ...(toolDefs.length ? { tools: toolDefs } : {}),
              ...(o.effort ? { output_config: { effort: o.effort } } : {}),
              ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
            },
            { signal: o.signal },
          );
          inputTokens += response.usage.input_tokens;
          outputTokens += response.usage.output_tokens;
          // full content goes back unchanged, thinking blocks included
          messages.push({ role: 'assistant', content: response.content });

          if (response.stop_reason === 'pause_turn' && resumes < 5) continue;
          if (response.stop_reason === 'refusal') {
            const d = response.stop_details;
            throw new Error(`Claude declined the request${d?.category ? ` (${d.category})` : ''}${d?.explanation ? `: ${d.explanation}` : ''}`);
          }
          const text = response.content
            .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('');
          const toolCalls = response.content
            .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
            .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
          return {
            text,
            toolCalls,
            done: response.stop_reason !== 'tool_use',
            stopReason: response.stop_reason ?? 'end_turn',
            usage: { inputTokens, outputTokens },
          };
        }
      };

      return {
        async sendUser(text) {
          messages.push({ role: 'user', content: text });
          return call();
        },
        async sendToolResults(results) {
          // all results of one turn go back in a single user message
          messages.push({
            role: 'user',
            content: results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
          });
          return call();
        },
      };
    },
  };
}

export async function listAnthropicModels(apiKey: string, baseURL?: string) {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const out: Array<{ name: string; value: string }> = [];
  for await (const m of client.models.list()) out.push({ name: m.display_name, value: m.id });
  return out;
}

/* ---------------- OpenAI-compatible chat completions ---------------- */

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: { message: text } };
  }
  if (!res.ok) {
    const err = (json as { error?: { message?: string } | string }).error;
    throw new Error(`${res.status} ${typeof err === 'string' ? err : (err?.message ?? res.statusText)}`);
  }
  return json as T;
}

export interface OpenAiOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  maxTokens?: number;
  organization?: string;
  signal?: AbortSignal;
}

export function openAiModel(o: OpenAiOptions): ChatModel {
  const url = `${o.baseURL.replace(/\/$/, '')}/chat/completions`;
  const headers: Record<string, string> = { authorization: `Bearer ${o.apiKey}`, ...(o.organization ? { 'openai-organization': o.organization } : {}) };
  return {
    provider: 'openai',
    model: o.model,
    createSession({ system, history, tools }) {
      const messages: OpenAiMessage[] = [...(system ? [{ role: 'system' as const, content: system }] : []), ...normalizeHistory(history).map((m) => ({ role: m.role, content: m.text }))];
      const toolDefs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      const call = async (): Promise<ModelTurn> => {
        const res = await postJson<{
          choices: Array<{ message: OpenAiMessage; finish_reason: string }>;
          usage?: { prompt_tokens: number; completion_tokens: number };
        }>(url, { model: o.model, messages, ...(toolDefs.length ? { tools: toolDefs } : {}), ...(o.maxTokens ? { max_completion_tokens: o.maxTokens } : {}) }, headers, o.signal);
        const choice = res.choices[0];
        messages.push(choice.message);
        const toolCalls = (choice.message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, input: safeParse(c.function.arguments) }));
        return {
          text: choice.message.content ?? '',
          toolCalls,
          done: toolCalls.length === 0,
          stopReason: choice.finish_reason,
          usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
        };
      };
      return {
        async sendUser(text) {
          messages.push({ role: 'user', content: text });
          return call();
        },
        async sendToolResults(results) {
          for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
          return call();
        },
      };
    },
  };
}

/* ---------------- Ollama ---------------- */

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

export interface OllamaOptions {
  baseURL: string;
  apiKey?: string;
  model: string;
  numCtx?: number;
  signal?: AbortSignal;
}

export function ollamaModel(o: OllamaOptions): ChatModel {
  const url = `${o.baseURL.replace(/\/$/, '')}/api/chat`;
  const headers: Record<string, string> = o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {};
  return {
    provider: 'ollama',
    model: o.model,
    createSession({ system, history, tools }) {
      const messages: OllamaMessage[] = [...(system ? [{ role: 'system' as const, content: system }] : []), ...normalizeHistory(history).map((m) => ({ role: m.role, content: m.text }))];
      const toolDefs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      // Ollama tool calls carry no ids: map our generated ids back to tool names
      const pending = new Map<string, string>();
      let counter = 0;
      const call = async (): Promise<ModelTurn> => {
        const res = await postJson<{ message: OllamaMessage; done_reason?: string; prompt_eval_count?: number; eval_count?: number }>(
          url,
          { model: o.model, messages, stream: false, ...(toolDefs.length ? { tools: toolDefs } : {}), ...(o.numCtx ? { options: { num_ctx: o.numCtx } } : {}) },
          headers,
          o.signal,
        );
        messages.push(res.message);
        const toolCalls = (res.message.tool_calls ?? []).map((c) => {
          const id = `call_${++counter}`;
          pending.set(id, c.function.name);
          return { id, name: c.function.name, input: c.function.arguments ?? {} };
        });
        return {
          text: res.message.content ?? '',
          toolCalls,
          done: toolCalls.length === 0,
          stopReason: res.done_reason ?? 'stop',
          usage: { inputTokens: res.prompt_eval_count ?? 0, outputTokens: res.eval_count ?? 0 },
        };
      };
      return {
        async sendUser(text) {
          messages.push({ role: 'user', content: text });
          return call();
        },
        async sendToolResults(results) {
          for (const r of results) messages.push({ role: 'tool', tool_name: pending.get(r.id), content: r.isError ? `ERROR: ${r.content}` : r.content });
          return call();
        },
      };
    },
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? v : { input: v };
  } catch {
    return { input: s };
  }
}

/** Tool names must be short identifiers for every provider. */
export function toToolName(nodeName: string) {
  return nodeName.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'tool';
}
