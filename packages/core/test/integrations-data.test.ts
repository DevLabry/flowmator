import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mongoConnector, parseRedisInfo, s3KeyPath, s3Url, signAws, toObjectIds, type MongoCollection } from '@flowmator/nodes-base';
import { ObjectId } from '../../nodes-base/node_modules/mongodb';
import { connections, items, makeWorkflow, node, out, run } from './helpers';
import { calls, creds, credentialsHelper, route, runNode, withCred } from './integration-harness';

const xmlResponse = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'application/xml', ...headers } });

/* ---------- MongoDB ---------- */

describe('MongoDB', () => {
  const log: Array<[string, ...unknown[]]> = [];
  let docs: Array<Record<string, unknown>> = [];
  const fake: MongoCollection = {
    find: (query, options) => (log.push(['find', query, options]), { toArray: async () => docs }),
    aggregate: (pipeline) => (log.push(['aggregate', pipeline]), { toArray: async () => [{ _id: 'x', total: 3 }] }),
    insertMany: async (d) => (log.push(['insertMany', d]), { insertedIds: Object.fromEntries(d.map((_, i) => [i, new ObjectId('65a1b2c3d4e5f60718293a4' + i)])) }),
    deleteMany: async (q) => (log.push(['deleteMany', q]), { deletedCount: 2 }),
    updateOne: async (f, u, o) => void log.push(['updateOne', f, u, o]),
    findOneAndUpdate: async (f, u, o) => (log.push(['findOneAndUpdate', f, u, o]), null),
    findOneAndReplace: async (f, r, o) => (log.push(['findOneAndReplace', f, r, o]), null),
  };
  let closed = 0;
  beforeAll(() => {
    creds.mongoDb = { configurationType: 'connectionString', connectionString: 'mongodb://db', database: 'app' };
    mongoConnector.connect = async () => ({ collection: (name: string) => (log.push(['collection', name]), fake), close: async () => void closed++ });
  });

  it('finds with query options and turns ObjectIds into strings', async () => {
    docs = [{ _id: new ObjectId('65a1b2c3d4e5f60718293a4b'), name: 'Ada', born: new Date('1815-12-10T00:00:00Z') }];
    const out = await runNode('mongoDb', { operation: 'find', collection: 'people', query: '{ "_id": "65a1b2c3d4e5f60718293a4b" }', options: { limit: 5, sort: '{ "name": 1 }' } }, 'mongoDb');
    expect(out).toEqual([{ _id: '65a1b2c3d4e5f60718293a4b', name: 'Ada', born: '1815-12-10T00:00:00.000Z' }]);
    const [, query, options] = log.find((l) => l[0] === 'find')!;
    expect((query as any)._id).toBeInstanceOf(ObjectId);
    expect(options).toEqual({ limit: 5, sort: { name: 1 } });
    expect(closed).toBeGreaterThan(0);
  });

  it('inserts every item in one batch with the chosen fields', async () => {
    log.length = 0;
    const out = await runNode('mongoDb', { operation: 'insert', collection: 'people', fields: 'name,address.city,born', writeOptions: { dateFields: 'born' } }, 'mongoDb', items({ name: 'Ada', address: { city: 'London', zip: 'X' }, born: '1815-12-10', extra: 1 }, { name: 'Alan', born: '1912-06-23' }));
    const inserts = log.filter((l) => l[0] === 'insertMany');
    expect(inserts).toHaveLength(1);
    const written = inserts[0][1] as Array<Record<string, unknown>>;
    expect(written[0]).toEqual({ name: 'Ada', address: { city: 'London' }, born: new Date('1815-12-10') });
    expect(out.map((o) => o.id)).toEqual(['65a1b2c3d4e5f60718293a40', '65a1b2c3d4e5f60718293a41']);
  });

  it('updates by key, upserts, deletes and aggregates', async () => {
    log.length = 0;
    const out = await runNode('mongoDb', { operation: 'update', collection: 'people', fields: 'name', updateKey: 'email', upsert: true }, 'mongoDb', items({ email: 'a@x.io', name: 'Ada L.' }));
    expect(out).toEqual([{ name: 'Ada L.', email: 'a@x.io' }]);
    expect(log.find((l) => l[0] === 'updateOne')!.slice(1)).toEqual([{ email: 'a@x.io' }, { $set: { name: 'Ada L.' } }, { upsert: true }]);

    await runNode('mongoDb', { operation: 'findOneAndReplace', collection: 'people', fields: 'name', updateKey: 'email' }, 'mongoDb', items({ email: 'a@x.io', name: 'Ada' }));
    expect(log.find((l) => l[0] === 'findOneAndReplace')![2]).toEqual({ email: 'a@x.io', name: 'Ada' });

    expect(await runNode('mongoDb', { operation: 'delete', collection: 'people', query: '{ "age": { "$lt": 18 } }' }, 'mongoDb')).toEqual([{ deletedCount: 2 }]);
    expect(await runNode('mongoDb', { operation: 'aggregate', collection: 'people', query: '[{ "$count": "total" }]' }, 'mongoDb')).toEqual([{ _id: 'x', total: 3 }]);
    expect(log.find((l) => l[0] === 'aggregate')![1]).toEqual([{ $count: 'total' }]);
  });

  it('only converts _id values that look like ObjectIds', () => {
    const q = toObjectIds({ _id: { $in: ['65a1b2c3d4e5f60718293a4b', 'nope'] }, ref: '65a1b2c3d4e5f60718293a4b' });
    expect((q._id as any).$in[0]).toBeInstanceOf(ObjectId);
    expect((q._id as any).$in[1]).toBe('nope');
    expect(q.ref).toBe('65a1b2c3d4e5f60718293a4b');
  });
});

