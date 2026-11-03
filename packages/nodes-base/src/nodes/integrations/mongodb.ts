import { MongoClient, ObjectId, type Document } from 'mongodb';
import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, INodeType } from '@flowmator/workflow';
import { NodeOperationError } from '@flowmator/workflow';
import { mongoUri } from '../../ai/vector-stores';
import { jsonParam } from '../../utils/api';
import { errorItem } from '../../utils/object';

type MongoCreds = Parameters<typeof mongoUri>[0];

/** The collection calls the node makes; tests swap in a recording fake. */
export interface MongoCollection {
  find(query: Document, options: { limit?: number; skip?: number; sort?: Document; projection?: Document }): { toArray(): Promise<Document[]> };
  aggregate(pipeline: Document[]): { toArray(): Promise<Document[]> };
  insertMany(docs: Document[]): Promise<{ insertedIds: Record<number, unknown> }>;
  deleteMany(query: Document): Promise<{ deletedCount: number }>;
  updateOne(filter: Document, update: Document, options: { upsert?: boolean }): Promise<unknown>;
  findOneAndUpdate(filter: Document, update: Document, options: { upsert?: boolean; returnDocument: 'after' }): Promise<Document | null>;
  findOneAndReplace(filter: Document, replacement: Document, options: { upsert?: boolean; returnDocument: 'after' }): Promise<Document | null>;
}
export interface MongoSession {
  collection(name: string): MongoCollection;
  close(): Promise<void>;
}

export const mongoConnector = {
  async connect(c: MongoCreds): Promise<MongoSession> {
    const client = new MongoClient(mongoUri(c), { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    const db = client.db(c.database);
    return { collection: (name) => db.collection(name) as unknown as MongoCollection, close: () => client.close() };
  },
};

/** 24-hex `_id` strings become ObjectIds, so queries written as JSON can match them. */
export function toObjectIds(query: Document): Document {
  const fix = (v: unknown): unknown => {
    if (typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v)) return new ObjectId(v);
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object' && !(v instanceof ObjectId)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k.startsWith('$') ? fix(x) : x]));
    return v;
  };
  return Object.fromEntries(Object.entries(query).map(([k, v]) => [k, k === '_id' ? fix(v) : v]));
}

/** ObjectIds and dates go out as strings, like any other JSON value. */
const plain = (doc: Document): IDataObject => JSON.parse(JSON.stringify(doc));

/** Picks the listed fields (dot paths allowed) from an item; nested paths are kept nested unless dot notation is on. */
export function pickFields(json: IDataObject, fields: string[], o: { dotNotation?: boolean; dateFields?: string[] } = {}): Document {
  const doc: Document = {};
  for (const field of fields) {
    const value = field.split('.').reduce<unknown>((v, k) => (v as IDataObject | undefined)?.[k], json);
    if (value === undefined) continue;
    if (o.dotNotation || !field.includes('.')) doc[field] = value;
    else {
      const keys = field.split('.');
      let target = doc;
      for (const k of keys.slice(0, -1)) target = target[k] ??= {};
      target[keys.at(-1)!] = value;
    }
  }
  for (const f of o.dateFields ?? []) if (doc[f] !== undefined && doc[f] !== null) doc[f] = new Date(doc[f] as string);
  return doc;
}

const csv = (s: unknown) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const show = (operation: string[]) => ({ show: { operation } });

const properties: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    default: 'find',
    options: [
      { name: 'Aggregate', value: 'aggregate', action: 'Aggregate documents' },
      { name: 'Delete', value: 'delete', action: 'Delete documents' },
      { name: 'Find', value: 'find', action: 'Find documents' },
      { name: 'Find And Replace', value: 'findOneAndReplace', action: 'Find and replace documents' },
      { name: 'Find And Update', value: 'findOneAndUpdate', action: 'Find and update documents' },
      { name: 'Insert', value: 'insert', action: 'Insert documents' },
      { name: 'Update', value: 'update', action: 'Update documents' },
    ],
  },
  { displayName: 'Collection', name: 'collection', type: 'string', default: '', required: true },
  { displayName: 'Query (JSON Format)', name: 'query', type: 'json', default: '[{ "$match": {} }]', displayOptions: show(['aggregate']), description: 'The aggregation pipeline' },
  { displayName: 'Delete Query (JSON Format)', name: 'query', type: 'json', default: '{}', displayOptions: show(['delete']), placeholder: '{ "birth": { "$gt": "1950-01-01" } }' },
  { displayName: 'Query (JSON Format)', name: 'query', type: 'json', default: '{}', displayOptions: show(['find']), placeholder: '{ "birth": { "$gt": "1950-01-01" } }' },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    displayOptions: show(['find']),
    options: [
      { displayName: 'Limit', name: 'limit', type: 'number', default: 0, description: '0 returns every document' },
      { displayName: 'Skip', name: 'skip', type: 'number', default: 0 },
      { displayName: 'Sort (JSON Format)', name: 'sort', type: 'json', default: '{}', placeholder: '{ "field": -1 }' },
      { displayName: 'Projection', name: 'projection', type: 'json', default: '{}', placeholder: '{ "_id": 0, "field": 1 }' },
    ],
  },
  { displayName: 'Fields', name: 'fields', type: 'string', default: '', displayOptions: show(['insert', 'update', 'findOneAndReplace', 'findOneAndUpdate']), placeholder: 'name,description', description: 'Comma separated input fields to write' },
  { displayName: 'Update Key', name: 'updateKey', type: 'string', default: 'id', displayOptions: show(['update', 'findOneAndReplace', 'findOneAndUpdate']), description: 'Field that identifies the document to change (often "id" or "_id")' },
  { displayName: 'Upsert', name: 'upsert', type: 'boolean', default: false, displayOptions: show(['update', 'findOneAndReplace', 'findOneAndUpdate']), description: 'Insert the document when nothing matches' },
  {
    displayName: 'Options',
    name: 'writeOptions',
    type: 'collection',
    default: {},
    displayOptions: show(['insert', 'update', 'findOneAndReplace', 'findOneAndUpdate']),
    options: [
      { displayName: 'Date Fields', name: 'dateFields', type: 'string', default: '', description: 'Comma separated fields stored as dates' },
      { displayName: 'Use Dot Notation', name: 'useDotNotation', type: 'boolean', default: false, description: 'Write "a.b" as a field named "a.b" (for $set) instead of a nested object' },
    ],
  },
];

