import { afterEach, beforeEach, vi } from 'vitest';
import type { IDataObject, INodeExecutionData } from '@8n8/workflow';
import type { ICredentialsHelper } from '../src';
import { connections, items, makeWorkflow, node, out, run } from './helpers';

/**
 * Shared by the integration tests: a recording fake fetch (register answers with `route`)
 * and credentials applied the way the server's generic authenticate does.
 */
/* ---------- recording fake fetch ---------- */

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
  form?: FormData;
  /** Binary request bodies (uploads) */
  raw?: Buffer;
}
export const calls: Call[] = [];
type Handler = (c: Call) => unknown | Promise<unknown>;
let handlers: Array<[RegExp, Handler]> = [];
export const route = (pattern: RegExp, handler: Handler) => handlers.push([pattern, handler]);
export const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  handlers = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { method: init.method ?? 'GET', url, headers, body: undefined };
    if (init.body instanceof FormData) call.form = init.body;
    else if (init.body instanceof Uint8Array) call.raw = Buffer.from(init.body);
    else if (typeof init.body === 'string') {
      try {
        call.body = JSON.parse(init.body);
      } catch {
        call.body = init.body;
      }
    } else if (init.body instanceof URLSearchParams) call.body = Object.fromEntries(init.body);
    calls.push(call);
    const h = handlers.find(([re]) => re.test(`${call.method} ${url.origin}${url.pathname}`));
    if (!h) return new Response(JSON.stringify({ message: `no fake route for ${call.method} ${url}` }), { status: 404, headers: { 'content-type': 'application/json' } });
    const result = await h[1](call);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => vi.unstubAllGlobals());

/** Token credentials are applied as Bearer headers, like the server's generic authenticate. */
/** Credentials by type; tests add their own (e.g. a database started in beforeAll). */
export const creds: Record<string, IDataObject> = {
  slackApi: { accessToken: 'xoxb-1' },
  telegramApi: { accessToken: '123:ABC', baseUrl: 'https://api.telegram.org' },
  githubApi: { accessToken: 'ghp_1', server: 'https://api.github.com' },
  notionApi: { apiKey: 'secret_1' },
  gmailOAuth2: { oauthTokenData: { access_token: 'ya29.gmail' } },
  googleSheetsOAuth2Api: { oauthTokenData: { access_token: 'ya29.sheets' } },
};
export const credentialsHelper: ICredentialsHelper = {
  async getDecrypted(_node, type) {
    return creds[type];
  },
  async authenticate(type, c, request) {
    const token = (c.accessToken ?? c.apiKey ?? (c.oauthTokenData as IDataObject)?.access_token) as string;
    request.headers = { ...(request.headers ?? {}), Authorization: c.botToken ? `Bot ${c.botToken}` : `Bearer ${token}` };
    return request;
  },
};

export const withCred = (type: string) => ({ credentials: { [type]: { id: '1', name: type } } });
export async function runNode(type: string, params: Record<string, unknown>, cred: string, input: INodeExecutionData[] = items({})) {
  const wf = makeWorkflow([node('Trigger', 'manualTrigger'), node('N', type, params, withCred(cred))], connections(['Trigger', 'N']));
  const r = await run(wf, { triggerData: input, additional: { credentialsHelper } });
  if (r.status !== 'success') throw new Error(r.data.resultData.error?.message);
  return out(r, 'N')!;
}

