import { ArrowRightLeft, Ellipsis, Plus, Share2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CredentialModal } from '../components/CredentialModal';
import { MoveModal, ProjectBadge, ShareModal } from '../components/Sharing';
import { Modal, Popover, timeAgo } from '../components/ui';
import { Api, type CredentialSummary } from '../lib/api';
import { errorToast, useApp } from '../store/app';

function RowMenu({ c, refresh }: { c: CredentialSummary; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<'share' | 'move' | null>(null);
  const can = (scope: string) => !!c.scopes?.includes(scope);
  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button className="ghost icon sm" onClick={() => setOpen(!open)}><Ellipsis size={15} /></button>
      <Popover open={open} onClose={() => setOpen(false)} style={{ right: 0, top: 28 }}>
        <button onClick={() => { setOpen(false); setModal('share'); }}><Share2 size={14} /> Share…</button>
        <button disabled={!can('move')} onClick={() => { setOpen(false); setModal('move'); }}><ArrowRightLeft size={14} /> Move to project…</button>
        <hr />
        <button className="danger" disabled={!can('delete')} onClick={async () => {
          setOpen(false);
          if (!confirm(`Delete credential “${c.name}”? Nodes using it will fail.`)) return;
          await Api.deleteCredential(c.id).catch(errorToast('Could not delete'));
          refresh();
        }}><Trash2 size={14} /> Delete</button>
      </Popover>
      {modal === 'share' && <ShareModal kind="credentials" item={c} onClose={() => setModal(null)} onChange={refresh} />}
      {modal === 'move' && <MoveModal kind="credentials" item={c} onClose={() => setModal(null)} onChange={refresh} />}
    </div>
  );
}

/** All credentials the user can see, or (inside a project page) the ones that project can use. */
export function CredentialsPage({ projectId, canCreate = true }: { projectId?: string; canCreate?: boolean }) {
  const all = useApp((s) => s.credentials);
  const credentialTypes = useApp((s) => s.credentialTypes);
  const [projectCredentials, setProjectCredentials] = useState<CredentialSummary[]>([]);
  const [picker, setPicker] = useState(false);
  const [edit, setEdit] = useState<{ type: string; id?: string } | null>(null);
  const [q, setQ] = useState('');
  const refresh = useCallback(() => {
    useApp.getState().refreshCredentials();
    if (projectId) Api.credentials({ projectId }).then(setProjectCredentials, errorToast('Could not load credentials'));
  }, [projectId]);
  useEffect(refresh, [refresh]);

  const credentials = projectId ? projectCredentials : all;
  const types = Object.values(credentialTypes).filter((t) => t.displayName.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="page">
      <div className="page-header">
        <h1>{projectId ? '' : 'Credentials'}</h1>
        <button className="primary" disabled={!canCreate} onClick={() => setPicker(true)}><Plus size={14} /> Add credential</button>
      </div>
      <div className="card">
        <table className="list">
          <thead><tr><th>Name</th><th>Type</th><th>Owner</th><th>Updated</th><th style={{ width: 40 }} /></tr></thead>
          <tbody>
            {credentials.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => setEdit({ type: c.type, id: c.id })}>
                <td style={{ fontWeight: 500 }}>{c.name}</td>
                <td className="muted">{credentialTypes[c.type]?.displayName ?? c.type}</td>
                <td><ProjectBadge project={c.homeProject} shared={c.sharedWithProjects?.length} /></td>
                <td className="muted">{timeAgo(c.updatedAt)}</td>
                <td><RowMenu c={c} refresh={refresh} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!credentials.length && <div className="empty">No credentials yet. They're stored encrypted on this machine.</div>}
      </div>
      {picker && (
        <Modal title="Add credential" onClose={() => setPicker(false)}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search credential types" />
          <div className="col" style={{ gap: 2 }}>
            {types.map((t) => (
              <div key={t.name} className="creator-item" onClick={() => { setPicker(false); setEdit({ type: t.name }); }}>
                <span style={{ fontWeight: 500 }}>{t.displayName}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {edit && <CredentialModal type={edit.type} credentialId={edit.id} projectId={projectId} onClose={() => { setEdit(null); refresh(); }} />}
    </div>
  );
}
