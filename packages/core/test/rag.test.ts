import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { characterSplitter, cosineSimilarity, recursiveSplitter, tokenSplitter } from '@flowmator/nodes-base';
import type { IConnections, INode } from '@flowmator/workflow';
import { items, makeWorkflow, node, out as rawOut, run } from './helpers';
import { calls, creds, credentialsHelper, route, withCred } from './integration-harness';

// node outputs here are documents and search results: loosely typed on purpose
const out = (...args: Parameters<typeof rawOut>) => rawOut(...args) as any[];

/* ---------- fakes ---------- */

/** Bag-of-words embeddings over a tiny vocabulary: texts about the same topic get close vectors. */
const VOCAB = ['cat', 'dog', 'pizza', 'pasta', 'car', 'engine'];
const embed = (text: string) => VOCAB.map((w) => (text.toLowerCase().match(new RegExp(w, 'g'))?.length ?? 0) + 0.01);
const openAiEmbeddings = () =>
  route(/POST https:\/\/api.openai.com\/v1\/embeddings/, (c) => ({ data: (c.body.input as string[]).map((t, index) => ({ index, embedding: embed(t) })).reverse() }));

creds.openAiApi = { apiKey: 'sk-test' };
creds.anthropicApi = { apiKey: 'test-key', url: 'https://claude.test' };
creds.googlePalmApi = { apiKey: 'g-key', host: 'https://gemini.test' };
creds.qdrantApi = { qdrantUrl: 'https://qdrant.test', apiKey: 'q-key' };

const sub = (name: string, type: string, params: Record<string, unknown> = {}, cred?: string) => node(name, `flowmator-ai.${type}`, params, cred ? withCred(cred) : {});

/** Links sub-nodes: [from, to, connection type] */
function wire(main: Array<[string, string]>, ai: Array<[string, string, string]>): IConnections {
  const c: IConnections = {};
  for (const [from, to] of main) ((c[from] ??= {}).main ??= [[]])[0]!.push({ node: to, type: 'main', index: 0 });
  for (const [from, to, type] of ai) ((c[from] ??= {})[type as 'main'] ??= [[]])[0]!.push({ node: to, type: type as 'main', index: 0 });
  return c;
}

const DOCS = [{ text: 'My cat sleeps all day. The cat likes the dog.' }, { text: 'Pizza and pasta are Italian food. Pizza is best.' }, { text: 'The car engine roars. A car needs an engine.' }];

/** Trigger → Vector Store (insert) with a data loader and OpenAI embeddings. */
function insertWorkflow(store: string, storeParams: Record<string, unknown>, cred?: string, loaderParams: Record<string, unknown> = {}, extra: { nodes?: INode[]; ai?: Array<[string, string, string]> } = {}) {
  return makeWorkflow(
    [
      node('Trigger', 'manualTrigger'),
      sub('Store', store, { mode: 'insert', ...storeParams }, cred),
      sub('Loader', 'documentDefaultDataLoader', { dataType: 'json', jsonMode: 'expressionData', jsonData: '={{ $json.text }}', options: { metadata: { metadataValues: [{ name: 'n', value: '={{ $itemIndex }}' }] } }, ...loaderParams }),
      sub('Embeddings', 'embeddingsOpenAi', {}, 'openAiApi'),
      ...(extra.nodes ?? []),
    ],
    wire([['Trigger', 'Store']], [['Loader', 'Store', 'ai_document'], ['Embeddings', 'Store', 'ai_embedding'], ...(extra.ai ?? [])]),
  );
}

function loadWorkflow(store: string, storeParams: Record<string, unknown>, cred?: string) {
  return makeWorkflow(
    [node('Trigger', 'manualTrigger'), sub('Store', store, { mode: 'load', topK: 2, ...storeParams }, cred), sub('Embeddings', 'embeddingsOpenAi', {}, 'openAiApi')],
    wire([['Trigger', 'Store']], [['Embeddings', 'Store', 'ai_embedding']]),
  );
}

const exec = async (wf: ReturnType<typeof makeWorkflow>, input = items({})) => {
  const r = await run(wf, { triggerData: input, additional: { credentialsHelper } });
  if (r.status !== 'success') throw new Error(r.data.resultData.error?.message);
  return r;
};

/* ---------- splitters ---------- */

