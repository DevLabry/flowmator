import { ArrowLeft, CircleCheck, CircleDashed, ExternalLink, Play, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { duration, timeAgo } from '../components/ui';
import { Api, type TestCaseExecution, type TestRun } from '../lib/api';
import { errorToast } from '../store/app';
import { useWorkflow } from '../store/workflow';

const EVALUATION_TRIGGER = 'flowmator.evaluationTrigger';
const EVALUATION_NODE = 'flowmator.evaluation';

const RUN_STATUS: Record<string, [string, string]> = {
  new: ['', 'Queued'],
  running: ['accent', 'Running'],
  completed: ['success', 'Completed'],
  error: ['error', 'Error'],
  cancelled: ['', 'Cancelled'],
  success: ['success', 'Success'],
  warning: ['warning', 'Some cases failed'],
};

function RunBadge({ status }: { status: string }) {
  const [kind, label] = RUN_STATUS[status] ?? ['', status];
  return <span className={`badge ${kind}`}>{label}</span>;
}

/** Metrics vary in range (0-1 similarity, 1-5 judge scores); show up to 3 decimals. */
const fmt = (v: number | undefined) => (v === undefined ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, ''));

function metricNames(rows: Array<{ metrics: Record<string, number> | null }>) {
  return [...new Set(rows.flatMap((r) => Object.keys(r.metrics ?? {})))];
}

/** One line per metric across the finished runs, oldest to newest. */
function MetricTrend({ runs }: { runs: TestRun[] }) {
  const done = runs.filter((r) => r.metrics && Object.keys(r.metrics).length).reverse();
  const names = metricNames(done);
  if (done.length < 2 || !names.length) return null;
  const w = 100 / (done.length - 1);
  return (
    <div className="eval-trends">
      {names.map((name) => {
        const values = done.map((r) => r.metrics?.[name]);
        const nums = values.filter((v): v is number => v !== undefined);
        const min = Math.min(...nums, 0);
        const max = Math.max(...nums, 1);
        const y = (v: number) => 36 - ((v - min) / (max - min || 1)) * 32;
        const points = values.map((v, i) => (v === undefined ? null : `${i * w},${y(v)}`)).filter(Boolean).join(' ');
        return (
          <div key={name} className="eval-trend">
            <div className="row"><span className="grow muted">{name}</span><strong>{fmt(nums[nums.length - 1])}</strong></div>
            <svg viewBox="-2 0 104 40" preserveAspectRatio="none" aria-label={`${name} across runs`}>
              <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        );
      })}
    </div>
  );
}

function SetupChecklist({ hasTrigger, hasMetrics }: { hasTrigger: boolean; hasMetrics: boolean }) {
  const step = (done: boolean, title: string, detail: string) => (
    <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
      {done ? <CircleCheck size={18} color="var(--success)" /> : <CircleDashed size={18} color="var(--text-3)" />}
      <div>
        <strong>{title}</strong>
        <div className="muted">{detail}</div>
      </div>
    </div>
  );
  return (
    <div className="card" style={{ display: 'grid', gap: 14, maxWidth: 560 }}>
      <h3 style={{ margin: 0 }}>Set up an evaluation</h3>
      <p className="muted" style={{ margin: 0 }}>Run the workflow on a dataset of test cases and score each result, so you can see whether a prompt or model change made things better.</p>
      {step(true, 'Create a dataset', 'A data table or Google Sheet with one row per test case: the inputs and, when you have them, the expected outputs.')}
      {step(hasTrigger, 'Add an Evaluation Trigger', '"When fetching a dataset row" feeds each row to the workflow.')}
      {step(hasMetrics, 'Add an Evaluation node that sets metrics', 'Use Correctness, Helpfulness, String Similarity, Categorization, Tools Used or your own numbers.')}
      <p className="faint" style={{ margin: 0 }}>Save the workflow, then come back here to run it.</p>
    </div>
  );
}

