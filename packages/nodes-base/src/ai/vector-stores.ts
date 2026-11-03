import { randomUUID } from 'node:crypto';
import { MongoClient, type Document } from 'mongodb';
import type { ICredentialType, IDataObject, INodeType, IExecuteFunctions, ISupplyDataFunctions } from '@flowmator/workflow';
import { vectorStoreNode, type AiDocument } from './rag';
import { redisClient } from './subnodes';

const password = { password: true };

/* ---------------- Supabase ---------------- */

interface SupabaseCreds {
  host: string;
  serviceRole: string;
}

/**
 * LangChain's Supabase layout: a `documents` table (content, metadata, embedding) and a
 * `match_documents(query_embedding, match_count, filter)` function that ranks by similarity.
 */
export const SupabaseVectorStore = vectorStoreNode({
  name: 'vectorStoreSupabase',
  displayName: 'Supabase Vector Store',
  description: 'Stores documents and vectors in a Supabase (pgvector) table',
  icon: 'fa:database',
  credentials: [{ name: 'supabaseApi', required: true }],
  properties: [
    { displayName: 'Table Name', name: 'tableName', type: 'string', default: 'documents', required: true, description: 'Needs content, metadata and embedding columns' },
    { displayName: 'Query Name', name: 'queryName', type: 'string', default: 'match_documents', description: 'The Postgres function that searches the table' },
  ],
  insertOptions: [{ displayName: 'Clear Table', name: 'clearStore', type: 'boolean', default: false, description: 'Delete every row before inserting' }],
  async open(ctx, i) {
    const c = await ctx.getCredentials<SupabaseCreds>('supabaseApi');
    const table = String(ctx.getNodeParameter('tableName', i, 'documents')).trim();
    const queryName = String(ctx.getNodeParameter('queryName', i, 'match_documents') || 'match_documents').trim();
    if (!table) throw new Error('Set the Supabase table name');
    const base = `${c.host.replace(/\/$/, '')}/rest/v1`;
    const headers = { apikey: c.serviceRole, authorization: `Bearer ${c.serviceRole}` };
    const call = async (method: string, url: string, body?: unknown, extra: Record<string, string> = {}) => {
      const r = (await ctx.helpers.httpRequest({ method: method as 'GET', url, headers: { ...headers, ...extra }, ...(body !== undefined ? { body } : {}), json: true, returnFullResponse: true, ignoreHttpStatusErrors: true })) as {
        statusCode: number;
        body: unknown;
      };
      if (r.statusCode >= 400) {
        const b = r.body as { message?: string; hint?: string } | undefined;
        throw new Error(`Supabase: ${b?.message ?? `HTTP ${r.statusCode}`}${b?.hint ? ` (${b.hint})` : ''}`);
      }
      return r.body;
    };
    return {
      async add(rows) {
        for (let start = 0; start < rows.length; start += 500) {
          const batch = rows.slice(start, start + 500).map((r) => ({ content: r.document.pageContent, metadata: r.document.metadata, embedding: r.vector }));
          await call('POST', `${base}/${encodeURIComponent(table)}`, batch, { prefer: 'return=minimal' });
        }
      },
      async search(vector, k, filter) {
        const rows = (await call('POST', `${base}/rpc/${encodeURIComponent(queryName)}`, { query_embedding: vector, match_count: k, filter: filter ?? {} })) as Array<{ content?: string; metadata?: IDataObject; similarity?: number }>;
        return rows.map((r) => [{ pageContent: r.content ?? '', metadata: r.metadata ?? {} }, Number(r.similarity ?? 0)] as [AiDocument, number]);
      },
      async clear() {
        await call('DELETE', `${base}/${encodeURIComponent(table)}?id=not.is.null`);
      },
    };
  },
});

/* ---------------- MongoDB Atlas ---------------- */

interface MongoCreds {
  configurationType?: 'connectionString' | 'values';
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database: string;
}

