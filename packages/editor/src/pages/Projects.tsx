import { Layers, Trash2, User as UserIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { Modal } from '../components/ui';
import { Api, type Project, type ProjectRole, type User } from '../lib/api';
import { errorToast, useApp } from '../store/app';
import { ROLE_LABELS, displayName, projectLabel, useAuth } from '../store/auth';
import { CredentialsPage } from './Credentials';
import { WorkflowsPage } from './Workflows';

const TEAM_ROLES: ProjectRole[] = ['project:admin', 'project:editor', 'project:viewer'];

/** /projects/:id/(workflows|credentials|settings); `personal` stands for the user's own project. */
export function ProjectPage({ tab }: { tab: 'workflows' | 'credentials' | 'settings' }) {
  const params = useParams();
  const personalId = useAuth((s) => s.user?.personalProjectId);
  const id = params.id === 'personal' ? personalId! : params.id!;
  const [project, setProject] = useState<Project | null>(null);
  const navigate = useNavigate();
  const load = useCallback(() => {
    Api.project(id).then(setProject, (e) => {
      errorToast('Could not open project')(e);
      navigate('/home/workflows');
    });
  }, [id, navigate]);
  useEffect(load, [load]);

  if (!project || project.id !== id) return null;
  const base = `/projects/${params.id}`;
  const canCreate = project.scopes.includes('create');
  const Icon = project.type === 'team' ? Layers : UserIcon;
  return (
    <div className="col" style={{ flex: 1, minHeight: 0, gap: 0 }}>
      <div className="project-header">
        <div className="row">
          <Icon size={18} />
          <h1>{projectLabel(project)}</h1>
          {project.role && project.type === 'team' && <span className="badge">{ROLE_LABELS[project.role]}</span>}
        </div>
        {project.description && <div className="muted">{project.description}</div>}
        <div className="tabs" style={{ marginTop: 12 }}>
          <NavLink to={`${base}/workflows`}>Workflows</NavLink>
          <NavLink to={`${base}/credentials`}>Credentials</NavLink>
          {project.type === 'team' && project.scopes.includes('update') && <NavLink to={`${base}/settings`}>Project settings</NavLink>}
        </div>
      </div>
      {tab === 'workflows' && <WorkflowsPage projectId={id} canCreate={canCreate} />}
      {tab === 'credentials' && <CredentialsPage projectId={id} canCreate={canCreate} />}
      {tab === 'settings' && <ProjectSettings project={project} onChange={load} />}
    </div>
  );
}

function ProjectSettings({ project, onChange }: { project: Project; onChange: () => void }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [relations, setRelations] = useState(() => (project.relations ?? []).map((r) => ({ userId: r.id, role: r.role })));
  const [users, setUsers] = useState<User[]>([]);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    Api.users().then(setUsers, errorToast('Could not load users'));
  }, []);
  const byId = new Map(users.map((u) => [u.id, u]));
  const candidates = users.filter((u) => !u.isPending && !relations.some((r) => r.userId === u.id));

  const save = async () => {
    try {
      await Api.updateProject(project.id, { name, description: description || null, relations });
      useApp.getState().toast('success', 'Project saved');
      await useAuth.getState().refreshProjects();
      onChange();
    } catch (e) {
      errorToast('Could not save project')(e);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <section className="card col" style={{ padding: 18, marginBottom: 18 }}>
        <h2>Project</h2>
        <label className="col" style={{ gap: 4 }}><span className="field-label">Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="col" style={{ gap: 4 }}><span className="field-label">Description</span><textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      </section>

      <section className="card col" style={{ padding: 18, marginBottom: 18 }}>
        <h2>Members</h2>
        <div className="muted">Admins manage the project and its members, editors create and edit its workflows and credentials, viewers only look.</div>
        <select value="" onChange={(e) => e.target.value && setRelations([...relations, { userId: e.target.value, role: 'project:editor' }])}>
          <option value="">Add a member…</option>
          {candidates.map((u) => <option key={u.id} value={u.id}>{displayName(u)} ({u.email})</option>)}
        </select>
        {relations.map((r) => {
          const u = byId.get(r.userId);
          return (
            <div key={r.userId} className="row share-row">
              <span className="grow col" style={{ gap: 0 }}>
                <strong>{u ? displayName(u) : r.userId}</strong>
                {u && <span className="faint">{u.email}</span>}
              </span>
              <select style={{ width: 130 }} value={r.role} onChange={(e) => setRelations(relations.map((x) => (x.userId === r.userId ? { ...x, role: e.target.value as ProjectRole } : x)))}>
                {TEAM_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
              </select>
              <button className="ghost icon sm danger" title="Remove from project" onClick={() => setRelations(relations.filter((x) => x.userId !== r.userId))}><Trash2 size={13} /></button>
            </div>
          );
        })}
        {!relations.length && <div className="faint">No members yet. Owners and admins of the instance can always open it.</div>}
      </section>

      <div className="row" style={{ marginBottom: 28 }}>
        <button className="primary" onClick={save}>Save</button>
        <span className="grow" />
        {project.scopes.includes('delete') && <button className="danger" onClick={() => setDeleting(true)}><Trash2 size={14} /> Delete project</button>}
      </div>
      {deleting && <DeleteProjectModal project={project} onClose={() => setDeleting(false)} onDeleted={() => navigate('/home/workflows')} />}
    </div>
  );
}

function DeleteProjectModal({ project, onClose, onDeleted }: { project: Project; onClose: () => void; onDeleted: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [mode, setMode] = useState<'transfer' | 'delete'>('transfer');
  const [target, setTarget] = useState('');
  useEffect(() => {
    Api.projects().then((list) => setProjects(list.filter((p) => p.id !== project.id && p.scopes.includes('create'))), errorToast('Could not load projects'));
  }, [project.id]);
  const remove = async () => {
    try {
      await Api.deleteProject(project.id, mode === 'transfer' ? target : undefined);
      await useAuth.getState().refreshProjects();
      useApp.getState().toast('success', `Project “${project.name}” deleted`);
      onDeleted();
    } catch (e) {
      errorToast('Could not delete project')(e);
    }
  };
  return (
    <Modal title={`Delete “${project.name}”`} onClose={onClose} width={480} footer={<><button onClick={onClose}>Cancel</button><button className="danger" disabled={mode === 'transfer' && !target} onClick={remove}>Delete project</button></>}>
      <div className="muted">What should happen to its workflows, credentials, folders and data tables?</div>
      <label className="row"><input type="radio" checked={mode === 'transfer'} onChange={() => setMode('transfer')} /> Move them to another project</label>
      {mode === 'transfer' && (
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose a project…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{projectLabel(p)}</option>)}
        </select>
      )}
      <label className="row"><input type="radio" checked={mode === 'delete'} onChange={() => setMode('delete')} /> Delete them</label>
    </Modal>
  );
}

/** Admins: a new team project, then its settings to name it and add members (as n8n does). */
export async function createTeamProject(navigate: (to: string) => void) {
  try {
    const project = await Api.createProject('My project');
    await useAuth.getState().refreshProjects();
    navigate(`/projects/${project.id}/settings`);
  } catch (e) {
    errorToast('Could not create project')(e);
  }
}
