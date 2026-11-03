import { ArrowRightLeft, Layers, Share2, User as UserIcon, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Api, type Project, type ProjectRef, type Sharing, type User } from '../lib/api';
import { displayName, projectLabel, useAuth } from '../store/auth';
import { errorToast, useApp } from '../store/app';
import { Modal } from './ui';

/** "Personal", a team name or another user's name, with the matching icon. */
export function ProjectBadge({ project, shared }: { project?: ProjectRef | null; shared?: number }) {
  if (!project) return null;
  const Icon = project.type === 'team' ? Layers : UserIcon;
  return (
    <span className="badge" title={shared ? `Shared with ${shared} more project${shared === 1 ? '' : 's'}` : undefined}>
      <Icon size={11} /> {projectLabel(project)}
      {!!shared && <span className="faint">+{shared}</span>}
    </span>
  );
}

type Kind = 'workflows' | 'credentials';
interface Item extends Sharing {
  id?: string;
  name: string;
}

const KIND_LABEL: Record<Kind, string> = { workflows: 'workflow', credentials: 'credential' };

/** Who can be shared with: other users (their personal projects) and team projects. */
function useShareTargets() {
  const [users, setUsers] = useState<User[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    Api.users().then(setUsers, errorToast('Could not load users'));
    Api.projects().then(setProjects, errorToast('Could not load projects'));
  }, []);
  const targets: ProjectRef[] = [
    ...users.filter((u) => u.personalProjectId).map((u) => ({ id: u.personalProjectId!, name: displayName(u), type: 'personal' as const, icon: null })),
    ...projects.filter((p) => p.type === 'team'),
  ];
  return { targets, projects };
}

/**
 * Workflows shared with a project can be edited by its members; credentials shared with a project can be used
 * by its workflows. Only the owning project can share, move or delete.
 */
export function ShareModal({ kind, item, onClose, onChange }: { kind: Kind; item: Item; onClose: () => void; onChange?: (s: Sharing) => void }) {
  const { targets } = useShareTargets();
  const [selected, setSelected] = useState<string[]>(() => (item.sharedWithProjects ?? []).map((p) => p.id));
  const [busy, setBusy] = useState(false);
  const canShare = item.scopes?.includes('share');
  const home = item.homeProject?.id;
  const options = targets.filter((t) => t.id !== home && !selected.includes(t.id));
  const byId = new Map(targets.map((t) => [t.id, t]));
  for (const p of item.sharedWithProjects ?? []) if (!byId.has(p.id)) byId.set(p.id, p);

  const save = async () => {
    setBusy(true);
    try {
      const res = await Api.share(kind, item.id!, selected);
      onChange?.(res);
      useApp.getState().toast('success', `Sharing of “${item.name}” saved`);
      onClose();
    } catch (e) {
      errorToast('Could not share')(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={<span className="row" style={{ gap: 8 }}><Share2 size={16} /> Share “{item.name}”</span>}
      onClose={onClose}
      width={520}
      footer={canShare ? <><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={save}>Save</button></> : <button onClick={onClose}>Close</button>}
    >
      <div className="muted">
        {kind === 'workflows'
          ? 'People you share with can open, edit and run this workflow. Only its owner can share, move or delete it.'
          : 'Workflows of the projects you share with can use this credential. People there can’t see or edit its secrets.'}
      </div>
      <div className="row"><span className="grow faint">Owner</span><ProjectBadge project={item.homeProject} /></div>
      {canShare && (
        <select value="" onChange={(e) => e.target.value && setSelected([...selected, e.target.value])}>
          <option value="">Add users or projects…</option>
          {options.map((t) => <option key={t.id} value={t.id}>{t.type === 'team' ? `▣ ${t.name}` : t.name}</option>)}
        </select>
      )}
      <div className="col" style={{ gap: 4 }}>
        {selected.map((id) => (
          <div key={id} className="row share-row">
            <span className="grow"><ProjectBadge project={byId.get(id) ?? { id, name: id, type: 'team', icon: null }} /></span>
            <span className="faint">{kind === 'workflows' ? 'Editor' : 'User'}</span>
            {canShare && <button className="ghost icon sm" title="Stop sharing" onClick={() => setSelected(selected.filter((x) => x !== id))}><X size={13} /></button>}
          </div>
        ))}
        {!selected.length && <div className="faint">Not shared with anyone.</div>}
      </div>
    </Modal>
  );
}

/** Moves a workflow or credential to another project the user can create in. */
export function MoveModal({ kind, item, onClose, onChange }: { kind: Kind; item: Item; onClose: () => void; onChange?: (s: Sharing) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Api.projects().then((list) => setProjects(list.filter((p) => p.scopes.includes('create') && p.id !== item.homeProject?.id)), errorToast('Could not load projects'));
  }, [item.homeProject?.id]);
  const move = async () => {
    setBusy(true);
    try {
      const res = await Api.transfer(kind, item.id!, target);
      onChange?.(res);
      useApp.getState().toast('success', `“${item.name}” moved to ${projectLabel(res.homeProject!)}`);
      onClose();
    } catch (e) {
      errorToast('Could not move')(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={<span className="row" style={{ gap: 8 }}><ArrowRightLeft size={16} /> Move “{item.name}”</span>}
      onClose={onClose}
      width={480}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!target || busy} onClick={move}>Move {KIND_LABEL[kind]}</button></>}
    >
      <div className="row"><span className="grow faint">Currently in</span><ProjectBadge project={item.homeProject} /></div>
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">Choose a project…</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{projectLabel(p)}</option>)}
      </select>
      <div className="faint">
        {kind === 'workflows'
          ? 'Members of the new project get access. Credentials it uses must be owned by or shared with that project, or its nodes will fail.'
          : 'Workflows of other projects keep using it only if it is shared with them.'}
      </div>
    </Modal>
  );
}

/** Which project new things go to: the one in the URL, else the personal project. */
export function useCurrentProjectId(projectId?: string) {
  const personal = useAuth((s) => s.user?.personalProjectId);
  return projectId ?? personal;
}
