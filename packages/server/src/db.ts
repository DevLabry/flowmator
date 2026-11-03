import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { ExecutionMode, ExecutionStatus, IConnections, IDataObject, INode, IPinData, IRun, IWorkflowBase, IWorkflowSettings } from '@flowmator/workflow';

// Loaded via require: Vite (vitest) doesn't recognize node:sqlite as a built-in yet and fails to resolve the import.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  nodes TEXT NOT NULL,
  connections TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  staticData TEXT,
  pinData TEXT,
  meta TEXT,
  versionId TEXT NOT NULL,
  parentFolderId TEXT,
  isArchived INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_history (
  versionId TEXT PRIMARY KEY,
  workflowId TEXT NOT NULL,
  name TEXT,
  nodes TEXT NOT NULL,
  connections TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_wf ON workflow_history(workflowId, createdAt);
CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_tags (workflowId TEXT NOT NULL, tagId TEXT NOT NULL, PRIMARY KEY (workflowId, tagId));
CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parentFolderId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflowId TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  startedAt TEXT,
  stoppedAt TEXT,
  waitTill TEXT,
  retryOf TEXT,
  retrySuccessId TEXT,
  data TEXT,
  workflowData TEXT NOT NULL,
  customData TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exec_wf ON executions(workflowId, id);
CREATE INDEX IF NOT EXISTS idx_exec_wait ON executions(status, waitTill);
CREATE TABLE IF NOT EXISTS variables (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, apiKey TEXT NOT NULL UNIQUE, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const now = () => new Date().toISOString();
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const parse = <T>(v: unknown, fallback: T): T => (typeof v === 'string' && v !== '' ? (JSON.parse(v) as T) : fallback);
/** Short ids like n8n's (16 alphanumerics) so URLs stay readable. */
export const newId = () => randomUUID().replace(/-/g, '').slice(0, 16);

export interface WorkflowEntity extends IWorkflowBase {
  id: string;
  active: boolean;
  versionId: string;
  parentFolderId?: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  tags: string[];
}

export interface CredentialEntity {
  id: string;
  name: string;
  type: string;
  data: string; // encrypted
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionEntity {
  id: string;
  workflowId: string | null;
  mode: ExecutionMode;
  status: ExecutionStatus;
  startedAt: string | null;
  stoppedAt: string | null;
  waitTill: string | null;
  retryOf: string | null;
  retrySuccessId: string | null;
  data: IRun['data'] | null;
  workflowData: IWorkflowBase;
  customData: IDataObject;
  createdAt: string;
}

export interface ExecutionSummary extends Omit<ExecutionEntity, 'data' | 'workflowData' | 'customData'> {
  workflowName: string;
}

type Row = Record<string, unknown>;

function retryWhileLocked(fn: () => void, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (!/database is locked|SQLITE_BUSY/i.test((e as Error).message) || Date.now() > until) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + Math.random() * 50);
    }
  }
}

export class Database {
  readonly db: DatabaseSyncType;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    // workers and webhook processes open the same file; switching a new database to WAL takes an
    // exclusive lock that SQLite doesn't wait for, so concurrent first opens retry instead
    retryWhileLocked(() => this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;'));
    retryWhileLocked(() => this.db.exec(SCHEMA));
    retryWhileLocked(() => this.renameLegacyNodeTypes());
    retryWhileLocked(() => this.addOwnerColumns());
  }

  /** Since user management, folders belong to a project and API keys to a user. */
  private addOwnerColumns() {
    for (const [table, column] of [
      ['folders', 'projectId'],
      ['api_keys', 'userId'],
    ]) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
  }

  /** Flowmator was called 8n8: stored node types move from 8n8.x / 8n8-ai.x to flowmator.x / flowmator-ai.x. */
  private renameLegacyNodeTypes() {
    for (const table of ['workflows', 'workflow_history']) {
      this.db
        .prepare(`UPDATE ${table} SET nodes = REPLACE(REPLACE(nodes, '"type":"8n8-ai.', '"type":"flowmator-ai.'), '"type":"8n8.', '"type":"flowmator.') WHERE nodes LIKE '%"type":"8n8%'`)
        .run();
    }
  }

