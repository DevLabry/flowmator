import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, INodeProperties, INodeTypeDescription } from '@8n8/workflow';
import { apiRequest } from '../../utils/api';

/** OAuth2 (per-service credential) or a service account, like the other Google nodes. */
export const googleAuthProp: INodeProperties = {
  displayName: 'Authentication',
  name: 'authentication',
  type: 'options',
  default: 'oAuth2',
  options: [
    { name: 'OAuth2 (recommended)', value: 'oAuth2' },
    { name: 'Service Account', value: 'serviceAccount' },
  ],
};

export const googleCredentials = (oauthType: string): NonNullable<INodeTypeDescription['credentials']> => [
  { name: oauthType, required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
  { name: 'googleApi', required: true, displayOptions: { show: { authentication: ['serviceAccount'] } } },
];

/** Google APIs answer { error: { code, message } }; surface the message instead of a bare status. */
export async function googleRequest<T = IDataObject>(
  ctx: { helpers: IExecuteFunctions['helpers'] },
  auth: unknown,
  oauthType: string,
  options: IHttpRequestOptions,
  i = 0,
): Promise<T> {
  try {
    return await apiRequest<T>(ctx, auth === 'serviceAccount' ? 'googleApi' : oauthType, options, i);
  } catch (e) {
    const err = (e as { body?: { error?: { message?: string; code?: number } | string; error_description?: string } }).body;
    const message = typeof err?.error === 'object' ? err.error.message : (err?.error_description ?? err?.error);
    if (message) throw new Error(`Google API error${typeof err?.error === 'object' && err.error.code ? ` ${err.error.code}` : ''}: ${message}`);
    throw e;
  }
}

/** Pages through a Google list endpoint (nextPageToken). */
export async function googlePages(fetchPage: (pageToken: string | undefined, pageSize: number) => Promise<IDataObject>, key: string, limit: number | undefined, pageSize = 100) {
  const out: IDataObject[] = [];
  let token: string | undefined;
  do {
    const r = await fetchPage(token, limit ? Math.min(pageSize, limit - out.length) : pageSize);
    out.push(...((r[key] as IDataObject[]) ?? []));
    token = r.nextPageToken as string | undefined;
  } while (token && (!limit || out.length < limit));
  return limit ? out.slice(0, limit) : out;
}