export const MongoDb: INodeType = {
  description: {
    name: 'flowmator.mongoDb',
    displayName: 'MongoDB',
    description: 'Find, insert and update documents in MongoDB',
    group: ['input'],
    version: [1, 1.1, 1.2],
    defaults: { name: 'MongoDB', color: '#13AA52' },
    icon: 'fa:leaf',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["collection"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'mongoDb', required: true }],
    codex: { categories: ['Data & Storage'], alias: ['NoSQL', 'Database', 'Atlas'] },
    properties,
  },
  async execute(this: IExecuteFunctions) {
    const creds = await this.getCredentials<MongoCreds>('mongoDb');
    const db = await mongoConnector.connect(creds).catch((e: Error) => {
      throw new NodeOperationError(this.getNode(), `Could not connect to MongoDB: ${e.message}`);
    });
    const items = this.getInputData();
    const op = this.getNodeParameter('operation', 0) as string;
    const out: INodeExecutionData[] = [];
    try {
      // inserts go in one batch
      if (op === 'insert') {
        const docs = items.map((item, i) => {
          const o = this.getNodeParameter('writeOptions', i, {}) as IDataObject;
          return pickFields(item.json, csv(this.getNodeParameter('fields', i, '')), { dotNotation: !!o.useDotNotation, dateFields: csv(o.dateFields) });
        });
        const coll = db.collection(this.getNodeParameter('collection', 0) as string);
        const r = await coll.insertMany(docs);
        docs.forEach((doc, i) => out.push({ json: plain({ ...doc, id: r.insertedIds[i] }), pairedItem: { item: i } }));
        return [out];
      }
      for (let i = 0; i < items.length; i++) {
        try {
          for (const json of await runMongo(this, db, op, i, items[i].json)) out.push({ json, pairedItem: { item: i } });
        } catch (e) {
          if (this.continueOnFail()) out.push(errorItem(e, i));
          else throw new NodeOperationError(this.getNode(), e as Error, { itemIndex: i });
        }
      }
    } finally {
      await db.close().catch(() => {});
    }
    return [out];
  },
};

async function runMongo(ctx: IExecuteFunctions, db: MongoSession, op: string, i: number, json: IDataObject): Promise<IDataObject[]> {
  const p = <T = string>(name: string, fallback?: unknown) => ctx.getNodeParameter(name, i, fallback) as T;
  const coll = db.collection(p('collection'));

  if (op === 'aggregate') {
    const pipeline = p<unknown>('query');
    const stages = typeof pipeline === 'string' ? JSON.parse(pipeline) : pipeline;
    if (!Array.isArray(stages)) throw new Error('The aggregation pipeline must be a JSON array');
    return (await coll.aggregate(stages).toArray()).map(plain);
  }
  if (op === 'find') {
    const o = p<IDataObject>('options', {});
    const docs = await coll
      .find(toObjectIds(jsonParam(p<unknown>('query', '{}'), 'Query')), {
        ...(Number(o.limit) > 0 ? { limit: Number(o.limit) } : {}),
        ...(Number(o.skip) > 0 ? { skip: Number(o.skip) } : {}),
        ...(o.sort ? { sort: jsonParam(o.sort, 'Sort') } : {}),
        ...(o.projection ? { projection: jsonParam(o.projection, 'Projection') } : {}),
      })
      .toArray();
    return docs.map(plain);
  }
  if (op === 'delete') {
    const r = await coll.deleteMany(toObjectIds(jsonParam(p<unknown>('query', '{}'), 'Delete Query')));
    return [{ deletedCount: r.deletedCount }];
  }

  // update / findOneAndUpdate / findOneAndReplace
  const o = p<IDataObject>('writeOptions', {});
  const key = p('updateKey', 'id').trim();
  const doc = pickFields(json, csv(p('fields', '')), { dotNotation: !!o.useDotNotation, dateFields: csv(o.dateFields) });
  const keyValue = json[key];
  if (keyValue === undefined) throw new Error(`The item has no value for the update key "${key}"`);
  const filter = toObjectIds({ [key]: keyValue });
  delete doc[key];
  if (key !== '_id') delete doc._id;
  const upsert = p<boolean>('upsert', false);
  if (op === 'update') await coll.updateOne(filter, { $set: doc }, { upsert });
  else if (op === 'findOneAndUpdate') await coll.findOneAndUpdate(filter, { $set: doc }, { upsert, returnDocument: 'after' });
  else await coll.findOneAndReplace(filter, { [key]: keyValue, ...doc }, { upsert, returnDocument: 'after' });
  // the written fields come out (with the key)
  return [plain({ ...doc, [key]: keyValue })];
}
