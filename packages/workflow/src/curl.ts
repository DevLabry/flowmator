import type { IDataObject } from './types';

/** Splits a shell command into words: quotes, $'…' strings, backslash escapes and line continuations. */
export function shellWords(input: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  const src = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      continue;
    }
    inWord = true;
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      word += src.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? src.length : end;
    } else if (c === '$' && src[i + 1] === "'") {
      i += 2;
      for (; i < src.length && src[i] !== "'"; i++) {
        if (src[i] !== '\\') word += src[i];
        else {
          const n = src[++i];
          word += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        }
      }
    } else if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === '\\' && /["\\$`]/.test(src[i + 1] ?? '')) i++;
        word += src[i];
      }
    } else if (c === '\\') word += src[++i] ?? '';
    else word += c;
  }
  if (inWord) words.push(word);
  return words;
}

const FLAGS_WITH_VALUE = new Set([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json',
  '-F', '--form', '--form-string', '-u', '--user', '-A', '--user-agent', '-b', '--cookie', '-e', '--referer', '--url', '-m', '--max-time',
  '-o', '--output', '-x', '--proxy', '--connect-timeout', '-w', '--write-out', '-c', '--cookie-jar', '-T', '--upload-file', '--retry', '-r', '--range',
]);

type KeyValue = { name: string; value: string };

const splitPairs = (body: string): KeyValue[] | null => {
  if (!body || /[\r\n]/.test(body)) return null;
  const pairs = body.split('&').map((p) => {
    const eq = p.indexOf('=');
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;
      }
    };
    return eq < 0 ? null : { name: dec(p.slice(0, eq)), value: dec(p.slice(eq + 1)) };
  });
  return pairs.every(Boolean) ? (pairs as KeyValue[]) : null;
};

/**
 * Turns a cURL command into HTTP Request node parameters (method, URL, query, headers, body, options).
 * Throws when the command is not a curl call or has no URL.
 */
