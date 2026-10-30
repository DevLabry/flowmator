import type { Redis } from 'ioredis';
import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, INodeType, ITriggerFunctions } from '@8n8/workflow';
import { NodeOperationError } from '@8n8/workflow';
import { redisClient } from '../../ai/subnodes';
import { errorItem } from '../../utils/object';

type RedisCreds = Parameters<typeof redisClient>[0];

/** `INFO` output as an object: sections are flattened, numbers parsed. */
export function parseRedisInfo(info: string): IDataObject {
  const out: IDataObject = {};
  for (const line of info.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at < 0) continue;
    const key = line.slice(0, at);
    const raw = line.slice(at + 1);
    // e.g. db0:keys=1,expires=0
    if (/^[a-z_]+=/.test(raw) && raw.includes(',')) out[key] = Object.fromEntries(raw.split(',').map((kv) => kv.split('=')).map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)]));
    else out[key] = raw !== '' && !isNaN(Number(raw)) ? Number(raw) : raw;
  }
  return out;
}

/** Sets `value` at a dot path (or a plain key when dot notation is off). */
function setPath(target: IDataObject, path: string, value: unknown, dotNotation: boolean) {
  if (!dotNotation) return void (target[path] = value as IDataObject);
  const keys = path.split('.');
  let t = target;
  for (const k of keys.slice(0, -1)) t = (t[k] = t[k] && typeof t[k] === 'object' ? t[k] : {}) as IDataObject;
  t[keys.at(-1)!] = value as IDataObject;
}

async function readKey(redis: Redis, key: string, type: string): Promise<unknown> {
  const actual = type === 'automatic' ? await redis.type(key) : type;
  if (actual === 'string') return redis.get(key);
  if (actual === 'hash') return redis.hgetall(key);
  if (actual === 'list') return redis.lrange(key, 0, -1);
  if (actual === 'sets' || actual === 'set') return redis.smembers(key);
  return null;
}

async function writeKey(redis: Redis, key: string, value: unknown, type: string, ttl?: number) {
  const json = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  let kind = type;
  if (kind === 'automatic') kind = Array.isArray(value) ? 'list' : value && typeof value === 'object' ? 'hash' : 'string';
  if (kind === 'string') await redis.set(key, json(value));
  else if (kind === 'hash') {
    const obj = (typeof value === 'string' ? JSON.parse(value) : value) as IDataObject;
    await redis.hset(key, Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k, json(v)])));
  } else if (kind === 'list') {
    const list = (typeof value === 'string' ? JSON.parse(value) : value) as unknown[];
    await redis.multi().del(key).rpush(key, ...list.map(json)).exec();
  } else if (kind === 'sets') {
    const list = (typeof value === 'string' ? JSON.parse(value) : value) as unknown[];
    await redis.sadd(key, ...list.map(json));
  }
  if (ttl) await redis.expire(key, ttl);
}

const show = (operation: string[]) => ({ show: { operation } });
const keyTypes = (auto: boolean) => [
  ...(auto ? [{ name: 'Automatic', value: 'automatic' }] : []),
  { name: 'Hash', value: 'hash' },
  { name: 'List', value: 'list' },
  { name: 'Sets', value: 'sets' },
  { name: 'String', value: 'string' },
];

