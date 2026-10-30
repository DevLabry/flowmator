import { createSign } from 'node:crypto';
import { signAws } from '@flowmator/nodes-base';
import type { IDataObject } from '@flowmator/workflow';
import type { Cipher } from './credentials';
import type { Database } from './db';

/** Secret values by provider, then by name (JSON secrets become objects: $secrets.vault.app.apiKey). */
export type SecretsCache = Record<string, Record<string, unknown>>;

interface Provider {
  name: string;
  displayName: string;
  properties: Array<{ name: string; displayName: string; type: 'string' | 'password' | 'options'; default?: string; options?: string[]; placeholder?: string; hint?: string }>;
  fetch(settings: IDataObject): Promise<Record<string, unknown>>;
}

const KEY = 'externalSecrets';

async function json(url: string, init: RequestInit = {}): Promise<IDataObject> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
  if (!res.ok) throw new Error(`${res.status} ${(body as IDataObject).errors ?? (body as IDataObject).message ?? (body as IDataObject).error_description ?? res.statusText}`);
  return body as IDataObject;
}

/** A secret string that holds JSON becomes an object, so its keys can be addressed. */
const value = (raw: unknown) => {
  if (typeof raw !== 'string') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : raw;
  } catch {
    return raw;
  }
};

/* ---------- HashiCorp Vault (KV v1/v2) ---------- */

const vault: Provider = {
  name: 'vault',
  displayName: 'HashiCorp Vault',
  properties: [
    { name: 'url', displayName: 'Vault URL', type: 'string', placeholder: 'https://vault.example.com:8200' },
    { name: 'namespace', displayName: 'Namespace', type: 'string', hint: 'Vault Enterprise / HCP only' },
    { name: 'authMethod', displayName: 'Authentication Method', type: 'options', default: 'token', options: ['token', 'appRole', 'usernameAndPassword'] },
    { name: 'token', displayName: 'Token', type: 'password' },
    { name: 'roleId', displayName: 'Role ID', type: 'string' },
    { name: 'secretId', displayName: 'Secret ID', type: 'password' },
    { name: 'username', displayName: 'Username', type: 'string' },
    { name: 'password', displayName: 'Password', type: 'password' },
    { name: 'kvMountPath', displayName: 'KV Mount Path', type: 'string', default: 'secret' },
    { name: 'kvVersion', displayName: 'KV Version', type: 'options', default: '2', options: ['1', '2'] },
  ],
  async fetch(s) {
    const base = String(s.url ?? '').replace(/\/+$/, '');
    const headers: Record<string, string> = s.namespace ? { 'X-Vault-Namespace': String(s.namespace) } : {};
    let token = String(s.token ?? '');
    if (s.authMethod === 'appRole') token = String(((await json(`${base}/v1/auth/approle/login`, { method: 'POST', headers, body: JSON.stringify({ role_id: s.roleId, secret_id: s.secretId }) })).auth as IDataObject).client_token);
    if (s.authMethod === 'usernameAndPassword') token = String(((await json(`${base}/v1/auth/userpass/login/${encodeURIComponent(String(s.username))}`, { method: 'POST', headers, body: JSON.stringify({ password: s.password }) })).auth as IDataObject).client_token);
    headers['X-Vault-Token'] = token;
    const mount = String(s.kvMountPath || 'secret').replace(/^\/+|\/+$/g, '');
    const v2 = String(s.kvVersion ?? '2') === '2';
    const out: Record<string, unknown> = {};
    const walk = async (path: string) => {
      // GET ?list=true is Vault's equivalent of the LIST verb, which some proxies reject
      const listUrl = `${base}/v1/${mount}/${v2 ? 'metadata/' : ''}${path}?list=true`;
      let keys: string[] = [];
      try {
        keys = (((await json(listUrl, { headers })).data as IDataObject).keys as string[]) ?? [];
      } catch (e) {
        if (String((e as Error).message).startsWith('404')) return;
        throw e;
      }
      for (const key of keys) {
        if (key.endsWith('/')) await walk(`${path}${key}`);
        else {
          const r = (await json(`${base}/v1/${mount}/${v2 ? 'data/' : ''}${path}${key}`, { headers })).data as IDataObject;
          // nested paths are addressed with dots: $secrets.vault["team/app"] or $secrets.vault.team_app
          out[`${path}${key}`] = v2 ? (r.data as IDataObject) : r;
        }
      }
    };
    await walk('');
    return out;
  },
};

/* ---------- AWS Secrets Manager ---------- */