export function mongoUri(c: MongoCreds) {
  if (c.configurationType !== 'values') {
    if (!c.connectionString) throw new Error('Set the connection string in the MongoDB credential');
    return c.connectionString;
  }
  const auth = c.user ? `${encodeURIComponent(c.user)}:${encodeURIComponent(c.password ?? '')}@` : '';
  return `mongodb://${auth}${c.host || 'localhost'}:${c.port || 27017}`;
}

/** LangChain's Atlas layout: the text and the vector in their own fields, metadata as top-level fields. */
export const MongoDbAtlasVectorStore = vectorStoreNode({
  name: 'vectorStoreMongoDBAtlas',
  displayName: 'MongoDB Atlas Vector Store',
  description: 'Stores documents and vectors in a MongoDB Atlas collection with a vector search index',
  icon: 'fa:database',
  credentials: [{ name: 'mongoDb', required: true }],
  properties: [
    { displayName: 'Collection', name: 'mongoCollection', type: 'string', default: '', required: true },
    { displayName: 'Vector Index Name', name: 'vectorIndexName', type: 'string', default: 'vector_index', required: true, description: 'The Atlas Vector Search index on the embedding field' },
    { displayName: 'Embedding Field', name: 'embedding', type: 'string', default: 'embedding' },
    { displayName: 'Text Field', name: 'metadata_field', type: 'string', default: 'text', description: 'Where the text of each document is stored' },
  ],
  insertOptions: [{ displayName: 'Clear Collection', name: 'clearStore', type: 'boolean', default: false, description: 'Delete every document before inserting' }],
  async open(ctx, i) {
    const c = await ctx.getCredentials<MongoCreds>('mongoDb');
    const name = String(ctx.getNodeParameter('mongoCollection', i, '')).trim();
    if (!name) throw new Error('Set the MongoDB collection');
    const index = String(ctx.getNodeParameter('vectorIndexName', i, 'vector_index') || 'vector_index');
    const embeddingKey = String(ctx.getNodeParameter('embedding', i, 'embedding') || 'embedding');
    const textKey = String(ctx.getNodeParameter('metadata_field', i, 'text') || 'text');
    const client = new MongoClient(mongoUri(c));
    await client.connect();
    const collection = client.db(c.database).collection(name);
    return {
      async add(rows) {
        if (rows.length) await collection.insertMany(rows.map((r) => ({ ...r.document.metadata, [textKey]: r.document.pageContent, [embeddingKey]: r.vector })));
      },
      async search(vector, k, filter) {
        const pipeline: Document[] = [
          {
            $vectorSearch: {
              index,
              path: embeddingKey,
              queryVector: vector,
              numCandidates: Math.max(k * 10, 100),
              limit: k,
              // filtered fields must be declared as "filter" fields in the index
              ...(filter ? { filter: Object.fromEntries(Object.entries(filter).map(([key, v]) => [key, { $eq: v }])) } : {}),
            },
          },
          { $set: { score: { $meta: 'vectorSearchScore' } } },
          { $project: { [embeddingKey]: 0 } },
        ];
        const docs = await collection.aggregate(pipeline).toArray();
        return docs.map(({ _id, score, [textKey]: text, ...metadata }) => [{ pageContent: String(text ?? ''), metadata: metadata as IDataObject }, Number(score ?? 0)] as [AiDocument, number]);
      },
      async clear() {
        await collection.deleteMany({});
      },
      async close() {
        await client.close();
      },
    };
  },
});

/* ---------------- Weaviate ---------------- */

interface WeaviateCreds {
  connection_type?: 'weaviate_cloud' | 'custom_connection';
  weaviate_cloud_endpoint?: string;
  weaviate_api_key?: string;
  custom_connection_http_host?: string;
  custom_connection_http_port?: number;
  custom_connection_http_secure?: boolean;
}

