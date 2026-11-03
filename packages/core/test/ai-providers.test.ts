import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { IConnections, INode } from '@flowmator/workflow';
import { items, makeWorkflow, node, out as rawOut, run } from './helpers';
import { calls, creds, credentialsHelper, route, withCred } from './integration-harness';

/* ---------- ioredis fake with the Redis Query Engine calls the Redis store makes ---------- */

const redis = vi.hoisted(() => ({ indexes: new Map<string, unknown[]>(), hashes: new Map<string, Record<string, unknown>>(), expires: new Map<string, number>(), searches: [] as unknown[][] }));
vi.mock('../../nodes-base/node_modules/ioredis', () => {
  const cosine = (a: number[], b: number[]) => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / Math.sqrt(na * nb);
  };
  const floats = (b: Buffer) => Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
  class Redis {
    async call(command: string, ...args: unknown[]) {
      const index = String(args[0]);
      if (command === 'FT.INFO') {
        if (!redis.indexes.has(index)) throw new Error('Unknown index name');
        return [];
      }
      if (command === 'FT.CREATE') return void redis.indexes.set(index, args.slice(1));
      if (command === 'FT.DROPINDEX') {
        const prefix = String(redis.indexes.get(index)![4]);
        for (const key of [...redis.hashes.keys()]) if (key.startsWith(prefix)) redis.hashes.delete(key);
        return void redis.indexes.delete(index);
      }
      if (command === 'FT.SEARCH') {
        redis.searches.push(args);
        const query = floats(args[5] as Buffer);
        const prefix = String(redis.indexes.get(index)![4]);
        const k = Number(String(args[1]).match(/KNN (\d+)/)![1]);
        const hits = [...redis.hashes.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, h]) => [key, h, 1 - cosine(floats(h.content_vector as Buffer), query)] as const)
          .sort((a, b) => a[2] - b[2])
          .slice(0, k);
        return [hits.length, ...hits.flatMap(([key, h, score]) => [key, ['metadata', h.metadata, 'content', h.content, 'vector_score', String(score)]])];
      }
      throw new Error(`ERR unknown command '${command}'`);
    }
    pipeline() {
      const ops: Array<() => void> = [];
      const p = {
        hset: (key: string, fields: Record<string, unknown>) => (ops.push(() => redis.hashes.set(key, fields)), p),
        expire: (key: string, ttl: number) => (ops.push(() => redis.expires.set(key, ttl)), p),
        exec: async () => ops.map((op) => (op(), [null, 1])),
      };
      return p;
    }
    disconnect() {}
  }
  return { Redis, default: Redis };
});

const out = (...args: Parameters<typeof rawOut>) => rawOut(...args) as any[];

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
creds.cohereApi = { apiKey: 'co-key' };
creds.huggingFaceApi = { apiKey: 'hf_key' };
creds.googleApi = { email: 'bot@my-proj.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), region: 'europe-west4' };
creds.weaviateApi = { connection_type: 'weaviate_cloud', weaviate_cloud_endpoint: 'abc.weaviate.test', weaviate_api_key: 'wv-key' };
creds.milvusApi = { baseUrl: 'https://milvus.test', username: 'root', password: 'Milvus' };
creds.redis = { host: 'localhost', port: 6379 };

const sub = (name: string, type: string, params: Record<string, unknown> = {}, cred?: string) => node(name, `flowmator-ai.${type}`, params, cred ? withCred(cred) : {});

function wire(main: Array<[string, string]>, ai: Array<[string, string, string]>): IConnections {
  const c: IConnections = {};
  for (const [from, to] of main) ((c[from] ??= {}).main ??= [[]])[0]!.push({ node: to, type: 'main', index: 0 });
  for (const [from, to, type] of ai) ((c[from] ??= {})[type as 'main'] ??= [[]])[0]!.push({ node: to, type: type as 'main', index: 0 });
  return c;
}

const exec = async (wf: ReturnType<typeof makeWorkflow>, input = items({})) => {
  const r = await run(wf, { triggerData: input, additional: { credentialsHelper } });
  if (r.status !== 'success') throw new Error(r.data.resultData.error?.message);
  return r;
};

const extractWith = (m: INode) =>
  makeWorkflow(
    [node('Trigger', 'manualTrigger'), node('Extract', 'flowmator-ai.informationExtractor', { text: 'Bob is 30', schemaType: 'fromAttributes', attributes: { attributes: [{ name: 'age', type: 'number' }] } }), m],
    wire([['Trigger', 'Extract']], [[m.name, 'Extract', 'ai_languageModel']]),
  );
const openAiReply = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });

/** Google's token endpoint: checks the service account's signed JWT asks for Vertex's scope. */
function googleToken() {
  route(/POST https:\/\/oauth2.googleapis.com\/token/, (c) => {
    const form = new URLSearchParams(c.body as string);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = form.get('assertion')!.split('.');
    expect(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url')).toBe(true);
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({ iss: 'bot@my-proj.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/cloud-platform' });
    return { access_token: 'ya29.vertex', expires_in: 3600 };
  });
}

describe('Cohere, Hugging Face and Vertex chat models', () => {
  it('calls Cohere on its OpenAI-compatible endpoint', async () => {
    route(/POST https:\/\/api.cohere.ai\/compatibility\/v1\/chat\/completions/, (c) => {
      expect(c.headers.authorization).toBe('Bearer co-key');
      expect(c.body).toMatchObject({ model: 'command-a-03-2025', max_tokens: 200 });
      return openAiReply('{"age":30}');
    });
    const r = await exec(extractWith(sub('Cohere', 'lmChatCohere', { model: 'command-a-03-2025', options: { maxTokens: 200 } }, 'cohereApi')));
    expect(out(r, 'Extract')).toEqual([{ output: { age: 30 } }]);
  });

  it('calls a Hugging Face model through the inference router', async () => {
    route(/POST https:\/\/router.huggingface.co\/v1\/chat\/completions/, (c) => {
      expect(c.headers.authorization).toBe('Bearer hf_key');
      expect(c.body.model).toBe('Qwen/Qwen3-8B');
      return openAiReply('{"age":30}');
    });
    expect(out(await exec(extractWith(sub('HF', 'lmOpenHuggingFaceInference', { model: 'Qwen/Qwen3-8B' }, 'huggingFaceApi'))), 'Extract')).toEqual([{ output: { age: 30 } }]);
  });

  it('runs Gemini on Vertex AI with a service account token', async () => {
    googleToken();
    route(/POST https:\/\/europe-west4-aiplatform.googleapis.com\/v1\/projects\/my-proj\/locations\/europe-west4\/publishers\/google\/models\/gemini-2.5-flash:generateContent/, (c) => {
      expect(c.headers.authorization).toBe('Bearer ya29.vertex');
      expect(c.headers['x-goog-api-key']).toBeUndefined();
      expect(c.body.generationConfig).toEqual({ maxOutputTokens: 2048, temperature: 0 });
      return { candidates: [{ content: { role: 'model', parts: [{ text: '{"age":30}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3 } };
    });
    const r = await exec(extractWith(sub('Vertex', 'lmChatGoogleVertex', { modelName: 'gemini-2.5-flash', options: { maxTokens: 2048, temperature: 0 } }, 'googleApi')));
    expect(out(r, 'Extract')).toEqual([{ output: { age: 30 } }]);
  });

  it('needs a project when the service account address has none', async () => {
    const saved = creds.googleApi;
    creds.googleApi = { ...saved, email: 'someone@example.com' };
    try {
      const r = await run(extractWith(sub('Vertex', 'lmChatGoogleVertex', { modelName: 'gemini-2.5-flash' }, 'googleApi')), { additional: { credentialsHelper } });
      expect(r.data.resultData.error?.message).toContain('Set the Google Cloud project ID');
    } finally {
      creds.googleApi = saved;
    }
  });
});

/* ---------- vector stores (each with one of the new embeddings) ---------- */

const VOCAB = ['cat', 'dog', 'pizza'];
const embed = (text: string) => VOCAB.map((w) => (text.toLowerCase().includes(w) ? 1 : 0) + 0.01);

function storeWorkflow(type: string, params: Record<string, unknown>, cred: string, embeddings: INode) {
  const mode = params.mode as string;
  return makeWorkflow(
    [
      node('Trigger', 'manualTrigger'),
      sub('Store', type, params, cred),
      { ...embeddings, name: 'Embeddings' },
      ...(mode === 'insert' ? [sub('Loader', 'documentDefaultDataLoader', { dataType: 'json', jsonMode: 'expressionData', jsonData: '={{ $json.text }}' })] : []),
    ],
    wire([['Trigger', 'Store']], [['Embeddings', 'Store', 'ai_embedding'], ...(mode === 'insert' ? [['Loader', 'Store', 'ai_document'] as [string, string, string]] : [])]),
  );
}

describe('Weaviate Vector Store', () => {
  const cohere = () => sub('E', 'embeddingsCohere', { modelName: 'embed-v4.0' }, 'cohereApi');
  const inputTypes: string[] = [];
  const cohereEmbed = () =>
    route(/POST https:\/\/api.cohere.ai\/v2\/embed/, (c) => {
      expect(c.body).toMatchObject({ model: 'embed-v4.0', embedding_types: ['float'] });
      inputTypes.push(c.body.input_type);
      return { embeddings: { float: (c.body.texts as string[]).map(embed) } };
    });

  it('creates the collection, batches objects and searches with nearVector', async () => {
    cohereEmbed();
    const objects: Array<Record<string, any>> = [];
    let schema: Record<string, unknown> | undefined;
    route(/GET https:\/\/abc.weaviate.test\/v1\/schema\/Notes/, (c) => {
      expect(c.headers.authorization).toBe('Bearer wv-key');
      if (!schema) return new Response(JSON.stringify({ error: [{ message: 'not found' }] }), { status: 404 });
      // Weaviate adds the properties it sees on insert
      return { ...schema, properties: [...new Set(objects.flatMap((o) => Object.keys(o.properties)))].map((name) => ({ name })) };
    });
    route(/POST https:\/\/abc.weaviate.test\/v1\/schema$/, (c) => void (schema = c.body));
    route(/POST https:\/\/abc.weaviate.test\/v1\/batch\/objects/, (c) => {
      objects.push(...c.body.objects);
      return c.body.objects.map((o: { id: string }) => ({ id: o.id, result: {} }));
    });
    await exec(storeWorkflow('vectorStoreWeaviate', { mode: 'insert', weaviateCollection: 'notes' }, 'weaviateApi', cohere()), items({ text: 'cat facts' }, { text: 'pizza night' }));
    expect(schema).toEqual({ class: 'Notes', vectorizer: 'none', vectorIndexConfig: { distance: 'cosine' } });
    expect(objects.map((o) => ({ ...o, id: typeof o.id }))).toEqual([
      { class: 'Notes', id: 'string', vector: embed('cat facts'), properties: { source: 'json', loc_chunk: 0, text: 'cat facts' } },
      { class: 'Notes', id: 'string', vector: embed('pizza night'), properties: { source: 'json', loc_chunk: 0, text: 'pizza night' } },
    ]);

    route(/POST https:\/\/abc.weaviate.test\/v1\/graphql/, (c) => {
      expect(c.body.query).toContain(`Notes(nearVector: {vector: ${JSON.stringify(embed('a cat'))}}, limit: 1, where: {path:["source"],operator:Equal,valueText:"json"})`);
      expect(c.body.query).toContain('{ source loc_chunk text _additional { distance } }');
      return { data: { Get: { Notes: [{ source: 'json', loc_chunk: 0, text: 'cat facts', _additional: { distance: 0.25 } }] } } };
    });
    const found = await exec(
      storeWorkflow('vectorStoreWeaviate', { mode: 'load', weaviateCollection: 'notes', prompt: 'a cat', topK: 1, options: { metadataFilter: { metadataValues: [{ name: 'source', value: 'json' }] } } }, 'weaviateApi', cohere()),
    );
    expect(out(found, 'Store')).toEqual([{ document: { pageContent: 'cat facts', metadata: { source: 'json', loc_chunk: 0 } }, score: 0.75 }]);
    // documents and queries are embedded as Cohere asks
    expect(inputTypes).toEqual(['search_document', 'search_document', 'search_query']);
  });

  it('reports errors of single objects in a batch', async () => {
    cohereEmbed();
    route(/GET https:\/\/abc.weaviate.test\/v1\/schema\/Notes/, () => ({ class: 'Notes', properties: [] }));
    route(/POST https:\/\/abc.weaviate.test\/v1\/batch\/objects/, () => [{ result: { errors: { error: [{ message: 'vector lengths don\'t match' }] } } }]);
    const r = await run(storeWorkflow('vectorStoreWeaviate', { mode: 'insert', weaviateCollection: 'Notes' }, 'weaviateApi', cohere()), { triggerData: items({ text: 'x' }), additional: { credentialsHelper } });
    expect(r.data.resultData.error?.message).toContain("Weaviate: vector lengths don't match");
  });
});

describe('Milvus Vector Store', () => {
  const hf = () => sub('E', 'embeddingsHuggingFaceInference', { modelName: 'BAAI/bge-small-en-v1.5' }, 'huggingFaceApi');
  const hfEmbed = () =>
    route(/POST https:\/\/router.huggingface.co\/hf-inference\/models\/BAAI\/bge-small-en-v1.5\/pipeline\/feature-extraction/, (c) => {
      expect(c.headers.authorization).toBe('Bearer hf_key');
      // one vector per token: the node averages them
      return (c.body.inputs as string[]).map((t) => [embed(t), embed(t).map((v) => v + 2)]);
    });
  const pooled = (t: string) => embed(t).map((v) => (v + (v + 2)) / 2);

  it('creates a collection with LangChain fields, inserts and searches with a filter', async () => {
    hfEmbed();
    const requests: Array<[string, any]> = [];
    const data: Array<Record<string, unknown>> = [];
    let exists = false;
    route(/POST https:\/\/milvus.test\/v2\/vectordb\/.+/, (c) => {
      expect(c.headers.authorization).toBe('Bearer root:Milvus');
      const path = c.url.pathname.replace('/v2/vectordb', '');
      requests.push([path, c.body]);
      if (path === '/collections/has') return { code: 0, data: { has: exists } };
      if (path === '/collections/create') return (exists = true), { code: 0, data: {} };
      if (path === '/entities/insert') return data.push(...c.body.data), { code: 0, data: { insertCount: c.body.data.length } };
      if (path === '/entities/search') return { code: 0, data: [{ distance: 0.93, langchain_primaryid: 4511, langchain_text: 'dog days', source: 'json', loc: { chunk: 0 } }] };
      return { code: 1100, message: `unexpected ${path}` };
    });
    await exec(storeWorkflow('vectorStoreMilvus', { mode: 'insert', milvusCollection: 'kb' }, 'milvusApi', hf()), items({ text: 'dog days' }));
    expect(requests.find(([p]) => p === '/collections/create')![1]).toEqual({
      collectionName: 'kb',
      schema: {
        autoId: true,
        enableDynamicField: true,
        fields: [
          { fieldName: 'langchain_primaryid', dataType: 'Int64', isPrimary: true },
          { fieldName: 'langchain_text', dataType: 'VarChar', elementTypeParams: { max_length: 65535 } },
          { fieldName: 'langchain_vector', dataType: 'FloatVector', elementTypeParams: { dim: 3 } },
        ],
      },
      indexParams: [{ fieldName: 'langchain_vector', indexName: 'langchain_vector_index', metricType: 'COSINE', indexType: 'AUTOINDEX' }],
    });
    expect(data).toEqual([{ source: 'json', loc: { chunk: 0 }, langchain_text: 'dog days', langchain_vector: pooled('dog days') }]);

    const found = await exec(
      storeWorkflow('vectorStoreMilvus', { mode: 'load', milvusCollection: 'kb', prompt: 'dog', topK: 2, options: { metadataFilter: { metadataValues: [{ name: 'source', value: 'json' }] } } }, 'milvusApi', hf()),
    );
    expect(requests.at(-1)).toEqual(['/entities/search', { collectionName: 'kb', data: [pooled('dog')], annsField: 'langchain_vector', limit: 2, outputFields: ['*'], filter: 'source == "json"' }]);
    expect(out(found, 'Store')).toEqual([{ document: { pageContent: 'dog days', metadata: { source: 'json', loc: { chunk: 0 } } }, score: 0.93 }]);
  });

  it('explains Milvus error codes', async () => {
    hfEmbed();
    route(/POST https:\/\/milvus.test\/v2\/vectordb\/.+/, () => ({ code: 1800, message: 'user hasn\'t authenticated' }));
    const r = await run(storeWorkflow('vectorStoreMilvus', { mode: 'load', milvusCollection: 'kb', prompt: 'x' }, 'milvusApi', hf()), { additional: { credentialsHelper } });
    expect(r.data.resultData.error?.message).toContain("Milvus: user hasn't authenticated");
  });
});

describe('Redis Vector Store', () => {
  const vertex = () => sub('E', 'embeddingsGoogleVertex', { projectId: 'other-proj', modelName: 'text-embedding-005' }, 'googleApi');
  const vertexEmbed = () => {
    googleToken();
    route(/POST https:\/\/europe-west4-aiplatform.googleapis.com\/v1\/projects\/other-proj\/locations\/europe-west4\/publishers\/google\/models\/text-embedding-005:predict/, (c) => {
      expect(c.headers.authorization).toBe('Bearer ya29.vertex');
      return { predictions: (c.body.instances as Array<{ content: string }>).map((i) => ({ embeddings: { values: embed(i.content) } })) };
    });
  };

  it('stores hashes in the LangChain layout and searches with KNN', async () => {
    vertexEmbed();
    await exec(storeWorkflow('vectorStoreRedis', { mode: 'insert', redisIndex: 'kb', redisOptions: { ttl: 60 } }, 'redis', vertex()), items({ text: 'cat facts' }, { text: 'dog days' }, { text: 'pizza night' }));
    expect(redis.indexes.get('kb')).toEqual(['ON', 'HASH', 'PREFIX', 1, 'doc:kb:', 'SCHEMA', 'content_vector', 'VECTOR', 'HNSW', 6, 'TYPE', 'FLOAT32', 'DIM', 3, 'DISTANCE_METRIC', 'COSINE', 'content', 'TEXT', 'metadata', 'TEXT']);
    const stored = [...redis.hashes.entries()];
    expect(stored).toHaveLength(3);
    expect(stored[0][0]).toMatch(/^doc:kb:[0-9a-f-]{36}$/);
    expect(stored[0][1]).toMatchObject({ content: 'cat facts', metadata: '{"source":"json","loc":{"chunk":0}}' });
    expect(Array.from(new Float32Array((stored[0][1].content_vector as Buffer).buffer.slice(0)))).toEqual(embed('cat facts').map(Math.fround));
    expect(redis.expires.get(stored[0][0])).toBe(60);

    const found = await exec(storeWorkflow('vectorStoreRedis', { mode: 'load', redisIndex: 'kb', prompt: 'pizza', topK: 1 }, 'redis', vertex()));
    expect(redis.searches.at(-1)!.slice(0, 4)).toEqual(['kb', '*=>[KNN 1 @content_vector $vector AS vector_score]', 'PARAMS', 2]);
    const [result] = out(found, 'Store');
    expect(result.document).toEqual({ pageContent: 'pizza night', metadata: { source: 'json', loc: { chunk: 0 } } });
    expect(result.score).toBeCloseTo(1, 3);
  });

  it('filters metadata on a wider KNN result and drops the index when clearing', async () => {
    vertexEmbed();
    redis.hashes.clear();
    redis.indexes.clear();
    const insert = (text: string, clearStore = false) =>
      exec(storeWorkflow('vectorStoreRedis', { mode: 'insert', redisIndex: 'kb', options: { clearStore } }, 'redis', vertex()), items({ text }));
    await insert('cat facts');
    await insert('dog days', true);
    expect([...redis.hashes.values()].map((h) => h.content)).toEqual(['dog days']);

    const found = await exec(storeWorkflow('vectorStoreRedis', { mode: 'load', redisIndex: 'kb', prompt: 'cat', topK: 1, options: { metadataFilter: { metadataValues: [{ name: 'source', value: 'other' }] } } }, 'redis', vertex()));
    expect(redis.searches.at(-1)![1]).toBe('*=>[KNN 10 @content_vector $vector AS vector_score]');
    expect(out(found, 'Store')).toEqual([]);
    // one token for the whole file: it is cached until it expires
    expect(calls.filter((c) => c.url.hostname === 'oauth2.googleapis.com').length).toBeLessThanOrEqual(1);
  });
});