  close() {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /* ---------------- workflows ---------------- */

  private toWorkflow(r: Row): WorkflowEntity {
    const tags = (this.db.prepare('SELECT t.name FROM tags t JOIN workflow_tags wt ON wt.tagId = t.id WHERE wt.workflowId = ? ORDER BY t.name').all(r.id as string) as Row[]).map((t) => t.name as string);
    return {
      id: r.id as string,
      name: r.name as string,
      active: !!r.active,
      nodes: parse<INode[]>(r.nodes, []),
      connections: parse<IConnections>(r.connections, {}),
      settings: parse<IWorkflowSettings>(r.settings, {}),
      staticData: parse<IDataObject>(r.staticData, {}),
      pinData: parse<IPinData>(r.pinData, {}),
      meta: parse<IDataObject>(r.meta, {}),
      versionId: r.versionId as string,
      parentFolderId: (r.parentFolderId as string) ?? null,
      isArchived: !!r.isArchived,
      createdAt: r.createdAt as string,
      updatedAt: r.updatedAt as string,
      tags,
    };
  }

  listWorkflows(filter: { active?: boolean; name?: string; tag?: string; folderId?: string | null; archived?: boolean } = {}): WorkflowEntity[] {
    const where: string[] = ['isArchived = ?'];
    const args: Array<string | number | null> = [filter.archived ? 1 : 0];
    if (filter.active !== undefined) {
      where.push('active = ?');
      args.push(filter.active ? 1 : 0);
    }
    if (filter.name) {
      where.push('name LIKE ?');
      args.push(`%${filter.name}%`);
    }
    if (filter.tag) {
      where.push('id IN (SELECT wt.workflowId FROM workflow_tags wt JOIN tags t ON t.id = wt.tagId WHERE t.name = ?)');
      args.push(filter.tag);
    }
    if (filter.folderId !== undefined) {
      where.push(filter.folderId === null ? 'parentFolderId IS NULL' : 'parentFolderId = ?');
      if (filter.folderId !== null) args.push(filter.folderId);
    }
    const rows = this.db.prepare(`SELECT * FROM workflows WHERE ${where.join(' AND ')} ORDER BY updatedAt DESC`).all(...args) as Row[];
    return rows.map((r) => this.toWorkflow(r));
  }

  getWorkflow(id: string): WorkflowEntity | null {
    const r = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toWorkflow(r) : null;
  }

  createWorkflow(data: Partial<IWorkflowBase> & { name: string; parentFolderId?: string | null }): WorkflowEntity {
    const id = data.id && !this.getWorkflow(data.id) ? data.id : newId();
    const versionId = randomUUID();
    const ts = now();
    this.db
      .prepare('INSERT INTO workflows (id, name, active, nodes, connections, settings, staticData, pinData, meta, versionId, parentFolderId, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, data.name, 0, json(data.nodes ?? []), json(data.connections ?? {}), json(data.settings ?? { executionOrder: 'v1' }), json(data.staticData ?? null), json(data.pinData ?? {}), json(data.meta ?? null), versionId, data.parentFolderId ?? null, ts, ts);
    this.saveHistory(id, versionId, data.name, data.nodes ?? [], data.connections ?? {});
    if (data.tags) this.setWorkflowTags(id, data.tags);
    return this.getWorkflow(id)!;
  }

  /** Updates fields; a new history version is recorded when nodes or connections change. */
  updateWorkflow(id: string, data: Partial<WorkflowEntity>): WorkflowEntity {
    const current = this.getWorkflow(id);
    if (!current) throw new Error(`Workflow ${id} not found`);
    const graphChanged =
      (data.nodes !== undefined && JSON.stringify(data.nodes) !== JSON.stringify(current.nodes)) ||
      (data.connections !== undefined && JSON.stringify(data.connections) !== JSON.stringify(current.connections));
    const versionId = graphChanged ? randomUUID() : current.versionId;
    const merged = { ...current, ...data };
    this.db
      .prepare('UPDATE workflows SET name=?, active=?, nodes=?, connections=?, settings=?, staticData=?, pinData=?, meta=?, versionId=?, parentFolderId=?, isArchived=?, updatedAt=? WHERE id=?')
      .run(merged.name, merged.active ? 1 : 0, json(merged.nodes), json(merged.connections), json(merged.settings ?? {}), json(merged.staticData ?? null), json(merged.pinData ?? {}), json(merged.meta ?? null), versionId, merged.parentFolderId ?? null, merged.isArchived ? 1 : 0, now(), id);
    if (graphChanged) this.saveHistory(id, versionId, merged.name, merged.nodes, merged.connections);
    if (data.tags) this.setWorkflowTags(id, data.tags);
    return this.getWorkflow(id)!;
  }

  /** Persists static data without bumping updatedAt (pollers write it often). */
  saveStaticData(id: string, staticData: IDataObject) {
    this.db.prepare('UPDATE workflows SET staticData = ? WHERE id = ?').run(json(staticData), id);
  }

  deleteWorkflow(id: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM workflow_tags WHERE workflowId = ?').run(id);
      this.db.prepare('DELETE FROM workflow_history WHERE workflowId = ?').run(id);
      this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    });
  }