export function weaviateUrl(c: WeaviateCreds) {
  if (c.connection_type === 'custom_connection') {
    return `${c.custom_connection_http_secure ? 'https' : 'http'}://${c.custom_connection_http_host || 'localhost'}:${c.custom_connection_http_port || 8080}`;
  }
  const endpoint = String(c.weaviate_cloud_endpoint ?? '').trim().replace(/\/$/, '');
  if (!endpoint) throw new Error('Set the Weaviate cloud endpoint in the credential');
  return /^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`;
}

/** Weaviate properties are flat: nested metadata becomes parent_child keys, like LangChain's store. */
function flatten(o: IDataObject, prefix = '', out: IDataObject = {}) {
  for (const [k, v] of Object.entries(o)) {
    const key = `${prefix}${k}`.replace(/[^A-Za-z0-9_]/g, '_');
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as IDataObject, `${key}_`, out);
    else out[key] = v;
  }
  return out;
}

/** GraphQL literal for a where filter: keys and operators bare, values JSON. */
const gql = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(gql).join(',')}]` : v && typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${k}:${k === 'operator' ? String(x) : gql(x)}`).join(',')}}` : JSON.stringify(v);

const weaviateCondition = (key: string, value: unknown) => ({
  path: [key.replace(/[^A-Za-z0-9_]/g, '_')],
  operator: 'Equal',
  ...(typeof value === 'number' ? { valueNumber: value } : typeof value === 'boolean' ? { valueBoolean: value } : { valueText: String(value) }),
});

export const WeaviateVectorStore = vectorStoreNode({
  name: 'vectorStoreWeaviate',
  displayName: 'Weaviate Vector Store',
  description: 'Stores documents and vectors in a Weaviate collection',
  icon: 'fa:database',
  credentials: [{ name: 'weaviateApi', required: true }],
  properties: [{ displayName: 'Weaviate Collection', name: 'weaviateCollection', type: 'string', default: '', required: true, description: 'Created when inserting into a collection that does not exist' }],
  insertOptions: [{ displayName: 'Clear Collection', name: 'clearStore', type: 'boolean', default: false, description: 'Delete the collection before inserting' }],
  async open(ctx, i) {
    const c = await ctx.getCredentials<WeaviateCreds>('weaviateApi');
    const raw = String(ctx.getNodeParameter('weaviateCollection', i, '')).trim();
    if (!raw) throw new Error('Set the Weaviate collection');
    // collection (class) names always start upper-case in Weaviate
    const collection = raw[0].toUpperCase() + raw.slice(1);
    const base = `${weaviateUrl(c)}/v1`;
    const headers: Record<string, string> = c.weaviate_api_key ? { authorization: `Bearer ${c.weaviate_api_key}` } : {};
    const call = async <T = IDataObject>(method: string, url: string, body?: unknown) => {
      const r = (await ctx.helpers.httpRequest({ method: method as 'GET', url, headers, ...(body !== undefined ? { body } : {}), json: true, returnFullResponse: true, ignoreHttpStatusErrors: true })) as { statusCode: number; body: T };
      if (r.statusCode >= 400 && r.statusCode !== 404) {
        const b = r.body as { error?: Array<{ message?: string }>; message?: string };
        throw new Error(`Weaviate: ${b?.error?.[0]?.message ?? b?.message ?? `HTTP ${r.statusCode}`}`);
      }
      return r;
    };
    const properties = async () => {
      const r = await call<{ properties?: Array<{ name: string }> }>('GET', `${base}/schema/${collection}`);
      return r.statusCode === 404 ? undefined : (r.body.properties ?? []).map((p) => p.name);
    };
    return {
      async add(rows) {
        if (!rows.length) return;
        if (!(await properties())) await call('POST', `${base}/schema`, { class: collection, vectorizer: 'none', vectorIndexConfig: { distance: 'cosine' } });
        for (let start = 0; start < rows.length; start += 100) {
          const objects = rows.slice(start, start + 100).map((r) => ({ class: collection, id: randomUUID(), vector: r.vector, properties: { ...flatten(r.document.metadata), text: r.document.pageContent } }));
          const res = await call<Array<{ result?: { errors?: { error?: Array<{ message: string }> } } }>>('POST', `${base}/batch/objects`, { objects });
          const failed = (Array.isArray(res.body) ? res.body : []).find((o) => o.result?.errors?.error?.length);
          if (failed) throw new Error(`Weaviate: ${failed.result!.errors!.error![0].message}`);
        }
      },
      async search(vector, k, filter) {
        const fields = await properties();
        if (!fields) return [];
        const conditions = Object.entries(filter ?? {}).map(([key, v]) => weaviateCondition(key, v));
        const where = conditions.length === 1 ? conditions[0] : conditions.length ? { operator: 'And', operands: conditions } : undefined;
        const query = `{ Get { ${collection}(nearVector: {vector: ${JSON.stringify(vector)}}, limit: ${k}${where ? `, where: ${gql(where)}` : ''}) { ${fields.join(' ')} _additional { distance } } } }`;
        const res = await call<{ data?: { Get?: Record<string, Array<IDataObject & { _additional: { distance: number } }>> }; errors?: Array<{ message: string }> }>('POST', `${base}/graphql`, { query });
        if (res.body.errors?.length) throw new Error(`Weaviate: ${res.body.errors[0].message}`);
        return (res.body.data?.Get?.[collection] ?? []).map(({ _additional, text, ...metadata }) => {
          for (const key of Object.keys(metadata)) if (metadata[key] === null) delete metadata[key];
          return [{ pageContent: String(text ?? ''), metadata }, 1 - Number(_additional?.distance ?? 1)] as [AiDocument, number];
        });
      },
      async clear() {
        await call('DELETE', `${base}/schema/${collection}`);
      },
    };
  },
});

/* ---------------- Milvus ---------------- */

interface MilvusCreds {
  baseUrl: string;
  username?: string;
  password?: string;
}

/** Milvus boolean expression for an equality filter on (dynamic) metadata fields. */
const milvusFilter = (filter?: IDataObject) =>
  Object.entries(filter ?? {})
    .map(([k, v]) => `${k} == ${typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(String(v))}`)
    .join(' and ');

/** LangChain's Milvus field names; metadata goes into dynamic fields. */
const MILVUS = { id: 'langchain_primaryid', text: 'langchain_text', vector: 'langchain_vector' };

export const MilvusVectorStore = vectorStoreNode({
  name: 'vectorStoreMilvus',
  displayName: 'Milvus Vector Store',
  description: 'Stores documents and vectors in a Milvus (or Zilliz Cloud) collection',
  icon: 'fa:database',
  credentials: [{ name: 'milvusApi', required: true }],
  properties: [{ displayName: 'Milvus Collection', name: 'milvusCollection', type: 'string', default: '', required: true, description: 'Created when inserting into a collection that does not exist' }],
  insertOptions: [{ displayName: 'Clear Collection', name: 'clearStore', type: 'boolean', default: false, description: 'Drop the collection before inserting' }],
  async open(ctx, i) {
    const c = await ctx.getCredentials<MilvusCreds>('milvusApi');
    const collectionName = String(ctx.getNodeParameter('milvusCollection', i, '')).trim();
    if (!collectionName) throw new Error('Set the Milvus collection');
    const base = `${String(c.baseUrl || 'http://localhost:19530').replace(/\/$/, '')}/v2/vectordb`;
    const headers: Record<string, string> = c.username || c.password ? { authorization: `Bearer ${c.username ?? ''}:${c.password ?? ''}` } : {};
    const call = async <T = IDataObject>(path: string, body: IDataObject) => {
      const r = (await ctx.helpers.httpRequest({ method: 'POST', url: `${base}${path}`, headers, body: { collectionName, ...body }, json: true })) as { code: number; message?: string; data?: T };
      if (r.code !== 0) throw new Error(`Milvus: ${r.message ?? `code ${r.code}`}`);
      return r.data as T;
    };
    return {
      async add(rows) {
        if (!rows.length) return;
        if (!(await call<{ has: boolean }>('/collections/has', {})).has) {
          await call('/collections/create', {
            schema: {
              autoId: true,
              enableDynamicField: true,
              fields: [
                { fieldName: MILVUS.id, dataType: 'Int64', isPrimary: true },
                { fieldName: MILVUS.text, dataType: 'VarChar', elementTypeParams: { max_length: 65535 } },
                { fieldName: MILVUS.vector, dataType: 'FloatVector', elementTypeParams: { dim: rows[0].vector.length } },
              ],
            },
            indexParams: [{ fieldName: MILVUS.vector, indexName: `${MILVUS.vector}_index`, metricType: 'COSINE', indexType: 'AUTOINDEX' }],
          });
        }
        for (let start = 0; start < rows.length; start += 500) {
          const data = rows.slice(start, start + 500).map((r) => ({ ...r.document.metadata, [MILVUS.text]: r.document.pageContent, [MILVUS.vector]: r.vector }));
          await call('/entities/insert', { data });
        }
      },
      async search(vector, k, filter) {
        if (!(await call<{ has: boolean }>('/collections/has', {})).has) return [];
        const expr = milvusFilter(filter);
        const rows = await call<Array<IDataObject & { distance: number }>>('/entities/search', { data: [vector], annsField: MILVUS.vector, limit: k, outputFields: ['*'], ...(expr ? { filter: expr } : {}) });
        return (rows ?? []).map(({ distance, [MILVUS.id]: _id, [MILVUS.text]: text, [MILVUS.vector]: _v, ...metadata }) => [{ pageContent: String(text ?? ''), metadata }, Number(distance)] as [AiDocument, number]);
      },
      async clear() {
        await call('/collections/drop', {});
      },
    };
  },
});

/* ---------------- Redis ---------------- */

interface RedisCreds {
  host: string;
  port?: number;
  database?: number;
  user?: string;
  password?: string;
  ssl?: boolean;
}

/** RediSearch reply to FT.SEARCH: [total, key, [field, value, ...], key, [...], ...] */
function searchRows(reply: unknown[]) {
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < reply.length; i += 2) {
    const fields = (reply[i + 1] as unknown[]) ?? [];
    const row: Record<string, string> = {};
    for (let j = 0; j < fields.length; j += 2) row[String(fields[j])] = String(fields[j + 1]);
    rows.push(row);
  }
  return rows;
}

