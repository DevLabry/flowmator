import { Copy, Ellipsis, KeyRound, Link2, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Modal, Popover } from '../components/ui';
import { Api, type GlobalRole, type User } from '../lib/api';
import { errorToast, useApp } from '../store/app';
import { ROLE_LABELS, displayName, useAuth } from '../store/auth';
import { passwordProblem } from './Auth';

/** The server keeps the day of last activity (YYYY-MM-DD). */
function lastActive(day: string | null) {
  if (!day) return '—';
  const today = new Date().toISOString().slice(0, 10);
  if (day.slice(0, 10) === today) return 'Today';
  return new Date(`${day.slice(0, 10)}T12:00:00`).toLocaleDateString();
}

const copy = (text: string, what: string) => {
  navigator.clipboard.writeText(text).then(
    () => useApp.getState().toast('success', `${what} copied`),
    () => prompt(`Copy the ${what.toLowerCase()}`, text),
  );
};

/** Owners and admins: invite people, change roles, hand out reset links, remove users. */
export function UsersPage() {
  const me = useAuth((s) => s.user)!;
  const smtpSetup = useAuth((s) => s.smtpSetup);
  const [users, setUsers] = useState<User[]>([]);
  const [inviting, setInviting] = useState(false);
  const [deleting, setDeleting] = useState<User | null>(null);
  const refresh = useCallback(() => {
    Api.users().then(setUsers, errorToast('Could not load users'));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <div className="page-header">
        <h1>Users</h1>
        <button className="primary" onClick={() => setInviting(true)}><Plus size={14} /> Invite</button>
      </div>
      {!smtpSetup && <div className="card muted" style={{ padding: 12, marginBottom: 14 }}>Email isn't set up (N8N_EMAIL_MODE=smtp), so invitations and password resets give you a link to send yourself.</div>}
      <div className="card">
        <table className="list">
          <thead><tr><th>User</th><th>Role</th><th>Projects</th><th>Last active</th><th style={{ width: 40 }} /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <div style={{ fontWeight: 500 }}>{u.isPending ? u.email : displayName(u)} {u.id === me.id && <span className="faint">(you)</span>}</div>
                  {!u.isPending && <div className="faint" style={{ fontSize: 12 }}>{u.email}</div>}
                </td>
                <td>
                  {u.isOwner || u.id === me.id ? (
                    <span className="badge">{ROLE_LABELS[u.role]}</span>
                  ) : (
                    <select style={{ width: 120 }} value={u.role} onChange={(e) => Api.setUserRole(u.id, e.target.value as GlobalRole).then(refresh, errorToast('Could not change role'))}>
                      <option value="global:member">Member</option>
                      <option value="global:admin">Admin</option>
                    </select>
                  )}
                  {u.isPending && <span className="badge warning" style={{ marginLeft: 6 }}>Pending</span>}
                </td>
                <td className="muted">{(u.projectRelations ?? []).map((p) => p.name).join(', ') || '—'}</td>
                <td className="muted">{lastActive(u.lastActiveAt)}</td>
                <td>{!u.isOwner && u.id !== me.id && <UserMenu user={u} onDelete={() => setDeleting(u)} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {inviting && <InviteModal onClose={() => { setInviting(false); refresh(); }} />}
      {deleting && <DeleteUserModal user={deleting} users={users} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); refresh(); }} />}
    </div>
  );
}