const aws: Provider = {
  name: 'awsSecretsManager',
  displayName: 'AWS Secrets Manager',
  properties: [
    { name: 'region', displayName: 'Region', type: 'string', default: 'us-east-1' },
    { name: 'accessKeyId', displayName: 'Access Key ID', type: 'string' },
    { name: 'secretAccessKey', displayName: 'Secret Access Key', type: 'password' },
  ],
  async fetch(s) {
    const region = String(s.region || 'us-east-1');
    const url = `https://secretsmanager.${region}.amazonaws.com/`;
    const creds = { accessKeyId: String(s.accessKeyId), secretAccessKey: String(s.secretAccessKey) };
    const call = async (target: string, body: IDataObject) => {
      const payload = JSON.stringify(body);
      const headers = signAws({ method: 'POST', url, body: payload, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `secretsmanager.${target}` } }, creds, region, 'secretsmanager');
      return json(url, { method: 'POST', headers, body: payload });
    };
    const names: string[] = [];
    let token: string | undefined;
    do {
      const r = await call('ListSecrets', { MaxResults: 100, ...(token ? { NextToken: token } : {}) });
      names.push(...((r.SecretList as IDataObject[]) ?? []).map((x) => String(x.Name)));
      token = r.NextToken as string | undefined;
    } while (token);
    const out: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i += 20) {
      const r = await call('BatchGetSecretValue', { SecretIdList: names.slice(i, i + 20) });
      for (const v of (r.SecretValues as IDataObject[]) ?? []) out[String(v.Name)] = value(v.SecretString);
    }
    return out;
  },
};

/* ---------- Azure Key Vault ---------- */

