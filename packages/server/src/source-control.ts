import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import ssh2 from 'ssh2';
import { isExpression, type IDataObject } from '@8n8/workflow';
import type { ActiveWorkflows } from './active-workflows';
import type { CredentialsService, Cipher } from './credentials';
import type { Database, WorkflowEntity } from './db';
import type { EventBus } from './events';

const run = promisify(execFile);

export interface SourceControlPreferences {
  connected: boolean;
  repositoryUrl: string;
  branchName: string;
  branchReadOnly: boolean;
  branchColor: string;
  connectionType: 'ssh' | 'https';
  keyGeneratorType: 'ed25519' | 'rsa';
  publicKey?: string;
  httpsUsername?: string;
  /** stored encrypted, never sent to the editor */
  httpsPassword?: string;
  authorName: string;
  authorEmail: string;
}

export type FileType = 'workflow' | 'credential' | 'variables' | 'tags' | 'folders';
export interface StatusEntry {
  id: string;
  name: string;
  type: FileType;
  status: 'created' | 'modified' | 'deleted';
  location: 'local' | 'remote';
  conflict: boolean;
  file: string;
  updatedAt?: string;
}

const PREFS = 'sourceControl';
const SECRETS = 'sourceControlSecrets';
const BASE = 'sourceControlBase';

const hash = (s: string) => createHash('sha1').update(s).digest('hex');
const stable = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

export class SourceControlError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly details?: unknown) {
    super(message);
  }
}

/**
 * Git-backed environments like n8n's: workflows, credential stubs (no secrets), variable stubs,
 * tags and folders are files in a repository branch; push writes the local versions, pull imports
 * the remote ones. Changes are tracked against the hash of each file at its last sync, so status
 * can tell local edits, remote edits and conflicts apart.
 */