const properties: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    default: 'info',
    options: [
      { name: 'Delete', value: 'delete', action: 'Delete a key' },
      { name: 'Get', value: 'get', action: 'Get the value of a key' },
      { name: 'Increment', value: 'incr', action: 'Atomically increment a key' },
      { name: 'Info', value: 'info', action: 'Get Redis info' },
      { name: 'Keys', value: 'keys', action: 'Return keys matching a pattern' },
      { name: 'List Length', value: 'llen', action: 'Get the length of a list' },
      { name: 'Pop', value: 'pop', action: 'Pop data from a list' },
      { name: 'Publish', value: 'publish', action: 'Publish a message to a channel' },
      { name: 'Push', value: 'push', action: 'Push data to a list' },
      { name: 'Set', value: 'set', action: 'Set the value of a key' },
    ],
  },
  { displayName: 'Name', name: 'propertyName', type: 'string', default: 'propertyName', required: true, displayOptions: show(['get', 'pop']), description: 'Output field for the value; dot notation writes nested fields' },
  { displayName: 'Key', name: 'key', type: 'string', default: '', required: true, displayOptions: show(['delete', 'get', 'incr', 'set']) },
  { displayName: 'Key Type', name: 'keyType', type: 'options', default: 'automatic', displayOptions: show(['get']), options: keyTypes(true) },
  { displayName: 'Value', name: 'value', type: 'string', default: '', displayOptions: show(['set']) },
  { displayName: 'Key Type', name: 'keyType', type: 'options', default: 'automatic', displayOptions: show(['set']), options: keyTypes(true), description: 'Automatic stores objects as hashes and arrays as lists' },
  { displayName: 'Value Is JSON', name: 'valueIsJSON', type: 'boolean', default: true, displayOptions: { show: { operation: ['set'], keyType: ['hash'] } } },
  { displayName: 'Expire', name: 'expire', type: 'boolean', default: false, displayOptions: show(['set', 'incr']) },
  { displayName: 'TTL', name: 'ttl', type: 'number', default: 60, typeOptions: { minValue: 1 }, displayOptions: { show: { operation: ['set', 'incr'], expire: [true] } }, description: 'Seconds' },
  { displayName: 'Key Pattern', name: 'keyPattern', type: 'string', default: '', required: true, displayOptions: show(['keys']), placeholder: 'user:*' },
  { displayName: 'Get Values', name: 'getValues', type: 'boolean', default: true, displayOptions: show(['keys']) },
  { displayName: 'List', name: 'list', type: 'string', default: '', required: true, displayOptions: show(['llen', 'pop', 'push']) },
  { displayName: 'Channel', name: 'channel', type: 'string', default: '', required: true, displayOptions: show(['publish']) },
  { displayName: 'Data', name: 'messageData', type: 'string', default: '', required: true, displayOptions: show(['publish', 'push']) },
  { displayName: 'Tail', name: 'tail', type: 'boolean', default: false, displayOptions: show(['push', 'pop']), description: 'Use the end of the list instead of the start' },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    displayOptions: show(['get', 'pop']),
    options: [{ displayName: 'Dot Notation', name: 'dotNotation', type: 'boolean', default: true, description: 'Write "a.b" as a nested field' }],
  },
];

export const RedisNode: INodeType = {
  description: {
    name: '8n8.redis',
    displayName: 'Redis',
    description: 'Get, set, increment, publish and push data in Redis',
    group: ['input'],
    version: 1,
    defaults: { name: 'Redis', color: '#DC382D' },
    icon: 'fa:database',
    subtitle: '={{$parameter["operation"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'redis', required: true }],
    codex: { categories: ['Data & Storage'], alias: ['Cache', 'Key Value', 'Valkey'] },
    properties,
  },
  async execute(this: IExecuteFunctions) {
    const redis = redisClient(await this.getCredentials<RedisCreds>('redis'));
    await redis.connect().catch((e: Error) => {
      redis.disconnect();
      throw new NodeOperationError(this.getNode(), `Could not connect to Redis: ${e.message}`);
    });
    const items = this.getInputData();
    const op = this.getNodeParameter('operation', 0) as string;
    const out: INodeExecutionData[] = [];
    try {
      // info runs once, not per item
      if (op === 'info') return [[{ json: parseRedisInfo(await redis.info()), pairedItem: { item: 0 } }]];
      for (let i = 0; i < items.length; i++) {
        try {
          out.push({ json: await runRedis(this, redis, op, i, items[i].json), pairedItem: { item: i } });
        } catch (e) {
          if (this.continueOnFail()) out.push(errorItem(e, i));
          else throw new NodeOperationError(this.getNode(), e as Error, { itemIndex: i });
        }
      }
    } finally {
      await redis.quit().catch(() => redis.disconnect());
    }
    return [out];
  },
};