export function parseCurl(command: string): IDataObject {
  const words = shellWords(command.trim());
  if (!words.length || !/^curl(\.exe)?$/i.test(words[0].split(/[\\/]/).pop() ?? '')) throw new Error('The command must start with "curl"');

  let method: string | undefined;
  let url: string | undefined;
  const headers: KeyValue[] = [];
  const data: string[] = [];
  const form: Array<{ name: string; value: string; file: boolean }> = [];
  let get = false;
  let json = false;
  const options: IDataObject = {};

  for (let i = 1; i < words.length; i++) {
    let flag = words[i];
    let value: string | undefined;
    // --flag=value and -Xvalue forms
    if (flag.startsWith('--') && flag.includes('=')) [flag, value] = [flag.slice(0, flag.indexOf('=')), flag.slice(flag.indexOf('=') + 1)];
    else if (/^-[A-Za-z]./.test(flag) && FLAGS_WITH_VALUE.has(flag.slice(0, 2))) [flag, value] = [flag.slice(0, 2), flag.slice(2)];
    if (FLAGS_WITH_VALUE.has(flag) && value === undefined) value = words[++i] ?? '';
    if (!flag.startsWith('-')) {
      url ??= flag;
      continue;
    }
    const v = value ?? '';
    switch (flag) {
      case '-X':
      case '--request':
        method = v.toUpperCase();
        break;
      case '--url':
        url = v;
        break;
      case '-H':
      case '--header': {
        const colon = v.indexOf(':');
        if (colon > 0) headers.push({ name: v.slice(0, colon).trim(), value: v.slice(colon + 1).trim() });
        break;
      }
      case '-d':
      case '--data':
      case '--data-ascii':
      case '--data-binary':
      case '--data-raw':
        data.push(flag === '--data-raw' || flag === '--data-binary' ? v : v.replace(/[\r\n]/g, ''));
        break;
      case '--data-urlencode': {
        const eq = v.indexOf('=');
        data.push(eq < 0 ? encodeURIComponent(v) : `${v.slice(0, eq)}=${encodeURIComponent(v.slice(eq + 1))}`);
        break;
      }
      case '--json':
        json = true;
        data.push(v);
        break;
      case '-F':
      case '--form':
      case '--form-string': {
        const eq = v.indexOf('=');
        if (eq < 0) break;
        const val = v.slice(eq + 1);
        const file = flag !== '--form-string' && val.startsWith('@');
        form.push({ name: v.slice(0, eq), value: file ? val.slice(1).split(';')[0] : val, file });
        break;
      }
      case '-u':
      case '--user':
        headers.push({ name: 'Authorization', value: `Basic ${btoa(v.includes(':') ? v : `${v}:`)}` });
        break;
      case '-A':
      case '--user-agent':
        headers.push({ name: 'User-Agent', value: v });
        break;
      case '-b':
      case '--cookie':
        if (v.includes('=')) headers.push({ name: 'Cookie', value: v });
        break;
      case '-e':
      case '--referer':
        headers.push({ name: 'Referer', value: v });
        break;
      case '-G':
      case '--get':
        get = true;
        break;
      case '-I':
      case '--head':
        method = 'HEAD';
        break;
      case '-k':
      case '--insecure':
        options.allowUnauthorizedCerts = true;
        break;
      case '-m':
      case '--max-time':
        if (Number(v) > 0) options.timeout = Math.round(Number(v) * 1000);
        break;
    }
  }
  if (!url) throw new Error('No URL found in the cURL command');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  if (json) {
    if (!headers.some((h) => h.name.toLowerCase() === 'content-type')) headers.push({ name: 'Content-Type', value: 'application/json' });
    if (!headers.some((h) => h.name.toLowerCase() === 'accept')) headers.push({ name: 'Accept', value: 'application/json' });
  }

  const params: IDataObject = {};
  const query: KeyValue[] = [];
  const parsedUrl = new URL(url);
  for (const [name, value] of parsedUrl.searchParams) query.push({ name, value });
  if (query.length) parsedUrl.search = '';
  const body = data.join('&');
  if (get && body) {
    query.push(...(splitPairs(body) ?? [{ name: body, value: '' }]));
  }
  method ??= (data.length && !get) || form.length ? 'POST' : 'GET';
  params.method = method;
  params.url = query.length ? parsedUrl.toString().replace(/\?$/, '') : url;
  if (query.length) Object.assign(params, { sendQuery: true, specifyQuery: 'keypair', queryParameters: { parameters: query } });

  const contentTypeIdx = headers.findIndex((h) => h.name.toLowerCase() === 'content-type');
  const contentType = contentTypeIdx >= 0 ? headers[contentTypeIdx].value : '';
  const sendBody = (form.length > 0 || (data.length > 0 && !get));
  if (sendBody) {
    params.sendBody = true;
    if (form.length) {
      params.contentType = 'multipart-form-data';
      params.bodyParameters = {
        parameters: form.map((f) => (f.file ? { parameterType: 'formBinaryData', name: f.name, inputDataFieldName: 'data', value: '' } : { parameterType: 'formData', name: f.name, value: f.value })),
      };
    } else {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(body);
      } catch {
        parsedJson = undefined;
      }
      const pairs = splitPairs(body);
      if (/json/i.test(contentType) || (!contentType && parsedJson !== null && typeof parsedJson === 'object')) {
        params.contentType = 'json';
        if (parsedJson !== undefined) Object.assign(params, { specifyBody: 'json', jsonBody: JSON.stringify(parsedJson, null, 2) });
        else Object.assign(params, { contentType: 'raw', rawContentType: contentType || 'application/json', body });
      } else if ((!contentType || /x-www-form-urlencoded/i.test(contentType)) && pairs) {
        Object.assign(params, { contentType: 'form-urlencoded', specifyBody: 'keypair', bodyParameters: { parameters: pairs } });
      } else {
        Object.assign(params, { contentType: 'raw', rawContentType: contentType || 'application/x-www-form-urlencoded', body });
      }
    }
    // the body type already says it; the multipart boundary must come from the request itself
    if (contentTypeIdx >= 0 && params.contentType !== 'raw') headers.splice(contentTypeIdx, 1);
  }
  if (headers.length) Object.assign(params, { sendHeaders: true, specifyHeaders: 'keypair', headerParameters: { parameters: headers } });
  if (Object.keys(options).length) params.options = options;
  return params;
}
