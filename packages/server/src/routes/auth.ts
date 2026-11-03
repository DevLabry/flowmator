import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAdmin } from '../access';
import type { AppContext } from '../context';
import { Mailer } from '../mailer';
import { AUTH_COOKIE, Sessions, UserError, checkPasswordStrength, personalName, verifyPassword, type GlobalRole, type ProjectRole, type User } from '../users';
import { HttpError } from './errors';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user (set by the auth hook on /rest routes) */
    user: User | null;
  }
}

/** Routes anyone can call: signing in, the owner setup, invitations and password resets. */
const PUBLIC: Array<[string, RegExp]> = [
  ['*', /^\/rest\/login$/],
  ['POST', /^\/rest\/logout$/],
  ['POST', /^\/rest\/owner\/setup$/],
  ['GET', /^\/rest\/settings$/],
  ['POST', /^\/rest\/forgot-password$/],
  ['GET', /^\/rest\/resolve-password-token$/],
  ['POST', /^\/rest\/change-password$/],
  ['GET', /^\/rest\/invitations\/[^/]+$/],
  ['POST', /^\/rest\/invitations\/[^/]+\/accept$/],
  ['GET', /^\/rest\/oauth2-credential\/callback$/],
  // authenticates itself (WebSocket upgrade)
  ['GET', /^\/rest\/push$/],
];

export function cookieValue(req: FastifyRequest, name: string) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Public shape of a user: no password hash. */
export const publicUser = (u: User) => ({ ...u, isOwner: u.role === 'global:owner', fullName: [u.firstName, u.lastName].filter(Boolean).join(' ') || null });

const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX_FAILURES = 5;

