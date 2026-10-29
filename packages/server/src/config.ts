import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ServerConfig {
  userFolder: string;
  dbFile: string;
  binaryDataDir: string;
  encryptionKey: string;
  host: string;
  port: number;
  protocol: 'http' | 'https';
  /** Public base URL used to build webhook URLs, e.g. https://my-tunnel.example.com/ */
  webhookUrl: string;
  timezone: string;
  endpoints: { rest: string; webhook: string; webhookTest: string; webhookWaiting: string; form: string; formTest: string; formWaiting: string };
  executions: { pruneAfterHours: number; pruneMaxCount: number; timeoutSeconds: number; saveManual: boolean };
  editorDistDir?: string;
}

/**
 * Settings come from N8N_* environment variables (same names n8n uses, so existing setups carry over).
 * The encryption key is generated once and stored in <userFolder>/config.json.
 */
export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const env = process.env;
  const userFolder = overrides.userFolder ?? env.N8N_USER_FOLDER ?? path.join(os.homedir(), '.8n8');
  mkdirSync(userFolder, { recursive: true });

  const configFile = path.join(userFolder, 'config.json');
  const fileConfig: { encryptionKey?: string } = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
  let encryptionKey = overrides.encryptionKey ?? env.N8N_ENCRYPTION_KEY ?? fileConfig.encryptionKey;
  if (!encryptionKey) {
    encryptionKey = randomBytes(24).toString('base64');
    writeFileSync(configFile, JSON.stringify({ ...fileConfig, encryptionKey }, null, 2), { mode: 0o600 });
  }

  const host = overrides.host ?? env.N8N_HOST ?? 'localhost';
  const port = overrides.port ?? Number(env.N8N_PORT ?? 5678);
  const protocol = (overrides.protocol ?? env.N8N_PROTOCOL ?? 'http') as 'http' | 'https';
  const baseUrl = overrides.webhookUrl ?? env.WEBHOOK_URL ?? `${protocol}://${host}:${port}/`;

  return {
    userFolder,
    dbFile: overrides.dbFile ?? path.join(userFolder, 'database.sqlite'),
    binaryDataDir: overrides.binaryDataDir ?? path.join(userFolder, 'binaryData'),
    encryptionKey,
    host,
    port,
    protocol,
    webhookUrl: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
    timezone: overrides.timezone ?? env.GENERIC_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    endpoints: {
      rest: 'rest',
      webhook: env.N8N_ENDPOINT_WEBHOOK ?? 'webhook',
      webhookTest: env.N8N_ENDPOINT_WEBHOOK_TEST ?? 'webhook-test',
      webhookWaiting: env.N8N_ENDPOINT_WEBHOOK_WAIT ?? 'webhook-waiting',
      form: 'form',
      formTest: 'form-test',
      formWaiting: 'form-waiting',
      ...overrides.endpoints,
    },
    executions: {
      pruneAfterHours: Number(env.EXECUTIONS_DATA_MAX_AGE ?? 336),
      pruneMaxCount: Number(env.EXECUTIONS_DATA_PRUNE_MAX_COUNT ?? 10000),
      timeoutSeconds: Number(env.EXECUTIONS_TIMEOUT ?? -1),
      saveManual: (env.EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS ?? 'true') === 'true',
      ...overrides.executions,
    },
    editorDistDir: overrides.editorDistDir,
  };
}