const azure: Provider = {
  name: 'azureKeyVault',
  displayName: 'Azure Key Vault',
  properties: [
    { name: 'vaultName', displayName: 'Vault Name', type: 'string' },
    { name: 'tenantId', displayName: 'Tenant ID', type: 'string' },
    { name: 'clientId', displayName: 'Client ID', type: 'string' },
    { name: 'clientSecret', displayName: 'Client Secret', type: 'password' },
  ],
  async fetch(s) {
    const token = await json(`https://login.microsoftonline.com/${encodeURIComponent(String(s.tenantId))}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: String(s.clientId), client_secret: String(s.clientSecret), scope: 'https://vault.azure.net/.default' }),
    });
    const headers = { Authorization: `Bearer ${token.access_token}` };
    const base = `https://${s.vaultName}.vault.azure.net`;
    const out: Record<string, unknown> = {};
    let next: string | undefined = `${base}/secrets?api-version=7.4`;
    while (next) {
      const page: IDataObject = await json(next, { headers });
      for (const item of (page.value as IDataObject[]) ?? []) {
        if ((item.attributes as IDataObject)?.enabled === false) continue;
        const name = String(item.id).split('/').pop()!;
        out[name] = value((await json(`${base}/secrets/${name}?api-version=7.4`, { headers })).value);
      }
      next = (page.nextLink as string) || undefined;
    }
    return out;
  },
};

/* ---------- Google Cloud Secret Manager ---------- */

const gcp: Provider = {
  name: 'gcpSecretsManager',
  displayName: 'GCP Secrets Manager',
  properties: [{ name: 'serviceAccountKey', displayName: 'Service Account Key', type: 'password', hint: 'The JSON key file of a service account with "Secret Manager Secret Accessor"' }],
  async fetch(s) {
    const key = JSON.parse(String(s.serviceAccountKey ?? '{}')) as { client_email: string; private_key: string; project_id: string };
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url')}`;
    const token = await json('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
    const headers = { Authorization: `Bearer ${token.access_token}` };
    const base = `https://secretmanager.googleapis.com/v1/projects/${key.project_id}/secrets`;
    const out: Record<string, unknown> = {};
    let pageToken: string | undefined;
    do {
      const page: IDataObject = await json(`${base}?pageSize=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { headers });
      for (const secret of (page.secrets as IDataObject[]) ?? []) {
        const name = String(secret.name).split('/').pop()!;
        try {
          const v = await json(`${base}/${name}/versions/latest:access`, { headers });
          out[name] = value(Buffer.from(String((v.payload as IDataObject).data), 'base64').toString('utf8'));
        } catch {
          // secrets without an enabled version are skipped
        }
      }
      pageToken = (page.nextPageToken as string) || undefined;
    } while (pageToken);
    return out;
  },
};

export const SECRET_PROVIDERS: Provider[] = [vault, aws, azure, gcp];

interface StoredProvider {
  connected: boolean;
  settings: IDataObject;
}

/**
 * External secrets: providers are configured in the settings page, their secrets are fetched on connect
 * and every N8N_EXTERNAL_SECRETS_UPDATE_INTERVAL seconds, and credentials read them as {{ $secrets.provider.name }}.
 */
export class ExternalSecretsService {
  private cache: SecretsCache = {};
  private state: Record<string, { status: 'connected' | 'error' | 'disconnected'; error?: string; updatedAt?: string }> = {};
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly database: Database,
    private readonly cipher: Cipher,
    readonly intervalSec = Number(process.env.N8N_EXTERNAL_SECRETS_UPDATE_INTERVAL ?? 300),
  ) {}

  private load(): Record<string, StoredProvider> {
    const raw = this.database.getSetting<string>(KEY, '');
    return raw ? (this.cipher.decrypt(raw) as unknown as Record<string, StoredProvider>) : {};
  }

  private store(all: Record<string, StoredProvider>) {
    this.database.setSetting(KEY, this.cipher.encrypt(all as unknown as IDataObject));
  }

  /** What the settings page shows; passwords are never sent back. */
  list() {
    const all = this.load();
    return SECRET_PROVIDERS.map((p) => {
      const stored = all[p.name];
      const settings = Object.fromEntries(p.properties.map((prop) => [prop.name, prop.type === 'password' ? (stored?.settings[prop.name] ? '__FLOWMATOR_REDACTED__' : '') : (stored?.settings[prop.name] ?? prop.default ?? '')]));
      return {
        name: p.name,
        displayName: p.displayName,
        properties: p.properties,
        connected: !!stored?.connected,
        settings,
        state: this.state[p.name]?.status ?? (stored?.connected ? 'connected' : 'disconnected'),
        error: this.state[p.name]?.error,
        updatedAt: this.state[p.name]?.updatedAt,
        secrets: Object.keys(this.cache[p.name] ?? {}),
      };
    });
  }

  private provider(name: string) {
    const p = SECRET_PROVIDERS.find((x) => x.name === name);
    if (!p) throw new Error(`Unknown secrets provider "${name}"`);
    return p;
  }

  /** Saves settings (redacted passwords keep their stored value). */
  saveSettings(name: string, settings: IDataObject) {
    this.provider(name);
    const all = this.load();
    const prev = all[name]?.settings ?? {};
    const merged = Object.fromEntries(Object.entries({ ...prev, ...settings }).map(([k, v]) => [k, v === '__FLOWMATOR_REDACTED__' ? prev[k] : v])) as IDataObject;
    all[name] = { connected: all[name]?.connected ?? false, settings: merged };
    this.store(all);
  }

  /** Fetches with the given (or stored) settings without saving anything. */
  async test(name: string, settings?: IDataObject) {
    const stored = this.load()[name]?.settings ?? {};
    const merged = Object.fromEntries(Object.entries({ ...stored, ...(settings ?? {}) }).map(([k, v]) => [k, v === '__FLOWMATOR_REDACTED__' ? stored[k] : v])) as IDataObject;
    try {
      const secrets = await this.provider(name).fetch(merged);
      return { success: true, count: Object.keys(secrets).length };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  async setConnected(name: string, connected: boolean) {
    const all = this.load();
    all[name] = { settings: all[name]?.settings ?? {}, connected };
    this.store(all);
    if (connected) await this.refreshProvider(name);
    else {
      delete this.cache[name];
      this.state[name] = { status: 'disconnected' };
    }
  }

  async refreshProvider(name: string) {
    const stored = this.load()[name];
    if (!stored?.connected) return;
    try {
      this.cache[name] = await this.provider(name).fetch(stored.settings);
      this.state[name] = { status: 'connected', updatedAt: new Date().toISOString() };
    } catch (e) {
      // keep the last good values so running workflows don't lose their credentials
      this.state[name] = { status: 'error', error: (e as Error).message, updatedAt: this.state[name]?.updatedAt };
    }
  }

  async refreshAll() {
    await Promise.all(Object.entries(this.load()).filter(([, p]) => p.connected).map(([name]) => this.refreshProvider(name)));
  }

  async start() {
    await this.refreshAll();
    if (this.intervalSec > 0) {
      this.timer = setInterval(() => void this.refreshAll(), this.intervalSec * 1000);
      this.timer.unref();
    }
  }

  stop() {
    clearInterval(this.timer);
  }

  /** The $secrets object credentials see. */
  secrets(): SecretsCache {
    return this.cache;
  }
}