describe('text splitters', () => {
  it('splits recursively by paragraph, line and word, with overlap', () => {
    const text = 'aaaa bbbb cccc\n\ndddd eeee\nffff gggg hhhh';
    const chunks = recursiveSplitter(10, 5).splitText(text);
    expect(chunks.every((c) => c.length <= 10)).toBe(true);
    expect(chunks).toEqual(['aaaa bbbb', 'bbbb cccc', 'dddd eeee', 'ffff gggg', 'gggg hhhh']);
  });

  it('keeps small texts whole and splits at a separator', () => {
    expect(recursiveSplitter(100, 10).splitText('short text')).toEqual(['short text']);
    expect(characterSplitter('|', 7, 0).splitText('ab|cd|efgh|ij')).toEqual(['ab|cd', 'efgh|ij']);
    expect(() => recursiveSplitter(10, 10)).toThrow('Chunk Overlap must be smaller');
  });

  it('splits by approximate tokens', () => {
    const chunks = tokenSplitter(3, 1).splitText('one two three four five');
    expect(chunks).toEqual(['one two three', 'three four five']);
  });

  it('measures cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

/* ---------- Simple Vector Store ---------- */

describe('Simple Vector Store', () => {
  it('inserts documents and finds the closest ones', async () => {
    openAiEmbeddings();
    const inserted = await exec(insertWorkflow('vectorStoreInMemory', { memoryKey: 'pets-food-cars', options: { clearStore: true } }), items(...DOCS));
    const docs = out(inserted, 'Store')!;
    expect(docs).toHaveLength(3);
    expect(docs[1]).toEqual({ pageContent: DOCS[1].text, metadata: { source: 'json', n: 1, loc: { chunk: 0 } } });
    expect(calls[0].headers.authorization).toBe('Bearer sk-test');
    expect(calls[0].body.model).toBe('text-embedding-3-small');

    const found = await exec(loadWorkflow('vectorStoreInMemory', { memoryKey: 'pets-food-cars', prompt: 'what about a dog?' }));
    const res = out(found, 'Store')!;
    expect(res).toHaveLength(2);
    expect(res[0].document.pageContent).toContain('cat');
    expect(res[0].score).toBeGreaterThan(res[1].score);
  });

  it('filters by metadata and clears the store before inserting', async () => {
    openAiEmbeddings();
    await exec(insertWorkflow('vectorStoreInMemory', { memoryKey: 'filtered', options: { clearStore: true } }), items(...DOCS));
    await exec(insertWorkflow('vectorStoreInMemory', { memoryKey: 'filtered', options: { clearStore: true } }), items(...DOCS));
    const found = await exec(loadWorkflow('vectorStoreInMemory', { memoryKey: 'filtered', prompt: 'dog', topK: 10, options: { metadataFilter: { metadataValues: [{ name: 'n', value: '2' }] } } }));
    expect(out(found, 'Store')!.map((r) => r.document.pageContent)).toEqual([DOCS[2].text]);
  });

  it('splits long input with a connected text splitter', async () => {
    openAiEmbeddings();
    const wf = insertWorkflow('vectorStoreInMemory', { memoryKey: 'split', options: { clearStore: true } }, undefined, { textSplittingMode: 'custom' }, {
      nodes: [sub('Splitter', 'textSplitterCharacterTextSplitter', { separator: '. ', chunkSize: 30, chunkOverlap: 0 })],
      ai: [['Splitter', 'Loader', 'ai_textSplitter']],
    });
    const res = await exec(wf, items(DOCS[0]));
    expect(out(res, 'Store')!.map((d) => d.pageContent)).toEqual(['My cat sleeps all day', 'The cat likes the dog.']);
  });

  it('gives an agent a search tool over the store', async () => {
    openAiEmbeddings();
    await exec(insertWorkflow('vectorStoreInMemory', { memoryKey: 'agent-kb', options: { clearStore: true } }), items(...DOCS));
    let turn = 0;
    route(/POST https:\/\/claude.test\/v1\/messages/, (c) => {
      turn++;
      if (turn === 1) {
        expect(c.body.tools[0]).toMatchObject({ name: 'Knowledge', input_schema: { required: ['input'] } });
        return claude([{ type: 'tool_use', id: 't1', name: 'Knowledge', input: { input: 'pizza' } }], 'tool_use');
      }
      const result = c.body.messages.at(-1).content[0];
      expect(JSON.parse(result.content)[0].pageContent).toContain('Pizza');
      return claude([{ type: 'text', text: 'Pizza.' }], 'end_turn');
    });
    const wf = makeWorkflow(
      [
        node('Trigger', 'manualTrigger'),
        node('Agent', 'flowmator-ai.agent', { promptType: 'define', text: 'Best Italian food?' }),
        sub('Model', 'lmChatAnthropic', { model: 'claude-opus-5-5' }, 'anthropicApi'),
        sub('Knowledge', 'vectorStoreInMemory', { mode: 'retrieve-as-tool', memoryKey: 'agent-kb', toolDescription: 'Facts about pets, food and cars', topK: 1 }),
        sub('Embeddings', 'embeddingsOpenAi', {}, 'openAiApi'),
      ],
      wire([['Trigger', 'Agent']], [['Model', 'Agent', 'ai_languageModel'], ['Knowledge', 'Agent', 'ai_tool'], ['Embeddings', 'Knowledge', 'ai_embedding']]),
    );
    expect(out(await exec(wf), 'Agent')).toEqual([{ output: 'Pizza.' }]);
  });
});

const claude = (content: unknown[], stop_reason: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

/* ---------- chains ---------- */

describe('chains', () => {
  it('answers with retrieved context in the Question and Answer Chain', async () => {
    openAiEmbeddings();
    await exec(insertWorkflow('vectorStoreInMemory', { memoryKey: 'qa', options: { clearStore: true } }), items(...DOCS));
    route(/POST https:\/\/claude.test\/v1\/messages/, (c) => {
      expect(c.body.system).toContain('Context: Pizza and pasta');
      expect(c.body.system).not.toContain('engine');
      expect(c.body.messages).toEqual([{ role: 'user', content: 'Pizza or pasta?' }]);
      return claude([{ type: 'text', text: 'Pizza and pasta.' }], 'end_turn');
    });
    const wf = makeWorkflow(
      [
        node('Trigger', 'manualTrigger'),
        node('QA', 'flowmator-ai.chainRetrievalQa', {}),
        sub('Model', 'lmChatAnthropic', { model: 'claude-opus-5-5' }, 'anthropicApi'),
        sub('Retriever', 'retrieverVectorStore', { topK: 1 }),
        sub('Store', 'vectorStoreInMemory', { mode: 'retrieve', memoryKey: 'qa' }),
        sub('Embeddings', 'embeddingsOpenAi', {}, 'openAiApi'),
      ],
      wire([['Trigger', 'QA']], [['Model', 'QA', 'ai_languageModel'], ['Retriever', 'QA', 'ai_retriever'], ['Store', 'Retriever', 'ai_vectorStore'], ['Embeddings', 'Store', 'ai_embedding']]),
    );
    expect(out(await exec(wf, items({ chatInput: 'Pizza or pasta?' })), 'QA')).toEqual([{ response: 'Pizza and pasta.' }]);
  });

  it('runs a Basic LLM Chain with a structured output parser', async () => {
    route(/POST https:\/\/claude.test\/v1\/messages/, (c) => {
      expect(c.body.system).toContain('JSON Schema');
      return claude([{ type: 'text', text: '```json\n{"city":"Rome"}\n```' }], 'end_turn');
    });
    const wf = makeWorkflow(
      [
        node('Trigger', 'manualTrigger'),
        node('Chain', 'flowmator-ai.chainLlm', { promptType: 'define', text: '={{ "Capital of " + $json.country }}' }),
        sub('Model', 'lmChatAnthropic', { model: 'claude-opus-5-5' }, 'anthropicApi'),
        sub('Parser', 'outputParserStructured', { schemaType: 'fromJson', jsonSchemaExample: '{"city":"x"}' }),
      ],
      wire([['Trigger', 'Chain']], [['Model', 'Chain', 'ai_languageModel'], ['Parser', 'Chain', 'ai_outputParser']]),
    );
    expect(out(await exec(wf, items({ country: 'Italy' })), 'Chain')).toEqual([{ output: { city: 'Rome' } }]);
    expect(calls[0].body.messages[0].content).toBe('Capital of Italy');
  });
});

/* ---------- Qdrant (fake API) ---------- */

describe('Qdrant Vector Store', () => {
  it('creates the collection, upserts points and searches with a filter', async () => {
    openAiEmbeddings();
    const points: Array<{ vector: number[]; payload: { content: string; metadata: Record<string, unknown> } }> = [];
    let created: unknown;
    route(/GET https:\/\/qdrant.test\/collections\/docs$/, () => (created ? { result: {} } : new Response(JSON.stringify({ status: { error: 'Not found' } }), { status: 404 })));
    route(/PUT https:\/\/qdrant.test\/collections\/docs$/, (c) => ((created = c.body), { result: true }));
    route(/PUT https:\/\/qdrant.test\/collections\/docs\/points/, (c) => (points.push(...c.body.points), { result: {} }));
    route(/POST https:\/\/qdrant.test\/collections\/docs\/points\/search/, (c) => ({
      result: points
        .filter((p) => (c.body.filter?.must ?? []).every((m: { key: string; match: { value: unknown } }) => String(p.payload.metadata[m.key.replace('metadata.', '')]) === String(m.match.value)))
        .map((p) => ({ score: cosineSimilarity(c.body.vector, p.vector), payload: p.payload }))
        .sort((a, b) => b.score - a.score)
        .slice(0, c.body.limit),
    }));
    await exec(insertWorkflow('vectorStoreQdrant', { qdrantCollection: 'docs' }, 'qdrantApi'), items(...DOCS));
    expect(created).toEqual({ vectors: { size: 6, distance: 'Cosine' } });
    expect(calls.find((c) => c.method === 'PUT')!.headers['api-key']).toBe('q-key');
    const found = await exec(loadWorkflow('vectorStoreQdrant', { qdrantCollection: 'docs', prompt: 'engine', options: { metadataFilter: { metadataValues: [{ name: 'n', value: '2' }] } } }, 'qdrantApi'));
    expect(out(found, 'Store')!.map((r) => r.document.pageContent)).toEqual([DOCS[2].text]);
  });
});

/* ---------- Gemini ---------- */

describe('Google Gemini', () => {
  it('runs the agent tool loop and keeps thought signatures', async () => {
    let turn = 0;
    route(/POST https:\/\/gemini.test\/v1beta\/models\/gemini-2.5-flash:generateContent/, (c) => {
      expect(c.headers['x-goog-api-key']).toBe('g-key');
      turn++;
      if (turn === 1) {
        expect(c.body.tools[0].functionDeclarations[0]).toMatchObject({ name: 'calculator', parametersJsonSchema: { required: ['expression'] } });
        expect(c.body.systemInstruction.parts[0].text).toBe('You are a helpful assistant.');
        return { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'calculator', args: { expression: '6*7' } }, thoughtSignature: 'sig1' }] }, finishReason: 'STOP' }] };
      }
      expect(c.body.contents[1].parts[0].thoughtSignature).toBe('sig1');
      expect(c.body.contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'calculator', response: { result: '42' } } }] });
      return { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text: 'It is 42.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } };
    });
    const wf = makeWorkflow(
      [node('Trigger', 'manualTrigger'), node('Agent', 'flowmator-ai.agent', { promptType: 'define', text: '6 times 7?' }), sub('Model', 'lmChatGoogleGemini', { modelName: 'models/gemini-2.5-flash' }, 'googlePalmApi'), sub('Calc', 'toolCalculator')],
      wire([['Trigger', 'Agent']], [['Model', 'Agent', 'ai_languageModel'], ['Calc', 'Agent', 'ai_tool']]),
    );
    expect(out(await exec(wf), 'Agent')).toEqual([{ output: 'It is 42.' }]);
  });

  it('embeds text in batches', async () => {
    route(/batchEmbedContents/, (c) => ({ embeddings: c.body.requests.map((r: { content: { parts: Array<{ text: string }> } }) => ({ values: embed(r.content.parts[0].text) })) }));
    const wf = makeWorkflow(
      [node('Trigger', 'manualTrigger'), sub('Store', 'vectorStoreInMemory', { mode: 'insert', memoryKey: 'gem', options: { clearStore: true } }), sub('Loader', 'documentDefaultDataLoader', {}), sub('Emb', 'embeddingsGoogleGemini', {}, 'googlePalmApi')],
      wire([['Trigger', 'Store']], [['Loader', 'Store', 'ai_document'], ['Emb', 'Store', 'ai_embedding']]),
    );
    const res = await exec(wf, items({ title: 'Dog', tags: ['a', 'b'] }));
    expect(out(res, 'Store')![0].pageContent).toBe('title: Dog\ntags[0]: a\ntags[1]: b');
    expect(calls[0].url.pathname).toBe('/v1beta/models/gemini-embedding-001:batchEmbedContents');
    expect(calls[0].body.requests[0].model).toBe('models/gemini-embedding-001');
  });
});

