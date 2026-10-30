import { createCipheriv, createDecipheriv, createHash, createSign, randomBytes } from 'node:crypto';
import type { CredentialTypesRegistry, ICredentialsHelper } from '@8n8/core';
import { httpRequest } from '@8n8/core';
import {
  evaluateExpression,
  isExpression,
  NodeOperationError,
  type ICredentialType,
  type IDataObject,
  type IHttpRequestOptions,
  type INode,
} from '@8n8/workflow';
import type { CredentialEntity, Database } from './db';

/** AES-256-GCM; output is base64(iv | tag | ciphertext). */
export class Cipher {
  private readonly key: Buffer;
  constructor(secret: string) {
    this.key = createHash('sha256').update(secret).digest();
  }
  encrypt(data: IDataObject): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
  }
  decrypt(payload: string): IDataObject {
    const buf = Buffer.from(payload, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
  }
}

export const REDACTED = '__8N8_REDACTED__';

export class CredentialsService {
  constructor(
    private readonly db: Database,
    private readonly cipher: Cipher,
    readonly types: CredentialTypesRegistry,
  ) {}

  private secretFields(type: string): string[] {
    const t = this.types.get(type);
    return t.properties.filter((p) => p.typeOptions?.password || p.type === 'hidden').map((p) => p.name);
  }

  /** Public view: never includes secret values (they come back as a placeholder). */
  toPublic(entity: CredentialEntity, includeData = false) {
    const base = { id: entity.id, name: entity.name, type: entity.type, createdAt: entity.createdAt, updatedAt: entity.updatedAt };
    if (!includeData) return base;
    const data = this.cipher.decrypt(entity.data);
    for (const f of this.secretFields(entity.type)) {
      if (data[f] !== undefined && data[f] !== '') data[f] = REDACTED;
    }
    if (entity.type === 'oAuth2Api' || this.types.get(entity.type).extends?.includes('oAuth2Api')) {
      const token = this.cipher.decrypt(entity.data).oauthTokenData as IDataObject | undefined;
      (data as IDataObject).oauthTokenData = token?.access_token ? { connected: true } : {};
    }
    return { ...base, data };
  }

  list(type?: string) {
    return this.db.listCredentials(type).map((c) => this.toPublic(c));
  }

  get(id: string, includeData = false) {
    const c = this.db.getCredential(id);
    return c ? this.toPublic(c, includeData) : null;
  }

  getDecrypted(id: string): IDataObject & { __type: string; __name: string } {
    const c = this.db.getCredential(id);
    if (!c) throw new Error(`Credential with ID "${id}" does not exist`);
    const data = this.cipher.decrypt(c.data);
    // fixed settings (e.g. a provider's OAuth URLs) are hidden properties that only exist as defaults
    for (const p of this.types.get(c.type).properties) {
      if (data[p.name] === undefined && p.default !== undefined && p.default !== '') data[p.name] = structuredClone(p.default) as never;
    }
    return { ...data, __type: c.type, __name: c.name };
  }

  create(name: string, type: string, data: IDataObject, id?: string) {
    this.types.get(type); // validates the type
    return this.toPublic(this.db.createCredential(name, type, this.cipher.encrypt(data), id));
  }

  /** Redacted values in `data` keep their stored value, so the editor can save without re-entering secrets. */
  update(id: string, input: { name?: string; data?: IDataObject }) {
    const cur = this.db.getCredential(id);
    if (!cur) throw new Error('Credential not found');
    let encrypted: string | undefined;
    if (input.data) {
      const old = this.cipher.decrypt(cur.data);
      const merged: IDataObject = { ...old };
      for (const [k, v] of Object.entries(input.data)) if (v !== REDACTED) merged[k] = v;
      if (input.data.oauthTokenData && (input.data.oauthTokenData as IDataObject).connected) merged.oauthTokenData = old.oauthTokenData;
      encrypted = this.cipher.encrypt(merged);
    }
    return this.toPublic(this.db.updateCredential(id, { name: input.name, data: encrypted }));
  }

  saveData(id: string, data: IDataObject) {
    this.db.updateCredential(id, { data: this.cipher.encrypt(data) });
  }

