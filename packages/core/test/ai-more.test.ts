import { describe, expect, it, vi } from 'vitest';
import { levenshtein, serpSummary, signAws, stringSimilarity, toolsUsedScore } from '@flowmator/nodes-base';
import type { IConnections, INode } from '@flowmator/workflow';
import { items, makeWorkflow, node, out as rawOut, run } from './helpers';
import { calls, creds, credentialsHelper, route, withCred } from './integration-harness';

/* ---------- MongoDB driver fake (the Atlas store only needs these calls) ---------- */

const mongo = vi.hoisted(() => ({ docs: [] as Array<Record<string, unknown>>, pipelines: [] as unknown[], uris: [] as string[], closed: 0 }));
vi.mock('../../nodes-base/node_modules/mongodb', () => ({
  MongoClient: class {
    constructor(uri: string) {
      mongo.uris.push(uri);
    }
    async connect() {}
    async close() {
      mongo.closed++;
    }
    db() {
      return {
        collection: () => ({
          insertMany: async (docs: Array<Record<string, unknown>>) => void mongo.docs.push(...docs),
          deleteMany: async () => void (mongo.docs.length = 0),
          aggregate: (pipeline: Array<Record<string, any>>) => {
            mongo.pipelines.push(pipeline);
            const { limit } = pipeline[0].$vectorSearch;
            return { toArray: async () => mongo.docs.slice(0, limit).map(({ embedding: _e, ...d }, i) => ({ _id: `id${i}`, ...d, score: 0.9 - i / 10 })) };
          },
        }),
      };
    }
  },
}));

const out = (...args: Parameters<typeof rawOut>) => rawOut(...args) as any[];

creds.anthropicApi = { apiKey: 'test-key', url: 'https://claude.test' };
creds.openAiApi = { apiKey: 'sk-test' };
creds.mistralCloudApi = { apiKey: 'mistral-key' };
creds.groqApi = { apiKey: 'groq-key' };
creds.azureOpenAiApi = { apiKey: 'azure-key', resourceName: 'myres', apiVersion: '2025-03-01-preview' };
creds.aws = { region: 'us-east-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };
creds.serpApi = { apiKey: 'serp-key' };
creds.supabaseApi = { host: 'https://proj.supabase.test', serviceRole: 'service-key' };
creds.mongoDb = { configurationType: 'connectionString', connectionString: 'mongodb+srv://u:p@cluster.test', database: 'kb' };

const sub = (name: string, type: string, params: Record<string, unknown> = {}, cred?: string) => node(name, `flowmator-ai.${type}`, params, cred ? withCred(cred) : {});

function wire(main: Array<[string, string, number?]>, ai: Array<[string, string, string]>): IConnections {
  const c: IConnections = {};
  for (const [from, to, output = 0] of main) {
    const list = ((c[from] ??= {}).main ??= []);
    while (list.length <= output) list.push([]);
    list[output]!.push({ node: to, type: 'main', index: 0 });
  }
  for (const [from, to, type] of ai) ((c[from] ??= {})[type as 'main'] ??= [[]])[0]!.push({ node: to, type: type as 'main', index: 0 });
  return c;
}

const claude = (text: string, extra: { content?: unknown[]; stop?: string } = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: extra.content ?? [{ type: 'text', text }],
  stop_reason: extra.stop ?? 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const claudeRoute = (fn: (body: any) => unknown) => route(/POST https:\/\/claude.test\/v1\/messages/, (c) => fn(c.body));
const openAiReply = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });

const model = () => sub('Model', 'lmChatAnthropic', { model: 'claude-opus-5-5' }, 'anthropicApi');