/* ---------- Redis ---------- */

const redisBinary = process.env.REDIS_SERVER ?? spawnSync('which', ['redis-server'], { encoding: 'utf8' }).stdout.trim();

describe.skipIf(!redisBinary)('Redis', () => {
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

  const redisOp = (params: Record<string, unknown>, input = items({})) => runNode('redis', params, 'redis', input);

  it('sets and gets strings, hashes and lists', async () => {
    await redisOp({ operation: 'set', key: 'greeting', value: 'hello', keyType: 'string' });
    await redisOp({ operation: 'set', key: 'user:1', value: '{"name":"Ada","age":36}', keyType: 'automatic' });
    await redisOp({ operation: 'set', key: 'tags', value: '["a","b"]', keyType: 'list', expire: true, ttl: 100 });
    const [got] = await redisOp({ operation: 'get', key: 'greeting', propertyName: 'out.greeting', keyType: 'automatic' }, items({ keep: true }));
    expect(got).toEqual({ keep: true, out: { greeting: 'hello' } });
    expect((await redisOp({ operation: 'get', key: 'user:1', propertyName: 'user' }))[0].user).toEqual({ name: 'Ada', age: '36' });
    expect((await redisOp({ operation: 'get', key: 'tags', propertyName: 'tags' }))[0].tags).toEqual(['a', 'b']);
    expect((await redisOp({ operation: 'keys', keyPattern: 'user:*', getValues: true }))[0]).toEqual({ 'user:1': { name: 'Ada', age: '36' } });
  });

  it('increments, pushes, pops, measures and deletes', async () => {
    expect(await redisOp({ operation: 'incr', key: 'counter' }, items({}, {}))).toEqual([{ counter: 1 }, { counter: 2 }]);
    await redisOp({ operation: 'push', list: 'queue', messageData: '{"job":1}', tail: true });
    await redisOp({ operation: 'push', list: 'queue', messageData: 'second', tail: true });
    expect(await redisOp({ operation: 'llen', list: 'queue' })).toEqual([{ queue: 2 }]);
    expect((await redisOp({ operation: 'pop', list: 'queue', propertyName: 'next' }))[0].next).toEqual({ job: 1 });
    await redisOp({ operation: 'delete', key: 'counter' });
    expect((await redisOp({ operation: 'get', key: 'counter', propertyName: 'v' }))[0].v).toBeNull();
    const [info] = await redisOp({ operation: 'info' }, items({}, {}));
    expect(info.redis_version).toBeTruthy();
  });

  it('triggers on published messages, with patterns', async () => {
    const listen = (options: Record<string, unknown>) => {
      const wf = makeWorkflow([node('Sub', 'redisTrigger', { channels: 'orders, events:*', options }, withCred('redis'))], {});
      return run(wf, { additional: { credentialsHelper } });
    };
    const publish = async (channel: string, messageData: string) => {
      await new Promise((r) => setTimeout(r, 200));
      await redisOp({ operation: 'publish', channel, messageData });
    };
    const first = listen({ jsonParseBody: true });
    await publish('events:new', '{"id":7}');
    expect(out(await first, 'Sub')).toEqual([{ channel: 'events:new', message: { id: 7 } }]);
    const second = listen({ onlyMessage: true });
    await publish('orders', 'plain');
    expect(out(await second, 'Sub')).toEqual([{ message: 'plain' }]);
  });

  it('parses INFO output', () => {
    expect(parseRedisInfo('# Server\r\nredis_version:7.2.4\r\nuptime_in_seconds:12\r\n# Keyspace\r\ndb0:keys=3,expires=1,avg_ttl=0\r\n')).toEqual({ redis_version: '7.2.4', uptime_in_seconds: 12, db0: { keys: 3, expires: 1, avg_ttl: 0 } });
  });
});