  delete(id: string) {
    this.db.deleteCredential(id);
  }
}

const OAUTH2 = 'oAuth2Api';

export class CredentialsHelper implements ICredentialsHelper {
  /** External secrets, readable in credential fields as {{ $secrets.provider.name }} */
  secrets: () => Record<string, unknown> = () => ({});

  constructor(private readonly service: CredentialsService) {}

  private isOAuth2(type: string) {
    if (type === OAUTH2) return true;
    try {
      return this.service.types.get(type).extends?.includes(OAUTH2) ?? false;
    } catch {
      return false;
    }
  }

  async getDecrypted(node: INode, type: string): Promise<IDataObject> {
    const ref = node.credentials?.[type];
    if (!ref) throw new NodeOperationError(node, `Node "${node.name}" does not have any credentials of type "${type}" set`);
    let id = ref.id;
    if (!id) {
      const match = this.service.list(type).find((c) => c.name === ref.name);
      if (!match) throw new NodeOperationError(node, `Credential "${ref.name}" (${type}) not found`);
      id = match.id;
    }
    const { __type, __name, ...data } = this.service.getDecrypted(id);
    if (__type !== type) throw new NodeOperationError(node, `Credential "${__name}" is of type ${__type}, expected ${type}`);
    const credType = this.service.types.get(type);
    // fill defaults, and resolve expressions that reference other credential fields
    for (const p of credType.properties) if (data[p.name] === undefined && p.default !== undefined) data[p.name] = p.default as never;
    for (const [k, v] of Object.entries(data)) if (isExpression(v)) data[k] = evaluateExpression(v, { $credentials: data, $secrets: this.secrets() }) as never;
    return { ...data, __credentialId: id };
  }