export function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { users, access, config } = ctx;
  const sessions = new Sessions(config.encryptionKey);
  const mailer = new Mailer();
  const editorUrl = () => (process.env.N8N_EDITOR_BASE_URL || config.webhookUrl).replace(/\/?$/, '/');
  const secureCookie = process.env.N8N_SECURE_COOKIE ? process.env.N8N_SECURE_COOKIE === 'true' : config.protocol === 'https';

  const setCookie = (reply: FastifyReply, user: User) => {
    const { token, expires } = sessions.issue(user, users.fingerprint(user));
    reply.header('set-cookie', `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secureCookie ? '; Secure' : ''}`);
  };
  const clearCookie = (reply: FastifyReply) => reply.header('set-cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

  /** The session's user, if the cookie is valid and still matches their email and password. */
  const sessionUser = (req: FastifyRequest): User | null => {
    const claims = sessions.verify(cookieValue(req, AUTH_COOKIE));
    if (!claims) return null;
    const user = users.get(claims.id);
    if (!user || user.disabled || user.isPending || users.fingerprint(user) !== claims.hash) return null;
    return user;
  };
  ctx.sessionUser = sessionUser;

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/rest/')) return;
    req.user = sessionUser(req);
    if (req.user) {
      if (req.user.lastActiveAt !== new Date().toISOString().slice(0, 10)) users.touch(req.user.id);
      return;
    }
    if (PUBLIC.some(([method, re]) => (method === '*' || method === req.method) && re.test(path))) return;
    return reply.code(401).send({ code: 401, message: 'Unauthorized' });
  });

  const errors = <T>(fn: () => T) => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof UserError) throw new HttpError(e.statusCode, e.message);
      throw e;
    }
  };
  const me = (req: FastifyRequest) => {
    if (!req.user) throw new HttpError(401, 'Unauthorized');
    return req.user;
  };
  const withProject = (u: User) => ({ ...publicUser(u), personalProjectId: users.personalProject(u.id).id });

  /* ----- sign in ----- */

  const failures = new Map<string, { count: number; since: number }>();
  app.get('/rest/login', async (req) => {
    if (!req.user) throw new HttpError(401, 'Unauthorized');
    return { data: withProject(req.user) };
  });
  app.post('/rest/login', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; emailOrLdapLoginId?: string; password?: string };
    const email = String(body.emailOrLdapLoginId ?? body.email ?? '').trim().toLowerCase();
    const key = `${req.ip}|${email}`;
    const f = failures.get(key);
    if (f && f.count >= LOGIN_MAX_FAILURES && Date.now() - f.since < LOGIN_WINDOW_MS) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const user = email ? users.findByEmail(email) : null;
    if (!user || user.disabled || !verifyPassword(String(body.password ?? ''), users.passwordHash(user.id))) {
      const fresh = !f || Date.now() - f.since >= LOGIN_WINDOW_MS;
      failures.set(key, { count: fresh ? 1 : f!.count + 1, since: fresh ? Date.now() : f!.since });
      throw new HttpError(401, 'Wrong username or password. Do you have caps lock on?');
    }
    failures.delete(key);
    setCookie(reply, user);
    users.touch(user.id);
    return { data: withProject(users.get(user.id)!) };
  });
  app.post('/rest/logout', async (_req, reply) => {
    clearCookie(reply);
    return { data: { loggedOut: true } };
  });

  /* ----- first owner ----- */

  app.post('/rest/owner/setup', async (req, reply) => {
    if (users.isSetUp()) throw new HttpError(400, 'The instance owner is already set up');
    const body = (req.body ?? {}) as { email?: string; firstName?: string; lastName?: string; password?: string };
    const password = errors(() => checkPasswordStrength(body.password));
    const existing = users.owner();
    const owner = errors(() =>
      existing
        ? users.update(existing.id, { email: body.email, firstName: body.firstName ?? null, lastName: body.lastName ?? null, password })
        : users.create({ email: String(body.email ?? ''), firstName: body.firstName, lastName: body.lastName, password, role: 'global:owner' }),
    );
    // everything created before user management belongs to the owner
    access.claimOrphans();
    setCookie(reply, owner);
    return { data: withProject(owner) };
  });

  /* ----- me ----- */

  app.patch('/rest/me', async (req, reply) => {
    const user = me(req);
    const body = (req.body ?? {}) as { email?: string; firstName?: string; lastName?: string; currentPassword?: string };
    if (body.email !== undefined && body.email.trim().toLowerCase() !== user.email.toLowerCase() && !verifyPassword(String(body.currentPassword ?? ''), users.passwordHash(user.id))) {
      throw new HttpError(400, 'Enter your current password to change your email');
    }
    const updated = errors(() => users.update(user.id, { email: body.email, firstName: body.firstName, lastName: body.lastName }));
    setCookie(reply, updated);
    return { data: withProject(updated) };
  });
  app.patch('/rest/me/password', async (req, reply) => {
    const user = me(req);
    const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    if (!verifyPassword(String(currentPassword ?? ''), users.passwordHash(user.id))) throw new HttpError(400, 'Your current password is wrong');
    const updated = errors(() => users.update(user.id, { password: newPassword }));
    // other sessions end; this one gets a fresh cookie
    setCookie(reply, updated);
    return { data: withProject(updated) };
  });
  app.patch('/rest/me/settings', async (req) => ({ data: withProject(users.update(me(req).id, { settings: (req.body ?? {}) as Record<string, unknown> })) }));

  /* ----- users ----- */

  app.get('/rest/users', async (req) => {
    const viewer = me(req);
    return {
      data: users.list().map((u) => ({
        ...publicUser(u),
        // sharing with a user means sharing with their personal project
        personalProjectId: u.isPending ? null : users.personalProject(u.id).id,
        // members see who they can share with; owners and admins also see roles in projects
        ...(isAdmin(viewer) ? { projectRelations: users.projectsOf(u.id).filter((p) => p.type === 'team').map((p) => ({ id: p.id, name: p.name, role: p.role })) } : {}),
      })),
    };
  });

  const inviteLink = (token: string) => `${editorUrl()}signup?token=${encodeURIComponent(token)}`;
  const resetLink = (token: string) => `${editorUrl()}change-password?token=${encodeURIComponent(token)}`;

  const invite = async (inviter: User, email: string, role: GlobalRole) => {
    const user = errors(() => users.create({ email, role }));
    const link = inviteLink(users.createToken(user.id, 'invite', 24 * 7));
    const emailSent = await mailer
      .send(user.email, `${personalName(inviter)} invited you to Flowmator`, 'You have been invited to Flowmator. Open this link to set your password:', link)
      .catch((e: Error) => (console.error(`Invitation email to ${user.email} failed: ${e.message}`), false));
    return { user: { id: user.id, email: user.email, inviteAcceptUrl: link, emailSent } };
  };

  app.post('/rest/invitations', async (req) => {
    const inviter = me(req);
    access.requireAdmin(inviter);
    const list = (Array.isArray(req.body) ? req.body : [req.body]) as Array<{ email: string; role?: GlobalRole }>;
    const out = [];
    for (const item of list) {
      const role = item.role ?? 'global:member';
      if (role !== 'global:member' && role !== 'global:admin') throw new HttpError(400, `Invalid role ${role}`);
      out.push(await invite(inviter, item.email, role));
    }
    return { data: out };
  });
  app.get('/rest/invitations/:token', async (req) => {
    const user = users.resolveToken((req.params as { token: string }).token, 'invite');
    if (!user || !user.isPending) throw new HttpError(404, 'This invitation is no longer valid. Ask for a new one.');
    return { data: { email: user.email } };
  });
  app.post('/rest/invitations/:token/accept', async (req, reply) => {
    const { token } = req.params as { token: string };
    const user = users.resolveToken(token, 'invite');
    if (!user || !user.isPending) throw new HttpError(404, 'This invitation is no longer valid. Ask for a new one.');
    const body = (req.body ?? {}) as { firstName?: string; lastName?: string; password?: string };
    const updated = errors(() => users.update(user.id, { firstName: body.firstName ?? null, lastName: body.lastName ?? null, password: checkPasswordStrength(body.password) }));
    users.consumeToken(token);
    setCookie(reply, updated);
    return { data: withProject(updated) };
  });
  app.post('/rest/users/:id/reinvite', async (req) => {
    access.requireAdmin(me(req));
    const user = users.get((req.params as { id: string }).id);
    if (!user || !user.isPending) throw new HttpError(400, 'Only pending users can be invited again');
    const link = inviteLink(users.createToken(user.id, 'invite', 24 * 7));
    const emailSent = await mailer.send(user.email, 'Your invitation to Flowmator', 'You have been invited to Flowmator. Open this link to set your password:', link).catch(() => false);
    return { data: { inviteAcceptUrl: link, emailSent } };
  });

  app.patch('/rest/users/:id/role', async (req) => {
    const actor = me(req);
    access.requireAdmin(actor);
    const target = users.get((req.params as { id: string }).id);
    if (!target) throw new HttpError(404, 'User not found');
    const role = (req.body as { newRoleName?: GlobalRole })?.newRoleName;
    if (role !== 'global:admin' && role !== 'global:member') throw new HttpError(400, 'The role must be global:admin or global:member');
    if (target.role === 'global:owner') throw new HttpError(400, "The owner's role cannot be changed");
    return { data: publicUser(users.update(target.id, { role })) };
  });

  app.delete('/rest/users/:id', async (req) => {
    const actor = me(req);
    access.requireAdmin(actor);
    const target = users.get((req.params as { id: string }).id);
    if (!target) throw new HttpError(404, 'User not found');
    if (target.role === 'global:owner') throw new HttpError(400, 'The owner cannot be deleted');
    if (target.id === actor.id) throw new HttpError(400, 'You cannot delete yourself');
    const transferId = (req.query as { transferId?: string }).transferId || undefined;
    const { deletedWorkflows, deletedCredentials } = errors(() => users.delete(target.id, transferId));
    for (const id of deletedWorkflows) await ctx.deleteWorkflow(id);
    for (const id of deletedCredentials) ctx.credentials.delete(id);
    return { data: true };
  });

  /* ----- password reset ----- */

  app.get('/rest/users/:id/password-reset-link', async (req) => {
    access.requireAdmin(me(req));
    const user = users.get((req.params as { id: string }).id);
    if (!user || user.isPending) throw new HttpError(404, 'User not found');
    return { data: { link: resetLink(users.createToken(user.id, 'reset', 24)) } };
  });
  app.post('/rest/forgot-password', async (req) => {
    if (!mailer.enabled) throw new HttpError(400, 'Email is not set up on this instance. Ask an admin for a password reset link.');
    const user = users.findByEmail(String((req.body as { email?: string })?.email ?? ''));
    // same answer whether or not the email exists
    if (user && !user.isPending && !user.disabled) {
      await mailer.send(user.email, 'Reset your Flowmator password', 'Open this link to choose a new password. It is valid for 24 hours.', resetLink(users.createToken(user.id, 'reset', 24))).catch((e: Error) => console.error(`Password reset email failed: ${e.message}`));
    }
    return { data: true };
  });
  app.get('/rest/resolve-password-token', async (req) => {
    if (!users.resolveToken(String((req.query as { token?: string }).token ?? ''), 'reset')) throw new HttpError(404, 'This password reset link is no longer valid');
    return { data: true };
  });
  app.post('/rest/change-password', async (req, reply) => {
    const { token, password } = (req.body ?? {}) as { token?: string; password?: string };
    const user = users.resolveToken(String(token ?? ''), 'reset');
    if (!user) throw new HttpError(404, 'This password reset link is no longer valid');
    const updated = errors(() => users.update(user.id, { password: checkPasswordStrength(password) }));
    users.consumeToken(String(token));
    setCookie(reply, updated);
    return { data: withProject(updated) };
  });

  /* ----- projects ----- */

  const projectView = (user: User, projectId: string) => {
    const project = users.getProject(projectId)!;
    return { ...project, relations: users.members(projectId), scopes: access.projectScopes(user, projectId), role: users.projectRole(user.id, projectId) };
  };

  app.get('/rest/projects', async (req) => {
    const user = me(req);
    return { data: access.visibleProjects(user).map((p) => ({ ...p, role: users.projectRole(user.id, p.id), scopes: access.projectScopes(user, p.id) })) };
  });
  app.get('/rest/projects/my-projects', async (req) => {
    const user = me(req);
    return { data: users.projectsOf(user.id).map((p) => ({ ...p, scopes: access.projectScopes(user, p.id) })) };
  });
  app.get('/rest/projects/personal', async (req) => {
    const user = me(req);
    return { data: projectView(user, users.personalProject(user.id).id) };
  });
  app.post('/rest/projects', async (req) => {
    const user = me(req);
    access.requireAdmin(user);
    const body = (req.body ?? {}) as { name?: string; icon?: { type: string; value: string }; description?: string };
    const project = users.createTeamProject(String(body.name ?? ''), user.id, body);
    return { data: projectView(user, project.id) };
  });
  app.get('/rest/projects/:id', async (req) => {
    const user = me(req);
    const { id } = req.params as { id: string };
    errors(() => access.requireProject(user, id, 'read'));
    return { data: projectView(user, id) };
  });
  app.patch('/rest/projects/:id', async (req) => {
    const user = me(req);
    const { id } = req.params as { id: string };
    errors(() => access.requireProject(user, id, 'update'));
    const body = (req.body ?? {}) as { name?: string; icon?: { type: string; value: string } | null; description?: string | null; relations?: Array<{ userId: string; role: ProjectRole }> };
    errors(() => users.updateProject(id, body));
    return { data: projectView(user, id) };
  });
  app.delete('/rest/projects/:id', async (req) => {
    const user = me(req);
    const { id } = req.params as { id: string };
    errors(() => access.requireProject(user, id, 'delete'));
    const transferId = (req.query as { transferId?: string }).transferId || undefined;
    if (transferId) errors(() => access.requireProject(user, transferId, 'create'));
    const { deletedWorkflows, deletedCredentials } = errors(() => users.deleteProject(id, transferId));
    for (const wid of deletedWorkflows) await ctx.deleteWorkflow(wid);
    for (const cid of deletedCredentials) ctx.credentials.delete(cid);
    return { data: true };
  });
}
