import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src';
import { OWNER, signIn } from './auth-helper';

let app: App;
let dir: string;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

/** Calls the API as one of the users ('' = signed out). */
async function as(who: string, method: string, url: string, payload?: unknown) {
  const res = await app.app.inject({ method: method as 'GET', url, payload: payload as never, headers: { cookie: who ? cookies[who] : '' } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, cookie: res.headers['set-cookie'] ? String(res.headers['set-cookie']).split(';')[0] : undefined };
}

async function inviteAndAccept(name: string, role: 'global:member' | 'global:admin' = 'global:member') {
  const invited = await as('owner', 'POST', '/rest/invitations', [{ email: `${name}@test.dev`, role }]);
  expect(invited.status).toBe(200);
  const token = new URL(invited.body.data[0].user.inviteAcceptUrl).searchParams.get('token')!;
  const accepted = await as('', 'POST', `/rest/invitations/${token}/accept`, { firstName: name, lastName: 'Test', password: 'Passw0rd!' });
  expect(accepted.status).toBe(200);
  cookies[name] = accepted.cookie!;
  ids[name] = accepted.body.data.id;
  return token;
}

const workflow = (name: string, projectId?: string) => ({
  name,
  nodes: [{ id: 'start', name: 'Start', type: 'flowmator.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
  connections: {},
  ...(projectId ? { projectId } : {}),
});

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'flowmator-users-'));
  app = await createApp({ userFolder: dir, port: 0, webhookUrl: 'http://localhost:5678/', encryptionKey: 'test-key' });
  cookies.owner = await signIn(app);
});

afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('sign-in', () => {
  it('rejects REST calls without a session but keeps settings public', async () => {
    expect((await as('', 'GET', '/rest/workflows')).status).toBe(401);
    expect((await as('', 'GET', '/rest/settings')).status).toBe(200);
  });

  it('sets up the owner only once', async () => {
    expect((await as('', 'POST', '/rest/owner/setup', OWNER)).status).toBe(400);
  });

  it('logs in with the right password only', async () => {
    expect((await as('', 'POST', '/rest/login', { emailOrLdapLoginId: OWNER.email, password: 'wrong' })).status).toBe(401);
    const ok = await as('', 'POST', '/rest/login', { emailOrLdapLoginId: OWNER.email.toUpperCase(), password: OWNER.password });
    expect(ok.status).toBe(200);
    expect(ok.body.data.role).toBe('global:owner');
    expect((await as('', 'GET', '/rest/login')).status).toBe(401);
  });

  it('invites users with a link and refuses weak passwords and reused links', async () => {
    const invited = await as('owner', 'POST', '/rest/invitations', [{ email: 'weak@test.dev' }]);
    const token = new URL(invited.body.data[0].user.inviteAcceptUrl).searchParams.get('token')!;
    expect(invited.body.data[0].user.emailSent).toBe(false);
    expect((await as('', 'GET', `/rest/invitations/${token}`)).body.data.email).toBe('weak@test.dev');
    expect((await as('', 'POST', `/rest/invitations/${token}/accept`, { password: 'short' })).status).toBe(400);

    const used = await inviteAndAccept('alice');
    await inviteAndAccept('bob');
    await inviteAndAccept('carol', 'global:admin');
    expect((await as('', 'POST', `/rest/invitations/${used}/accept`, { password: 'Passw0rd!' })).status).toBe(404);
    expect((await as('alice', 'GET', '/rest/login')).body.data.email).toBe('alice@test.dev');
  });

  it('keeps instance settings for owners and admins', async () => {
    expect((await as('alice', 'POST', '/rest/invitations', [{ email: 'x@test.dev' }])).status).toBe(403);
    expect((await as('alice', 'POST', '/rest/variables', { key: 'k', value: 'v' })).status).toBe(403);
    expect((await as('alice', 'GET', '/rest/variables')).status).toBe(200);
    expect((await as('alice', 'GET', '/rest/eventbus/destination')).status).toBe(403);
    expect((await as('carol', 'POST', '/rest/variables', { key: 'admin_var', value: 'v' })).status).toBe(200);
  });
});