/** Trigger → root node, with a chat model (and any extra sub-nodes) plugged in. */
function withModel(root: INode, extra: { nodes?: INode[]; ai?: Array<[string, string, string]>; after?: INode[]; outputs?: number } = {}) {
  const after = extra.after ?? [];
  return makeWorkflow(
    [node('Trigger', 'manualTrigger'), root, extra.nodes?.find((n) => n.name === 'Model') ? [] : model(), ...(extra.nodes ?? []).filter((n) => n.name !== 'Model'), ...(extra.nodes?.filter((n) => n.name === 'Model') ?? []), ...after].flat(),
    wire([['Trigger', root.name], ...after.map((n, i) => [root.name, n.name, i] as [string, string, number])], [['Model', root.name, 'ai_languageModel'], ...(extra.ai ?? [])]),
  );
}

const exec = async (wf: ReturnType<typeof makeWorkflow>, input = items({})) => {
  const r = await run(wf, { triggerData: input, additional: { credentialsHelper } });
  if (r.status !== 'success') throw new Error(r.data.resultData.error?.message);
  return r;
};

/* ---------- chains ---------- */

describe('AI chains', () => {
  it('extracts attributes as structured output', async () => {
    claudeRoute((b) => {
      expect(b.system).toContain('expert extraction algorithm');
      expect(b.system).toContain('"company_name"');
      expect(b.messages[0].content).toBe('Acme Corp hired 12 people in Berlin.');
      return claude('{"company_name":"Acme Corp","hires":12}');
    });
    const wf = withModel(
      node('Extract', 'flowmator-ai.informationExtractor', {
        text: '={{ $json.note }}',
        schemaType: 'fromAttributes',
        attributes: { attributes: [{ name: 'company_name', type: 'string', required: true }, { name: 'hires', type: 'number' }] },
      }),
    );
    expect(out(await exec(wf, items({ note: 'Acme Corp hired 12 people in Berlin.' })), 'Extract')).toEqual([{ output: { company_name: 'Acme Corp', hires: 12 } }]);
  });

  it('asks again when the extraction misses a required attribute', async () => {
    const answers = ['{"hires":3}', '{"company_name":"Initech","hires":3}'];
    claudeRoute(() => claude(answers.shift()!));
    const wf = withModel(node('Extract', 'flowmator-ai.informationExtractor', { text: 'x', schemaType: 'fromAttributes', attributes: { attributes: [{ name: 'company_name', type: 'string', required: true }, { name: 'hires', type: 'number' }] } }));
    expect(out(await exec(wf), 'Extract')).toEqual([{ output: { company_name: 'Initech', hires: 3 } }]);
    expect(calls.filter((c) => c.url.hostname === 'claude.test')).toHaveLength(2);
  });

  it('routes items to the category outputs of the Text Classifier', async () => {
    claudeRoute((b) => {
      expect(b.system).toContain('billing, support');
      const text = b.messages[0].content as string;
      return claude(JSON.stringify(text.includes('invoice') ? { billing: true, support: false, fallback: false } : text.includes('broken') ? { billing: false, support: true, fallback: false } : { billing: false, support: false, fallback: true }));
    });
    const wf = withModel(
      node('Classify', 'flowmator-ai.textClassifier', { inputText: '={{ $json.msg }}', categories: { categories: [{ category: 'billing' }, { category: 'support' }] }, options: { fallback: 'other' } }),
      { after: [node('Billing', 'noOp'), node('Support', 'noOp'), node('Other', 'noOp')] },
    );
    const r = await exec(wf, items({ msg: 'Where is my invoice?' }, { msg: 'The app is broken' }, { msg: 'Hello!' }));
    expect(out(r, 'Billing')).toEqual([{ msg: 'Where is my invoice?' }]);
    expect(out(r, 'Support')).toEqual([{ msg: 'The app is broken' }]);
    expect(out(r, 'Other')).toEqual([{ msg: 'Hello!' }]);
  });

  it('adds the sentiment and routes by category', async () => {
    claudeRoute((b) => {
      expect(b.system).toContain('Positive, Neutral, Negative');
      return claude('{"sentiment":"negative","strength":0.8,"confidence":0.9}');
    });
    const wf = withModel(node('Sentiment', 'flowmator-ai.sentimentAnalysis', { inputText: '={{ $json.review }}', options: { includeDetailedResults: true } }), {
      after: [node('Pos', 'noOp'), node('Neu', 'noOp'), node('Neg', 'noOp')],
    });
    const r = await exec(wf, items({ review: 'Terrible service' }));
    expect(out(r, 'Neg')).toEqual([{ review: 'Terrible service', sentimentAnalysis: { category: 'Negative', strength: 0.8, confidence: 0.9 } }]);
    expect(out(r, 'Pos') ?? []).toEqual([]);
  });

  it('summarizes long input with map-reduce', async () => {
    const prompts: string[] = [];
    claudeRoute((b) => {
      prompts.push(b.messages[0].content);
      return claude(`summary ${prompts.length}`);
    });
    const long = 'word '.repeat(60).trim();
    const wf = withModel(node('Summarize', 'flowmator-ai.chainSummarization', { options: { chunkingMode: 'simple', chunkSize: 100, chunkOverlap: 0 } }));
    const r = await exec(wf, items({ text: long }));
    expect(prompts.length).toBeGreaterThan(2);
    // the last call combines the partial summaries
    expect(prompts.at(-1)).toContain('summary 1');
    expect(out(r, 'Summarize')).toEqual([{ response: { text: `summary ${prompts.length}` } }]);
  });

  it('summarizes in one prompt with the stuff method', async () => {
    claudeRoute((b) => {
      expect(b.messages[0].content).toContain('Write a concise summary');
      expect(b.messages[0].content).toContain('"title":"Hi"');
      return claude('Short.');
    });
    const wf = withModel(node('Summarize', 'flowmator-ai.chainSummarization', { options: { summarizationMethod: 'stuff' } }));
    expect(out(await exec(wf, items({ title: 'Hi' })), 'Summarize')).toEqual([{ response: { text: 'Short.' } }]);
  });
});