function UserMenu({ user, onDelete }: { user: User; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button className="ghost icon sm" onClick={() => setOpen(!open)}><Ellipsis size={15} /></button>
      <Popover open={open} onClose={() => setOpen(false)} style={{ right: 0, top: 28 }}>
        {user.isPending ? (
          <button onClick={async () => {
            setOpen(false);
            const res = await Api.reinvite(user.id).catch(errorToast('Could not create the link'));
            if (res) res.emailSent ? useApp.getState().toast('success', `Invitation sent to ${user.email}`) : copy(res.inviteAcceptUrl, 'Invitation link');
          }}><Link2 size={14} /> Copy invitation link</button>
        ) : (
          <button onClick={async () => {
            setOpen(false);
            const res = await Api.passwordResetLink(user.id).catch(errorToast('Could not create the link'));
            if (res) copy(res.link, 'Password reset link');
          }}><KeyRound size={14} /> Copy password reset link</button>
        )}
        <hr />
        <button className="danger" onClick={() => { setOpen(false); onDelete(); }}><Trash2 size={14} /> Delete user</button>
      </Popover>
    </div>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<GlobalRole>('global:member');
  const [links, setLinks] = useState<Array<{ email: string; url: string; emailSent: boolean }> | null>(null);
  const [busy, setBusy] = useState(false);
  const invite = async () => {
    const list = emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
    if (!list.length) return;
    setBusy(true);
    try {
      const res = await Api.invite(list.map((email) => ({ email, role })));
      setLinks(res.map((r) => ({ email: r.user.email, url: r.user.inviteAcceptUrl, emailSent: r.user.emailSent })));
    } catch (e) {
      errorToast('Could not invite')(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Invite users" onClose={onClose} width={560} footer={links ? <button className="primary" onClick={onClose}>Done</button> : <><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !emails.trim()} onClick={invite}>Invite</button></>}>
      {links ? (
        <div className="col">
          {links.map((l) => (
            <div key={l.email} className="row share-row">
              <span className="grow col" style={{ gap: 0 }}><strong>{l.email}</strong><span className="faint ellipsis" style={{ maxWidth: 360 }}>{l.emailSent ? 'Invitation emailed' : l.url}</span></span>
              <button className="sm" onClick={() => copy(l.url, 'Invitation link')}><Copy size={12} /> Copy link</button>
            </div>
          ))}
          <div className="faint">Links are valid for 7 days.</div>
        </div>
      ) : (
        <>
          <label className="col" style={{ gap: 4 }}><span className="field-label">Emails</span><textarea autoFocus rows={3} placeholder="ana@example.com, luis@example.com" value={emails} onChange={(e) => setEmails(e.target.value)} /></label>
          <label className="col" style={{ gap: 4 }}>
            <span className="field-label">Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value as GlobalRole)}>
              <option value="global:member">Member: their own workflows and what is shared with them</option>
              <option value="global:admin">Admin: everything, including users and settings</option>
            </select>
          </label>
        </>
      )}
    </Modal>
  );
}

function DeleteUserModal({ user, users, onClose, onDeleted }: { user: User; users: User[]; onClose: () => void; onDeleted: () => void }) {
  const [mode, setMode] = useState<'transfer' | 'delete'>('transfer');
  const [target, setTarget] = useState('');
  const others = users.filter((u) => u.id !== user.id && !u.isPending && u.personalProjectId);
  const remove = async () => {
    try {
      await Api.deleteUser(user.id, mode === 'transfer' ? others.find((u) => u.id === target)?.personalProjectId ?? undefined : undefined);
      useApp.getState().toast('success', `${user.email} deleted`);
      onDeleted();
    } catch (e) {
      errorToast('Could not delete user')(e);
    }
  };
  return (
    <Modal title={`Delete ${user.email}`} onClose={onClose} width={480} footer={<><button onClick={onClose}>Cancel</button><button className="danger" disabled={mode === 'transfer' && !target} onClick={remove}>Delete user</button></>}>
      {user.isPending ? (
        <div className="muted">The invitation stops working.</div>
      ) : (
        <>
          <div className="muted">What should happen to the workflows and credentials in their personal project?</div>
          <label className="row"><input type="radio" checked={mode === 'transfer'} onChange={() => setMode('transfer')} /> Give them to another user</label>
          {mode === 'transfer' && (
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose a user…</option>
              {others.map((u) => <option key={u.id} value={u.id}>{displayName(u)} ({u.email})</option>)}
            </select>
          )}
          <label className="row"><input type="radio" checked={mode === 'delete'} onChange={() => setMode('delete')} /> Delete them</label>
        </>
      )}
    </Modal>
  );
}

/** Everyone: name, email and password. */
export function PersonalSettingsPage() {
  const me = useAuth((s) => s.user)!;
  const [form, setForm] = useState({ firstName: me.firstName ?? '', lastName: me.lastName ?? '', email: me.email, currentPassword: '' });
  const [pw, setPw] = useState({ current: '', next: '' });
  const emailChanged = form.email.trim().toLowerCase() !== me.email.toLowerCase();
  const saveProfile = async () => {
    try {
      const user = await Api.updateMe({ firstName: form.firstName, lastName: form.lastName, email: form.email, ...(emailChanged ? { currentPassword: form.currentPassword } : {}) });
      useAuth.setState({ user: { ...me, ...user } });
      setForm({ ...form, currentPassword: '' });
      useApp.getState().toast('success', 'Profile saved');
    } catch (e) {
      errorToast('Could not save')(e);
    }
  };
  const savePassword = async () => {
    const problem = passwordProblem(pw.next);
    if (problem) return useApp.getState().toast('error', 'Choose a stronger password', problem);
    try {
      await Api.updateMyPassword(pw.current, pw.next);
      setPw({ current: '', next: '' });
      useApp.getState().toast('success', 'Password changed', 'Your other sessions were signed out');
    } catch (e) {
      errorToast('Could not change password')(e);
    }
  };
  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <div className="page-header"><h1>Personal settings</h1></div>
      <section className="card col" style={{ padding: 18, marginBottom: 18 }}>
        <h2>Profile</h2>
        <div className="row">
          <label className="col grow" style={{ gap: 4 }}><span className="field-label">First name</span><input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></label>
          <label className="col grow" style={{ gap: 4 }}><span className="field-label">Last name</span><input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></label>
        </div>
        <label className="col" style={{ gap: 4 }}><span className="field-label">Email</span><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        {emailChanged && <label className="col" style={{ gap: 4 }}><span className="field-label">Current password (to change your email)</span><input type="password" autoComplete="current-password" value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} /></label>}
        <div><button className="primary" onClick={saveProfile}>Save</button></div>
      </section>
      <section className="card col" style={{ padding: 18 }}>
        <h2>Password</h2>
        <label className="col" style={{ gap: 4 }}><span className="field-label">Current password</span><input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
        <label className="col" style={{ gap: 4 }}><span className="field-label">New password</span><input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></label>
        <div className="faint">8+ characters, at least one number and one uppercase letter. Your other sessions are signed out.</div>
        <div><button className="primary" disabled={!pw.current || !pw.next} onClick={savePassword}>Change password</button></div>
      </section>
    </div>
  );
}