/* ---------- Postgres: PGVector and chat memory (real Postgres via PGlite) ---------- */

describe('Postgres AI nodes', () => {
  let pgServer: PGLiteSocketServer;
  beforeAll(async () => {
    const db = await PGlite.create({ extensions: { vector } });
    const port = 20000 + Math.floor(Math.random() * 20000);
    pgServer = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 10 });
    await pgServer.start();
    creds.postgres = { host: '127.0.0.1', port, database: 'postgres', user: 'postgres', password: 'x', ssl: 'disable' };
  });
  afterAll(() => pgServer?.stop());

  it('stores and searches vectors with pgvector', async () => {
    openAiEmbeddings();
    await exec(insertWorkflow('vectorStorePGVector', { tableName: 'kb', options: { clearStore: true } }, 'postgres'), items(...DOCS));
    const found = await exec(loadWorkflow('vectorStorePGVector', { tableName: 'kb', prompt: 'pasta please' }, 'postgres'));
    const res = out(found, 'Store')!;
    expect(res[0].document).toEqual({ pageContent: DOCS[1].text, metadata: { source: 'json', n: 1, loc: { chunk: 0 } } });
    expect(res[0].score).toBeCloseTo(cosineSimilarity(embed('pasta please'), embed(DOCS[1].text)), 5);

    const filtered = await exec(loadWorkflow('vectorStorePGVector', { tableName: 'kb', prompt: 'pasta', options: { metadataFilter: { metadataValues: [{ name: 'n', value: 0 }] } } }, 'postgres'));
    expect(out(filtered, 'Store')!.map((r) => r.document.metadata.n)).toEqual([0]);
  });

  it('remembers the chat in a Postgres table', async () => {
    const answers = ['Hi Ada!', 'Your name is Ada.'];
    route(/POST https:\/\/claude.test\/v1\/messages/, () => claude([{ type: 'text', text: answers.shift()! }], 'end_turn'));
    const wf = makeWorkflow(
      [node('Trigger', 'manualTrigger'), node('Agent', 'flowmator-ai.agent', {}), sub('Model', 'lmChatAnthropic', { model: 'claude-opus-5-5' }, 'anthropicApi'), sub('Memory', 'memoryPostgresChat', { contextWindowLength: 5 }, 'postgres')],
      wire([['Trigger', 'Agent']], [['Model', 'Agent', 'ai_languageModel'], ['Memory', 'Agent', 'ai_memory']]),
    );
    await exec(wf, items({ sessionId: 's1', chatInput: 'I am Ada' }));
    await exec(wf, items({ sessionId: 's1', chatInput: 'Who am I?' }));
    const second = calls.filter((c) => c.url.hostname === 'claude.test')[1].body.messages;
    expect(second).toEqual([
      { role: 'user', content: 'I am Ada' },
      { role: 'assistant', content: 'Hi Ada!' },
      { role: 'user', content: 'Who am I?' },
    ]);
  });
});