/* ---------- tools ---------- */

/** Agent with one tool: the model calls it with `input`, then answers with what the tool returned. */
async function agentWithTool(tool: INode, toolName: string, input: Record<string, unknown>) {
  let seen = '';
  claudeRoute((b) => {
    const last = b.messages.at(-1);
    if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
      seen = last.content[0].content;
      return claude('done');
    }
    expect(b.tools.map((t: { name: string }) => t.name)).toContain(toolName);
    return claude('', { content: [{ type: 'tool_use', id: 't1', name: toolName, input }], stop: 'tool_use' });
  });
  const wf = withModel(node('Agent', 'flowmator-ai.agent', { promptType: 'define', text: 'go' }), { nodes: [tool], ai: [[tool.name, 'Agent', 'ai_tool']] });
  await exec(wf);
  return seen;
}

describe('AI tools', () => {
  it('lets the agent think out loud', async () => {
    expect(await agentWithTool(sub('Think', 'toolThink'), 'think', { thought: 'First check the date.' })).toBe('First check the date.');
  });

  it('looks pages up on Wikipedia', async () => {
    route(/GET https:\/\/es.wikipedia.org\/w\/api.php/, (c) => {
      expect(c.headers['user-agent']).toContain('flowmator');
      if (c.url.searchParams.get('list') === 'search') {
        expect(c.url.searchParams.get('srsearch')).toBe('Madrid');
        return { query: { search: [{ title: 'Madrid' }, { title: 'Real Madrid' }] } };
      }
      const title = c.url.searchParams.get('titles');
      return { query: { pages: [{ title, extract: `${title} es una ciudad.`.repeat(50) }] } };
    });
    const result = await agentWithTool(sub('Wiki', 'toolWikipedia', { options: { language: 'es', topKResults: 2, maxDocContentLength: 120 } }), 'wikipedia', { input: 'Madrid' });
    expect(result).toContain('Page: Madrid\nSummary: Madrid es una ciudad.');
    expect(result).toContain('Page: Real Madrid');
    expect(result.split('\n\n')[0].length).toBeLessThan(160);
  });

  it('searches Google through SerpApi', async () => {
    route(/GET https:\/\/serpapi.com\/search.json/, (c) => {
      expect(Object.fromEntries(c.url.searchParams)).toMatchObject({ engine: 'google', q: 'weather lisbon', api_key: 'serp-key', hl: 'pt' });
      return { answer_box: { answer: '21°C' }, organic_results: [{ title: 'Lisbon weather', link: 'https://w.test', snippet: 'Sunny' }] };
    });
    const result = await agentWithTool(sub('Serp', 'toolSerpApi', { options: { hl: 'pt' } }, 'serpApi'), 'serpapi', { input: 'weather lisbon' });
    expect(result).toBe('Answer: 21°C\n- Lisbon weather\n  https://w.test\n  Sunny');
  });

  it('summarizes SerpApi results and reports its errors', () => {
    expect(serpSummary({ knowledge_graph: { title: 'Ada Lovelace', type: 'Mathematician', description: 'English mathematician' } })).toBe('Ada Lovelace (Mathematician): English mathematician');
    expect(serpSummary({})).toBe('No good search result found');
    expect(() => serpSummary({ error: 'Invalid API key' })).toThrow('SerpAPI: Invalid API key');
  });
});