/** LangChain's Redis layout: hashes under doc:<index>: with content, JSON metadata and a FLOAT32 vector, searched with KNN. */
export const RedisVectorStore = vectorStoreNode({
  name: 'vectorStoreRedis',
  displayName: 'Redis Vector Store',
  description: 'Stores documents and vectors in Redis with the Redis Query Engine (Redis 8 or Redis Stack)',
  icon: 'fa:database',
  credentials: [{ name: 'redis', required: true }],
  properties: [
    { displayName: 'Redis Index', name: 'redisIndex', type: 'string', default: '', required: true, description: 'Created when inserting into an index that does not exist' },
    {
      displayName: 'Options',
      name: 'redisOptions',
      type: 'collection',
      default: {},
      options: [
        { displayName: 'Key Prefix', name: 'keyPrefix', type: 'string', default: '', description: 'Defaults to doc:<index>:' },
        { displayName: 'Metadata Key', name: 'metadataKey', type: 'string', default: 'metadata' },
        { displayName: 'Content Key', name: 'contentKey', type: 'string', default: 'content' },
        { displayName: 'Vector Key', name: 'vectorKey', type: 'string', default: 'content_vector' },
        { displayName: 'Document Time To Live', name: 'ttl', type: 'number', default: 0, description: 'Seconds until inserted documents expire. 0 = never.' },
      ],
    },
  ],
  insertOptions: [{ displayName: 'Clear Index', name: 'clearStore', type: 'boolean', default: false, description: 'Drop the index and its documents before inserting' }],
  async open(ctx: IExecuteFunctions | ISupplyDataFunctions, i) {
    const index = String(ctx.getNodeParameter('redisIndex', i, '')).trim();
    if (!index) throw new Error('Set the Redis index');
    const o = ctx.getNodeParameter('redisOptions', i, {}) as IDataObject;
    const prefix = String(o.keyPrefix || `doc:${index}:`);
    const metadataKey = String(o.metadataKey || 'metadata');
    const contentKey = String(o.contentKey || 'content');
    const vectorKey = String(o.vectorKey || 'content_vector');
    const ttl = Number(o.ttl) || 0;
    const redis = redisClient(await ctx.getCredentials<RedisCreds>('redis'));
    const ft = async (...args: Array<string | number | Buffer>) => {
      try {
        return (await redis.call(...(args as [string, ...Array<string | number | Buffer>]))) as unknown;
      } catch (e) {
        const message = (e as Error).message;
        if (/unknown command/i.test(message)) throw new Error('Redis: this server has no vector search. Use Redis 8 or Redis Stack.');
        throw new Error(`Redis: ${message}`);
      }
    };
    const exists = async () => {
      try {
        await redis.call('FT.INFO', index);
        return true;
      } catch (e) {
        if (/unknown index|no such index|not found/i.test((e as Error).message)) return false;
        if (/unknown command/i.test((e as Error).message)) throw new Error('Redis: this server has no vector search. Use Redis 8 or Redis Stack.');
        throw e;
      }
    };
    const toBuffer = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
    return {
      async add(rows) {
        if (!rows.length) return;
        if (!(await exists())) {
          await ft('FT.CREATE', index, 'ON', 'HASH', 'PREFIX', 1, prefix, 'SCHEMA', vectorKey, 'VECTOR', 'HNSW', 6, 'TYPE', 'FLOAT32', 'DIM', rows[0].vector.length, 'DISTANCE_METRIC', 'COSINE', contentKey, 'TEXT', metadataKey, 'TEXT');
        }
        const pipeline = redis.pipeline();
        for (const r of rows) {
          const key = `${prefix}${randomUUID()}`;
          pipeline.hset(key, { [contentKey]: r.document.pageContent, [metadataKey]: JSON.stringify(r.document.metadata), [vectorKey]: toBuffer(r.vector) });
          if (ttl > 0) pipeline.expire(key, ttl);
        }
        const results = (await pipeline.exec()) ?? [];
        const failed = results.find(([err]) => err);
        if (failed) throw new Error(`Redis: ${(failed[0] as Error).message}`);
      },
      async search(vector, k, filter) {
        if (!(await exists())) return [];
        // metadata is stored as JSON text, so filters are applied to a wider KNN result
        const wanted = filter && Object.keys(filter).length ? k * 10 : k;
        const reply = (await ft(
          'FT.SEARCH', index, `*=>[KNN ${wanted} @${vectorKey} $vector AS vector_score]`,
          'PARAMS', 2, 'vector', toBuffer(vector),
          'RETURN', 3, metadataKey, contentKey, 'vector_score',
          'SORTBY', 'vector_score', 'LIMIT', 0, wanted, 'DIALECT', 2,
        )) as unknown[];
        const docs = searchRows(reply).map((row) => {
          let metadata: IDataObject = {};
          try {
            metadata = JSON.parse(row[metadataKey] ?? '{}') as IDataObject;
          } catch {}
          return [{ pageContent: row[contentKey] ?? '', metadata }, 1 - Number(row.vector_score ?? 1)] as [AiDocument, number];
        });
        return docs.filter(([d]) => !filter || Object.entries(filter).every(([key, v]) => String(d.metadata[key]) === String(v))).slice(0, k);
      },
      async clear() {
        if (await exists()) await ft('FT.DROPINDEX', index, 'DD');
      },
      async close() {
        redis.disconnect();
      },
    };
  },
});

