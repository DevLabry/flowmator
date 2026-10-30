import type { IWorkflowSettings } from '@flowmator/workflow';
import { ArrowLeft, Download, Ellipsis, History, Redo2, RotateCcw, Save, Settings2, Undo2, Upload, Copy, Trash2, Bug } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Canvas } from '../components/Canvas';
import { NDV } from '../components/NDV';
import { Modal, Popover, StatusBadge, Switch, duration, timeAgo } from '../components/ui';
import { Api, ApiError, type ExecutionFull, type ExecutionSummary, type WorkflowData } from '../lib/api';
import { onPush } from '../lib/push';
import { errorToast, useApp } from '../store/app';
import { useWorkflow } from '../store/workflow';
import { EvaluationsTab } from './Evaluations';

function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\w.-]+/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const wf = useWorkflow((s) => s.workflow);
  const [s, setS] = useState<IWorkflowSettings>({ executionOrder: 'v1', ...wf.settings });
  const [workflows, setWorkflows] = useState<WorkflowData[]>([]);
  useEffect(() => {
    Api.workflows().then(setWorkflows).catch(() => {});
  }, []);
  const set = (patch: Partial<IWorkflowSettings>) => setS({ ...s, ...patch });
  const field = (label: string, control: React.ReactNode) => (
    <div>
      <label className="field-label">{label}</label>
      {control}
    </div>
  );
  return (
    <Modal
      title={`Settings for “${wf.name}”`}
      onClose={onClose}
      footer={<button className="primary" onClick={() => { useWorkflow.getState().setSettings(s); onClose(); }}>Save</button>}
    >
      {field('Execution order', (
        <select value={s.executionOrder ?? 'v1'} onChange={(e) => set({ executionOrder: e.target.value as 'v0' | 'v1' })}>
          <option value="v1">v1 (recommended): finish each branch before the next</option>
          <option value="v0">v0 (legacy): breadth first</option>
        </select>
      ))}
      {field('Error workflow (runs when this one fails)', (
        <select value={s.errorWorkflow ?? ''} onChange={(e) => set({ errorWorkflow: e.target.value || undefined })}>
          <option value="">— none —</option>
          {workflows.filter((w) => w.id !== wf.id && w.nodes.some((n) => n.type.endsWith('errorTrigger'))).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      ))}
      {field('Timezone', <input value={s.timezone ?? ''} placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone} onChange={(e) => set({ timezone: e.target.value || undefined })} />)}
      {field('Save failed production executions', (
        <select value={s.saveDataErrorExecution ?? 'all'} onChange={(e) => set({ saveDataErrorExecution: e.target.value as 'all' | 'none' })}>
          <option value="all">Save</option>
          <option value="none">Do not save</option>
        </select>
      ))}
      {field('Save successful production executions', (
        <select value={s.saveDataSuccessExecution ?? 'all'} onChange={(e) => set({ saveDataSuccessExecution: e.target.value as 'all' | 'none' })}>
          <option value="all">Save</option>
          <option value="none">Do not save</option>
        </select>
      ))}
      <div className="row"><span className="grow">Save manual executions</span><Switch checked={s.saveManualExecutions ?? true} onChange={(v) => set({ saveManualExecutions: v })} /></div>
      <div className="row"><span className="grow">Save execution progress (resume after crash)</span><Switch checked={!!s.saveExecutionProgress} onChange={(v) => set({ saveExecutionProgress: v })} /></div>
      {field('Timeout (seconds, -1 = none)', <input type="number" value={s.executionTimeout ?? -1} onChange={(e) => set({ executionTimeout: Number(e.target.value) })} />)}
      {field('Estimated time saved per production execution (minutes)', <input type="number" min={0} value={s.timeSavedPerExecution ?? ''} placeholder="0" onChange={(e) => set({ timeSavedPerExecution: e.target.value === '' ? undefined : Number(e.target.value) })} />)}
    </Modal>
  );
}

