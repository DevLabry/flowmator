import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Api, type InsightsRow, type InsightsSummary } from '../lib/api';
import { errorToast } from '../store/app';

const PERIODS = [
  [1, 'Last 24 hours'],
  [7, 'Last 7 days'],
  [14, 'Last 14 days'],
  [30, 'Last 30 days'],
  [90, 'Last 90 days'],
  [365, 'Last year'],
] as const;

const fmtMinutes = (m: number) => (m >= 60 ? `${(m / 60).toFixed(m >= 600 ? 0 : 1)}h` : `${Math.round(m)}m`);
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const fmtPct = (r: number) => `${(r * 100).toFixed(1)}%`;

const METRICS: Array<{ key: keyof InsightsSummary; label: string; fmt: (v: number) => string; lowerIsBetter?: boolean }> = [
  { key: 'total', label: 'Prod. executions', fmt: (v) => v.toLocaleString() },
  { key: 'failed', label: 'Failed prod. executions', fmt: (v) => v.toLocaleString(), lowerIsBetter: true },
  { key: 'failureRate', label: 'Failure rate', fmt: fmtPct, lowerIsBetter: true },
  { key: 'timeSaved', label: 'Time saved', fmt: fmtMinutes },
  { key: 'averageRunTime', label: 'Run time (avg.)', fmt: fmtMs, lowerIsBetter: true },
];

/** Production execution metrics (trigger, webhook and retry runs). */
export function InsightsPage() {
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<InsightsSummary>();
  const [series, setSeries] = useState<Array<InsightsRow & { date: string }>>([]);
  const [rows, setRows] = useState<InsightsRow[]>([]);
  const [sortBy, setSortBy] = useState('total:desc');
  const [metric, setMetric] = useState<keyof InsightsSummary>('total');

  useEffect(() => {
    Promise.all([Api.insightsSummary(days), Api.insightsByTime(days)]).then(([s, t]) => {
      setSummary(s);
      setSeries(t);
    }, errorToast('Could not load insights'));
  }, [days]);
  useEffect(() => {
    Api.insightsByWorkflow(days, sortBy).then(setRows, errorToast('Could not load insights'));
  }, [days, sortBy]);

  const sort = (field: string) => setSortBy((cur) => (cur === `${field}:desc` ? `${field}:asc` : `${field}:desc`));
  const header = (field: string, label: string) => (
    <th style={{ cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => sort(field)}>
      {label} {sortBy.startsWith(`${field}:`) ? (sortBy.endsWith('desc') ? '↓' : '↑') : ''}
    </th>
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Insights</h1>
          <div className="muted" style={{ marginTop: 4 }}>Production executions only. Set time saved per execution in each workflow's settings.</div>
        </div>
        <select style={{ width: 170 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {PERIODS.map(([d, label]) => <option key={d} value={d}>{label}</option>)}
        </select>
      </div>

      <div className="insights-tiles">
        {METRICS.map((m) => {
          const v = summary?.[m.key];
          const dev = v?.deviation;
          const good = dev == null || dev === 0 ? undefined : m.lowerIsBetter ? dev < 0 : dev > 0;
          return (
            <button key={m.key} className={`card insights-tile ${metric === m.key ? 'active' : ''}`} onClick={() => setMetric(m.key)}>
              <span className="muted">{m.label}</span>
              <strong>{v ? m.fmt(v.value) : '–'}</strong>
              <span className={good === undefined ? 'faint' : good ? 'text-success' : 'text-danger'}>
                {dev == null ? 'no previous data' : `${dev > 0 ? '▲' : dev < 0 ? '▼' : ''} ${m.fmt(Math.abs(dev))}`}
              </span>
            </button>
          );
        })}
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <Chart series={series} metric={metric} fmt={METRICS.find((m) => m.key === metric)!.fmt} />
      </div>

      <div className="card">
        <table className="list">
          <thead>
            <tr>
              {header('workflowName', 'Workflow')}
              {header('total', 'Prod. executions')}
              {header('failed', 'Failed')}
              {header('failureRate', 'Failure rate')}
              {header('timeSaved', 'Time saved')}
              {header('runTime', 'Run time (total)')}
              {header('averageRunTime', 'Run time (avg.)')}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.workflowId}>
                <td><Link to={`/workflow/${r.workflowId}`}>{r.workflowName || r.workflowId}</Link></td>
                <td>{r.total}</td>
                <td>{r.failed}</td>
                <td>{fmtPct(r.failureRate)}</td>
                <td>{fmtMinutes(r.timeSaved)}</td>
                <td>{fmtMs(r.runTime ?? 0)}</td>
                <td>{fmtMs(r.averageRunTime)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No production executions in this period</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Daily bars; executions are stacked success/failure. */
function Chart({ series, metric, fmt }: { series: Array<InsightsRow & { date: string }>; metric: keyof InsightsSummary; fmt: (v: number) => string }) {
  const value = (r: InsightsRow) => (metric === 'total' ? r.total : metric === 'failed' ? r.failed : r[metric]);
  const max = Math.max(...series.map(value), metric === 'failureRate' ? 0.01 : 1);
  const H = 160;
  return (
    <div>
      <div className="insights-chart" style={{ height: H }}>
        {series.map((r) => {
          const v = value(r);
          const h = (v / max) * H;
          const failH = metric === 'total' && r.total ? (r.failed / r.total) * h : 0;
          return (
            <div key={r.date} className="insights-bar" title={`${r.date}: ${fmt(v)}`}>
              <div style={{ height: h - failH, background: metric === 'failed' || metric === 'failureRate' ? 'var(--danger)' : 'var(--accent)' }} />
              {failH > 0 && <div style={{ height: failH, background: 'var(--danger)' }} />}
            </div>
          );
        })}
      </div>
      <div className="row faint" style={{ justifyContent: 'space-between', marginTop: 6, fontSize: 11 }}>
        <span>{series[0]?.date}</span>
        <span>max {fmt(max)}</span>
        <span>{series.at(-1)?.date}</span>
      </div>
    </div>
  );
}
