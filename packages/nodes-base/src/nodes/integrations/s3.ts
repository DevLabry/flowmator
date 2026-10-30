import { createHash } from 'node:crypto';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { IDataObject, ICredentialType, IExecuteFunctions, INodeProperties, INodeType } from '@flowmator/workflow';
import { collectPages, forEachItem, forOp, listLimit, operationProp, returnAllProps } from '../../utils/api';
import { encodeRfc3986, signAws, type AwsCredentials } from '../../utils/aws';

interface S3Creds extends AwsCredentials {
  region: string;
  /** S3-compatible storage (MinIO, R2, Wasabi…) */
  endpoint?: string;
  forcePathStyle?: boolean;
}

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, isArray: (name, jpath) => ['Contents', 'CommonPrefixes', 'Bucket', 'Deleted', 'Tag'].includes(name) || jpath === 'DeleteResult.Error' });
const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
/** Object keys keep their "/" separators; everything else is RFC 3986 encoded. */
export const s3KeyPath = (key: string) => key.split('/').map(encodeRfc3986).join('/');

/** Virtual-hosted URLs on AWS, path-style on custom endpoints (unless told otherwise). */
export function s3Url(c: S3Creds, region: string, bucket?: string, key = '', qs: Record<string, string> = {}) {
  const custom = c.endpoint?.replace(/\/+$/, '');
  const pathStyle = custom ? c.forcePathStyle !== false : !!c.forcePathStyle || (bucket?.includes('.') ?? false);
  let base: string;
  let pathname: string;
  if (!bucket) {
    base = custom ?? `https://s3.${region}.amazonaws.com`;
    pathname = '/';
  } else if (pathStyle) {
    base = custom ?? `https://s3.${region}.amazonaws.com`;
    pathname = `/${encodeRfc3986(bucket)}/${s3KeyPath(key)}`;
  } else {
    base = custom ? custom.replace('://', `://${bucket}.`) : `https://${bucket}.s3.${region}.amazonaws.com`;
    pathname = `/${s3KeyPath(key)}`;
  }
  const query = Object.entries(qs)
    .map(([k, v]) => (v === '' ? encodeRfc3986(k) : `${encodeRfc3986(k)}=${encodeRfc3986(v)}`))
    .join('&');
  return `${base}${pathname}${query ? `?${query}` : ''}`;
}

