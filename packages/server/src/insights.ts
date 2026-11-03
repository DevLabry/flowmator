import type { Database } from './db';
import type { BusEvent, EventBus } from './events';

export const INSIGHTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS insights_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflowId TEXT NOT NULL,
  workflowName TEXT NOT NULL,
  status TEXT NOT NULL,
  runtimeMs INTEGER NOT NULL,
  timeSavedMin REAL NOT NULL DEFAULT 0,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insights_ts ON insights_raw(timestamp);
CREATE INDEX IF NOT EXISTS idx_insights_wf ON insights_raw(workflowId, timestamp);
`;

/** Executions counted by insights: production runs only, like n8n (no manual, sub-workflow or evaluation runs). */
const COUNTED_MODES = new Set(['trigger', 'webhook', 'retry', 'cli', 'internal']);

interface Totals {
  total: number;
  failed: number;
  runtimeMs: number;
  timeSavedMin: number;
}

export interface InsightsSummary {
  total: { value: number; deviation: number | null };
  failed: { value: number; deviation: number | null };
  failureRate: { value: number; deviation: number | null };
  timeSaved: { value: number; deviation: number | null };
  averageRunTime: { value: number; deviation: number | null };
}

const DAY = 86_400_000;

export class InsightsService {
  constructor(
    private readonly database: Database,
    readonly maxAgeDays = Number(process.env.N8N_INSIGHTS_MAX_AGE_DAYS ?? 365),
  ) {
    database.db.exec(INSIGHTS_SCHEMA);
  }

  /** Records finished production executions from the event bus. */
  attach(bus: EventBus) {
    return bus.on((e: BusEvent) => {
      if (e.eventName !== 'n8n.workflow.success' && e.eventName !== 'n8n.workflow.failed') return;
      const p = e.payload;
      if (!p.workflowId || !COUNTED_MODES.has(String(p.mode))) return;
      const status = e.eventName === 'n8n.workflow.success' ? 'success' : 'failure';
      const saved = Number(p.timeSavedPerExecution ?? 0);
      this.record({ workflowId: String(p.workflowId), workflowName: String(p.workflowName ?? ''), status, runtimeMs: Number(p.runtimeMs ?? 0), timeSavedMin: status === 'success' ? saved : 0, timestamp: e.ts });
    });
  }

  record(r: { workflowId: string; workflowName: string; status: 'success' | 'failure'; runtimeMs: number; timeSavedMin: number; timestamp?: string }) {
    this.database.db
      .prepare('INSERT INTO insights_raw (workflowId, workflowName, status, runtimeMs, timeSavedMin, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.workflowId, r.workflowName, r.status, Math.round(r.runtimeMs), r.timeSavedMin, r.timestamp ?? new Date().toISOString());
  }

  prune(now = Date.now()) {
    this.database.db.prepare('DELETE FROM insights_raw WHERE timestamp < ?').run(new Date(now - this.maxAgeDays * DAY).toISOString());
  }

  private totals(from: string, to: string, workflowId?: string): Totals {
    const row = this.database.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(status = 'failure') AS failed, SUM(runtimeMs) AS runtimeMs, SUM(timeSavedMin) AS timeSavedMin
         FROM insights_raw WHERE timestamp >= ? AND timestamp < ?${workflowId ? ' AND workflowId = ?' : ''}`,
      )
      .get(...[from, to, ...(workflowId ? [workflowId] : [])]) as Record<string, number | null>;
    return { total: Number(row.total ?? 0), failed: Number(row.failed ?? 0), runtimeMs: Number(row.runtimeMs ?? 0), timeSavedMin: Number(row.timeSavedMin ?? 0) };
  }

  /** The last `days` days against the `days` before them. */
  summary(days: number, now = Date.now()): InsightsSummary {
    // the end is inclusive: an execution recorded this millisecond counts
    const end = new Date(now + 1).toISOString();
    const start = new Date(now - days * DAY).toISOString();
    const prevStart = new Date(now - 2 * days * DAY).toISOString();
    const cur = this.totals(start, end);
    const prev = this.totals(prevStart, start);
    const rate = (t: Totals) => (t.total ? t.failed / t.total : 0);
    const avg = (t: Totals) => (t.total ? t.runtimeMs / t.total : 0);
    const dev = (a: number, b: number, hasPrev: boolean) => (hasPrev ? a - b : null);
    const has = prev.total > 0;
    return {
      total: { value: cur.total, deviation: dev(cur.total, prev.total, has) },
      failed: { value: cur.failed, deviation: dev(cur.failed, prev.failed, has) },
      failureRate: { value: rate(cur), deviation: dev(rate(cur), rate(prev), has) },
      timeSaved: { value: cur.timeSavedMin, deviation: dev(cur.timeSavedMin, prev.timeSavedMin, has) },
      averageRunTime: { value: avg(cur), deviation: dev(avg(cur), avg(prev), has) },
    };
  }

  byWorkflow(days: number, sortBy = 'total:desc', now = Date.now()) {
    const [field, dir] = sortBy.split(':');
    const columns: Record<string, string> = { total: 'total', failed: 'failed', failureRate: 'failureRate', timeSaved: 'timeSaved', averageRunTime: 'averageRunTime', runTime: 'runTime', workflowName: 'workflowName' };
    const order = `${columns[field] ?? 'total'} ${dir === 'asc' ? 'ASC' : 'DESC'}`;
    return this.database.db
      .prepare(
        `SELECT workflowId, MAX(workflowName) AS workflowName, COUNT(*) AS total, SUM(status = 'success') AS succeeded, SUM(status = 'failure') AS failed,
                CAST(SUM(status = 'failure') AS REAL) / COUNT(*) AS failureRate, SUM(runtimeMs) AS runTime, AVG(runtimeMs) AS averageRunTime, SUM(timeSavedMin) AS timeSaved
         FROM insights_raw WHERE timestamp >= ? AND timestamp < ? GROUP BY workflowId ORDER BY ${order}`,
      )
      .all(new Date(now - days * DAY).toISOString(), new Date(now + 1).toISOString());
  }

  /** One bucket per day (UTC), including empty days. */
  byTime(days: number, now = Date.now()) {
    const rows = this.database.db
      .prepare(
        `SELECT substr(timestamp, 1, 10) AS date, COUNT(*) AS total, SUM(status = 'success') AS succeeded, SUM(status = 'failure') AS failed,
                AVG(runtimeMs) AS averageRunTime, SUM(timeSavedMin) AS timeSaved
         FROM insights_raw WHERE timestamp >= ? AND timestamp < ? GROUP BY date`,
      )
      .all(new Date(now - days * DAY).toISOString(), new Date(now + 1).toISOString()) as Array<Record<string, number | string>>;
    const byDate = new Map(rows.map((r) => [String(r.date), r]));
    const out = [];
    for (let d = days - 1; d >= 0; d--) {
      const date = new Date(now - d * DAY).toISOString().slice(0, 10);
      const r = byDate.get(date);
      const total = Number(r?.total ?? 0);
      out.push({
        date,
        total,
        succeeded: Number(r?.succeeded ?? 0),
        failed: Number(r?.failed ?? 0),
        failureRate: total ? Number(r?.failed ?? 0) / total : 0,
        averageRunTime: Number(r?.averageRunTime ?? 0),
        timeSaved: Number(r?.timeSaved ?? 0),
      });
    }
    return out;
  }
}