export const vectorStoreCredentials: ICredentialType[] = [
  {
    name: 'supabaseApi',
    displayName: 'Supabase',
    documentationUrl: 'https://supabase.com/dashboard/project/_/settings/api',
    properties: [
      { displayName: 'Host', name: 'host', type: 'string', default: '', placeholder: 'https://your-project.supabase.co' },
      { displayName: 'Service Role Secret', name: 'serviceRole', type: 'string', typeOptions: password, default: '' },
    ],
    test: { request: { url: '={{$credentials.host}}/rest/v1/', headers: { apikey: '={{$credentials.serviceRole}}', authorization: '=Bearer {{$credentials.serviceRole}}' } } },
  },
  {
    name: 'weaviateApi',
    displayName: 'Weaviate',
    documentationUrl: 'https://console.weaviate.cloud',
    properties: [
      {
        displayName: 'Connection Type',
        name: 'connection_type',
        type: 'options',
        default: 'weaviate_cloud',
        options: [
          { name: 'Weaviate Cloud', value: 'weaviate_cloud' },
          { name: 'Custom Connection', value: 'custom_connection' },
        ],
      },
      { displayName: 'Weaviate Cloud Endpoint', name: 'weaviate_cloud_endpoint', type: 'string', default: '', placeholder: 'https://abc123.c0.europe-west3.gcp.weaviate.cloud', displayOptions: { show: { connection_type: ['weaviate_cloud'] } } },
      { displayName: 'API Key', name: 'weaviate_api_key', type: 'string', typeOptions: password, default: '' },
      { displayName: 'HTTP Host', name: 'custom_connection_http_host', type: 'string', default: 'localhost', displayOptions: { show: { connection_type: ['custom_connection'] } } },
      { displayName: 'HTTP Port', name: 'custom_connection_http_port', type: 'number', default: 8080, displayOptions: { show: { connection_type: ['custom_connection'] } } },
      { displayName: 'HTTP Secure', name: 'custom_connection_http_secure', type: 'boolean', default: false, displayOptions: { show: { connection_type: ['custom_connection'] } } },
    ],
  },
  {
    name: 'milvusApi',
    displayName: 'Milvus',
    documentationUrl: 'https://milvus.io/docs/authenticate.md',
    properties: [
      { displayName: 'Base URL', name: 'baseUrl', type: 'string', default: 'http://localhost:19530', description: 'For Zilliz Cloud, the cluster endpoint' },
      { displayName: 'Username', name: 'username', type: 'string', default: '', description: 'For Zilliz Cloud with an API key, leave empty and put the key in Password' },
      { displayName: 'Password', name: 'password', type: 'string', typeOptions: password, default: '' },
    ],
  },
  {
    name: 'mongoDb',
    displayName: 'MongoDB',
    properties: [
      {
        displayName: 'Configuration Type',
        name: 'configurationType',
        type: 'options',
        default: 'connectionString',
        options: [
          { name: 'Connection String', value: 'connectionString' },
          { name: 'Values', value: 'values' },
        ],
      },
      { displayName: 'Connection String', name: 'connectionString', type: 'string', typeOptions: password, default: '', placeholder: 'mongodb+srv://user:pass@cluster0.mongodb.net', displayOptions: { show: { configurationType: ['connectionString'] } } },
      { displayName: 'Host', name: 'host', type: 'string', default: 'localhost', displayOptions: { show: { configurationType: ['values'] } } },
      { displayName: 'Port', name: 'port', type: 'number', default: 27017, displayOptions: { show: { configurationType: ['values'] } } },
      { displayName: 'User', name: 'user', type: 'string', default: '', displayOptions: { show: { configurationType: ['values'] } } },
      { displayName: 'Password', name: 'password', type: 'string', typeOptions: password, default: '', displayOptions: { show: { configurationType: ['values'] } } },
      { displayName: 'Database', name: 'database', type: 'string', default: '' },
    ],
  },
];

export const moreVectorStores: INodeType[] = [SupabaseVectorStore, MongoDbAtlasVectorStore, WeaviateVectorStore, MilvusVectorStore, RedisVectorStore];
