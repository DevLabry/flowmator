import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContext, type ConfigOverrides } from '../src';
import { executeWorkflow, exportCredentials, exportWorkflows, importCredentials, importWorkflows, listWorkflows, updateWorkflows } from '../src/commands/data';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/flowmator.mjs');
let dir: string;
let overrides: ConfigOverrides;

const node = (name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id: name, name, type, typeVersion: 1, position: [0, 0], parameters });
/** An n8n export: n8n-nodes-base types and tag objects. */
const n8nExport = {
  id: 'wf-from-n8n',
  name: 'From n8n',
  active: true,
  nodes: [
    node('Start', 'n8n-nodes-base.manualTrigger'),
    node('Set', 'n8n-nodes-base.set', { mode: 'manual', assignments: { assignments: [{ name: 'answer', value: '={{ 6 * 7 }}', type: 'number' }] } }),
  ],
  connections: { Start: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
  tags: [{ id: 't1', name: 'imported' }],
};

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flowmator-cli-'));
  overrides = { userFolder: path.join(dir, 'data'), encryptionKey: 'cli-key' };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const withDb = <T>(fn: (ctx: ReturnType<typeof createContext>) => T) => {
  const ctx = createContext(overrides);
  try {
    return fn(ctx);
  } finally {
    ctx.db.close();
  }
};

describe('cli: workflows', () => {
  it('imports n8n exports (inactive, types renamed, tags kept) and updates on re-import', async () => {
    const file = path.join(dir, 'wf.json');
    writeFileSync(file, JSON.stringify(n8nExport));
    expect(await importWorkflows({ input: file }, overrides)).toContain('1 new');
    const wf = withDb((ctx) => ctx.db.getWorkflow('wf-from-n8n'))!;
    expect(wf.active).toBe(false);
    expect(wf.nodes[1].type).toBe('flowmator.set');
    expect(wf.tags).toEqual(['imported']);

    writeFileSync(file, JSON.stringify([{ ...n8nExport, name: 'Renamed' }]));
    expect(await importWorkflows({ input: file }, overrides)).toContain('1 updated');
    expect(withDb((ctx) => ctx.db.getWorkflow('wf-from-n8n'))!.name).toBe('Renamed');
  });

  it('exports to stdout, a file, or one file per workflow', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await exportWorkflows({ id: 'wf-from-n8n' }, overrides);
      expect(JSON.parse(String(out.mock.calls[0][0]))[0].name).toBe('Renamed');
    } finally {
      out.mockRestore();
    }
    const backup = path.join(dir, 'backup');
    await exportWorkflows({ backup: true, output: backup }, overrides);
    expect(readdirSync(backup)).toEqual(['wf-from-n8n.json']);
    expect(readFileSync(path.join(backup, 'wf-from-n8n.json'), 'utf8')).toContain('\n  "id"'); // pretty
    await expect(exportWorkflows({}, overrides)).rejects.toThrow('--all or --id');
  });

  it('lists and (de)activates workflows', async () => {
    expect(await listWorkflows({}, overrides)).toBe('wf-from-n8n|Renamed');
    await updateWorkflows({ id: 'wf-from-n8n', active: true }, overrides);
    expect(await listWorkflows({ active: true, onlyId: true }, overrides)).toBe('wf-from-n8n');
    await updateWorkflows({ all: true, active: false }, overrides);
    expect(await listWorkflows({ active: true }, overrides)).toBe('');
  });

  it('executes a stored workflow or a file and reports the outcome', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await executeWorkflow({ id: 'wf-from-n8n' }, overrides)).toBe(0);
      expect(log.mock.calls[0][0]).toMatch(/^Execution \d+ was successful/);
      expect(log.mock.calls.flat().join('\n')).toContain('"answer": 42');

      const broken = path.join(dir, 'broken.json');
      writeFileSync(broken, JSON.stringify({ name: 'Broken', nodes: [node('Start', 'n8n-nodes-base.manualTrigger'), node('Code', 'n8n-nodes-base.code', { jsCode: 'throw new Error("nope")' })], connections: { Start: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } } }));
      expect(await executeWorkflow({ file: broken }, overrides)).toBe(1);
      expect(err.mock.calls.flat().join('\n')).toContain('nope');
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});

describe('cli: credentials', () => {
  it('round-trips encrypted and decrypted exports', async () => {
    withDb((ctx) => ctx.credentials.create('Token', 'httpHeaderAuth', { name: 'X-Key', value: 'secret-1' }));
    const encrypted = path.join(dir, 'creds.json');
    const decrypted = path.join(dir, 'creds-plain.json');
    await exportCredentials({ all: true, output: encrypted }, overrides);
    await exportCredentials({ all: true, output: decrypted, decrypted: true }, overrides);
    expect(readFileSync(encrypted, 'utf8')).not.toContain('secret-1');
    expect(JSON.parse(readFileSync(decrypted, 'utf8'))[0].data).toEqual({ name: 'X-Key', value: 'secret-1' });

    // same key: encrypted export imports as-is
    const sameKey = { ...overrides, userFolder: path.join(dir, 'same') };
    await importCredentials({ input: encrypted }, sameKey);
    // different key: only the decrypted export works
    const otherKey = { userFolder: path.join(dir, 'other'), encryptionKey: 'other-key' };
    await expect(importCredentials({ input: encrypted }, otherKey)).rejects.toThrow('different key');
    await importCredentials({ input: decrypted }, otherKey);
    const ctx = createContext(otherKey);
    try {
      const [cred] = ctx.credentials.list();
      expect(ctx.credentials.getDecrypted(cred.id).value).toBe('secret-1');
    } finally {
      ctx.db.close();
    }
  });
});

describe('cli: launcher', () => {
  it('runs commands through bin/flowmator.mjs', () => {
    const env = { ...process.env, FLOWMATOR_USER_FOLDER: overrides.userFolder!, FLOWMATOR_ENCRYPTION_KEY: 'cli-key' };
    expect(execFileSync(process.execPath, [bin, 'list:workflow', '--onlyId'], { env, encoding: 'utf8' }).trim()).toBe('wf-from-n8n');
    const bad = spawnSync(process.execPath, [bin, 'export:workflow'], { env, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('--all or --id');
    expect(execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })).toContain('import:workflow');
  });
});