describe('workflow sharing', () => {
  let wfId: string;

  it("puts new workflows in the creator's personal project, hidden from other members", async () => {
    const created = await as('alice', 'POST', '/rest/workflows', workflow('Alice flow'));
    expect(created.status).toBe(200);
    wfId = created.body.data.id;
    expect(created.body.data.homeProject.type).toBe('personal');
    expect(created.body.data.scopes).toContain('share');

    expect((await as('bob', 'GET', `/rest/workflows/${wfId}`)).status).toBe(404);
    expect((await as('bob', 'GET', '/rest/workflows')).body.data.map((w: { id: string }) => w.id)).not.toContain(wfId);
    // owners and admins see everything
    expect((await as('owner', 'GET', `/rest/workflows/${wfId}`)).status).toBe(200);
    expect((await as('carol', 'GET', '/rest/workflows')).body.data.map((w: { id: string }) => w.id)).toContain(wfId);
  });

  it('lets the people it is shared with edit but not delete or reshare it', async () => {
    const bobProject = (await as('bob', 'GET', '/rest/projects/personal')).body.data.id;
    expect((await as('bob', 'PUT', `/rest/workflows/${wfId}/share`, { shareWithIds: [bobProject] })).status).toBe(404);
    const shared = await as('alice', 'PUT', `/rest/workflows/${wfId}/share`, { shareWithIds: [bobProject] });
    expect(shared.body.data.sharedWithProjects.map((p: { id: string }) => p.id)).toEqual([bobProject]);

    expect((await as('bob', 'PATCH', `/rest/workflows/${wfId}`, { name: 'Renamed by Bob' })).status).toBe(200);
    expect((await as('bob', 'DELETE', `/rest/workflows/${wfId}`)).status).toBe(403);
    expect((await as('bob', 'PUT', `/rest/workflows/${wfId}/share`, { shareWithIds: [] })).status).toBe(403);
    expect((await as('bob', 'POST', `/rest/workflows/${wfId}/run?wait=true`, {})).status).toBe(200);

    await as('alice', 'PUT', `/rest/workflows/${wfId}/share`, { shareWithIds: [] });
    expect((await as('bob', 'GET', `/rest/workflows/${wfId}`)).status).toBe(404);
  });

  it('filters executions by the workflows the user can see', async () => {
    await as('alice', 'POST', `/rest/workflows/${wfId}/run?wait=true`, {});
    const own = await as('alice', 'GET', '/rest/executions');
    expect(own.body.data.results.length).toBeGreaterThan(0);
    expect((await as('bob', 'GET', '/rest/executions')).body.data.results).toEqual([]);
    const execId = own.body.data.results[0].id;
    expect((await as('bob', 'GET', `/rest/executions/${execId}`)).status).toBe(404);
  });
});