function RunDetail({ workflowId, run, onBack }: { workflowId: string; run: TestRun; onBack: () => void }) {
  const [cases, setCases] = useState<TestCaseExecution[]>([]);
  const refresh = useCallback(() => Api.testCases(workflowId, run.id).then(setCases).catch(errorToast('Could not load test cases')), [workflowId, run.id]);
  useEffect(() => {
    refresh();
  }, [refresh, run.status, run.completedAt]);
  useEffect(() => {
    if (run.status !== 'running') return;
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [refresh, run.status]);
  const names = metricNames(cases);
  const inputKeys = [...new Set(cases.flatMap((c) => Object.keys(c.inputs ?? {}).filter((k) => !['id', 'createdAt', 'updatedAt'].includes(k))))].slice(0, 3);

  return (
    <div className="eval-page">
      <div className="row">
        <button className="ghost sm" onClick={onBack}><ArrowLeft size={14} /> All runs</button>
        <h3 className="grow" style={{ margin: 0 }}>Run from {run.runAt ? new Date(run.runAt).toLocaleString() : '—'}</h3>
        <RunBadge status={run.status === 'completed' && run.finalResult ? run.finalResult : run.status} />
      </div>
      {run.errorDetails?.message && <div className="callout error">{run.errorDetails.message}</div>}
      {run.metrics && Object.keys(run.metrics).length > 0 && (
        <div className="eval-metrics">
          {Object.entries(run.metrics).map(([k, v]) => (
            <div key={k} className="card"><div className="muted">{k}</div><div className="eval-metric-value">{fmt(v)}</div></div>
          ))}
        </div>
      )}
      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table className="list">
          <thead>
            <tr>
              <th>#</th>
              <th>Status</th>
              {inputKeys.map((k) => <th key={k}>{k}</th>)}
              {names.map((n) => <th key={n} style={{ textAlign: 'right' }}>{n}</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {cases.map((c, i) => (
              <tr key={c.id}>
                <td className="faint">{i + 1}</td>
                <td>
                  <RunBadge status={c.status} />
                  {c.errorDetails?.message && <div className="faint" style={{ fontSize: 11, maxWidth: 260 }}>{c.errorDetails.message}</div>}
                </td>
                {inputKeys.map((k) => <td key={k} className="eval-cell" title={String(c.inputs?.[k] ?? '')}>{String(c.inputs?.[k] ?? '')}</td>)}
                {names.map((n) => <td key={n} className="mono" style={{ textAlign: 'right' }}>{fmt(c.metrics?.[n])}</td>)}
                <td style={{ textAlign: 'right' }}>
                  {c.executionId && <Link className="btn ghost sm" to={`/workflow/${workflowId}/executions/${c.executionId}`}><ExternalLink size={12} /> Execution</Link>}
                </td>
              </tr>
            ))}
            {!cases.length && <tr><td colSpan={4 + names.length + inputKeys.length} className="empty">No test cases</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function EvaluationsTab({ workflowId }: { workflowId: string }) {
  const { runId } = useParams();
  const navigate = useNavigate();
  const nodes = useWorkflow((s) => s.workflow.nodes);
  const [runs, setRuns] = useState<TestRun[] | null>(null);
  const [starting, setStarting] = useState(false);
  const refresh = useCallback(() => Api.testRuns(workflowId).then(setRuns).catch(errorToast('Could not load evaluations')), [workflowId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const running = runs?.find((r) => r.status === 'running' || r.status === 'new');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [refresh, running?.id]);

  const hasTrigger = nodes.some((n) => n.type === EVALUATION_TRIGGER && !n.disabled);
  const hasMetrics = nodes.some((n) => n.type === EVALUATION_NODE && !n.disabled && n.parameters.operation === 'setMetrics');

  const start = async () => {
    setStarting(true);
    try {
      const run = await Api.startTestRun(workflowId);
      setRuns((r) => [run, ...(r ?? [])]);
    } catch (e) {
      errorToast('Could not start the evaluation')(e);
    } finally {
      setStarting(false);
    }
  };

  const selected = runId ? runs?.find((r) => r.id === runId) : undefined;
  if (selected) return <RunDetail workflowId={workflowId} run={selected} onBack={() => navigate(`/workflow/${workflowId}/evaluations`)} />;
  if (!runs) return <div className="eval-page"><div className="empty">Loading…</div></div>;

  const names = metricNames(runs);
  return (
    <div className="eval-page">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>Evaluations</h2>
        {running ? (
          <button className="danger" onClick={() => Api.cancelTestRun(workflowId, running.id).then(refresh, errorToast('Could not cancel'))}><Square size={13} /> Stop evaluation</button>
        ) : (
          <button className="primary" disabled={starting || !hasTrigger || !hasMetrics} onClick={start}><Play size={13} /> Run evaluation</button>
        )}
      </div>
      {!runs.length && (!hasTrigger || !hasMetrics) ? (
        <SetupChecklist hasTrigger={hasTrigger} hasMetrics={hasMetrics} />
      ) : (
        <>
          <MetricTrend runs={runs} />
          <div className="card" style={{ padding: 0, overflow: 'auto' }}>
            <table className="list">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Duration</th>
                  {names.map((n) => <th key={n} style={{ textAlign: 'right' }}>{n}</th>)}
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/workflow/${workflowId}/evaluations/${r.id}`)}>
                    <td>
                      {r.runAt ? new Date(r.runAt).toLocaleString() : '—'}
                      <div className="faint" style={{ fontSize: 11 }}>{timeAgo(r.runAt)}</div>
                    </td>
                    <td>
                      <RunBadge status={r.status === 'completed' && r.finalResult ? r.finalResult : r.status} />
                      {r.errorDetails?.message && <div className="faint" style={{ fontSize: 11 }}>{r.errorDetails.message}</div>}
                    </td>
                    <td className="faint">{r.completedAt ? duration(r.runAt, r.completedAt) : '—'}</td>
                    {names.map((n) => <td key={n} className="mono" style={{ textAlign: 'right' }}>{fmt(r.metrics?.[n])}</td>)}
                    <td style={{ textAlign: 'right' }}>
                      {r.status !== 'running' && (
                        <button
                          className="ghost sm icon danger"
                          title="Delete run"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm('Delete this evaluation run?')) Api.deleteTestRun(workflowId, r.id).then(refresh, errorToast('Could not delete'));
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!runs.length && <tr><td colSpan={4 + names.length} className="empty">No evaluations yet. Run one to score the workflow on its dataset.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
