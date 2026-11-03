import type { Database } from './db';
import { UserError, type Project, type ProjectRole, type User, type UserService } from './users';

export type ResourceKind = 'workflow' | 'credential';
export type WorkflowScope = 'read' | 'update' | 'delete' | 'execute' | 'share' | 'move';
export type CredentialScope = 'read' | 'update' | 'delete' | 'share' | 'move' | 'use';
export type ProjectScope = 'read' | 'update' | 'delete' | 'create';

const ALL_WORKFLOW: WorkflowScope[] = ['read', 'update', 'delete', 'execute', 'share', 'move'];
const ALL_CREDENTIAL: CredentialScope[] = ['read', 'update', 'delete', 'share', 'move', 'use'];
const ALL_PROJECT: ProjectScope[] = ['read', 'update', 'delete', 'create'];

/** What a project role allows on an item, by how the item is linked to the project. */
const WORKFLOW_SCOPES: Record<string, Partial<Record<ProjectRole, WorkflowScope[]>>> = {
  'workflow:owner': {
    'project:personalOwner': ALL_WORKFLOW,
    'project:admin': ALL_WORKFLOW,
    'project:editor': ['read', 'update', 'delete', 'execute'],
    'project:viewer': ['read'],
  },
  'workflow:editor': {
    'project:personalOwner': ['read', 'update', 'execute'],
    'project:admin': ['read', 'update', 'execute'],
    'project:editor': ['read', 'update', 'execute'],
    'project:viewer': ['read'],
  },
};
const CREDENTIAL_SCOPES: Record<string, Partial<Record<ProjectRole, CredentialScope[]>>> = {
  'credential:owner': {
    'project:personalOwner': ALL_CREDENTIAL,
    'project:admin': ALL_CREDENTIAL,
    'project:editor': ['read', 'update', 'delete', 'use'],
    'project:viewer': ['read'],
  },
  'credential:user': {
    'project:personalOwner': ['read', 'use'],
    'project:admin': ['read', 'use'],
    'project:editor': ['read', 'use'],
    'project:viewer': ['read'],
  },
};
const PROJECT_SCOPES: Record<ProjectRole, ProjectScope[]> = {
  'project:personalOwner': ['read', 'create'],
  'project:admin': ALL_PROJECT,
  'project:editor': ['read', 'create'],
  'project:viewer': ['read'],
};

const TABLES = {
  workflow: { table: 'shared_workflows', key: 'workflowId', owner: 'workflow:owner', shared: 'workflow:editor' },
  credential: { table: 'shared_credentials', key: 'credentialsId', owner: 'credential:owner', shared: 'credential:user' },
} as const;

export const isAdmin = (user: Pick<User, 'role'>) => user.role === 'global:owner' || user.role === 'global:admin';

export class AccessError extends UserError {}
const forbidden = (what: string) => new AccessError(403, `You don't have permission to ${what}`);

/**
 * Who can see and do what. Owners and admins can do everything; members get what their
 * projects allow on the items those projects own or were shared.
 */