async function runRedis(ctx: IExecuteFunctions, redis: Redis, op: string, i: number, input: IDataObject): Promise<IDataObject> {
  const p = <T = string>(name: string, fallback?: unknown) => ctx.getNodeParameter(name, i, fallback) as T;
  const json: IDataObject = { ...input };
  const dot = p<IDataObject>('options', {}).dotNotation !== false;
  const ttl = p<boolean>('expire', false) ? Number(p('ttl', 60)) : undefined;

  if (op === 'delete') {
    await redis.del(p('key'));
    return json;
  }
  if (op === 'get') {
    setPath(json, p('propertyName'), await readKey(redis, p('key'), p('keyType', 'automatic')), dot);
    return json;
  }
  if (op === 'set') {
    let value: unknown = p<unknown>('value', '');
    const type = p('keyType', 'automatic');
    if (typeof value === 'string' && (type === 'list' || type === 'sets' || (type === 'hash' && p('valueIsJSON', true)) || type === 'automatic')) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object') value = parsed;
      } catch {}
    }
    await writeKey(redis, p('key'), value, type, ttl);
    return json;
  }
  if (op === 'incr') {
    const key = p('key');
    const value = await redis.incr(key);
    if (ttl) await redis.expire(key, ttl);
    return { [key]: value };
  }
  if (op === 'keys') {
    const keys = await redis.keys(p('keyPattern'));
    if (!p<boolean>('getValues', true)) return { keys };
    const result: IDataObject = {};
    for (const key of keys) result[key] = (await readKey(redis, key, 'automatic')) as IDataObject;
    return result;
  }
  if (op === 'llen') return { [p('list')]: await redis.llen(p('list')) };
  if (op === 'publish') {
    await redis.publish(p('channel'), p('messageData'));
    return json;
  }
  if (op === 'push') {
    const list = p('list');
    if (p<boolean>('tail', false)) await redis.rpush(list, p('messageData'));
    else await redis.lpush(list, p('messageData'));
    return json;
  }
  if (op === 'pop') {
    const raw = p<boolean>('tail', false) ? await redis.rpop(p('list')) : await redis.lpop(p('list'));
    let value: unknown = raw;
    try {
      if (raw !== null) value = JSON.parse(raw);
    } catch {}
    setPath(json, p('propertyName'), value, dot);
    return json;
  }
  throw new Error(`Unknown operation "${op}"`);
}

export const RedisTrigger: INodeType = {
  description: {
    name: '8n8.redisTrigger',
    displayName: 'Redis Trigger',
    description: 'Starts the workflow when a message is published to a Redis channel',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Redis Trigger', color: '#DC382D' },
    icon: 'fa:database',
    inputs: [],
    outputs: ['main'],
    credentials: [{ name: 'redis', required: true }],
    properties: [
      { displayName: 'Channels', name: 'channels', type: 'string', default: '', required: true, placeholder: 'orders, user:*', description: 'Comma separated; "*" patterns subscribe with PSUBSCRIBE' },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'JSON Parse Body', name: 'jsonParseBody', type: 'boolean', default: false },
          { displayName: 'Only Message', name: 'onlyMessage', type: 'boolean', default: false, description: 'Output just the message instead of channel and message' },
        ],
      },
    ],
  },
  async trigger(this: ITriggerFunctions) {
    const channels = String(this.getNodeParameter('channels', '')).split(',').map((c) => c.trim()).filter(Boolean);
    if (!channels.length) throw new NodeOperationError(this.getNode(), 'Set at least one channel');
    const o = this.getNodeParameter('options', {}) as IDataObject;
    const redis = redisClient(await this.getCredentials<RedisCreds>('redis'));
    await redis.connect();

    const emit = (channel: string, message: string) => {
      let body: unknown = message;
      if (o.jsonParseBody) {
        try {
          body = JSON.parse(message);
        } catch {}
      }
      const json = (o.onlyMessage ? (body && typeof body === 'object' ? body : { message: body }) : { channel, message: body }) as IDataObject;
      this.emit([[{ json }]]);
    };
    const patterns = channels.filter((c) => c.includes('*'));
    const exact = channels.filter((c) => !c.includes('*'));
    redis.on('message', emit);
    redis.on('pmessage', (_pattern: string, channel: string, message: string) => emit(channel, message));
    if (exact.length) await redis.subscribe(...exact);
    if (patterns.length) await redis.psubscribe(...patterns);
    return { closeFunction: async () => void (await redis.quit().catch(() => redis.disconnect())) };
  },
};
