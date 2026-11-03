import { Archive, ArrowRightLeft, Copy, Ellipsis, Plus, Search, Share2, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MoveModal, ProjectBadge, ShareModal } from '../components/Sharing';
import { Popover, Switch, timeAgo } from '../components/ui';
import { Api, type WorkflowData } from '../lib/api';
import { errorToast, useApp } from '../store/app';

function RowMenu({ wf, refresh }: { wf: WorkflowData; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<'share' | 'move' | null>(null);
  const navigate = useNavigate();
  const can = (scope: string) => !!wf.scopes?.includes(scope);
  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button className="ghost icon sm" onClick={() => setOpen(!open)}><Ellipsis size={15} /></button>
      <Popover open={open} onClose={() => setOpen(false)} style={{ right: 0, top: 28 }}>
        <button onClick={async () => { setOpen(false); const c = await Api.copyWorkflow(wf.id!).catch(errorToast('Could not duplicate')); if (c) navigate(`/workflow/${c.id}`); }}><Copy size={14} /> Duplicate</button>
        <button onClick={() => { setOpen(false); setModal('share'); }}><Share2 size={14} /> Share…</button>
        <button disabled={!can('move')} onClick={() => { setOpen(false); setModal('move'); }}><ArrowRightLeft size={14} /> Move to project…</button>
        <hr />
        {wf.isArchived ? (
          <button disabled={!can('delete')} onClick={async () => { setOpen(false); await Api.unarchive(wf.id!); refresh(); }}><Archive size={14} /> Unarchive</button>
        ) : (
          <button disabled={!can('delete')} onClick={async () => { setOpen(false); await Api.archive(wf.id!); refresh(); }}><Archive size={14} /> Archive</button>
        )}
        <button className="danger" disabled={!can('delete')} onClick={async () => {
          setOpen(false);
          if (!confirm(`Delete “${wf.name}”? Its executions stay in the list.`)) return;
          await Api.deleteWorkflow(wf.id!);
          refresh();
        }}><Trash2 size={14} /> Delete</button>
      </Popover>
      {modal === 'share' && <ShareModal kind="workflows" item={wf} onClose={() => setModal(null)} onChange={refresh} />}
      {modal === 'move' && <MoveModal kind="workflows" item={wf} onClose={() => setModal(null)} onChange={refresh} />}
    </div>
  );
}

/** All workflows the user can see, or (inside a project page) the ones of that project. */
export function WorkflowsPage({ projectId, canCreate = true }: { projectId?: string; canCreate?: boolean }) {
  const navigate = useNavigate();
  const [list, setList] = useState<WorkflowData[]>([]);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [archived, setArchived] = useState(false);
  const [sort, setSort] = useState<'updated' | 'name'>('updated');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    Api.workflows(`?archived=${archived}${projectId ? `&projectId=${projectId}` : ''}`).then(setList, errorToast('Could not load workflows'));
  }, [archived, projectId]);
  const newUrl = `/workflow/new${projectId ? `?projectId=${projectId}` : ''}`;
  useEffect(refresh, [refresh]);

  const tags = [...new Set(list.flatMap((w) => w.tags))].sort();
  const shown = list
    .filter((w) => w.name.toLowerCase().includes(q.toLowerCase()) && (!tag || w.tags.includes(tag)))
    .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')));

  const toggle = async (wf: WorkflowData, active: boolean) => {
    try {
      const res = active ? await Api.activate(wf.id!) : await Api.deactivate(wf.id!);
      setList(list.map((w) => (w.id === wf.id ? { ...w, active: res.active } : w)));
    } catch (e) {
      errorToast('Could not activate')(e);
    }
  };

  const importFile = async (file: File) => {
    try {
      const created = await Api.importWorkflows(JSON.parse(await file.text()), projectId);
      useApp.getState().toast('success', `Imported ${created.length} workflow${created.length === 1 ? '' : 's'}`);
      if (created.length === 1) navigate(`/workflow/${created[0].id}`);
      else refresh();
    } catch (e) {
      errorToast('Import failed')(e);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>{projectId ? '' : 'Workflows'}</h1>
        <div className="row">
          <button disabled={!canCreate} onClick={() => fileRef.current?.click()}><Upload size={14} /> Import</button>
          <button className="primary" disabled={!canCreate} onClick={() => navigate(newUrl)}><Plus size={14} /> Create workflow</button>
          <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        </div>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <div style={{ position: 'relative', width: 280 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-3)' }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search workflows" style={{ paddingLeft: 30 }} />
        </div>
        <select style={{ width: 160 }} value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All tags</option>
          {tags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select style={{ width: 160 }} value={sort} onChange={(e) => setSort(e.target.value as 'updated' | 'name')}>
          <option value="updated">Last updated</option>
          <option value="name">Name</option>
        </select>
        <span className="grow" />
        <label className="row muted"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>
      </div>
      <div className="card">
        <table className="list">
          <thead>
            <tr><th>Name</th><th>Tags</th><th>Owner</th><th>Last updated</th><th style={{ width: 90 }}>Active</th><th style={{ width: 40 }} /></tr>
          </thead>
          <tbody>
            {shown.map((w) => (
              <tr key={w.id} className="clickable" onClick={() => navigate(`/workflow/${w.id}`)}>
                <td>
                  <div style={{ fontWeight: 500 }}>{w.name}</div>
                  <div className="faint" style={{ fontSize: 12 }}>{w.nodes.filter((n) => !n.type.endsWith('stickyNote')).length} nodes{w.activationError ? ' · activation failed' : ''}</div>
                </td>
                <td>{w.tags.map((t) => <span key={t} className="badge" style={{ marginRight: 4 }}>{t}</span>)}</td>
                <td><ProjectBadge project={w.homeProject} shared={w.sharedWithProjects?.length} /></td>
                <td className="muted">{timeAgo(w.updatedAt)}</td>
                <td onClick={(e) => e.stopPropagation()}><Switch checked={w.active} disabled={w.isArchived || !w.scopes?.includes('update')} onChange={(v) => toggle(w, v)} /></td>
                <td><RowMenu wf={w} refresh={refresh} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && (
          <div className="empty">
            {list.length ? 'No workflows match your filters' : (
              <div className="col" style={{ alignItems: 'center' }}>
                <h2>Build your first workflow</h2>
                <div className="muted">Connect apps, transform data and automate tasks.</div>
                {canCreate && <button className="primary" onClick={() => navigate(newUrl)}><Plus size={14} /> Start from scratch</button>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
