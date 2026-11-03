import type { App } from '../src';

export const OWNER = { email: 'owner@test.dev', firstName: 'Test', lastName: 'Owner', password: 'Passw0rd!' };

/** Sets up the instance owner and makes every later `app.app.inject` call send their session cookie. */
export async function signIn(app: App) {
  const res = await app.app.inject({ method: 'POST', url: '/rest/owner/setup', payload: OWNER });
  if (res.statusCode !== 200) throw new Error(`Owner setup failed: ${res.body}`);
  const cookie = String(res.headers['set-cookie']).split(';')[0];
  const inject = app.app.inject.bind(app.app) as (opts: { headers?: Record<string, unknown> }) => unknown;
  (app.app as unknown as { inject: unknown }).inject = (opts: { headers?: Record<string, unknown> }) => inject({ ...opts, headers: { cookie, ...opts.headers } });
  return cookie;
}
