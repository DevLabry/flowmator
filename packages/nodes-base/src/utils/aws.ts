import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding, as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Signs a request with AWS Signature Version 4 and returns the headers to send.
 * The URL path must already be encoded the way it goes on the wire (e.g. model ids with ":" as %3A);
 * like every service but S3, the canonical path encodes it once more.
 */
export function signAws(
  request: { method: string; url: string; headers?: Record<string, string>; body?: string },
  credentials: AwsCredentials,
  region: string,
  service: string,
  now = new Date(),
): Record<string, string> {
  const url = new URL(request.url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...(request.headers ?? {}), host: url.host, 'x-amz-date': amzDate };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;

  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const signedHeaders = Object.keys(lower).sort();
  const canonicalPath = url.pathname.split('/').map((seg) => encode(seg)).join('/') || '/';
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    signedHeaders.map((h) => `${h}:${lower[h]}\n`).join(''),
    signedHeaders.join(';'),
    sha256(request.body ?? ''),
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const { host: _host, ...rest } = headers;
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
  };
}