describe('team projects', () => {
  let teamId: string;
  let wfId: string;

  it('only lets owners and admins create them', async () => {
    expect((await as('alice', 'POST', '/rest/projects', { name: 'Team' })).status).toBe(403);
    const team = await as('owner', 'POST', '/rest/projects', { name: 'Team' });
    expect(team.status).toBe(200);
    teamId = team.body.data.id;
    const updated = await as('owner', 'PATCH', `/rest/projects/${teamId}`, {
      relations: [
        { userId: ids.alice, role: 'project:editor' },
        { userId: ids.bob, role: 'project:viewer' },
      ],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.relations.map((r: { role: string }) => r.role).sort()).toEqual(['project:editor', 'project:viewer']);
  });

  it('gives editors and viewers their scopes', async () => {
    const created = await as('alice', 'POST', '/rest/workflows', workflow('Team flow', teamId));
    expect(created.status).toBe(200);
    wfId = created.body.data.id;
    expect(created.body.data.homeProject.id).toBe(teamId);

    expect((await as('bob', 'GET', `/rest/workflows/${wfId}`)).body.data.scopes).toEqual(['read']);
    expect((await as('bob', 'PATCH', `/rest/workflows/${wfId}`, { name: 'x' })).status).toBe(403);
    expect((await as('bob', 'POST', '/rest/workflows', workflow('Viewer flow', teamId))).status).toBe(403);
    expect((await as('bob', 'GET', `/rest/workflows?projectId=${teamId}`)).body.data.map((w: { id: string }) => w.id)).toEqual([wfId]);
    // editors can't change the members
    expect((await as('alice', 'PATCH', `/rest/projects/${teamId}`, { name: 'Mine' })).status).toBe(403);
  });

  it('moves workflows between projects', async () => {
    const own = await as('alice', 'POST', '/rest/workflows', workflow('To move'));
    const moved = await as('alice', 'PUT', `/rest/workflows/${own.body.data.id}/transfer`, { destinationProjectId: teamId });
    expect(moved.body.data.homeProject.id).toBe(teamId);
    expect((await as('bob', 'GET', `/rest/workflows/${own.body.data.id}`)).status).toBe(200);
    // a member can't move things into a personal project that isn't theirs
    const bobProject = (await as('bob', 'GET', '/rest/projects/personal')).body.data.id;
    const another = (await as('alice', 'POST', '/rest/workflows', workflow('Stays'))).body.data.id;
    expect((await as('alice', 'PUT', `/rest/workflows/${another}/transfer`, { destinationProjectId: bobProject })).status).toBe(404);
    // editors of a team project can't move its workflows out
    expect((await as('alice', 'PUT', `/rest/workflows/${wfId}/transfer`, { destinationProjectId: bobProject })).status).toBe(403);
  });

  it('keeps folders and data tables in their project', async () => {
    const folder = await as('alice', 'POST', '/rest/folders', { name: 'Team folder', projectId: teamId });
    expect(folder.body.data.projectId).toBe(teamId);
    expect((await as('bob', 'GET', `/rest/folders?projectId=${teamId}`)).body.data.map((f: { id: string }) => f.id)).toEqual([folder.body.data.id]);
    expect((await as('bob', 'DELETE', `/rest/folders/${folder.body.data.id}`)).status).toBe(403);

    const table = await as('alice', 'POST', '/rest/data-tables', { name: 'alice_table', columns: [{ name: 'a', type: 'string' }] });
    expect(table.status).toBe(200);
    expect((await as('bob', 'GET', `/rest/data-tables/${table.body.data.id}`)).status).toBe(404);
    expect((await as('bob', 'GET', '/rest/data-tables')).body.data.map((t: { id: string }) => t.id)).not.toContain(table.body.data.id);
  });
});

describe('credentials', () => {
  it('can only be used by workflows of the projects that own or share them', async () => {
    const cred = await as('alice', 'POST', '/rest/credentials', { name: 'Alice key', type: 'httpHeaderAuth', data: { name: 'x', value: 'secret' } });
    expect(cred.status).toBe(200);
    const credId = cred.body.data.id;
    const bobProject = (await as('bob', 'GET', '/rest/projects/personal')).body.data.id;
    const bobFlow = (await as('bob', 'POST', '/rest/workflows', workflow('Bob flow'))).body.data.id;

    expect((await as('bob', 'GET', `/rest/credentials/${credId}`)).status).toBe(404);
    expect(app.ctx.access.canUseCredential(bobFlow, credId)).toBe(false);

    await as('alice', 'PUT', `/rest/credentials/${credId}/share`, { shareWithIds: [bobProject] });
    expect(app.ctx.access.canUseCredential(bobFlow, credId)).toBe(true);
    const seen = await as('bob', 'GET', `/rest/credentials/${credId}?includeData=true`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.data).toBeUndefined();
    expect((await as('bob', 'PATCH', `/rest/credentials/${credId}`, { name: 'x' })).status).toBe(403);
  });
});

describe('users', () => {
  it('lets admins reset passwords, ending the old sessions', async () => {
    const link = await as('carol', 'GET', `/rest/users/${ids.bob}/password-reset-link`);
    const token = new URL(link.body.data.link).searchParams.get('token')!;
    const changed = await as('', 'POST', '/rest/change-password', { token, password: 'NewPassw0rd' });
    expect(changed.status).toBe(200);
    expect((await as('bob', 'GET', '/rest/workflows')).status).toBe(401);
    cookies.bob = changed.cookie!;
    expect((await as('bob', 'GET', '/rest/workflows')).status).toBe(200);
  });

  it('deletes users, moving their work to another user', async () => {
    const bobFlows = (await as('bob', 'GET', '/rest/workflows')).body.data.filter((w: { homeProject: { type: string } }) => w.homeProject.type === 'personal');
    expect(bobFlows.length).toBe(1);
    expect((await as('alice', 'DELETE', `/rest/users/${ids.bob}`)).status).toBe(403);
    expect((await as('owner', 'DELETE', `/rest/users/${ids.bob}?transferId=${(await as('alice', 'GET', '/rest/projects/personal')).body.data.id}`)).status).toBe(200);
    expect((await as('bob', 'GET', '/rest/workflows')).status).toBe(401);
    expect((await as('alice', 'GET', `/rest/workflows/${bobFlows[0].id}`)).status).toBe(200);
  });

  it('gives each user their own public API keys', async () => {
    const key = (await as('alice', 'POST', '/rest/api-keys', { label: 'cli' })).body.data.apiKey;
    expect((await as('owner', 'GET', '/rest/api-keys')).body.data).toEqual([]);
    const res = await app.app.inject({ method: 'GET', url: '/api/v1/workflows', headers: { 'x-n8n-api-key': key, cookie: '' } });
    const names = (JSON.parse(res.body).data as Array<{ name: string }>).map((w) => w.name);
    expect(names).toContain('To move');
    expect(names).not.toContain('Admin only');
  });
});

describe('user-management:reset', () => {
  it('keeps everything for the owner, who sets up again', async () => {
    const before = (await as('owner', 'GET', '/rest/workflows')).body.data.length;
    // alice, carol and the pending invitee
    expect(app.ctx.access.reset()).toBe(3);
    expect((await as('alice', 'GET', '/rest/workflows')).status).toBe(401);
    expect((await as('owner', 'GET', '/rest/workflows')).status).toBe(401);
    expect((await as('', 'GET', '/rest/login')).status).toBe(401);

    const setup = await as('', 'POST', '/rest/owner/setup', { ...OWNER, email: 'new-owner@test.dev' });
    expect(setup.status).toBe(200);
    cookies.owner = setup.cookie!;
    const after = await as('owner', 'GET', '/rest/workflows');
    expect(after.body.data.length).toBe(before);
    expect(new Set(after.body.data.map((w: { homeProject: { type: string } }) => w.homeProject.type))).toEqual(new Set(['personal']));
    expect((await as('owner', 'GET', '/rest/projects')).body.data).toHaveLength(1);
  });
});