/* ---------- S3 ---------- */

describe('AWS S3', () => {
  beforeAll(() => {
    creds.aws = { region: 'eu-west-1', accessKeyId: 'AKID', secretAccessKey: 'secret' };
    creds.s3 = { endpoint: 'https://minio.local:9000', region: 'us-east-1', accessKeyId: 'minio', secretAccessKey: 'minio-secret', forcePathStyle: true };
  });

  it('builds virtual-hosted and path-style URLs with encoded keys', () => {
    const c = { accessKeyId: '', secretAccessKey: '', region: 'eu-west-1' };
    expect(s3Url(c, 'eu-west-1', 'docs', 'a b/ñ+(1).pdf')).toBe('https://docs.s3.eu-west-1.amazonaws.com/a%20b/%C3%B1%2B%281%29.pdf');
    expect(s3Url(c, 'eu-west-1', 'my.bucket', 'k')).toBe('https://s3.eu-west-1.amazonaws.com/my.bucket/k');
    expect(s3Url({ ...c, endpoint: 'https://minio.local:9000/' }, 'us-east-1', 'b', 'k', { 'list-type': '2' })).toBe('https://minio.local:9000/b/k?list-type=2');
    expect(s3KeyPath('x/y z')).toBe('x/y%20z');
  });

  it('signs S3 requests with the payload hash and an unencoded canonical path', () => {
    const headers = signAws({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9' } }, { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }, 'us-east-1', 's3', new Date('2013-05-24T00:00:00Z'));
    // AWS's documented GetObject example
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(headers['x-amz-content-sha256']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('uploads text with tags and metadata, then downloads it as binary', async () => {
    route(/PUT https:\/\/docs\.s3\.eu-west-1\.amazonaws\.com\/reports\/q1\.txt/, () => new Response('', { headers: { etag: '"abc"' } }));
    const [up] = await runNode('awsS3', { resource: 'file', operation: 'upload', bucketName: 'docs', fileName: 'q1.txt', binaryData: false, fileContent: 'hola', additionalFields: { parentFolderKey: 'reports/', storageClass: 'STANDARD_IA' }, tagsUi: { tagsValues: [{ key: 'team', value: 'ops & data' }] }, metadataUi: { metadataValues: [{ key: 'Owner', value: 'ada' }] } }, 'aws');
    expect(up).toEqual({ success: true, key: 'reports/q1.txt', etag: '"abc"' });
    const put = calls.at(-1)!;
    expect(put.headers['x-amz-storage-class']).toBe('STANDARD_IA');
    expect(put.headers['x-amz-tagging']).toBe('team=ops%20%26%20data');
    expect(put.headers['x-amz-meta-owner']).toBe('ada');
    expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/s3\/aws4_request/);

    route(/GET https:\/\/docs\.s3\.eu-west-1\.amazonaws\.com\/reports\/q1\.txt/, () => new Response('hola', { headers: { 'content-type': 'text/plain' } }));
    const wf = makeWorkflow([node('Trigger', 'manualTrigger'), node('S3', 'awsS3', { resource: 'file', operation: 'download', bucketName: 'docs', fileKey: 'reports/q1.txt', binaryPropertyName: 'file' }, withCred('aws'))], connections(['Trigger', 'S3']));
    const r = await run(wf, { triggerData: items({}), additional: { credentialsHelper } });
    const item = r.data.resultData.runData.S3![0]!.data!.main![0]![0]!;
    expect(item.binary!.file).toMatchObject({ fileName: 'q1.txt', mimeType: 'text/plain' });
    expect(Buffer.from(item.binary!.file.data, 'base64').toString()).toBe('hola');
  });

  it('lists objects across pages and separates files from folders', async () => {
    const page = (keys: string[], next?: string) =>
      xmlResponse(`<?xml version="1.0"?><ListBucketResult><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}${keys.map((k) => `<Contents><Key>${k}</Key><Size>${k.endsWith('/') ? 0 : 10}</Size></Contents>`).join('')}</ListBucketResult>`);
    route(/GET https:\/\/docs\.s3\.eu-west-1\.amazonaws\.com\//, (c) => (c.url.searchParams.get('continuation-token') ? page(['inv/b.pdf', 'inv/old/']) : page(['inv/', 'inv/a.pdf'], 'tok2')));
    const files = await runNode('awsS3', { resource: 'file', operation: 'getAll', bucketName: 'docs', returnAll: true, options: { folderKey: 'inv' } }, 'aws');
    expect(files.map((f) => [f.Key, f.Size])).toEqual([['inv/a.pdf', 10], ['inv/b.pdf', 10]]);
    expect(calls[0].url.searchParams.get('prefix')).toBe('inv/');
    const folders = await runNode('awsS3', { resource: 'folder', operation: 'getAll', bucketName: 'docs', returnAll: true, options: { folderKey: 'inv' } }, 'aws');
    expect(folders.map((f) => f.Key)).toEqual(['inv/old/']);
  });

  it('deletes a folder with one multi-object delete', async () => {
    route(/GET https:\/\/docs\.s3/, () => xmlResponse('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>tmp/a&amp;b.txt</Key></Contents><Contents><Key>tmp/</Key></Contents></ListBucketResult>'));
    route(/POST https:\/\/docs\.s3/, () => xmlResponse('<DeleteResult></DeleteResult>'));
    const [r] = await runNode('awsS3', { resource: 'folder', operation: 'delete', bucketName: 'docs', folderKey: 'tmp' }, 'aws');
    expect(r).toEqual({ success: true, deleted: 2 });
    const del = calls.find((c) => c.method === 'POST')!;
    expect(del.url.search).toBe('?delete');
    expect(del.body).toContain('<Key>tmp/a&#38;b.txt</Key>');
    expect(del.headers['content-md5']).toBeTruthy();
  });

  it('follows the bucket region and reports S3 errors', async () => {
    route(/PUT https:\/\/docs\.s3\.eu-west-1/, () => xmlResponse('<Error><Code>PermanentRedirect</Code></Error>', 301, { 'x-amz-bucket-region': 'us-west-2' }));
    route(/PUT https:\/\/docs\.s3\.us-west-2/, () => new Response(''));
    await runNode('awsS3', { resource: 'folder', operation: 'create', bucketName: 'docs', folderName: 'new' }, 'aws');
    expect(calls.map((c) => c.url.host)).toEqual(['docs.s3.eu-west-1.amazonaws.com', 'docs.s3.us-west-2.amazonaws.com']);
    expect(calls[1].url.pathname).toBe('/new/');

    route(/DELETE https:\/\/docs\.s3/, () => xmlResponse('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', 403));
    await expect(runNode('awsS3', { resource: 'file', operation: 'delete', bucketName: 'docs', fileKey: 'x' }, 'aws')).rejects.toThrow('S3 error: 403 AccessDenied: Access Denied');
  });

  it('copies files and works with S3-compatible endpoints (path style)', async () => {
    route(/PUT https:\/\/minio\.local:9000\/backup\/copy\.txt/, () => xmlResponse('<CopyObjectResult><ETag>"e1"</ETag></CopyObjectResult>'));
    const [r] = await runNode('s3', { resource: 'file', operation: 'copy', sourcePath: '/docs/a b.txt', destinationPath: '/backup/copy.txt' }, 's3');
    expect(r).toMatchObject({ success: true, ETag: '"e1"' });
    expect(calls[0].headers['x-amz-copy-source']).toBe('/docs/a%20b.txt');
    expect(calls[0].headers.authorization).toContain('Credential=minio/');

    route(/GET https:\/\/minio\.local:9000\/$/, () => xmlResponse('<ListAllMyBucketsResult><Buckets><Bucket><Name>docs</Name></Bucket><Bucket><Name>backup</Name></Bucket></Buckets></ListAllMyBucketsResult>'));
    expect((await runNode('s3', { resource: 'bucket', operation: 'getAll', returnAll: true }, 's3')).map((b) => b.Name)).toEqual(['docs', 'backup']);
  });
});
