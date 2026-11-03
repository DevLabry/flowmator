import { RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { StatusBadge, duration } from '../components/ui';
import { Api, type ExecutionSummary, type WorkflowData } from '../lib/api';
import { onPush } from '../lib/push';
import { errorToast } from '../store/app';

export function ExecutionsPage() {
  const navigate = useNavigate();
  const [list, setList] = useState<ExecutionSummary[]>([]);
  const [count, setCount] = useState(0);
  const [workflows, setWorkflows] = useState<WorkflowData[]>([]);
  const [workflowId, setWorkflowId] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [auto, setAuto] = useState(true);

  const refresh = useCallback(() => {
    const q = new URLSearchParams({ limit: '100' });
    if (workflowId) q.set('workflowId', workflowId);
    if (status) q.set('status', status);
    Api.executions(`?${q}`).then((r) => {
      setList(r.results);
      setCount(r.count);
    }, errorToast('Could not load executions'));
  }, [workflowId, status]);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    Api.workflows().then(setWorkflows).catch(() => {});
  }, []);
  useEffect(() => {
    if (!auto) return;
    return onPush((e) => (e.type === 'executionFinished' || e.type === 'executionStarted' ? refresh() : undefined)) as () => void;
  }, [auto, refresh]);

  const loadMore = () => {
    const q = new URLSearchParams({ limit: '100', lastId: list.at(-1)!.id });
    if (workflowId) q.set('workflowId', workflowId);
    if (status) q.set('status', status);
    Api.executions(`?${q}`).then((r) => setList([...list, ...r.results]));
  };

  const del = async () => {
    if (!confirm(`Delete ${selected.size} execution(s)?`)) return;
    await Api.deleteExecutions({ ids: [...selected] });
    setSelected(new Set());
    refresh();
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Executions</h1>
        <div className="row">
          <label className="row muted"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto refresh</label>
          <button className="icon" onClick={refresh}><RefreshCw size={14} /></button>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <select style={{ width: 240 }} value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
          <option value="">All workflows</option>
          {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {['success', 'error', 'running', 'new', 'waiting', 'canceled', 'crashed'].map((s) => <option key={s} value={s}>{s === 'new' ? 'queued' : s}</option>)}
        </select>
        <span className="grow" />
        {selected.size > 0 && <button className="danger" onClick={del}><Trash2 size={14} /> Delete {selected.size}</button>}
      </div>
      <div className="card">
        <table className="list">
          <thead>
            <tr>
              <th style={{ width: 30 }}><input type="checkbox" checked={!!list.length && selected.size === list.length} onChange={(e) => setSelected(new Set(e.target.checked ? list.map((x) => x.id) : []))} /></th>
              <th>Workflow</th><th>Status</th><th>Started</th><th>Run time</th><th>ID</th><th>Mode</th>
            </tr>
          </thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.id} className="clickable" onClick={() => e.workflowId && navigate(`/workflow/${e.workflowId}/executions/${e.id}`)}>
                <td onClick={(ev) => ev.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(e.id)} onChange={(ev) => {
                    const next = new Set(selected);
                    if (ev.target.checked) next.add(e.id);
                    else next.delete(e.id);
                    setSelected(next);
                  }} />
                </td>
                <td style={{ fontWeight: 500 }}>{e.workflowName || '—'}</td>
                <td><StatusBadge status={e.status} />{e.retrySuccessId && <span className="faint" style={{ marginLeft: 6 }}>retried ✓</span>}</td>
                <td className="muted">{e.startedAt ? new Date(e.startedAt).toLocaleString() : ''}</td>
                <td className="muted">{e.status === 'waiting' && e.waitTill ? `until ${new Date(e.waitTill).toLocaleString()}` : duration(e.startedAt, e.stoppedAt)}</td>
                <td className="faint">#{e.id}{e.retryOf ? ` (retry of #${e.retryOf})` : ''}</td>
                <td className="faint">{e.mode}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="empty">No executions</div>}
        {list.length < count && <div style={{ padding: 12, textAlign: 'center' }}><button onClick={loadMore}>Load more ({count - list.length})</button></div>}
      </div>
    </div>
  );
}
