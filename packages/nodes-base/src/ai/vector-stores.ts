import { MongoClient, type Document } from 'mongodb';
import type { ICredentialType, IDataObject, INodeType } from '@8n8/workflow';
import { vectorStoreNode, type AiDocument } from './rag';

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

export const moreVectorStores: INodeType[] = [SupabaseVectorStore, MongoDbAtlasVectorStore];