export class SourceControlService {
  readonly dir: string;
  private readonly sshDir: string;
  /** Serializes git operations */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly database: Database,
    private readonly cipher: Cipher,
    private readonly credentials: CredentialsService,
    userFolder: string,
    private readonly activeWorkflows?: ActiveWorkflows,
    private readonly events?: EventBus,
  ) {
    this.dir = path.join(userFolder, 'git');
    this.sshDir = path.join(userFolder, 'ssh');
  }

  /* ---------------- preferences ---------------- */

  preferences(): SourceControlPreferences {
    const p = this.database.getSetting<Partial<SourceControlPreferences>>(PREFS, {});
    return {
      connected: false,
      repositoryUrl: '',
      branchName: 'main',
      branchReadOnly: false,
      branchColor: '#5296D6',
      connectionType: 'ssh',
      keyGeneratorType: 'ed25519',
      authorName: '8n8',
      authorEmail: '8n8@localhost',
      ...p,
    };
  }

  publicPreferences() {
    const { httpsPassword: _p, ...rest } = this.preferences();
    return { ...rest, hasHttpsPassword: !!this.secrets().httpsPassword, keyPath: this.keyFile() };
  }

  private secrets(): { privateKey?: string; httpsPassword?: string } {
    const raw = this.database.getSetting<string>(SECRETS, '');
    return raw ? (this.cipher.decrypt(raw) as { privateKey?: string; httpsPassword?: string }) : {};
  }

  private saveSecrets(s: { privateKey?: string; httpsPassword?: string }) {
    this.database.setSetting(SECRETS, this.cipher.encrypt(s as IDataObject));
  }

  private keyFile() {
    return path.join(this.sshDir, 'id_8n8');
  }

  /** Creates a deploy key pair; add the public key to the repository with write access. */
  generateKeyPair(type: 'ed25519' | 'rsa' = this.preferences().keyGeneratorType) {
    const pair = type === 'rsa' ? ssh2.utils.generateKeyPairSync('rsa', { bits: 4096, comment: '8n8 deploy key' }) : ssh2.utils.generateKeyPairSync('ed25519', { comment: '8n8 deploy key' });
    this.saveSecrets({ ...this.secrets(), privateKey: pair.private });
    this.database.setSetting(PREFS, { ...this.database.getSetting(PREFS, {}), keyGeneratorType: type, publicKey: pair.public.trim() });
    this.writeKey();
    return pair.public.trim();
  }

  private writeKey() {
    const key = this.secrets().privateKey;
    if (!key) return;
    mkdirSync(this.sshDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.keyFile(), key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600 });
  }

  /** Saves preferences; with `connected` true it initialises the repository and checks out the branch. */
  async setPreferences(input: Partial<SourceControlPreferences> & { httpsPassword?: string }) {
    const { httpsPassword, connected, ...rest } = input;
    if (httpsPassword !== undefined) this.saveSecrets({ ...this.secrets(), httpsPassword });
    const prefs = { ...this.preferences(), ...rest };
    this.database.setSetting(PREFS, { ...this.database.getSetting(PREFS, {}), ...rest });
    if (connected === true && !prefs.connected) {
      if (!prefs.repositoryUrl) throw new SourceControlError('Set the repository URL');
      if (prefs.connectionType === 'ssh' && !this.secrets().privateKey) this.generateKeyPair(prefs.keyGeneratorType);
      await this.connect(prefs);
    } else if (connected === false) await this.disconnect();
    return this.publicPreferences();
  }

  private async connect(prefs: SourceControlPreferences) {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    await this.git(['init', '-q']);
    await this.git(['remote', 'add', 'origin', prefs.repositoryUrl]);
    await this.git(['config', 'user.name', prefs.authorName]);
    await this.git(['config', 'user.email', prefs.authorEmail]);
    try {
      await this.git(['fetch', '-q', 'origin']);
    } catch (e) {
      rmSync(this.dir, { recursive: true, force: true });
      throw new SourceControlError(`Could not reach the repository: ${(e as Error).message}`);
    }
    await this.checkoutBranch(prefs.branchName);
    this.database.setSetting(PREFS, { ...this.database.getSetting(PREFS, {}), connected: true });
    this.database.setSetting(BASE, {});
  }

  private async checkoutBranch(branch: string) {
    const remote = await this.remoteBranches();
    if (remote.includes(branch)) await this.git(['checkout', '-q', '-B', branch, `origin/${branch}`]);
    else await this.git(['checkout', '-q', '--orphan', branch]).catch(() => this.git(['checkout', '-q', '-B', branch]));
  }

  async disconnect() {
    rmSync(this.dir, { recursive: true, force: true });
    this.database.setSetting(PREFS, { ...this.database.getSetting(PREFS, {}), connected: false });
    this.database.setSetting(BASE, {});
  }

  async remoteBranches(): Promise<string[]> {
    const out = await this.git(['branch', '-r', '--format=%(refname:short)']).catch(() => '');
    return out.split('\n').map((b) => b.trim().replace(/^origin\//, '')).filter((b) => b && b !== 'HEAD' && b !== 'origin');
  }

  async branches() {
    this.assertConnected();
    await this.git(['fetch', '-q', '--prune', 'origin']);
    return { branches: await this.remoteBranches(), currentBranch: this.preferences().branchName };
  }

  private assertConnected() {
    if (!this.preferences().connected || !existsSync(path.join(this.dir, '.git'))) throw new SourceControlError('Source control is not connected');
  }

  /* ---------------- git ---------------- */

  private async git(args: string[]): Promise<string> {
    const prefs = this.preferences();
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const pre: string[] = [];
    if (prefs.connectionType === 'ssh' && this.secrets().privateKey) {
      if (!existsSync(this.keyFile())) this.writeKey();
      env.GIT_SSH_COMMAND = `ssh -i "${this.keyFile()}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${path.join(this.sshDir, 'known_hosts')}"`;
    }
    if (prefs.connectionType === 'https' && prefs.httpsUsername) {
      // credentials go in a per-command header, never into .git/config
      const basic = Buffer.from(`${prefs.httpsUsername}:${this.secrets().httpsPassword ?? ''}`).toString('base64');
      pre.push('-c', `http.extraHeader=Authorization: Basic ${basic}`);
    }
    try {
      const { stdout } = await run('git', [...pre, ...args], { cwd: this.dir, env, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      throw new Error((err.stderr || err.message).trim().split('\n').filter((l) => !l.startsWith('hint:')).join(' '));
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => {});
    return next;
  }

  /* ---------------- files ---------------- */

  /** What the local instance would write, by repository path. */
  private localFiles(): Map<string, { content: string; id: string; name: string; type: FileType; updatedAt?: string }> {
    const files = new Map<string, { content: string; id: string; name: string; type: FileType; updatedAt?: string }>();
    for (const wf of this.database.listWorkflows({ archived: false })) {
      files.set(`workflows/${wf.id}.json`, { content: stable(workflowFile(wf)), id: wf.id, name: wf.name, type: 'workflow', updatedAt: wf.updatedAt });
    }
    for (const c of this.database.listCredentials()) {
      const data = this.credentials.getDecrypted(c.id);
      const { __type: _t, __name: _n, oauthTokenData: _o, ...fields } = data;
      // stubs keep the shape and any expressions ({{ $secrets.… }}), never values
      const stub = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, isExpression(v) ? v : typeof v === 'boolean' || typeof v === 'number' ? v : '']));
      files.set(`credential_stubs/${c.id}.json`, { content: stable({ id: c.id, name: c.name, type: c.type, data: stub }), id: c.id, name: c.name, type: 'credential', updatedAt: c.updatedAt });
    }
    const variables = this.database.listVariables();
    if (variables.length) files.set('variable_stubs.json', { content: stable(variables.map((v) => ({ id: v.id, key: v.key, type: 'string', value: '' }))), id: 'variables', name: 'variables', type: 'variables' });
    const tags = this.database.listTags();
    if (tags.length) {
      const mappings = this.database.db.prepare('SELECT workflowId, tagId FROM workflow_tags ORDER BY workflowId, tagId').all();
      files.set('tags.json', { content: stable({ tags: tags.map((t) => ({ id: t.id, name: t.name })), mappings }), id: 'tags', name: 'tags', type: 'tags' });
    }
    const folders = this.database.listFolders();
    if (folders.length) files.set('folders.json', { content: stable({ folders: folders.map((f) => ({ id: f.id, name: f.name, parentFolderId: f.parentFolderId ?? null })) }), id: 'folders', name: 'folders', type: 'folders' });
    return files;
  }

  /** Files on the remote branch (after a fetch). */
  private async remoteFiles(): Promise<Map<string, string>> {
    const branch = this.preferences().branchName;
    const files = new Map<string, string>();
    if (!(await this.remoteBranches()).includes(branch)) return files;
    const list = (await this.git(['ls-tree', '-r', '--name-only', `origin/${branch}`])).split('\n').filter((f) => /^(workflows|credential_stubs)\/[^/]+\.json$|^(variable_stubs|tags|folders)\.json$/.test(f));
    for (const f of list) files.set(f, await this.git(['show', `origin/${branch}:${f}`]));
    return files;
  }

  /**
   * Per file, the hashes of the local export and of the remote file at the last sync. Both are kept
   * because an imported file can export slightly differently (added defaults) without being edited.
   */
  private base(): Record<string, { l?: string; r?: string }> {
    return this.database.getSetting<Record<string, { l?: string; r?: string }>>(BASE, {});
  }

  private describe(file: string, content?: string): { id: string; name: string; type: FileType } {
    if (file.startsWith('workflows/')) {
      const id = path.basename(file, '.json');
      let name = id;
      try {
        name = JSON.parse(content ?? '{}').name ?? id;
      } catch {}
      return { id, name, type: 'workflow' };
    }
    if (file.startsWith('credential_stubs/')) {
      const id = path.basename(file, '.json');
      let name = id;
      try {
        name = JSON.parse(content ?? '{}').name ?? id;
      } catch {}
      return { id, name, type: 'credential' };
    }
    const type = file === 'variable_stubs.json' ? 'variables' : (file.replace('.json', '') as FileType);
    return { id: type, name: type, type };
  }

  /** Three-way status: each file compared with its hash at the last push/pull. */
  async status(fetch = true): Promise<StatusEntry[]> {
    this.assertConnected();
    if (fetch) await this.git(['fetch', '-q', '--prune', 'origin']);
    const local = this.localFiles();
    const remote = await this.remoteFiles();
    const base = this.base();
    const out: StatusEntry[] = [];
    for (const file of new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)])) {
      const l = local.get(file);
      const r = remote.get(file);
      const lh = l ? hash(l.content) : undefined;
      const rh = r !== undefined ? hash(r) : undefined;
      const b = base[file] ?? {};
      if (lh === rh) continue;
      const localChanged = lh !== b.l;
      const remoteChanged = rh !== b.r;
      if (!localChanged && !remoteChanged) continue;
      const info = l ? { id: l.id, name: l.name, type: l.type, updatedAt: l.updatedAt } : this.describe(file, r);
      const conflict = localChanged && remoteChanged;
      // where the newer version is; conflicts are reported as local (pushing would overwrite the remote)
      const location: 'local' | 'remote' = localChanged ? 'local' : 'remote';
      const present = location === 'local' ? !!l : r !== undefined;
      const other = location === 'local' ? r !== undefined : !!l;
      const status = !present ? 'deleted' : other ? 'modified' : 'created';
      out.push({ ...info, file, status, location, conflict });
    }
    return out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  }

  /* ---------------- push ---------------- */

  push(opts: { commitMessage?: string; fileNames?: string[]; force?: boolean } = {}) {
    return this.exclusive(async () => {
      this.assertConnected();
      const prefs = this.preferences();
      if (prefs.branchReadOnly) throw new SourceControlError('The branch is read-only: pushing is disabled');
      const status = (await this.status()).filter((s) => s.location === 'local' || s.conflict);
      const selected = opts.fileNames?.length ? status.filter((s) => opts.fileNames!.includes(s.file)) : status;
      const conflicts = selected.filter((s) => s.conflict);
      if (conflicts.length && !opts.force) throw new SourceControlError('Some files changed on the remote too: pull first or force push', 409, conflicts);
      if (!selected.length) return { pushed: [], commit: null };

      // start from the remote tip so remote changes to other files are kept
      if ((await this.remoteBranches()).includes(prefs.branchName)) await this.git(['reset', '-q', '--hard', `origin/${prefs.branchName}`]);
      const local = this.localFiles();
      const base = this.base();
      for (const s of selected) {
        const target = path.join(this.dir, s.file);
        const content = local.get(s.file)?.content;
        if (content === undefined) {
          if (existsSync(target)) unlinkSync(target);
          delete base[s.file];
        } else {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, content);
          base[s.file] = { l: hash(content), r: hash(content) };
        }
      }
      await this.git(['add', '-A', '--', ...new Set(selected.map((s) => s.file.split('/')[0]))]);
      const message = opts.commitMessage?.trim() || `Update ${selected.length} file${selected.length === 1 ? '' : 's'} from 8n8`;
      await this.git(['-c', `user.name=${prefs.authorName}`, '-c', `user.email=${prefs.authorEmail}`, 'commit', '-q', '--allow-empty', '-m', message]);
      await this.git(['push', '-q', 'origin', `HEAD:refs/heads/${prefs.branchName}`]);
      this.database.setSetting(BASE, base);
      const commit = (await this.git(['rev-parse', 'HEAD'])).trim();
      this.events?.emit('n8n.audit.source-control.pushed', { commit, files: selected.map((s) => s.file) });
      return { pushed: selected, commit };
    });
  }

  /* ---------------- pull ---------------- */

  pull(opts: { force?: boolean } = {}) {
    return this.exclusive(async () => {
      this.assertConnected();
      const status = (await this.status()).filter((s) => s.location === 'remote' || s.conflict);
      const conflicts = status.filter((s) => s.conflict);
      if (conflicts.length && !opts.force) throw new SourceControlError('Some files were changed locally too: push them or force pull to overwrite them', 409, conflicts);
      const branch = this.preferences().branchName;
      if ((await this.remoteBranches()).includes(branch)) await this.git(['reset', '-q', '--hard', `origin/${branch}`]);
      const base = this.base();
      const read = (file: string) => {
        const p = path.join(this.dir, file);
        return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
      };
      // folders first (workflows point at them), then tags, credentials, variables, workflows
      const order: FileType[] = ['folders', 'tags', 'credential', 'variables', 'workflow'];
      const sorted = [...status].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
      const reactivate: string[] = [];
      for (const s of sorted) {
        const content = read(s.file);
        if (content === undefined) {
          this.removeLocal(s);
          delete base[s.file];
          continue;
        }
        const data = JSON.parse(content);
        if (s.type === 'workflow') {
          if (this.importWorkflow(data)) reactivate.push(data.id);
        } else if (s.type === 'credential') this.importCredentialStub(data);
        else if (s.type === 'variables') this.importVariables(data);
        else if (s.type === 'tags') this.importTags(data);
        else if (s.type === 'folders') this.importFolders(data);
        base[s.file] = { r: hash(content) };
      }
      // the tag mapping refers to workflows, so it is applied again once they exist
      const tags = read('tags.json');
      if (tags && sorted.some((s) => s.type === 'workflow')) this.importTags(JSON.parse(tags));
      // what the imported state exports as, so it doesn't show up as a local change
      const local = this.localFiles();
      for (const s of sorted) if (base[s.file]) base[s.file].l = local.has(s.file) ? hash(local.get(s.file)!.content) : undefined;
      this.database.setSetting(BASE, base);
      for (const id of reactivate) {
        const wf = this.database.getWorkflow(id);
        if (wf?.active) await this.activeWorkflows?.add(wf, 'update').catch((e: Error) => console.error(`Workflow ${id} not reactivated: ${e.message}`));
      }
      this.events?.emit('n8n.audit.source-control.pulled', { files: sorted.map((s) => s.file) });
      return { pulled: sorted };
    });
  }

  /** Returns true when the workflow is active and needs re-registering. */
  private importWorkflow(data: WorkflowFile): boolean {
    const existing = this.database.getWorkflow(data.id);
    const fields = { name: data.name, nodes: data.nodes, connections: data.connections, settings: data.settings ?? {}, meta: data.meta, parentFolderId: data.parentFolderId ?? null, isArchived: false, pinData: existing?.pinData };
    if (existing) {
      this.database.updateWorkflow(data.id, fields);
      return existing.active;
    }
    this.database.createWorkflow({ id: data.id, ...fields });
    return false;
  }

  private importCredentialStub(data: { id: string; name: string; type: string; data: IDataObject }) {
    const existing = this.database.getCredential(data.id);
    if (existing) {
      // values stay local; only the name and expressions (secret references) come from git
      const current = this.credentials.getDecrypted(data.id);
      const { __type: _t, __name: _n, ...fields } = current;
      for (const [k, v] of Object.entries(data.data ?? {})) if (isExpression(v)) fields[k] = v;
      this.credentials.update(data.id, { name: data.name, data: fields });
    } else this.credentials.create(data.name, data.type, data.data ?? {}, data.id);
  }

  private importVariables(list: Array<{ id: string; key: string }>) {
    const existing = new Set(this.database.listVariables().map((v) => v.key));
    for (const v of list) if (!existing.has(v.key)) this.database.db.prepare('INSERT OR IGNORE INTO variables (id, key, value) VALUES (?,?,?)').run(v.id, v.key, '');
  }

  private importTags(data: { tags: Array<{ id: string; name: string }>; mappings: Array<{ workflowId: string; tagId: string }> }) {
    const ts = new Date().toISOString();
    for (const t of data.tags ?? []) {
      const byName = this.database.db.prepare('SELECT id FROM tags WHERE name = ?').get(t.name) as { id: string } | undefined;
      if (byName && byName.id !== t.id) continue;
      this.database.db.prepare('INSERT INTO tags (id, name, createdAt, updatedAt) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updatedAt = excluded.updatedAt').run(t.id, t.name, ts, ts);
    }
    const byWorkflow = new Map<string, string[]>();
    for (const m of data.mappings ?? []) byWorkflow.set(m.workflowId, [...(byWorkflow.get(m.workflowId) ?? []), m.tagId]);
    for (const [workflowId, tagIds] of byWorkflow) if (this.database.getWorkflow(workflowId)) this.database.setWorkflowTags(workflowId, tagIds);
  }

  private importFolders(data: { folders: Array<{ id: string; name: string; parentFolderId: string | null }> }) {
    const ts = new Date().toISOString();
    for (const f of data.folders ?? []) {
      this.database.db
        .prepare('INSERT INTO folders (id, name, parentFolderId, createdAt, updatedAt) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, parentFolderId = excluded.parentFolderId, updatedAt = excluded.updatedAt')
        .run(f.id, f.name, f.parentFolderId ?? null, ts, ts);
    }
  }

  /** A file deleted on the remote: workflows are archived (and deactivated), credentials are kept. */
  private removeLocal(s: StatusEntry) {
    if (s.type !== 'workflow') return;
    const wf = this.database.getWorkflow(s.id);
    if (!wf) return;
    if (wf.active) void this.activeWorkflows?.remove(wf.id);
    this.database.updateWorkflow(wf.id, { active: false, isArchived: true });
  }

  /** Remote version of one file next to the local one (for the diff view). */
  async diff(file: string) {
    this.assertConnected();
    const local = this.localFiles().get(file)?.content ?? null;
    const branch = this.preferences().branchName;
    const remote = await this.git(['show', `origin/${branch}:${file}`]).catch(() => null);
    return { file, local, remote };
  }

  /** Files currently checked out (for tests and debugging). */
  checkedOut() {
    if (!existsSync(path.join(this.dir, 'workflows'))) return [];
    return readdirSync(path.join(this.dir, 'workflows'));
  }
}

interface WorkflowFile {
  id: string;
  name: string;
  nodes: WorkflowEntity['nodes'];
  connections: WorkflowEntity['connections'];
  settings?: WorkflowEntity['settings'];
  meta?: WorkflowEntity['meta'];
  parentFolderId?: string | null;
  versionId?: string;
}

/** The repository form of a workflow: what defines it, not its local state (active, static and pinned data). */
export function workflowFile(wf: WorkflowEntity): WorkflowFile {
  return {
    id: wf.id,
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings,
    ...(wf.meta ? { meta: wf.meta } : {}),
    parentFolderId: wf.parentFolderId ?? null,
    versionId: wf.versionId,
  };
}