  async authenticate(type: string, credentials: IDataObject, request: IHttpRequestOptions): Promise<IHttpRequestOptions> {
    if (this.isOAuth2(type)) return this.authenticateOAuth2(credentials, request);
    if (type === 'googleApi') return this.authenticateServiceAccount(credentials, request);
    if (type === 'httpCustomAuth') {
      const custom = typeof credentials.json === 'string' ? JSON.parse(credentials.json) : (credentials.json as IDataObject);
      request.headers = { ...(request.headers ?? {}), ...(custom.headers ?? {}) };
      request.qs = { ...(request.qs ?? {}), ...(custom.qs ?? {}) };
      if (custom.body && request.body && typeof request.body === 'object') request.body = { ...(request.body as IDataObject), ...custom.body };
      return request;
    }
    const credType: ICredentialType = this.service.types.get(type);
    const auth = credType.authenticate;
    if (!auth) return request;
    const resolve = (v: string) => String(isExpression(v) ? evaluateExpression(v, { $credentials: credentials, $secrets: this.secrets() }) : v);
    const mapRecord = (r?: Record<string, string>) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [resolve(k), resolve(v)]));
    const p = auth.properties;
    if (p.headers) request.headers = { ...(request.headers ?? {}), ...mapRecord(p.headers) };
    if (p.qs) request.qs = { ...(request.qs ?? {}), ...mapRecord(p.qs) };
    if (p.body) request.body = { ...((request.body as IDataObject) ?? {}), ...mapRecord(p.body) };
    if (p.auth) request.auth = { username: resolve(p.auth.username), password: resolve(p.auth.password) };
    return request;
  }

  private async authenticateOAuth2(credentials: IDataObject, request: IHttpRequestOptions) {
    let token = (credentials.oauthTokenData ?? {}) as IDataObject;
    if (!token.access_token && credentials.grantType === 'clientCredentials') {
      token = await this.fetchClientCredentialsToken(credentials);
      this.persistToken(credentials, token);
    }
    if (!token.access_token) throw new Error('OAuth2 credential is not connected. Open the credential and click "Connect".');
    // always Bearer: some providers report other token_type values (Slack says "bot")
    request.headers = { ...(request.headers ?? {}), Authorization: `Bearer ${token.access_token}` };
    return request;
  }

  private serviceTokens = new Map<string, { token: string; expires: number }>();

  /** Google service account: a signed JWT is exchanged for a short-lived access token (cached until expiry). */
  private async authenticateServiceAccount(credentials: IDataObject, request: IHttpRequestOptions) {
    const email = String(credentials.email ?? '');
    const scopes = String(credentials.scopes ?? '').trim();
    const sub = String(credentials.delegatedEmail ?? '');
    const key = `${email}|${scopes}|${sub}`;
    let cached = this.serviceTokens.get(key);
    if (!cached || cached.expires < Date.now() + 60_000) {
      const now = Math.floor(Date.now() / 1000);
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: email, scope: scopes, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600, ...(sub ? { sub } : {}) })}`;
      const privateKey = String(credentials.privateKey ?? '').replace(/\\n/g, '\n');
      const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url');
      const res = (await httpRequest({
        url: 'https://oauth2.googleapis.com/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` },
        json: true,
      })) as { access_token: string; expires_in: number };
      cached = { token: res.access_token, expires: Date.now() + res.expires_in * 1000 };
      this.serviceTokens.set(key, cached);
    }
    request.headers = { ...(request.headers ?? {}), Authorization: `Bearer ${cached.token}` };
    return request;
  }

  private persistToken(credentials: IDataObject, token: IDataObject) {
    const id = credentials.__credentialId as string | undefined;
    credentials.oauthTokenData = token;
    if (!id) return;
    const { __type, __name, ...stored } = this.service.getDecrypted(id);
    this.service.saveData(id, { ...stored, oauthTokenData: token });
  }

  private tokenRequest(credentials: IDataObject, params: Record<string, string>) {
    const body: Record<string, string> = { ...params };
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (credentials.authentication === 'body') {
      body.client_id = String(credentials.clientId ?? '');
      body.client_secret = String(credentials.clientSecret ?? '');
    } else {
      headers.Authorization = `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`;
    }
    return httpRequest({ url: String(credentials.accessTokenUrl), method: 'POST', headers, body, json: true }) as Promise<IDataObject>;
  }

  async fetchClientCredentialsToken(credentials: IDataObject) {
    return this.tokenRequest(credentials, { grant_type: 'client_credentials', ...(credentials.scope ? { scope: String(credentials.scope) } : {}) });
  }

  async exchangeCode(credentials: IDataObject, code: string, redirectUri: string, codeVerifier?: string) {
    return this.tokenRequest(credentials, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    });
  }

  async refresh(_node: INode, type: string, credentials: IDataObject): Promise<IDataObject | null> {
    if (!this.isOAuth2(type)) return null;
    const token = (credentials.oauthTokenData ?? {}) as IDataObject;
    let fresh: IDataObject;
    if (credentials.grantType === 'clientCredentials') fresh = await this.fetchClientCredentialsToken(credentials);
    else if (token.refresh_token) {
      fresh = await this.tokenRequest(credentials, { grant_type: 'refresh_token', refresh_token: String(token.refresh_token) });
      fresh.refresh_token ??= token.refresh_token;
    } else return null;
    this.persistToken(credentials, fresh);
    return { ...credentials, oauthTokenData: fresh };
  }
}

/** Tries a credential: runs the type's test request, or for generic auth types simply checks it can be decrypted. */
export async function testCredential(service: CredentialsService, helper: CredentialsHelper, type: string, data: IDataObject) {
  const credType = service.types.get(type);
  if (!credType.test) return { status: 'OK', message: 'Credential saved (this type has no automatic test)' };
  try {
    // test requests may use {{ $credentials.x }} in their URL and headers
    const resolve = (v: unknown): unknown =>
      isExpression(v) ? evaluateExpression(v, { $credentials: data, $secrets: helper.secrets() })
      : Array.isArray(v) ? v.map(resolve)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]))
      : v;
    const req = await helper.authenticate(type, data, resolve(structuredClone(credType.test.request)) as IHttpRequestOptions);
    await httpRequest(req);
    return { status: 'OK', message: 'Connection tested successfully' };
  } catch (e) {
    return { status: 'Error', message: (e as Error).message };
  }
}
