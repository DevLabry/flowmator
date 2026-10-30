import type { IDataObject, IHttpFullResponse, IHttpRequestOptions } from '@flowmator/workflow';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly body: unknown,
    readonly headers: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function appendQuery(url: URL, qs: IDataObject) {
  for (const [k, v] of Object.entries(qs)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
}

/** Thin fetch wrapper with the conventions nodes expect (JSON by default, throws on >= 400). */
export async function httpRequest(options: IHttpRequestOptions, signal?: AbortSignal): Promise<any> {
  const url = new URL(options.baseURL ? options.url.replace(/^\//, '') : options.url, options.baseURL ? options.baseURL.replace(/\/?$/, '/') : undefined);
  if (options.qs) appendQuery(url, options.qs);

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const lower = Object.fromEntries(Object.keys(headers).map((k) => [k.toLowerCase(), k]));
  if (options.auth) {
    headers.Authorization = `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`).toString('base64')}`;
  }

  let body: BodyInit | undefined;
  const b = options.body;
  if (b !== undefined && b !== null && options.method !== 'GET' && options.method !== 'HEAD') {
    if (typeof b === 'string' || b instanceof Uint8Array || b instanceof ArrayBuffer || b instanceof URLSearchParams || b instanceof FormData || b instanceof Blob) {
      body = b as BodyInit;
    } else {
      const contentType = lower['content-type'] ? headers[lower['content-type']] : '';
      if (contentType.includes('application/x-www-form-urlencoded')) {
        body = new URLSearchParams(Object.entries(b as IDataObject).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
      } else {
        body = JSON.stringify(b);
        if (!lower['content-type']) headers['Content-Type'] = 'application/json';
      }
    }
  }

  const timeoutSignal = options.timeout ? AbortSignal.timeout(options.timeout) : undefined;
  const combined = signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : (signal ?? timeoutSignal);

  const res = await fetch(url, { method: options.method ?? 'GET', headers, body, signal: combined, redirect: 'follow' });
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (resHeaders[k] = v));

  let parsed: unknown;
  if (options.encoding === 'arraybuffer') {
    parsed = Buffer.from(await res.arrayBuffer());
  } else {
    const text = await res.text();
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    if (options.encoding === 'text') parsed = text;
    else if (isJson || options.json) {
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }
    } else parsed = text;
  }

  if (res.status >= 400 && !options.ignoreHttpStatusErrors) {
    const msg = typeof parsed === 'object' && parsed ? ((parsed as IDataObject).message ?? (parsed as IDataObject).error) : parsed;
    throw new HttpError(
      `Request failed with status code ${res.status}${msg && typeof msg === 'string' ? `: ${msg.slice(0, 300)}` : ''}`,
      res.status,
      parsed,
      resHeaders,
    );
  }

  if (options.returnFullResponse) {
    const full: IHttpFullResponse = { statusCode: res.status, statusMessage: res.statusText, headers: resHeaders, body: parsed };
    return full;
  }
  return parsed;
}