/* ---------- chat models ---------- */

const extractWith = (m: INode) =>
  makeWorkflow(
    [node('Trigger', 'manualTrigger'), node('Extract', 'flowmator-ai.informationExtractor', { text: 'Bob is 30', schemaType: 'fromAttributes', attributes: { attributes: [{ name: 'age', type: 'number' }] } }), m],
    wire([['Trigger', 'Extract']], [[m.name, 'Extract', 'ai_languageModel']]),
  );

describe('more chat models', () => {
  it('calls Mistral with its own token field', async () => {
    route(/POST https:\/\/api.mistral.ai\/v1\/chat\/completions/, (c) => {
      expect(c.headers.authorization).toBe('Bearer mistral-key');
      expect(c.body).toMatchObject({ model: 'mistral-large-latest', max_tokens: 300 });
      expect(c.body.max_completion_tokens).toBeUndefined();
      return openAiReply('{"age":30}');
    });
    const r = await exec(extractWith(sub('Mistral', 'lmChatMistralCloud', { model: 'mistral-large-latest', options: { maxTokens: 300 } }, 'mistralCloudApi')));
    expect(out(r, 'Extract')).toEqual([{ output: { age: 30 } }]);
  });

  it('calls Groq on its OpenAI-compatible endpoint', async () => {
    route(/POST https:\/\/api.groq.com\/openai\/v1\/chat\/completions/, (c) => {
      expect(c.headers.authorization).toBe('Bearer groq-key');
      expect(c.body.model).toBe('llama-3.3-70b-versatile');
      return openAiReply('{"age":30}');
    });
    expect(out(await exec(extractWith(sub('Groq', 'lmChatGroq', { model: 'llama-3.3-70b-versatile' }, 'groqApi'))), 'Extract')).toEqual([{ output: { age: 30 } }]);
  });

  it('calls an Azure OpenAI deployment with the api-key header', async () => {
    route(/POST https:\/\/myres.openai.azure.com\/openai\/deployments\/gpt-prod\/chat\/completions/, (c) => {
      expect(c.url.searchParams.get('api-version')).toBe('2025-03-01-preview');
      expect(c.headers['api-key']).toBe('azure-key');
      return openAiReply('{"age":30}');
    });
    expect(out(await exec(extractWith(sub('Azure', 'lmChatAzureOpenAi', { model: 'gpt-prod' }, 'azureOpenAiApi'))), 'Extract')).toEqual([{ output: { age: 30 } }]);
  });

  it('runs an agent on AWS Bedrock with signed Converse calls', async () => {
    let turn = 0;
    route(/POST https:\/\/bedrock-runtime.us-east-1.amazonaws.com\/model\/.+\/converse/, (c) => {
      turn++;
      expect(c.url.pathname).toBe('/model/anthropic.claude-v2%3A1/converse');
      expect(c.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
      expect(c.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
      if (turn === 1) {
        expect(c.body.system).toEqual([{ text: expect.stringContaining('helpful') }]);
        expect(c.body.toolConfig.tools[0].toolSpec).toMatchObject({ name: 'think', inputSchema: { json: { required: ['thought'] } } });
        expect(c.body.inferenceConfig).toEqual({ maxTokens: 500, temperature: 0.2 });
        return { output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'tu1', name: 'think', input: { thought: 'hmm' } } }] } }, stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 2 } };
      }
      expect(c.body.messages.at(-1)).toEqual({ role: 'user', content: [{ toolResult: { toolUseId: 'tu1', content: [{ text: 'hmm' }] } }] });
      return { output: { message: { role: 'assistant', content: [{ text: 'All good.' }] } }, stopReason: 'end_turn', usage: { inputTokens: 9, outputTokens: 3 } };
    });
    const wf = makeWorkflow(
      [node('Trigger', 'manualTrigger'), node('Agent', 'flowmator-ai.agent', { promptType: 'define', text: 'go' }), sub('Bedrock', 'lmChatAwsBedrock', { model: 'anthropic.claude-v2:1', options: { maxTokens: 500, temperature: 0.2 } }, 'aws'), sub('Think', 'toolThink')],
      wire([['Trigger', 'Agent']], [['Bedrock', 'Agent', 'ai_languageModel'], ['Think', 'Agent', 'ai_tool']]),
    );
    expect(out(await exec(wf), 'Agent')).toEqual([{ output: 'All good.' }]);
    expect(turn).toBe(2);
  });

  it('signs requests like the AWS SigV4 test suite (get-vanilla)', () => {
    const headers = signAws(
      { method: 'GET', url: 'https://example.amazonaws.com/' },
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      'us-east-1',
      'service',
      new Date('2015-08-30T12:36:00Z'),
    );
    expect(headers).toEqual({
      'x-amz-date': '20150830T123600Z',
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    });
  });

  it('signs query strings and session tokens (get-vanilla-query-order-key-case)', () => {
    const headers = signAws(
      { method: 'GET', url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1' },
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      'us-east-1',
      'service',
      new Date('2015-08-30T12:36:00Z'),
    );
    expect(headers.authorization).toContain('Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
    const withToken = signAws({ method: 'GET', url: 'https://example.amazonaws.com/' }, { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'tok' }, 'us-east-1', 'service');
    expect(withToken['x-amz-security-token']).toBe('tok');
    expect(withToken.authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token');
  });
});

/* ---------- vector stores ---------- */

const VOCAB = ['cat', 'dog', 'pizza'];
const embed = (text: string) => VOCAB.map((w) => (text.toLowerCase().includes(w) ? 1 : 0) + 0.01);
const openAiEmbeddings = () => route(/POST https:\/\/api.openai.com\/v1\/embeddings/, (c) => ({ data: (c.body.input as string[]).map((t, index) => ({ index, embedding: embed(t) })) }));

function storeWorkflow(type: string, params: Record<string, unknown>, cred: string) {
  const mode = params.mode as string;
  return makeWorkflow(
    [
      node('Trigger', 'manualTrigger'),
      sub('Store', type, params, cred),
      sub('Embeddings', 'embeddingsOpenAi', {}, 'openAiApi'),
      ...(mode === 'insert' ? [sub('Loader', 'documentDefaultDataLoader', { dataType: 'json', jsonMode: 'expressionData', jsonData: '={{ $json.text }}' })] : []),
    ],
    wire([['Trigger', 'Store']], [['Embeddings', 'Store', 'ai_embedding'], ...(mode === 'insert' ? [['Loader', 'Store', 'ai_document'] as [string, string, string]] : [])]),
  );
}

describe('Supabase Vector Store', () => {
  it('inserts rows through PostgREST and searches with the match function', async () => {
    openAiEmbeddings();
    route(/DELETE https:\/\/proj.supabase.test\/rest\/v1\/docs/, (c) => {
      expect(c.url.searchParams.get('id')).toBe('not.is.null');
      return new Response(null, { status: 204 });
    });
    const inserted: unknown[] = [];
    route(/POST https:\/\/proj.supabase.test\/rest\/v1\/docs/, (c) => {
      expect(c.headers.apikey).toBe('service-key');
      expect(c.headers.authorization).toBe('Bearer service-key');
      expect(c.headers.prefer).toBe('return=minimal');
      inserted.push(...c.body);
      return new Response(null, { status: 201 });
    });
    await exec(storeWorkflow('vectorStoreSupabase', { mode: 'insert', tableName: 'docs', options: { clearStore: true } }, 'supabaseApi'), items({ text: 'cat facts' }, { text: 'pizza night' }));
    expect(inserted).toEqual([
      { content: 'cat facts', metadata: { source: 'json', loc: { chunk: 0 } }, embedding: embed('cat facts') },
      { content: 'pizza night', metadata: { source: 'json', loc: { chunk: 0 } }, embedding: embed('pizza night') },
    ]);
    // cleared once, before the first insert
    expect(calls.filter((c) => c.url.hostname === 'proj.supabase.test').map((c) => c.method)).toEqual(['DELETE', 'POST', 'POST']);

    route(/POST https:\/\/proj.supabase.test\/rest\/v1\/rpc\/match_docs/, (c) => {
      expect(c.body).toEqual({ query_embedding: embed('dog?'), match_count: 1, filter: { lang: 'en' } });
      return [{ id: 1, content: 'cat facts', metadata: { lang: 'en' }, similarity: 0.87 }];
    });
    const found = await exec(
      storeWorkflow('vectorStoreSupabase', { mode: 'load', tableName: 'docs', queryName: 'match_docs', prompt: 'dog?', topK: 1, options: { metadataFilter: { metadataValues: [{ name: 'lang', value: 'en' }] } } }, 'supabaseApi'),
    );
    expect(out(found, 'Store')).toEqual([{ document: { pageContent: 'cat facts', metadata: { lang: 'en' } }, score: 0.87 }]);
  });

  it('explains PostgREST errors', async () => {
    openAiEmbeddings();
    route(/POST https:\/\/proj.supabase.test\/rest\/v1\/rpc\/match_documents/, () => new Response(JSON.stringify({ message: 'Could not find the function', hint: 'Create match_documents' }), { status: 404, headers: { 'content-type': 'application/json' } }));
    const r = await run(storeWorkflow('vectorStoreSupabase', { mode: 'load', tableName: 'documents', prompt: 'x' }, 'supabaseApi'), { additional: { credentialsHelper } });
    expect(r.data.resultData.error?.message).toContain('Supabase: Could not find the function (Create match_documents)');
  });
});

describe('MongoDB Atlas Vector Store', () => {
  it('stores text, vector and metadata fields and searches with $vectorSearch', async () => {
    openAiEmbeddings();
    mongo.docs.length = 0;
    await exec(storeWorkflow('vectorStoreMongoDBAtlas', { mode: 'insert', mongoCollection: 'notes', vectorIndexName: 'idx', options: { clearStore: true } }, 'mongoDb'), items({ text: 'cat facts' }, { text: 'dog days' }));
    expect(mongo.uris.at(-1)).toBe('mongodb+srv://u:p@cluster.test');
    expect(mongo.docs).toEqual([
      { source: 'json', loc: { chunk: 0 }, text: 'cat facts', embedding: embed('cat facts') },
      { source: 'json', loc: { chunk: 0 }, text: 'dog days', embedding: embed('dog days') },
    ]);

    const found = await exec(
      storeWorkflow('vectorStoreMongoDBAtlas', { mode: 'load', mongoCollection: 'notes', vectorIndexName: 'idx', prompt: 'cat', topK: 1, options: { metadataFilter: { metadataValues: [{ name: 'source', value: 'json' }] } } }, 'mongoDb'),
    );
    expect(mongo.pipelines.at(-1)).toEqual([
      { $vectorSearch: { index: 'idx', path: 'embedding', queryVector: embed('cat'), numCandidates: 100, limit: 1, filter: { source: { $eq: 'json' } } } },
      { $set: { score: { $meta: 'vectorSearchScore' } } },
      { $project: { embedding: 0 } },
    ]);
    expect(out(found, 'Store')).toEqual([{ document: { pageContent: 'cat facts', metadata: { source: 'json', loc: { chunk: 0 } } }, score: 0.9 }]);
    expect(mongo.closed).toBeGreaterThanOrEqual(2);
  });
});

/* ---------- evaluation metrics ---------- */

describe('Evaluation metrics', () => {
  const metricsWf = (params: Record<string, unknown>, withJudge = false) =>
    makeWorkflow(
      [node('Trigger', 'manualTrigger'), node('Metrics', 'evaluation', { operation: 'setMetrics', ...params }), ...(withJudge ? [model()] : [])],
      wire([['Trigger', 'Metrics']], withJudge ? [['Model', 'Metrics', 'ai_languageModel']] : []),
    );

  it('scores string similarity, categories and tool use', async () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(stringSimilarity('abcd', 'abcd')).toBe(1);
    expect(stringSimilarity('abcd', 'abxd')).toBe(0.75);
    expect(toolsUsedScore('calculator, wikipedia', [{ action: { tool: 'Calculator' } }])).toBe(0.5);

    const sim = await exec(metricsWf({ metric: 'stringSimilarity', expectedAnswer: '={{ $json.expected }}', actualAnswer: '={{ $json.actual }}' }), items({ expected: 'Paris', actual: 'Pariss' }));
    expect(out(sim, 'Metrics')[0]['String similarity']).toBeCloseTo(5 / 6);
    const cat = await exec(metricsWf({ metric: 'categorization', expectedAnswer: 'spam', actualAnswer: ' spam ', options: { metricName: 'Spam match' } }));
    expect(out(cat, 'Metrics')).toEqual([{ 'Spam match': 1 }]);
    const tools = await exec(metricsWf({ metric: 'toolsUsed', expectedTools: 'calculator', intermediateSteps: '={{ $json.intermediateSteps }}' }), items({ intermediateSteps: [{ action: { tool: 'calculator' } }] }));
    expect(out(tools, 'Metrics')).toEqual([{ 'Tools Used': 1 }]);
  });

  it('records custom metrics and rejects non-numbers', async () => {
    const r = await exec(metricsWf({ metric: 'customMetrics', metrics: { values: [{ name: 'latency', value: '={{ $json.ms / 1000 }}' }, { name: 'ok', value: 1 }] } }), items({ ms: 1500 }));
    expect(out(r, 'Metrics')).toEqual([{ latency: 1.5, ok: 1 }]);
    const bad = await run(metricsWf({ metric: 'customMetrics', metrics: { values: [{ name: 'x', value: '={{ "abc" }}' }] } }), { additional: { credentialsHelper } });
    expect(bad.data.resultData.error?.message).toContain('Metric "x" must be a number');
  });

  it('judges correctness with a chat model', async () => {
    claudeRoute((b) => {
      expect(b.system).toContain('factual correctness');
      expect(b.messages[0].content).toBe('[BEGIN DATA]\n[Ground truth]: 4\n[Output]: four\n[END DATA]');
      return claude('{"extended_reasoning":"Same number","score":5}');
    });
    const r = await exec(metricsWf({ metric: 'correctness', expectedAnswer: '4', actualAnswer: 'four' }, true));
    expect(out(r, 'Metrics')).toEqual([{ Correctness: 5 }]);
  });

  it('sends items to the Normal branch outside evaluations', async () => {
    const wf = makeWorkflow(
      [node('Trigger', 'manualTrigger'), node('Check', 'evaluation', { operation: 'checkIfEvaluating' }), node('Eval', 'noOp'), node('Normal', 'noOp')],
      wire([['Trigger', 'Check'], ['Check', 'Eval', 0], ['Check', 'Normal', 1]], []),
    );
    const r = await exec(wf, items({ a: 1 }));
    expect(out(r, 'Normal')).toEqual([{ a: 1 }]);
    expect(out(r, 'Eval') ?? []).toEqual([]);
  });
});
