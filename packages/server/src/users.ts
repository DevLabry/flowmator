import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { newId, type Database } from './db';

/**
 * Users, projects and what each project owns or has been given, in n8n's model:
 * every user has a personal project, team projects have members with a role, and
 * workflows and credentials belong to one project (owner) and can be shared with others.
 */
export const USERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  firstName TEXT,
  lastName TEXT,
  password TEXT,
  role TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  settings TEXT,
  lastActiveAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  icon TEXT,
  description TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_relations (
  projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (projectId, userId)
);
CREATE INDEX IF NOT EXISTS idx_project_relations_user ON project_relations (userId);
CREATE TABLE IF NOT EXISTS shared_workflows (
  workflowId TEXT NOT NULL,
  projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (workflowId, projectId)
);
CREATE INDEX IF NOT EXISTS idx_shared_workflows_project ON shared_workflows (projectId);
CREATE TABLE IF NOT EXISTS shared_credentials (
  credentialsId TEXT NOT NULL,
  projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (credentialsId, projectId)
);
CREATE INDEX IF NOT EXISTS idx_shared_credentials_project ON shared_credentials (projectId);
CREATE TABLE IF NOT EXISTS auth_tokens (
  tokenHash TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);
`;

export type GlobalRole = 'global:owner' | 'global:admin' | 'global:member';
export type ProjectRole = 'project:personalOwner' | 'project:admin' | 'project:editor' | 'project:viewer';
export type ProjectType = 'personal' | 'team';

export interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: GlobalRole;
  disabled: boolean;
  /** Invited users have no password until they accept */
  isPending: boolean;
  settings: Record<string, unknown>;
  lastActiveAt: string | null;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  type: ProjectType;
  icon: { type: string; value: string } | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export class UserError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
type Row = Record<string, unknown>;

/* ---------------- passwords ---------------- */

const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined) {
  const [scheme, salt, hash] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

/** Same rules as n8n: 8 to 64 characters with a number and a capital letter. */
export function checkPasswordStrength(password: unknown) {
  const p = String(password ?? '');
  if (p.length < 8 || p.length > 64) throw new UserError(400, 'Password must be 8 to 64 characters long');
  if (!/\d/.test(p)) throw new UserError(400, 'Password must contain at least 1 number');
  if (!/[A-Z]/.test(p)) throw new UserError(400, 'Password must contain at least 1 uppercase letter');
  return p;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function checkEmail(email: unknown) {
  const e = String(email ?? '').trim();
  if (!EMAIL.test(e)) throw new UserError(400, `Invalid email address: ${e || '(empty)'}`);
  return e;
}

/* ---------------- sessions (signed cookie, HS256 JWT) ---------------- */

export const AUTH_COOKIE = 'flowmator-auth';
const SESSION_DAYS = 7;

interface SessionClaims {
  id: string;
  /** Changes when the email or password changes, which signs out every other session */
  hash: string;
  exp: number;
}

export class Sessions {
  private readonly secret: Buffer;

  constructor(encryptionKey: string) {
    this.secret = createHmac('sha256', encryptionKey).update('flowmator-session').digest();
  }

  static fingerprint(email: string, passwordHash: string | null) {
    return sha256(`${email.toLowerCase()}:${passwordHash ?? ''}`).slice(0, 16);
  }

  issue(user: { id: string }, fingerprint: string, days = SESSION_DAYS) {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const claims: SessionClaims = { id: user.id, hash: fingerprint, exp: Math.floor(Date.now() / 1000) + days * 86400 };
    const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
    return { token: `${unsigned}.${createHmac('sha256', this.secret).update(unsigned).digest('base64url')}`, expires: new Date(claims.exp * 1000) };
  }

  verify(token: string | undefined): SessionClaims | null {
    const [header, payload, signature] = String(token ?? '').split('.');
    if (!header || !payload || !signature) return null;
    const expected = createHmac('sha256', this.secret).update(`${header}.${payload}`).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as SessionClaims;
      return claims.exp * 1000 > Date.now() ? claims : null;
    } catch {
      return null;
    }
  }
}

/* ---------------- users and projects ---------------- */

export class UserService {
  constructor(private readonly database: Database) {
    database.db.exec(USERS_SCHEMA);
    // data tables belong to a project since user management (folders and API keys: see Database)
    for (const [table, column] of [['data_tables', 'projectId']]) {
      const columns = database.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (columns.length && !columns.some((c) => c.name === column)) database.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
  }

  private get db() {
    return this.database.db;
  }

  private toUser(r: Row): User {
    return {
      id: r.id as string,
      email: r.email as string,
      firstName: (r.firstName as string) ?? null,
      lastName: (r.lastName as string) ?? null,
      role: r.role as GlobalRole,
      disabled: !!r.disabled,
      isPending: !r.password,
      settings: r.settings ? JSON.parse(r.settings as string) : {},
      lastActiveAt: (r.lastActiveAt as string) ?? null,
      createdAt: r.createdAt as string,
    };
  }

  private toProject(r: Row): Project {
    return {
      id: r.id as string,
      name: r.name as string,
      type: r.type as ProjectType,
      icon: r.icon ? JSON.parse(r.icon as string) : null,
      description: (r.description as string) ?? null,
      createdAt: r.createdAt as string,
      updatedAt: r.updatedAt as string,
    };
  }

  /* ----- users ----- */

  /** Until the owner signs up, the instance is open for the setup screen only. */
  isSetUp() {
    return !!this.db.prepare("SELECT 1 FROM users WHERE role = 'global:owner' AND password IS NOT NULL").get();
  }

  owner(): User | null {
    const r = this.db.prepare("SELECT * FROM users WHERE role = 'global:owner'").get() as Row | undefined;
    return r ? this.toUser(r) : null;
  }

  list(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY createdAt').all() as Row[]).map((r) => this.toUser(r));
  }

  get(id: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toUser(r) : null;
  }

  findByEmail(email: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as Row | undefined;
    return r ? this.toUser(r) : null;
  }

  passwordHash(id: string) {
    return (this.db.prepare('SELECT password FROM users WHERE id = ?').get(id) as { password: string | null } | undefined)?.password ?? null;
  }

  fingerprint(user: User) {
    return Sessions.fingerprint(user.email, this.passwordHash(user.id));
  }

  /** Creates the user and their personal project. */
  create(input: { email: string; firstName?: string | null; lastName?: string | null; password?: string | null; role: GlobalRole }): User {
    const email = checkEmail(input.email);
    if (this.findByEmail(email)) throw new UserError(400, `There is already a user with the email ${email}`);
    const id = newId();
    const at = now();
    this.database.transaction(() => {
      this.db
        .prepare('INSERT INTO users (id, email, firstName, lastName, password, role, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, email, input.firstName ?? null, input.lastName ?? null, input.password ? hashPassword(input.password) : null, input.role, at, at);
      const projectId = newId();
      this.db.prepare("INSERT INTO projects (id, name, type, createdAt, updatedAt) VALUES (?, ?, 'personal', ?, ?)").run(projectId, personalName({ email, firstName: input.firstName, lastName: input.lastName }), at, at);
      this.db.prepare("INSERT INTO project_relations (projectId, userId, role, createdAt) VALUES (?, ?, 'project:personalOwner', ?)").run(projectId, id, at);
    });
    return this.get(id)!;
  }

  update(id: string, input: { email?: string; firstName?: string | null; lastName?: string | null; password?: string; role?: GlobalRole; disabled?: boolean; settings?: Record<string, unknown> }): User {
    const current = this.get(id);
    if (!current) throw new UserError(404, 'User not found');
    const fields: Record<string, unknown> = {};
    if (input.email !== undefined && input.email !== current.email) {
      const email = checkEmail(input.email);
      const other = this.findByEmail(email);
      if (other && other.id !== id) throw new UserError(400, `There is already a user with the email ${email}`);
      fields.email = email;
    }
    if (input.firstName !== undefined) fields.firstName = input.firstName;
    if (input.lastName !== undefined) fields.lastName = input.lastName;
    if (input.password !== undefined) fields.password = hashPassword(checkPasswordStrength(input.password));
    if (input.role !== undefined) fields.role = input.role;
    if (input.disabled !== undefined) fields.disabled = input.disabled ? 1 : 0;
    if (input.settings !== undefined) fields.settings = JSON.stringify({ ...current.settings, ...input.settings });
    if (Object.keys(fields).length) {
      const keys = Object.keys(fields);
      this.db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updatedAt = ? WHERE id = ?`).run(...(keys.map((k) => fields[k]) as string[]), now(), id);
    }
    const user = this.get(id)!;
    // the personal project carries the user's name
    if (fields.email || fields.firstName !== undefined || fields.lastName !== undefined) {
      this.db.prepare('UPDATE projects SET name = ?, updatedAt = ? WHERE id = ?').run(personalName(user), now(), this.personalProject(id).id);
    }
    return user;
  }

  touch(id: string) {
    this.db.prepare('UPDATE users SET lastActiveAt = ? WHERE id = ?').run(now().slice(0, 10), id);
  }

  /**
   * Deletes a user and their personal project. What the project owned moves to `transferTo`
   * (another project), or is deleted with it.
   */
  delete(id: string, transferTo?: string): { deletedWorkflows: string[]; deletedCredentials: string[] } {
    const personal = this.personalProject(id);
    const result = this.transferOrDrop(personal.id, transferTo);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(personal.id);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return result;
  }

  /* ----- tokens (invitations and password resets) ----- */

  createToken(userId: string, type: 'invite' | 'reset', hours: number) {
    const token = randomBytes(24).toString('base64url');
    this.db.prepare('DELETE FROM auth_tokens WHERE userId = ? AND type = ?').run(userId, type);
    this.db.prepare('INSERT INTO auth_tokens (tokenHash, userId, type, expiresAt) VALUES (?, ?, ?, ?)').run(sha256(token), userId, type, new Date(Date.now() + hours * 3_600_000).toISOString());
    return token;
  }

  resolveToken(token: string, type: 'invite' | 'reset'): User | null {
    const r = this.db.prepare('SELECT userId, expiresAt FROM auth_tokens WHERE tokenHash = ? AND type = ?').get(sha256(String(token)), type) as { userId: string; expiresAt: string } | undefined;
    if (!r || r.expiresAt < now()) return null;
    return this.get(r.userId);
  }

  consumeToken(token: string) {
    this.db.prepare('DELETE FROM auth_tokens WHERE tokenHash = ?').run(sha256(String(token)));
  }

  /* ----- projects ----- */

  personalProject(userId: string): Project {
    const r = this.db.prepare("SELECT p.* FROM projects p JOIN project_relations r ON r.projectId = p.id WHERE r.userId = ? AND p.type = 'personal'").get(userId) as Row | undefined;
    if (!r) throw new UserError(404, 'Personal project not found');
    return this.toProject(r);
  }

  getProject(id: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toProject(r) : null;
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY type DESC, name COLLATE NOCASE").all() as Row[]).map((r) => this.toProject(r));
  }

  /** Projects the user is a member of, with their role in each. */
  projectsOf(userId: string): Array<Project & { role: ProjectRole }> {
    return (this.db.prepare('SELECT p.*, r.role AS memberRole FROM projects p JOIN project_relations r ON r.projectId = p.id WHERE r.userId = ? ORDER BY p.type DESC, p.name COLLATE NOCASE').all(userId) as Row[]).map((r) => ({
      ...this.toProject(r),
      role: r.memberRole as ProjectRole,
    }));
  }

  projectRole(userId: string, projectId: string): ProjectRole | null {
    return ((this.db.prepare('SELECT role FROM project_relations WHERE userId = ? AND projectId = ?').get(userId, projectId) as { role: ProjectRole } | undefined)?.role ?? null);
  }

  members(projectId: string): Array<{ id: string; email: string; firstName: string | null; lastName: string | null; role: ProjectRole }> {
    return (this.db.prepare('SELECT u.id, u.email, u.firstName, u.lastName, r.role FROM project_relations r JOIN users u ON u.id = r.userId WHERE r.projectId = ? ORDER BY u.email').all(projectId) as Row[]).map((r) => ({
      id: r.id as string,
      email: r.email as string,
      firstName: (r.firstName as string) ?? null,
      lastName: (r.lastName as string) ?? null,
      role: r.role as ProjectRole,
    }));
  }

  createTeamProject(name: string, creatorId: string, extra: { icon?: Project['icon']; description?: string } = {}): Project {
    const id = newId();
    const at = now();
    this.database.transaction(() => {
      this.db.prepare("INSERT INTO projects (id, name, type, icon, description, createdAt, updatedAt) VALUES (?, ?, 'team', ?, ?, ?, ?)").run(id, name.trim() || 'My project', extra.icon ? JSON.stringify(extra.icon) : null, extra.description ?? null, at, at);
      this.db.prepare("INSERT INTO project_relations (projectId, userId, role, createdAt) VALUES (?, ?, 'project:admin', ?)").run(id, creatorId, at);
    });
    return this.getProject(id)!;
  }

  updateProject(id: string, input: { name?: string; icon?: Project['icon']; description?: string | null; relations?: Array<{ userId: string; role: ProjectRole }> }) {
    const project = this.getProject(id);
    if (!project) throw new UserError(404, 'Project not found');
    if (project.type === 'personal' && (input.name !== undefined || input.relations)) throw new UserError(400, 'Personal projects cannot be renamed or shared');
    this.database.transaction(() => {
      if (input.name !== undefined) this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(input.name.trim() || project.name, id);
      if (input.icon !== undefined) this.db.prepare('UPDATE projects SET icon = ? WHERE id = ?').run(input.icon ? JSON.stringify(input.icon) : null, id);
      if (input.description !== undefined) this.db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(input.description, id);
      if (input.relations) {
        const valid: ProjectRole[] = ['project:admin', 'project:editor', 'project:viewer'];
        for (const r of input.relations) {
          if (!valid.includes(r.role)) throw new UserError(400, `Invalid project role ${r.role}`);
          if (!this.get(r.userId)) throw new UserError(400, `User ${r.userId} not found`);
        }
        this.db.prepare('DELETE FROM project_relations WHERE projectId = ?').run(id);
        const insert = this.db.prepare('INSERT INTO project_relations (projectId, userId, role, createdAt) VALUES (?, ?, ?, ?)');
        for (const r of input.relations) insert.run(id, r.userId, r.role, now());
      }
      this.db.prepare('UPDATE projects SET updatedAt = ? WHERE id = ?').run(now(), id);
    });
    return this.getProject(id)!;
  }

  deleteProject(id: string, transferTo?: string) {
    const project = this.getProject(id);
    if (!project) throw new UserError(404, 'Project not found');
    if (project.type === 'personal') throw new UserError(400, 'Personal projects are deleted with their user');
    const result = this.transferOrDrop(id, transferTo);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return result;
  }

  /** Moves what a project owns to another project, or returns what has to be deleted with it. */
  private transferOrDrop(projectId: string, transferTo?: string) {
    if (transferTo) {
      if (transferTo === projectId || !this.getProject(transferTo)) throw new UserError(400, 'Choose another project to transfer the data to');
      this.database.transaction(() => {
        for (const [table, key, ownerRole] of [
          ['shared_workflows', 'workflowId', 'workflow:owner'],
          ['shared_credentials', 'credentialsId', 'credential:owner'],
        ]) {
          // the destination may already have a share of the same item
          this.db.prepare(`DELETE FROM ${table} WHERE projectId = ? AND ${key} IN (SELECT ${key} FROM ${table} WHERE projectId = ? AND role = ?)`).run(transferTo, projectId, ownerRole);
          this.db.prepare(`UPDATE ${table} SET projectId = ? WHERE projectId = ? AND role = ?`).run(transferTo, projectId, ownerRole);
          this.db.prepare(`DELETE FROM ${table} WHERE projectId = ?`).run(projectId);
        }
        this.db.prepare('UPDATE folders SET projectId = ? WHERE projectId = ?').run(transferTo, projectId);
        this.db.prepare('UPDATE data_tables SET projectId = ? WHERE projectId = ?').run(transferTo, projectId);
      });
      return { deletedWorkflows: [], deletedCredentials: [] };
    }
    const owned = (table: string, key: string, role: string) => (this.db.prepare(`SELECT ${key} AS id FROM ${table} WHERE projectId = ? AND role = ?`).all(projectId, role) as Array<{ id: string }>).map((r) => r.id);
    return { deletedWorkflows: owned('shared_workflows', 'workflowId', 'workflow:owner'), deletedCredentials: owned('shared_credentials', 'credentialsId', 'credential:owner') };
  }
}

export function personalName(u: { email: string; firstName?: string | null; lastName?: string | null }) {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
  return name ? `${name} <${u.email}>` : u.email;
}