export class AccessService {
  constructor(
    private readonly database: Database,
    readonly users: UserService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /* ----- ownership and sharing ----- */

  homeProject(kind: ResourceKind, id: string): Project | null {
    const t = TABLES[kind];
    const r = this.db.prepare(`SELECT projectId FROM ${t.table} WHERE ${t.key} = ? AND role = ?`).get(id, t.owner) as { projectId: string } | undefined;
    return r ? this.users.getProject(r.projectId) : null;
  }

  sharedWith(kind: ResourceKind, id: string): Project[] {
    const t = TABLES[kind];
    const rows = this.db.prepare(`SELECT projectId FROM ${t.table} WHERE ${t.key} = ? AND role = ?`).all(id, t.shared) as Array<{ projectId: string }>;
    return rows.map((r) => this.users.getProject(r.projectId)).filter((p): p is Project => !!p);
  }

  setOwner(kind: ResourceKind, id: string, projectId: string) {
    const t = TABLES[kind];
    this.database.transaction(() => {
      this.db.prepare(`DELETE FROM ${t.table} WHERE ${t.key} = ? AND (role = ? OR projectId = ?)`).run(id, t.owner, projectId);
      this.db.prepare(`INSERT INTO ${t.table} (${t.key}, projectId, role, createdAt) VALUES (?, ?, ?, ?)`).run(id, projectId, t.owner, new Date().toISOString());
    });
  }

  /** Replaces the projects an item is shared with (its home project is left out). */
  share(kind: ResourceKind, id: string, projectIds: string[]) {
    const t = TABLES[kind];
    const home = this.homeProject(kind, id);
    for (const p of projectIds) if (!this.users.getProject(p)) throw new UserError(400, `Project ${p} not found`);
    this.database.transaction(() => {
      this.db.prepare(`DELETE FROM ${t.table} WHERE ${t.key} = ? AND role = ?`).run(id, t.shared);
      const insert = this.db.prepare(`INSERT INTO ${t.table} (${t.key}, projectId, role, createdAt) VALUES (?, ?, ?, ?)`);
      for (const p of new Set(projectIds)) if (p !== home?.id) insert.run(id, p, t.shared, new Date().toISOString());
    });
  }

  forget(kind: ResourceKind, id: string) {
    const t = TABLES[kind];
    this.db.prepare(`DELETE FROM ${t.table} WHERE ${t.key} = ?`).run(id);
  }

  /**
   * Gives everything that has no project (from before user management, CLI imports, source
   * control pulls) to the owner's personal project.
   */
  claimOrphans() {
    const owner = this.users.owner();
    if (!owner) return;
    const home = this.users.personalProject(owner.id).id;
    const at = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO shared_workflows (workflowId, projectId, role, createdAt) SELECT id, ?, 'workflow:owner', ? FROM workflows WHERE id NOT IN (SELECT workflowId FROM shared_workflows WHERE role = 'workflow:owner')`)
      .run(home, at);
    this.db
      .prepare(`INSERT INTO shared_credentials (credentialsId, projectId, role, createdAt) SELECT id, ?, 'credential:owner', ? FROM credentials WHERE id NOT IN (SELECT credentialsId FROM shared_credentials WHERE role = 'credential:owner')`)
      .run(home, at);
    this.db.prepare('UPDATE folders SET projectId = ? WHERE projectId IS NULL').run(home);
    this.db.prepare('UPDATE data_tables SET projectId = ? WHERE projectId IS NULL').run(home);
    // shares of items that no longer exist
    this.db.prepare('DELETE FROM shared_workflows WHERE workflowId NOT IN (SELECT id FROM workflows)').run();
    this.db.prepare('DELETE FROM shared_credentials WHERE credentialsId NOT IN (SELECT id FROM credentials)').run();
  }

  /**
   * `flowmator user-management:reset`: back to a single owner who has to be set up again.
   * Other users, team projects and shares go; every workflow, credential, folder and data table
   * ends up in the owner's personal project. Returns how many users were removed.
   */
  reset() {
    const owner = this.users.owner();
    const removed = (this.db.prepare("SELECT COUNT(*) AS c FROM users WHERE role != 'global:owner'").get() as { c: number }).c;
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM shared_workflows; DELETE FROM shared_credentials; DELETE FROM auth_tokens;');
      this.db.exec('UPDATE folders SET projectId = NULL; UPDATE data_tables SET projectId = NULL;');
      if (owner) {
        const home = this.users.personalProject(owner.id).id;
        this.db.prepare('DELETE FROM projects WHERE id != ?').run(home);
        this.db.prepare('DELETE FROM api_keys WHERE userId IS NOT NULL AND userId != ?').run(owner.id);
        this.db.prepare("DELETE FROM users WHERE role != 'global:owner'").run();
        this.db.prepare('UPDATE users SET password = NULL, firstName = NULL, lastName = NULL WHERE id = ?').run(owner.id);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.claimOrphans();
    return removed;
  }

  /* ----- scopes ----- */

  /** Each (project role, link role) pair the user has on an item. */
  private links(kind: ResourceKind, user: User, id: string) {
    const t = TABLES[kind];
    return this.db
      .prepare(`SELECT r.role AS projectRole, s.role AS linkRole FROM ${t.table} s JOIN project_relations r ON r.projectId = s.projectId WHERE s.${t.key} = ? AND r.userId = ?`)
      .all(id, user.id) as Array<{ projectRole: ProjectRole; linkRole: string }>;
  }

  workflowScopes(user: User, workflowId: string): WorkflowScope[] {
    if (isAdmin(user)) return ALL_WORKFLOW;
    return [...new Set(this.links('workflow', user, workflowId).flatMap((l) => WORKFLOW_SCOPES[l.linkRole]?.[l.projectRole] ?? []))];
  }

  credentialScopes(user: User, credentialId: string): CredentialScope[] {
    if (isAdmin(user)) return ALL_CREDENTIAL;
    return [...new Set(this.links('credential', user, credentialId).flatMap((l) => CREDENTIAL_SCOPES[l.linkRole]?.[l.projectRole] ?? []))];
  }

  projectScopes(user: User, projectId: string): ProjectScope[] {
    const project = this.users.getProject(projectId);
    if (!project) return [];
    if (isAdmin(user)) return project.type === 'personal' ? ['read', 'create'] : ALL_PROJECT;
    const role = this.users.projectRole(user.id, projectId);
    return role ? PROJECT_SCOPES[role] : [];
  }

  requireWorkflow(user: User, workflowId: string, scope: WorkflowScope) {
    const scopes = this.workflowScopes(user, workflowId);
    // 404 when the user can't see it at all, so ids of other people's workflows don't leak
    if (!scopes.length) throw new AccessError(404, `Workflow with ID "${workflowId}" not found`);
    if (!scopes.includes(scope)) throw forbidden(`${scope} this workflow`);
  }

  requireCredential(user: User, credentialId: string, scope: CredentialScope) {
    const scopes = this.credentialScopes(user, credentialId);
    if (!scopes.length) throw new AccessError(404, 'Credential not found');
    if (!scopes.includes(scope)) throw forbidden(`${scope} this credential`);
  }

  requireProject(user: User, projectId: string, scope: ProjectScope) {
    const scopes = this.projectScopes(user, projectId);
    if (!scopes.length) throw new AccessError(404, 'Project not found');
    if (!scopes.includes(scope)) throw forbidden(scope === 'create' ? 'create items in this project' : `${scope} this project`);
  }

  requireAdmin(user: User) {
    if (!isAdmin(user)) throw forbidden('do this (owners and admins only)');
  }

  /** Ids of the items the user can see; undefined means all of them. */
  visible(kind: ResourceKind, user: User, projectId?: string): Set<string> | undefined {
    const t = TABLES[kind];
    if (projectId) {
      return new Set((this.db.prepare(`SELECT ${t.key} AS id FROM ${t.table} WHERE projectId = ?`).all(projectId) as Array<{ id: string }>).map((r) => r.id));
    }
    if (isAdmin(user)) return undefined;
    const rows = this.db.prepare(`SELECT DISTINCT s.${t.key} AS id FROM ${t.table} s JOIN project_relations r ON r.projectId = s.projectId WHERE r.userId = ?`).all(user.id) as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  /** Projects the user can see (all of them for owners and admins). */
  visibleProjects(user: User) {
    if (isAdmin(user)) return this.users.listProjects();
    return this.users.projectsOf(user.id);
  }

  /** Home project id of every item of a kind, for list views. */
  homeProjects(kind: ResourceKind) {
    const t = TABLES[kind];
    const rows = this.db.prepare(`SELECT ${t.key} AS id, projectId FROM ${t.table} WHERE role = ?`).all(t.owner) as Array<{ id: string; projectId: string }>;
    return new Map(rows.map((r) => [r.id, r.projectId]));
  }

  sharesOf(kind: ResourceKind) {
    const t = TABLES[kind];
    const map = new Map<string, string[]>();
    for (const r of this.db.prepare(`SELECT ${t.key} AS id, projectId FROM ${t.table} WHERE role = ?`).all(t.shared) as Array<{ id: string; projectId: string }>) {
      map.set(r.id, [...(map.get(r.id) ?? []), r.projectId]);
    }
    return map;
  }

  /**
   * A workflow may only use credentials its home project can use (owned or shared with it).
   * Workflows without a home project (no user management yet) can use any.
   */
  canUseCredential(workflowId: string | undefined, credentialId: string) {
    if (!workflowId || !this.users.isSetUp()) return true;
    const home = this.homeProject('workflow', workflowId);
    if (!home) return true;
    return !!this.db.prepare('SELECT 1 FROM shared_credentials WHERE credentialsId = ? AND projectId = ?').get(credentialId, home.id);
  }

  /** Users that can see a workflow, for live editor events. */
  canSeeWorkflow(userId: string, workflowId: string) {
    const user = this.users.get(userId);
    return !!user && this.workflowScopes(user, workflowId).length > 0;
  }

  /** Data table / folder ownership checks: the user needs the project scope of the item's project. */
  requireProjectItem(user: User, table: 'folders' | 'data_tables', id: string, scope: ProjectScope) {
    const r = this.db.prepare(`SELECT projectId FROM ${table} WHERE id = ?`).get(id) as { projectId: string | null } | undefined;
    if (!r) return;
    if (r.projectId) this.requireProject(user, r.projectId, scope);
    else this.requireAdmin(user);
  }

  projectItems(table: 'folders' | 'data_tables', user: User, projectId?: string): Set<string> | undefined {
    if (projectId) return new Set((this.db.prepare(`SELECT id FROM ${table} WHERE projectId = ?`).all(projectId) as Array<{ id: string }>).map((r) => r.id));
    if (isAdmin(user)) return undefined;
    const rows = this.db.prepare(`SELECT t.id FROM ${table} t JOIN project_relations r ON r.projectId = t.projectId WHERE r.userId = ?`).all(user.id) as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  setItemProject(table: 'folders' | 'data_tables', id: string, projectId: string) {
    this.db.prepare(`UPDATE ${table} SET projectId = ? WHERE id = ?`).run(projectId, id);
  }
}
