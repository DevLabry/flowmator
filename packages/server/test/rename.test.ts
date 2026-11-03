import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src';
import { signIn } from './auth-helper';
import { defaultUserFolder } from '../src/config';
import { Database } from '../src/db';

const dir = mkdtempSync(path.join(os.tmpdir(), 'flowmator-rename-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Flowmator was called 8n8: data saved under the old name has to keep working. */
describe('data from before the rename', () => {
  it('renames stored 8n8 node types and runs the workflow', async () => {
    const userFolder = path.join(dir, 'data');
    mkdirSync(userFolder);
    const db = new Database(path.join(userFolder, 'database.sqlite'));
    const legacy = db.createWorkflow({
      name: 'Old',
      nodes: [
        { id: 'a', name: 'Start', type: '8n8.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'b', name: 'Set', type: '8n8.set', typeVersion: 1, position: [200, 0], parameters: { mode: 'raw', jsonOutput: '{"ok":true}' } },
        { id: 'c', name: 'Agent', type: '8n8-ai.agent', typeVersion: 1, position: [400, 0], parameters: {}, disabled: true },
      ],
      connections: { Start: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
    });
    db.close();

    const app = await createApp({ userFolder, port: 0, webhookUrl: 'http://localhost:5678/', encryptionKey: 'k' });
    await signIn(app);
    try {
      const stored = app.ctx.db.getWorkflow(legacy.id)!;
      expect(stored.nodes.map((n) => n.type)).toEqual(['flowmator.manualTrigger', 'flowmator.set', 'flowmator-ai.agent']);
      const res = await app.app.inject({ method: 'POST', url: `/rest/workflows/${legacy.id}/run?wait=true`, payload: {} });
      expect(JSON.parse(res.body).data.data.runData.Set[0].data.main[0][0].json).toEqual({ ok: true });
      // exports from the old name can still be imported
      expect(app.ctx.nodeTypes.has('8n8.httpRequest')).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it('keeps using ~/.8n8 until ~/.flowmator exists', () => {
    const home = path.join(dir, 'home');
    mkdirSync(path.join(home, '.8n8'), { recursive: true });
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      expect(defaultUserFolder()).toBe(path.join(home, '.8n8'));
      mkdirSync(path.join(home, '.flowmator'));
      expect(defaultUserFolder()).toBe(path.join(home, '.flowmator'));
    } finally {
      spy.mockRestore();
    }
  });
});