function HistoryDrawer({ onClose }: { onClose: () => void }) {
  const wf = useWorkflow((s) => s.workflow);
  const [versions, setVersions] = useState<Array<{ versionId: string; createdAt: string }>>([]);
  useEffect(() => {
    if (wf.id) Api.history(wf.id).then(setVersions).catch(errorToast('Could not load history'));
  }, [wf.id, wf.versionId]);
  const restore = async (v: string) => {
    if (!wf.id || !confirm('Restore this version? Current unsaved changes are discarded.')) return;
    const restored = await Api.restoreVersion(wf.id, v).catch(errorToast('Restore failed'));
    if (restored) {
      useWorkflow.getState().load(restored);
      useApp.getState().toast('success', 'Version restored');
    }
  };
  return (
    <div className="drawer">
      <div className="drawer-head"><h3>Version history</h3><button className="ghost sm icon" onClick={onClose}>×</button></div>
      <div style={{ overflow: 'auto' }}>
        {versions.map((v, i) => (
          <div key={v.versionId} className="exec-item">
            <div className="row">
              <span className="grow">{new Date(v.createdAt).toLocaleString()}</span>
              {i === 0 ? <span className="badge accent">Current</span> : <button className="sm" onClick={() => restore(v.versionId)}><RotateCcw size={12} /> Restore</button>}
            </div>
            <span className="faint mono" style={{ fontSize: 11 }}>{v.versionId.slice(0, 8)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExecutionsTab({ workflowId }: { workflowId: string }) {
  const { executionId } = useParams();
  const navigate = useNavigate();
  const [list, setList] = useState<ExecutionSummary[]>([]);
  const [current, setCurrent] = useState<ExecutionFull | null>(null);
  const refresh = useCallback(() => Api.executions(`?workflowId=${workflowId}&limit=100`).then((r) => setList(r.results)).catch(() => {}), [workflowId]);
  useEffect(() => {
    refresh();
    return onPush((e) => e.type === 'executionFinished' || e.type === 'executionStarted' ? refresh() : undefined) as () => void;
  }, [refresh]);
  useEffect(() => {
    const id = executionId ?? list[0]?.id;
    if (!id) return;
    Api.execution(id).then((e) => {
      setCurrent(e);
      useWorkflow.getState().load({ ...e.workflowData, id: workflowId }, { readOnly: true, runData: e.data?.resultData.runData ?? {} });
      if (e.data?.resultData.error) useWorkflow.setState({ executionError: { message: e.data.resultData.error.message, node: e.data.resultData.error.node, description: e.data.resultData.error.description } });
    }, errorToast('Could not load execution'));
  }, [executionId, list[0]?.id, workflowId]);

  const debugInEditor = async () => {
    if (!current?.data) return;
    // copy this execution's data into the editor as pinned data on the trigger, then open the editor
    const wf = await Api.workflow(workflowId);
    const runData = current.data.resultData.runData;
    const trigger = wf.nodes.find((n) => runData[n.name] && !(runData[n.name][0].source?.length));
    const pinData = { ...wf.pinData, ...(trigger ? { [trigger.name]: runData[trigger.name][0].data?.main?.[0] ?? [] } : {}) };
    await Api.updateWorkflow(workflowId, { pinData });
    navigate(`/workflow/${workflowId}`);
    useApp.getState().toast('info', 'Trigger data pinned', 'Run the workflow to debug it with the same input');
  };

  return (
    <div className="editor-body">
      <div className="exec-list">
        {list.map((e) => (
          <div key={e.id} className={`exec-item ${e.status} ${current?.id === e.id ? 'active' : ''}`} onClick={() => navigate(`/workflow/${workflowId}/executions/${e.id}`)}>
            <div className="row"><strong className="grow">{e.startedAt ? new Date(e.startedAt).toLocaleString() : '—'}</strong><StatusBadge status={e.status} /></div>
            <div className="faint">#{e.id} · {e.mode}{e.stoppedAt ? ` · ${duration(e.startedAt, e.stoppedAt)}` : ''}{e.retryOf ? ` · retry of #${e.retryOf}` : ''}</div>
          </div>
        ))}
        {!list.length && <div className="empty">No executions yet</div>}
      </div>
      <div className="grow" style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {current && (
          <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
            <strong>Execution #{current.id}</strong>
            <StatusBadge status={current.status} />
            <span className="faint grow">{timeAgo(current.startedAt)}</span>
            {['error', 'crashed', 'canceled'].includes(current.status) && (
              <>
                <button className="sm" onClick={() => Api.retryExecution(current.id, true).then(() => refresh(), errorToast('Retry failed'))}>Retry with current workflow</button>
                <button className="sm" onClick={() => Api.retryExecution(current.id, false).then(() => refresh(), errorToast('Retry failed'))}>Retry with original</button>
              </>
            )}
            {['running', 'waiting', 'new'].includes(current.status) && <button className="sm danger" onClick={() => Api.stopExecution(current.id).then(refresh)}>Stop</button>}
            <button className="sm" onClick={debugInEditor}><Bug size={12} /> Debug in editor</button>
            <button className="sm icon danger" title="Delete" onClick={async () => { await Api.deleteExecution(current.id); setCurrent(null); navigate(`/workflow/${workflowId}/executions`); refresh(); }}><Trash2 size={12} /></button>
          </div>
        )}
        <div className="grow" style={{ display: 'flex' }}>{current ? <Canvas /> : <div className="empty grow">Select an execution</div>}</div>
      </div>
      <NDV />
    </div>
  );
}

export function EditorPage({ tab = 'editor' }: { tab?: 'editor' | 'executions' | 'evaluations' }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const wf = useWorkflow((s) => s.workflow);
  const dirty = useWorkflow((s) => s.dirty);
  const canUndo = useWorkflow((s) => s.past.length > 0);
  const canRedo = useWorkflow((s) => s.future.length > 0);
  const [menu, setMenu] = useState(false);
  const [settings, setSettings] = useState(false);
  const [history, setHistory] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // load the workflow when entering the editor tab (evaluations reads its nodes too)
  useEffect(() => {
    if (tab === 'executions') return;
    if (tab === 'evaluations' && useWorkflow.getState().workflow.id === id) return;
    if (!id) {
      useWorkflow.getState().newWorkflow();
      return;
    }
    // already open (e.g. we just saved a new workflow and only the URL changed): keep run data
    if (useWorkflow.getState().workflow.id === id && !useWorkflow.getState().readOnly) return;
    Api.workflow(id).then((w) => useWorkflow.getState().load(w), (e) => {
      errorToast('Could not open workflow')(e);
      navigate('/home/workflows');
    });
  }, [id, tab, navigate]);

  // a new workflow gets its id on first save (also auto-saves before a run): move to its URL
  const savedId = wf.id;
  useEffect(() => {
    if (!id && savedId && tab === 'editor') navigate(`/workflow/${savedId}`, { replace: true });
  }, [id, savedId, tab, navigate]);

  const save = useCallback(async () => {
    try {
      await useWorkflow.getState().save();
      useApp.getState().toast('success', 'Saved');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (confirm(`${e.message}\n\nOverwrite anyway?`)) {
          const st = useWorkflow.getState();
          const saved = await Api.updateWorkflow(st.workflow.id!, { ...st.workflow, versionId: undefined }, true);
          useWorkflow.setState({ workflow: { ...st.workflow, versionId: saved.versionId }, dirty: false });
        }
      } else errorToast('Could not save')(e);
    }
  }, [id, navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (!useWorkflow.getState().readOnly) save();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !useWorkflow.getState().readOnly) {
        e.preventDefault();
        useWorkflow.getState().run();
      }
    };
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (useWorkflow.getState().dirty && !useWorkflow.getState().readOnly) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [save]);

  const toggleActive = async (active: boolean) => {
    if (!wf.id || dirty) await save();
    const wid = useWorkflow.getState().workflow.id!;
    try {
      const res = active ? await Api.activate(wid) : await Api.deactivate(wid);
      useWorkflow.setState({ workflow: { ...useWorkflow.getState().workflow, active: res.active, versionId: res.versionId, activationError: null } });
      useApp.getState().toast('success', active ? 'Workflow activated' : 'Workflow deactivated', active ? 'Production webhooks and triggers are live' : undefined);
    } catch (e) {
      errorToast('Could not activate')(e);
    }
  };

  const importFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      const st = useWorkflow.getState();
      st.addNodes(parsed.nodes ?? [], parsed.connections ?? {});
      if (!st.workflow.nodes.length && parsed.name) st.setName(parsed.name);
    } catch (e) {
      errorToast('Could not import file')(e);
    }
  };

  const goTab = (t: 'editor' | 'executions' | 'evaluations') => {
    if (!wf.id) return;
    if (t !== 'editor' && tab === 'editor' && dirty && !confirm('You have unsaved changes. Leave the editor?')) return;
    navigate(t === 'editor' ? `/workflow/${wf.id}` : `/workflow/${wf.id}/${t}`);
  };

  return (
    <div className="editor">
      <header className="editor-header">
        <Link to="/home/workflows" className="btn ghost icon" title="All workflows" style={{ border: 'none' }}><ArrowLeft size={16} /></Link>
        <input className="name-input" value={wf.name} disabled={tab !== 'editor'} onChange={(e) => useWorkflow.getState().setName(e.target.value)} size={Math.max(12, wf.name.length)} />
        <div className="row" style={{ gap: 4 }}>
          {wf.tags.map((t) => (
            <span key={t} className="badge" style={{ cursor: 'pointer' }} title="Remove tag" onClick={() => tab === 'editor' && useWorkflow.getState().setTags(wf.tags.filter((x) => x !== t))}>{t}</span>
          ))}
          {tab === 'editor' && (
            <input
              value={tagInput}
              placeholder="+ tag"
              style={{ width: 70, minHeight: 24, padding: '2px 6px', fontSize: 12 }}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tagInput.trim()) {
                  useWorkflow.getState().setTags([...new Set([...wf.tags, tagInput.trim()])]);
                  setTagInput('');
                }
              }}
            />
          )}
        </div>
        <span className="grow" />
        <div className="seg">
          <button className={tab === 'editor' ? 'active' : ''} onClick={() => goTab('editor')}>Editor</button>
          <button className={tab === 'executions' ? 'active' : ''} disabled={!wf.id} onClick={() => goTab('executions')}>Executions</button>
          <button className={tab === 'evaluations' ? 'active' : ''} disabled={!wf.id} onClick={() => goTab('evaluations')}>Evaluations</button>
        </div>
        <span className="grow" />
        {wf.activationError && <span className="badge error" title={wf.activationError}>Activation failed</span>}
        <span className="row" style={{ gap: 6 }}>
          <span className="muted">{wf.active ? 'Active' : 'Inactive'}</span>
          <Switch checked={wf.active} onChange={toggleActive} />
        </span>
        {tab === 'editor' && (
          <>
            <button className="ghost icon" disabled={!canUndo} title="Undo (Ctrl+Z)" onClick={() => useWorkflow.getState().undo()}><Undo2 size={15} /></button>
            <button className="ghost icon" disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" onClick={() => useWorkflow.getState().redo()}><Redo2 size={15} /></button>
            <button className={dirty || !wf.id ? 'primary' : ''} onClick={save} title="Save (Ctrl+S)"><Save size={14} /> {dirty || !wf.id ? 'Save' : 'Saved'}</button>
          </>
        )}
        <div style={{ position: 'relative' }}>
          <button className="ghost icon" onClick={() => setMenu(!menu)}><Ellipsis size={16} /></button>
          <Popover open={menu} onClose={() => setMenu(false)} style={{ right: 0, top: 36 }}>
            <button onClick={() => { setMenu(false); download(wf.name, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings, pinData: wf.pinData, tags: wf.tags }); }}><Download size={14} /> Download JSON</button>
            <button onClick={() => { setMenu(false); fileRef.current?.click(); }}><Upload size={14} /> Import from file</button>
            <button onClick={async () => {
              setMenu(false);
              const url = prompt('Workflow JSON URL');
              if (!url) return;
              try {
                const parsed = await (await fetch(url)).json();
                useWorkflow.getState().addNodes(parsed.nodes ?? [], parsed.connections ?? {});
              } catch (e) {
                errorToast('Could not import from URL')(e);
              }
            }}><Upload size={14} /> Import from URL</button>
            <hr />
            <button disabled={!wf.id} onClick={async () => { setMenu(false); const c = await Api.copyWorkflow(wf.id!); navigate(`/workflow/${c.id}`); }}><Copy size={14} /> Duplicate</button>
            <button disabled={!wf.id} onClick={() => { setMenu(false); setHistory(true); }}><History size={14} /> Version history</button>
            <button onClick={() => { setMenu(false); setSettings(true); }}><Settings2 size={14} /> Settings</button>
            <hr />
            <button disabled={!wf.id} className="danger" onClick={async () => {
              setMenu(false);
              if (!confirm(`Delete “${wf.name}”?`)) return;
              await Api.deleteWorkflow(wf.id!);
              navigate('/home/workflows');
            }}><Trash2 size={14} /> Delete</button>
          </Popover>
        </div>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
      </header>
      {tab === 'executions' && id ? (
        <ExecutionsTab workflowId={id} />
      ) : tab === 'evaluations' && id ? (
        <div className="editor-body"><EvaluationsTab workflowId={id} /></div>
      ) : (
        <div className="editor-body">
          <Canvas />
          <NDV />
          {history && <HistoryDrawer onClose={() => setHistory(false)} />}
        </div>
      )}
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
    </div>
  );
}