interface S3Request {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
  bucket?: string;
  key?: string;
  qs?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

/** Signed request; follows the bucket's region when AWS says it lives elsewhere. */
async function s3Fetch(c: S3Creds, r: S3Request, region = c.region || 'us-east-1'): Promise<Response> {
  const url = s3Url(c, region, r.bucket, r.key, r.qs);
  const headers = signAws({ method: r.method, url, headers: r.headers, body: r.body }, c, region, 's3');
  const res = await fetch(url, { method: r.method, headers, body: r.body as BodyInit | undefined });
  const moved = res.headers.get('x-amz-bucket-region');
  if ((res.status === 301 || res.status === 400) && moved && moved !== region && !c.endpoint) return s3Fetch(c, r, moved);
  if (!res.ok) {
    const text = await res.text();
    const err = text ? (xml.parse(text).Error as IDataObject | undefined) : undefined;
    throw new Error(`S3 error: ${res.status} ${err?.Code ?? res.statusText}${err?.Message ? `: ${err.Message}` : ''}`);
  }
  return res;
}

async function s3Xml(c: S3Creds, r: S3Request): Promise<IDataObject> {
  const text = await (await s3Fetch(c, r)).text();
  return text ? xml.parse(text) : {};
}

const numberish = (o: IDataObject): IDataObject => ({ ...o, ...(o.Size !== undefined ? { Size: Number(o.Size) } : {}) });

async function listObjects(c: S3Creds, bucket: string, qs: Record<string, string>, limit: number | undefined) {
  return collectPages(async (token, size) => {
    const r = (await s3Xml(c, { method: 'GET', bucket, qs: { 'list-type': '2', 'max-keys': String(size), ...qs, ...(token ? { 'continuation-token': token } : {}) } })).ListBucketResult as IDataObject;
    return { items: ((r.Contents as IDataObject[]) ?? []).map(numberish), next: r.IsTruncated === 'true' ? String(r.NextContinuationToken) : undefined };
  }, limit, 1000);
}

/** "/bucket/path/to/file" → bucket and key */
function splitPath(p: string) {
  const [bucket, ...rest] = p.replace(/^\/+/, '').split('/');
  return { bucket, key: rest.join('/') };
}

const bucketProp: INodeProperties = { displayName: 'Bucket Name', name: 'bucketName', type: 'string', default: '', required: true };
const folderKeyProp = (name = 'folderKey'): INodeProperties => ({ displayName: 'Folder Key', name, type: 'string', default: '', placeholder: 'invoices/2026/', description: 'Path of the folder inside the bucket' });

const properties: INodeProperties[] = [
  { displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true, default: 'file', options: [{ name: 'Bucket', value: 'bucket' }, { name: 'File', value: 'file' }, { name: 'Folder', value: 'folder' }] },
  operationProp('bucket', [
    { name: 'Create', value: 'create' },
    { name: 'Delete', value: 'delete' },
    { name: 'Get Many', value: 'getAll' },
    { name: 'Search', value: 'search', description: 'List the objects in a bucket' },
  ]),
  operationProp('file', [
    { name: 'Copy', value: 'copy' },
    { name: 'Delete', value: 'delete' },
    { name: 'Download', value: 'download' },
    { name: 'Get Many', value: 'getAll' },
    { name: 'Upload', value: 'upload' },
  ], 'download'),
  operationProp('folder', [
    { name: 'Create', value: 'create' },
    { name: 'Delete', value: 'delete', description: 'Delete the folder and everything in it' },
    { name: 'Get Many', value: 'getAll' },
  ]),

  /* bucket */
  ...forOp('bucket', ['create', 'delete', 'search'], [{ ...bucketProp, name: 'name' }]),
  ...forOp('bucket', 'create', [
    {
      displayName: 'Additional Fields',
      name: 'additionalFields',
      type: 'collection',
      default: {},
      options: [
        { displayName: 'ACL', name: 'acl', type: 'options', default: 'private', options: ['authenticatedRead', 'private', 'publicRead', 'publicReadWrite'].map((v) => ({ name: v, value: v })) },
        { displayName: 'Object Lock Enabled', name: 'objectLockEnabledForBucket', type: 'boolean', default: false },
        { displayName: 'Region', name: 'region', type: 'string', default: '', description: 'Defaults to the credential region' },
      ],
    },
  ]),
  ...forOp('bucket', ['getAll', 'search'], returnAllProps({ resource: ['bucket'], operation: ['getAll', 'search'] })),
  ...forOp('bucket', 'search', [
    {
      displayName: 'Additional Fields',
      name: 'additionalFields',
      type: 'collection',
      default: {},
      options: [
        { displayName: 'Delimiter', name: 'delimiter', type: 'string', default: '' },
        { displayName: 'Fetch Owner', name: 'fetchOwner', type: 'boolean', default: false },
        { displayName: 'Prefix', name: 'prefix', type: 'string', default: '' },
        { displayName: 'Start After', name: 'startAfter', type: 'string', default: '' },
      ],
    },
  ]),

  /* file */
  ...forOp('file', 'copy', [
    { displayName: 'Source Path', name: 'sourcePath', type: 'string', default: '', required: true, placeholder: '/bucket/folder/file.txt' },
    { displayName: 'Destination Path', name: 'destinationPath', type: 'string', default: '', required: true, placeholder: '/bucket/folder/copy.txt' },
  ]),
  ...forOp('file', ['upload', 'delete', 'download', 'getAll'], [bucketProp]),
  ...forOp('file', ['delete', 'download'], [{ displayName: 'File Key', name: 'fileKey', type: 'string', default: '', required: true, placeholder: 'folder/file.txt' }]),
  ...forOp('file', 'download', [{ displayName: 'Put Output File in Field', name: 'binaryPropertyName', type: 'string', default: 'data', required: true }]),
  ...forOp('file', 'delete', [{ displayName: 'Options', name: 'options', type: 'collection', default: {}, options: [{ displayName: 'Version ID', name: 'versionId', type: 'string', default: '' }] }]),
  ...forOp('file', 'upload', [
    { displayName: 'File Name', name: 'fileName', type: 'string', default: '', required: true, placeholder: 'hello.txt', description: 'Key of the new object (can include folders)' },
    { displayName: 'Binary File', name: 'binaryData', type: 'boolean', default: true },
    { displayName: 'Input Binary Field', name: 'binaryPropertyName', type: 'string', default: 'data', displayOptions: { show: { binaryData: [true] } } },
    { displayName: 'File Content', name: 'fileContent', type: 'string', default: '', displayOptions: { show: { binaryData: [false] } } },
    {
      displayName: 'Additional Fields',
      name: 'additionalFields',
      type: 'collection',
      default: {},
      options: [
        { displayName: 'ACL', name: 'acl', type: 'options', default: 'private', options: ['authenticatedRead', 'awsExecRead', 'bucketOwnerFullControl', 'bucketOwnerRead', 'private', 'publicRead', 'publicReadWrite'].map((v) => ({ name: v, value: v })) },
        { displayName: 'Parent Folder Key', name: 'parentFolderKey', type: 'string', default: '' },
        { displayName: 'Server Side Encryption', name: 'serverSideEncryption', type: 'options', default: 'AES256', options: [{ name: 'AES256', value: 'AES256' }, { name: 'AWS:KMS', value: 'aws:kms' }] },
        { displayName: 'Storage Class', name: 'storageClass', type: 'options', default: 'STANDARD', options: ['STANDARD', 'REDUCED_REDUNDANCY', 'STANDARD_IA', 'ONEZONE_IA', 'INTELLIGENT_TIERING', 'GLACIER', 'GLACIER_IR', 'DEEP_ARCHIVE'].map((v) => ({ name: v, value: v })) },
      ],
    },
    {
      displayName: 'Tags',
      name: 'tagsUi',
      type: 'fixedCollection',
      typeOptions: { multipleValues: true },
      default: {},
      options: [{ name: 'tagsValues', displayName: 'Tag', values: [{ displayName: 'Key', name: 'key', type: 'string', default: '' }, { displayName: 'Value', name: 'value', type: 'string', default: '' }] }],
    },
    {
      displayName: 'Metadata',
      name: 'metadataUi',
      type: 'fixedCollection',
      typeOptions: { multipleValues: true },
      default: {},
      options: [{ name: 'metadataValues', displayName: 'Metadata', values: [{ displayName: 'Key', name: 'key', type: 'string', default: '' }, { displayName: 'Value', name: 'value', type: 'string', default: '' }] }],
    },
  ]),
  ...forOp('file', 'getAll', [...returnAllProps({ resource: ['file'], operation: ['getAll'] }), { displayName: 'Options', name: 'options', type: 'collection', default: {}, options: [folderKeyProp()] }]),

  /* folder */
  ...forOp('folder', ['create', 'delete', 'getAll'], [bucketProp]),
  ...forOp('folder', 'create', [
    { displayName: 'Folder Name', name: 'folderName', type: 'string', default: '', required: true },
    { displayName: 'Additional Fields', name: 'additionalFields', type: 'collection', default: {}, options: [{ displayName: 'Parent Folder Key', name: 'parentFolderKey', type: 'string', default: '' }] },
  ]),
  ...forOp('folder', 'delete', [{ ...folderKeyProp(), required: true }]),
  ...forOp('folder', 'getAll', [...returnAllProps({ resource: ['folder'], operation: ['getAll'] }), { displayName: 'Options', name: 'options', type: 'collection', default: {}, options: [folderKeyProp()] }]),
];

const ACL: Record<string, string> = {
  authenticatedRead: 'authenticated-read',
  awsExecRead: 'aws-exec-read',
  bucketOwnerFullControl: 'bucket-owner-full-control',
  bucketOwnerRead: 'bucket-owner-read',
  private: 'private',
  publicRead: 'public-read',
  publicReadWrite: 'public-read-write',
};

const join = (...parts: string[]) => parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

async function execute(this: IExecuteFunctions, credentialType: string) {
  const c = await this.getCredentials<S3Creds>(credentialType);
  return [
    await forEachItem(this, async (i, item) => {
      const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
      const resource = p('resource');
      const op = p('operation');

      if (resource === 'bucket') {
        if (op === 'getAll') {
          const r = (await s3Xml(c, { method: 'GET' })).ListAllMyBucketsResult as IDataObject;
          const buckets = (((r.Buckets as IDataObject)?.Bucket as IDataObject[]) ?? []);
          const limit = listLimit(this, i);
          return limit ? buckets.slice(0, limit) : buckets;
        }
        const bucket = p('name');
        if (op === 'create') {
          const f = p<IDataObject>('additionalFields', {});
          const region = String(f.region || c.region || 'us-east-1');
          const headers: Record<string, string> = {};
          if (f.acl) headers['x-amz-acl'] = ACL[String(f.acl)];
          if (f.objectLockEnabledForBucket) headers['x-amz-bucket-object-lock-enabled'] = 'true';
          const body = region === 'us-east-1' || c.endpoint ? undefined : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${escapeXml(region)}</LocationConstraint></CreateBucketConfiguration>`;
          await s3Fetch(c, { method: 'PUT', bucket, headers, body }, region);
          return { success: true };
        }
        if (op === 'delete') {
          await s3Fetch(c, { method: 'DELETE', bucket });
          return { success: true };
        }
        const f = p<IDataObject>('additionalFields', {});
        const qs: Record<string, string> = {};
        if (f.prefix) qs.prefix = String(f.prefix);
        if (f.delimiter) qs.delimiter = String(f.delimiter);
        if (f.startAfter) qs['start-after'] = String(f.startAfter);
        if (f.fetchOwner) qs['fetch-owner'] = 'true';
        return listObjects(c, bucket, qs, listLimit(this, i));
      }

      if (resource === 'file') {
        if (op === 'copy') {
          const src = splitPath(p('sourcePath'));
          const dest = splitPath(p('destinationPath'));
          const r = await s3Xml(c, { method: 'PUT', bucket: dest.bucket, key: dest.key, headers: { 'x-amz-copy-source': `/${encodeRfc3986(src.bucket)}/${s3KeyPath(src.key)}` } });
          return { success: true, ...((r.CopyObjectResult as IDataObject) ?? {}) };
        }
        const bucket = p('bucketName');
        if (op === 'download') {
          const key = p('fileKey');
          const res = await s3Fetch(c, { method: 'GET', bucket, key });
          const data = Buffer.from(await res.arrayBuffer());
          const mime = res.headers.get('content-type') ?? undefined;
          return { json: { ...item.json }, binary: { ...(item.binary ?? {}), [p('binaryPropertyName', 'data')]: await this.helpers.prepareBinaryData(data, path.posix.basename(key), mime) } };
        }
        if (op === 'delete') {
          const versionId = p<IDataObject>('options', {}).versionId;
          await s3Fetch(c, { method: 'DELETE', bucket, key: p('fileKey'), qs: versionId ? { versionId: String(versionId) } : {} });
          return { success: true };
        }
        if (op === 'getAll') {
          const folder = String(p<IDataObject>('options', {}).folderKey ?? '');
          const prefix = folder ? `${join(folder)}/` : '';
          // folder markers are not files
          const objects = await listObjects(c, bucket, prefix ? { prefix } : {}, undefined);
          const files = objects.filter((o) => !String(o.Key).endsWith('/'));
          const limit = listLimit(this, i);
          return limit ? files.slice(0, limit) : files;
        }
        // upload
        const f = p<IDataObject>('additionalFields', {});
        const key = join(String(f.parentFolderKey ?? ''), p('fileName'));
        let body: Buffer;
        let contentType = 'text/plain; charset=utf-8';
        if (p<boolean>('binaryData', true)) {
          const prop = p('binaryPropertyName', 'data');
          const bin = this.helpers.assertBinaryData(i, prop);
          body = await this.helpers.getBinaryDataBuffer(i, prop);
          contentType = bin.mimeType || 'application/octet-stream';
        } else body = Buffer.from(String(p("fileContent", "")), "utf8");
        const headers: Record<string, string> = { 'content-type': contentType, 'content-length': String(body.length) };
        if (f.acl) headers['x-amz-acl'] = ACL[String(f.acl)];
        if (f.storageClass) headers['x-amz-storage-class'] = String(f.storageClass);
        if (f.serverSideEncryption) headers['x-amz-server-side-encryption'] = String(f.serverSideEncryption);
        const tags = ((p<IDataObject>('tagsUi', {}).tagsValues as Array<{ key: string; value: string }>) ?? []).filter((t) => t.key);
        if (tags.length) headers['x-amz-tagging'] = tags.map((t) => `${encodeRfc3986(t.key)}=${encodeRfc3986(t.value ?? '')}`).join('&');
        for (const m of ((p<IDataObject>('metadataUi', {}).metadataValues as Array<{ key: string; value: string }>) ?? []).filter((m) => m.key)) headers[`x-amz-meta-${m.key.toLowerCase()}`] = m.value ?? '';
        const res = await s3Fetch(c, { method: 'PUT', bucket, key, headers, body });
        return { success: true, key, etag: res.headers.get('etag') ?? undefined };
      }

      // folder
      const bucket = p('bucketName');
      if (op === 'create') {
        const key = `${join(String(p<IDataObject>('additionalFields', {}).parentFolderKey ?? ''), p('folderName'))}/`;
        await s3Fetch(c, { method: 'PUT', bucket, key, headers: { 'content-length': '0' }, body: '' });
        return { success: true, key };
      }
      if (op === 'delete') {
        const prefix = `${join(p('folderKey'))}/`;
        const objects = await listObjects(c, bucket, { prefix }, undefined);
        // a folder created by the console has a "folder/" marker; include it even when the listing missed it
        const keys = [...new Set([...objects.map((o) => String(o.Key)), prefix])];
        for (let n = 0; n < keys.length; n += 1000) {
          const body = `<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${keys.slice(n, n + 1000).map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join('')}</Delete>`;
          const md5 = createHash('md5').update(body).digest('base64');
          const r = (await s3Xml(c, { method: 'POST', bucket, qs: { delete: '' }, headers: { 'content-type': 'application/xml', 'content-md5': md5 }, body })).DeleteResult as IDataObject | undefined;
          const errors = (r?.Error as IDataObject[]) ?? [];
          if (errors.length) throw new Error(`Could not delete ${errors.length} object(s): ${errors.map((e) => `${e.Key} (${e.Code})`).join(', ')}`);
        }
        return { success: true, deleted: keys.length };
      }
      const folder = String(p<IDataObject>('options', {}).folderKey ?? '');
      const prefix = folder ? `${join(folder)}/` : '';
      const objects = await listObjects(c, bucket, prefix ? { prefix } : {}, undefined);
      const folders = objects.filter((o) => String(o.Key).endsWith('/') && o.Key !== prefix);
      const limit = listLimit(this, i);
      return limit ? folders.slice(0, limit) : folders;
    }),
  ];
}

const description = (name: string, displayName: string, description: string, credential: string): INodeType['description'] => ({
  name,
  displayName,
  description,
  group: ['output'],
  version: 2,
  defaults: { name: displayName, color: '#D05B4B' },
  icon: 'fa:aws',
  subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
  inputs: ['main'],
  outputs: ['main'],
  credentials: [{ name: credential, required: true }],
  codex: { categories: ['Data & Storage'], alias: ['Bucket', 'Storage', 'Object Storage', 'Files'] },
  properties,
});

export const AwsS3: INodeType = {
  description: description('flowmator.awsS3', 'AWS S3', 'Upload, download, copy and list files in AWS S3 buckets', 'aws'),
  execute(this: IExecuteFunctions) {
    return execute.call(this, 'aws');
  },
};

export const S3: INodeType = {
  description: description('flowmator.s3', 'S3', 'Files in S3-compatible storage: MinIO, Cloudflare R2, Wasabi, Backblaze B2, DigitalOcean Spaces…', 's3'),
  execute(this: IExecuteFunctions) {
    return execute.call(this, 's3');
  },
};

export const s3Credentials: ICredentialType[] = [
  {
    name: 's3',
    displayName: 'S3 (compatible storage)',
    properties: [
      { displayName: 'S3 Endpoint', name: 'endpoint', type: 'string', default: '', placeholder: 'https://<account>.r2.cloudflarestorage.com' },
      { displayName: 'Region', name: 'region', type: 'string', default: 'us-east-1', description: 'R2 uses "auto"' },
      { displayName: 'Access Key ID', name: 'accessKeyId', type: 'string', default: '' },
      { displayName: 'Secret Access Key', name: 'secretAccessKey', type: 'string', typeOptions: { password: true }, default: '' },
      { displayName: 'Force Path Style', name: 'forcePathStyle', type: 'boolean', default: true, description: 'endpoint/bucket/key instead of bucket.endpoint/key' },
    ],
  },
];