/* ---------- Redis chat memory ---------- */

const redisBinary = process.env.REDIS_SERVER ?? spawnSync('which', ['redis-server'], { encoding: 'utf8' }).stdout.trim();

describe.skipIf(!redisBinary)('Redis Chat Memory', () => {
  let redis: ChildProcess;
  beforeAll(async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    redis = spawn(redisBinary, ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    creds.redis = { host: '127.0.0.1', port, database: 0 };
  });
  afterAll(() => redis?.kill());

  it('keeps the last exchanges per session', async () => {
    const answers = ['one', 'two', 'three'];
    route(/POST https:\/\/claude.test\/v1\/messages/, () => claude([{ type: 'text', text: answers.shift()! }], 'end_turn'));
    const wf = makeWorkflow(
      [node('Trigger', 'manualTrigger'), node('Agent', 'flowmator-ai.agent', {}), sub('Model', 'lmChatAnthropic', { model: 'claude-opus-5-5' }, 'anthropicApi'), sub('Memory', 'memoryRedisChat', { contextWindowLength: 1, sessionTTL: 60 }, 'redis')],
      wire([['Trigger', 'Agent']], [['Model', 'Agent', 'ai_languageModel'], ['Memory', 'Agent', 'ai_memory']]),
    );
    for (const q of ['q1', 'q2', 'q3']) await exec(wf, items({ sessionId: 'r1', chatInput: q }));
    const last = calls.filter((c) => c.url.hostname === 'claude.test')[2].body.messages;
    // window of 1 exchange: only q2/two comes back
    expect(last).toEqual([
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'q3' },
    ]);
  });
});