  private saveHistory(workflowId: string, versionId: string, name: string, nodes: INode[], connections: IConnections) {
    this.db.prepare('INSERT INTO workflow_history (versionId, workflowId, name, nodes, connections, createdAt) VALUES (?,?,?,?,?,?)').run(versionId, workflowId, name, json(nodes), json(connections), now());
  }

  listHistory(workflowId: string) {
    return (this.db.prepare('SELECT versionId, workflowId, name, createdAt FROM workflow_history WHERE workflowId = ? ORDER BY createdAt DESC, rowid DESC').all(workflowId) as Row[]).map((r) => ({ ...r }));
  }

  getHistoryVersion(workflowId: string, versionId: string) {
    const r = this.db.prepare('SELECT * FROM workflow_history WHERE workflowId = ? AND versionId = ?').get(workflowId, versionId) as Row | undefined;
    return r ? { ...r, nodes: parse<INode[]>(r.nodes, []), connections: parse<IConnections>(r.connections, {}) } : null;
  }

  /* ---------------- tags & folders ---------------- */

  listTags(withUsage = false) {
    const rows = this.db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM workflow_tags wt WHERE wt.tagId = t.id) AS usageCount FROM tags t ORDER BY name`).all() as Row[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt, ...(withUsage ? { usageCount: r.usageCount } : {}) }));
  }

  upsertTag(name: string): string {
    const existing = this.db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as Row | undefined;
    if (existing) return existing.id as string;
    const id = newId();
    this.db.prepare('INSERT INTO tags (id, name, createdAt, updatedAt) VALUES (?,?,?,?)').run(id, name, now(), now());
    return id;
  }

  renameTag(id: string, name: string) {
    this.db.prepare('UPDATE tags SET name = ?, updatedAt = ? WHERE id = ?').run(name, now(), id);
  }

  deleteTag(id: string) {
    this.db.prepare('DELETE FROM workflow_tags WHERE tagId = ?').run(id);
    this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  }

  setWorkflowTags(workflowId: string, tags: string[]) {
    this.db.prepare('DELETE FROM workflow_tags WHERE workflowId = ?').run(workflowId);
    for (const t of tags) {
      const byId = this.db.prepare('SELECT id FROM tags WHERE id = ?').get(t) as Row | undefined;
      const tagId = byId ? (byId.id as string) : this.upsertTag(t);
      this.db.prepare('INSERT OR IGNORE INTO workflow_tags (workflowId, tagId) VALUES (?,?)').run(workflowId, tagId);
    }
  }

  listFolders() {
    return this.db.prepare('SELECT * FROM folders ORDER BY name').all() as Row[];
  }

  createFolder(name: string, parentFolderId: string | null = null) {
    const id = newId();
    this.db.prepare('INSERT INTO folders (id, name, parentFolderId, createdAt, updatedAt) VALUES (?,?,?,?,?)').run(id, name, parentFolderId, now(), now());
    return { id, name, parentFolderId };
  }

  updateFolder(id: string, data: { name?: string; parentFolderId?: string | null }) {
    const cur = this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Row | undefined;
    if (!cur) throw new Error('Folder not found');
    this.db.prepare('UPDATE folders SET name = ?, parentFolderId = ?, updatedAt = ? WHERE id = ?').run(data.name ?? (cur.name as string), data.parentFolderId === undefined ? (cur.parentFolderId as string | null) : data.parentFolderId, now(), id);
  }

  deleteFolder(id: string) {
    this.db.prepare('UPDATE workflows SET parentFolderId = NULL WHERE parentFolderId = ?').run(id);
    this.db.prepare('UPDATE folders SET parentFolderId = NULL WHERE parentFolderId = ?').run(id);
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  }

  /* ---------------- credentials ---------------- */

  listCredentials(type?: string): CredentialEntity[] {
    return (type
      ? this.db.prepare('SELECT * FROM credentials WHERE type = ? ORDER BY name').all(type)
      : this.db.prepare('SELECT * FROM credentials ORDER BY name').all()) as unknown as CredentialEntity[];
  }

  getCredential(id: string): CredentialEntity | null {
    return (this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as unknown as CredentialEntity) ?? null;
  }

  findCredentialByName(name: string, type: string): CredentialEntity | null {
    return (this.db.prepare('SELECT * FROM credentials WHERE name = ? AND type = ?').get(name, type) as unknown as CredentialEntity) ?? null;
  }

  createCredential(name: string, type: string, encryptedData: string, id = newId()): CredentialEntity {
    this.db.prepare('INSERT INTO credentials (id, name, type, data, createdAt, updatedAt) VALUES (?,?,?,?,?,?)').run(id, name, type, encryptedData, now(), now());
    return this.getCredential(id)!;
  }

  updateCredential(id: string, data: { name?: string; data?: string }) {
    const cur = this.getCredential(id);
    if (!cur) throw new Error('Credential not found');
    this.db.prepare('UPDATE credentials SET name = ?, data = ?, updatedAt = ? WHERE id = ?').run(data.name ?? cur.name, data.data ?? cur.data, now(), id);
    return this.getCredential(id)!;
  }

  deleteCredential(id: string) {
    this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
  }

  /* ---------------- executions ---------------- */

  private toExecution(r: Row): ExecutionEntity {
    return {
      id: String(r.id),
      workflowId: (r.workflowId as string) ?? null,
      mode: r.mode as ExecutionMode,
      status: r.status as ExecutionStatus,
      startedAt: (r.startedAt as string) ?? null,
      stoppedAt: (r.stoppedAt as string) ?? null,
      waitTill: (r.waitTill as string) ?? null,
      retryOf: (r.retryOf as string) ?? null,
      retrySuccessId: (r.retrySuccessId as string) ?? null,
      data: parse<IRun['data'] | null>(r.data, null),
      workflowData: parse<IWorkflowBase>(r.workflowData, { name: '', nodes: [], connections: {} }),
      customData: parse<IDataObject>(r.customData, {}),
      createdAt: r.createdAt as string,
    };
  }

  createExecution(e: { workflowId?: string; mode: ExecutionMode; status: ExecutionStatus; workflowData: IWorkflowBase; retryOf?: string; startedAt?: Date }): string {
    const res = this.db
      .prepare('INSERT INTO executions (workflowId, mode, status, startedAt, retryOf, workflowData, createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(e.workflowId ?? null, e.mode, e.status, (e.startedAt ?? new Date()).toISOString(), e.retryOf ?? null, json(e.workflowData), now());
    return String(res.lastInsertRowid);
  }

  updateExecution(id: string, data: Partial<{ status: ExecutionStatus; stoppedAt: Date | null; waitTill: Date | null; data: IRun['data']; customData: IDataObject; retrySuccessId: string; startedAt: Date }>) {
    const sets: string[] = [];
    const args: Array<string | null> = [];
    const set = (col: string, v: string | null) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if (data.status !== undefined) set('status', data.status);
    if (data.stoppedAt !== undefined) set('stoppedAt', data.stoppedAt ? data.stoppedAt.toISOString() : null);
    if (data.startedAt !== undefined) set('startedAt', data.startedAt.toISOString());
    if (data.waitTill !== undefined) set('waitTill', data.waitTill ? data.waitTill.toISOString() : null);
    if (data.data !== undefined) set('data', json(data.data));
    if (data.customData !== undefined) set('customData', json(data.customData));
    if (data.retrySuccessId !== undefined) set('retrySuccessId', data.retrySuccessId);
    if (!sets.length) return;
    this.db.prepare(`UPDATE executions SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  getExecution(id: string): ExecutionEntity | null {
    const r = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toExecution(r) : null;
  }

  listExecutions(filter: { workflowId?: string; workflowIds?: string[]; status?: ExecutionStatus[]; limit?: number; lastId?: string; startedAfter?: string; startedBefore?: string } = {}): { results: ExecutionSummary[]; count: number } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.workflowId) {
      where.push('e.workflowId = ?');
      args.push(filter.workflowId);
    }
    if (filter.workflowIds) {
      where.push(filter.workflowIds.length ? `e.workflowId IN (${filter.workflowIds.map(() => '?').join(',')})` : '0');
      args.push(...filter.workflowIds);
    }
    if (filter.status?.length) {
      where.push(`e.status IN (${filter.status.map(() => '?').join(',')})`);
      args.push(...filter.status);
    }
    if (filter.startedAfter) {
      where.push('e.startedAt >= ?');
      args.push(filter.startedAfter);
    }
    if (filter.startedBefore) {
      where.push('e.startedAt <= ?');
      args.push(filter.startedBefore);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = (this.db.prepare(`SELECT COUNT(*) AS c FROM executions e ${whereSql}`).get(...args) as Row).c as number;
    const pageWhere = filter.lastId ? `${whereSql ? `${whereSql} AND` : 'WHERE'} e.id < ?` : whereSql;
    const pageArgs = filter.lastId ? [...args, Number(filter.lastId)] : args;
    const rows = this.db
      .prepare(`SELECT e.id, e.workflowId, e.mode, e.status, e.startedAt, e.stoppedAt, e.waitTill, e.retryOf, e.retrySuccessId, e.createdAt, COALESCE(w.name, json_extract(e.workflowData, '$.name')) AS workflowName FROM executions e LEFT JOIN workflows w ON w.id = e.workflowId ${pageWhere} ORDER BY e.id DESC LIMIT ?`)
      .all(...pageArgs, filter.limit ?? 50) as Row[];
    return {
      count,
      results: rows.map((r) => ({
        id: String(r.id),
        workflowId: (r.workflowId as string) ?? null,
        workflowName: (r.workflowName as string) ?? '',
        mode: r.mode as ExecutionMode,
        status: r.status as ExecutionStatus,
        startedAt: (r.startedAt as string) ?? null,
        stoppedAt: (r.stoppedAt as string) ?? null,
        waitTill: (r.waitTill as string) ?? null,
        retryOf: (r.retryOf as string) ?? null,
        retrySuccessId: (r.retrySuccessId as string) ?? null,
        createdAt: r.createdAt as string,
      })),
    };
  }

  /** Waiting executions whose waitTill passed (or is about to, within `withinMs`). */
  dueWaitingExecutions(withinMs: number): Array<{ id: string; waitTill: string }> {
    const limit = new Date(Date.now() + withinMs).toISOString();
    return this.db.prepare("SELECT id, waitTill FROM executions WHERE status = 'waiting' AND waitTill IS NOT NULL AND waitTill <= ?").all(limit).map((r: any) => ({ id: String(r.id), waitTill: r.waitTill }));
  }

  deleteExecutions(ids: string[]) {
    for (const id of ids) this.db.prepare('DELETE FROM executions WHERE id = ?').run(id);
  }

  /** Marks executions left "running" by a crash, except `keep` (still queued or on a worker). */
  markCrashedExecutions(keep: string[] = []): number {
    const exclude = keep.length ? ` AND id NOT IN (${keep.map(() => '?').join(',')})` : '';
    return Number(this.db.prepare(`UPDATE executions SET status = 'crashed', stoppedAt = ? WHERE status IN ('running', 'new')${exclude}`).run(now(), ...keep).changes);
  }

  pruneExecutions(maxAgeHours: number, maxCount: number): string[] {
    const cutoff = new Date(Date.now() - maxAgeHours * 3_600_000).toISOString();
    const old = this.db.prepare("SELECT id FROM executions WHERE status NOT IN ('running','waiting','new') AND (stoppedAt < ? OR id <= (SELECT id FROM executions ORDER BY id DESC LIMIT 1 OFFSET ?))").all(cutoff, maxCount) as Row[];
    const ids = old.map((r) => String(r.id));
    this.deleteExecutions(ids);
    return ids;
  }

  /* ---------------- variables, api keys, settings ---------------- */

  listVariables() {
    return this.db.prepare('SELECT * FROM variables ORDER BY key').all() as Array<{ id: string; key: string; value: string }>;
  }

  createVariable(key: string, value: string) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) throw new Error('Variable keys may only contain letters, numbers and underscores');
    const id = newId();
    this.db.prepare('INSERT INTO variables (id, key, value) VALUES (?,?,?)').run(id, key, value);
    return { id, key, value };
  }

  updateVariable(id: string, data: { key?: string; value?: string }) {
    const cur = this.db.prepare('SELECT * FROM variables WHERE id = ?').get(id) as Row | undefined;
    if (!cur) throw new Error('Variable not found');
    this.db.prepare('UPDATE variables SET key = ?, value = ? WHERE id = ?').run(data.key ?? (cur.key as string), data.value ?? (cur.value as string), id);
    return { id, key: data.key ?? cur.key, value: data.value ?? cur.value };
  }

  deleteVariable(id: string) {
    this.db.prepare('DELETE FROM variables WHERE id = ?').run(id);
  }

  listApiKeys(userId?: string) {
    const sql = 'SELECT id, label, substr(apiKey, 1, 6) || \'…\' AS apiKey, createdAt FROM api_keys';
    return userId ? this.db.prepare(`${sql} WHERE userId = ?`).all(userId) : this.db.prepare(sql).all();
  }

  createApiKey(label: string, apiKey: string, userId: string | null = null) {
    const id = newId();
    this.db.prepare('INSERT INTO api_keys (id, label, apiKey, userId, createdAt) VALUES (?,?,?,?,?)').run(id, label, apiKey, userId, now());
    return { id, label, apiKey };
  }

  findApiKey(apiKey: string) {
    return (this.db.prepare('SELECT id, userId FROM api_keys WHERE apiKey = ?').get(apiKey) as { id: string; userId: string | null } | undefined) ?? null;
  }

  /** Deletes the key; with a user, only one of theirs. */
  deleteApiKey(id: string, userId?: string) {
    if (userId) this.db.prepare('DELETE FROM api_keys WHERE id = ? AND userId = ?').run(id, userId);
    else this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  }

  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r ? (JSON.parse(r.value as string) as T) : fallback;
  }

  setSetting(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }
}
