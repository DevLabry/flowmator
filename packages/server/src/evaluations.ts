import { httpRequest, type ICredentialsHelper } from '@flowmator/core';
import { collectMetrics, EVALUATION_NODE, EVALUATION_TRIGGER, evaluationDataset } from '@flowmator/nodes-base';
import type { DataTableRow, IDataObject, IHelpers, INode, IRun } from '@flowmator/workflow';
import { newId, type Database } from './db';
import type { DataTableService } from './data-tables';
import type { ExecutionService } from './execution-service';

export const EVALUATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY,
  workflowId TEXT NOT NULL,
  status TEXT NOT NULL,
  runAt TEXT,
  completedAt TEXT,
  metrics TEXT,
  errorCode TEXT,
  errorDetails TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_runs_workflow ON test_runs (workflowId, createdAt);
CREATE TABLE IF NOT EXISTS test_case_executions (
  id TEXT PRIMARY KEY,
  testRunId TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  executionId TEXT,
  status TEXT NOT NULL,
  runAt TEXT,
  completedAt TEXT,
  metrics TEXT,
  inputs TEXT,
  errorCode TEXT,
  errorDetails TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_cases_run ON test_case_executions (testRunId, createdAt);
`;

export type TestRunStatus = 'new' | 'running' | 'completed' | 'error' | 'cancelled';
export type TestCaseStatus = 'new' | 'running' | 'success' | 'error' | 'cancelled';

export interface TestRun {
  id: string;
  workflowId: string;
  status: TestRunStatus;
  runAt: string | null;
  completedAt: string | null;
  metrics: Record<string, number> | null;
  errorCode: string | null;
  errorDetails: IDataObject | null;
  createdAt: string;
  updatedAt: string;
  /** Counts by status, for the runs list */
  finalResult?: 'success' | 'error' | 'warning' | null;
}

export interface TestCaseExecution {
  id: string;
  testRunId: string;
  executionId: string | null;
  status: TestCaseStatus;
  runAt: string | null;
  completedAt: string | null;
  metrics: Record<string, number> | null;
  inputs: DataTableRow | null;
  errorCode: string | null;
  errorDetails: IDataObject | null;
  createdAt: string;
}

export class EvaluationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

type Row = Record<string, unknown>;
const json = <T>(v: unknown): T | null => (typeof v === 'string' && v ? (JSON.parse(v) as T) : null);
const now = () => new Date().toISOString();

/** Averages each metric over the cases that recorded it. */
export function averageMetrics(cases: Array<Record<string, number>>): Record<string, number> {
  const sums: Record<string, { total: number; count: number }> = {};
  for (const metrics of cases) {
    for (const [k, v] of Object.entries(metrics)) {
      sums[k] ??= { total: 0, count: 0 };
      sums[k].total += v;
      sums[k].count++;
    }
  }
  return Object.fromEntries(Object.entries(sums).map(([k, { total, count }]) => [k, total / count]));
}

/**
 * Evaluations ("test runs"): the workflow runs once per dataset row from its Evaluation Trigger,
 * in mode "evaluation", and each run's Set Metrics outputs are averaged into the test run's metrics.
 */
export class EvaluationService {
  /** Test run id → cancel flag and the execution in flight */
  private readonly active = new Map<string, { cancelled: boolean; executionId?: string; promise: Promise<void> }>();

  constructor(
    private readonly database: Database,
    private readonly executions: ExecutionService,
    private readonly dataTables: DataTableService,
    /** Only main runs evaluations; workers and webhook processes share the database and must not touch them. */
    recover = true,
    /** Lets the trigger's credentials read datasets that live outside Flowmator (Google Sheets) */
    private readonly credentialsHelper?: ICredentialsHelper,
  ) {
    database.db.exec(EVALUATION_SCHEMA);
    if (!recover) return;
    // a restart leaves runs that were in progress without a runner
    database.db.prepare("UPDATE test_runs SET status = 'cancelled', completedAt = ?, updatedAt = ? WHERE status IN ('new', 'running')").run(now(), now());
    database.db.prepare("UPDATE test_case_executions SET status = 'cancelled', completedAt = ? WHERE status IN ('new', 'running')").run(now());
  }

  private get db() {
    return this.database.db;
  }

  private toRun(r: Row): TestRun {
    return {
      id: r.id as string,
      workflowId: r.workflowId as string,
      status: r.status as TestRunStatus,
      runAt: (r.runAt as string) ?? null,
      completedAt: (r.completedAt as string) ?? null,
      metrics: json(r.metrics),
      errorCode: (r.errorCode as string) ?? null,
      errorDetails: json(r.errorDetails),
      createdAt: r.createdAt as string,
      updatedAt: r.updatedAt as string,
    };
  }

  private toCase(r: Row): TestCaseExecution {
    return {
      id: r.id as string,
      testRunId: r.testRunId as string,
      executionId: (r.executionId as string) ?? null,
      status: r.status as TestCaseStatus,
      runAt: (r.runAt as string) ?? null,
      completedAt: (r.completedAt as string) ?? null,
      metrics: json(r.metrics),
      inputs: json(r.inputs),
      errorCode: (r.errorCode as string) ?? null,
      errorDetails: json(r.errorDetails),
      createdAt: r.createdAt as string,
    };
  }

  /** Newest first, with an overall result once finished. */
  listRuns(workflowId: string): TestRun[] {
    const runs = (this.db.prepare('SELECT * FROM test_runs WHERE workflowId = ? ORDER BY createdAt DESC, rowid DESC').all(workflowId) as Row[]).map((r) => this.toRun(r));
    const counts = this.db.prepare('SELECT status, COUNT(*) AS n FROM test_case_executions WHERE testRunId = ? GROUP BY status');
    for (const run of runs) {
      if (run.status !== 'completed') continue;
      const byStatus = Object.fromEntries((counts.all(run.id) as Row[]).map((c) => [c.status, Number(c.n)]));
      run.finalResult = byStatus.error ? (byStatus.success ? 'warning' : 'error') : 'success';
    }
    return runs;
  }

  getRun(workflowId: string, id: string): TestRun | null {
    const r = this.db.prepare('SELECT * FROM test_runs WHERE id = ? AND workflowId = ?').get(id, workflowId) as Row | undefined;
    return r ? this.toRun(r) : null;
  }

  listCases(testRunId: string): TestCaseExecution[] {
    return (this.db.prepare('SELECT * FROM test_case_executions WHERE testRunId = ? ORDER BY createdAt, rowid').all(testRunId) as Row[]).map((r) => this.toCase(r));
  }

  /** Authenticated requests with a node's credentials, outside an execution. */
  private helpersFor(node: INode): IHelpers | undefined {
    const helper = this.credentialsHelper;
    if (!helper) return undefined;
    return {
      httpRequest,
      async httpRequestWithAuthentication(type, options) {
        const credentials = await helper.getDecrypted(node, type);
        return httpRequest(await helper.authenticate(type, credentials, { ...options }, node));
      },
    } as Partial<IHelpers> as IHelpers;
  }

  private updateRun(id: string, fields: Partial<Record<'status' | 'runAt' | 'completedAt' | 'metrics' | 'errorCode' | 'errorDetails', string | null>>) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE test_runs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updatedAt = ? WHERE id = ?`).run(...keys.map((k) => fields[k as keyof typeof fields] ?? null), now(), id);
  }

  private updateCase(id: string, fields: Partial<Record<'status' | 'executionId' | 'completedAt' | 'metrics' | 'errorCode' | 'errorDetails', string | null>>) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE test_case_executions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k as keyof typeof fields] ?? null), id);
  }

  /** Creates the test run and starts it in the background; `done` settles when it finishes. */
  startRun(workflowId: string): { run: TestRun; done: Promise<void> } {
    const workflow = this.database.getWorkflow(workflowId);
    if (!workflow) throw new EvaluationError('Workflow not found', 404);
    const trigger = workflow.nodes.find((n) => n.type === EVALUATION_TRIGGER && !n.disabled);
    if (!trigger) throw new EvaluationError('Add an Evaluation Trigger ("When fetching a dataset row") to the workflow first');
    if (!workflow.nodes.some((n) => n.type === EVALUATION_NODE && !n.disabled && n.parameters.operation === 'setMetrics')) {
      throw new EvaluationError('Add an Evaluation node with the "Set Metrics" operation so the run has something to measure');
    }
    if ([...this.active.keys()].some((id) => this.getRun(workflowId, id))) throw new EvaluationError('An evaluation is already running for this workflow', 409);

    const id = newId();
    const at = now();
    this.db.prepare("INSERT INTO test_runs (id, workflowId, status, runAt, createdAt, updatedAt) VALUES (?, ?, 'running', ?, ?, ?)").run(id, workflowId, at, at, at);
    const state: { cancelled: boolean; executionId?: string; promise: Promise<void> } = { cancelled: false, promise: Promise.resolve() };
    this.active.set(id, state);

    state.promise = (async () => {
      try {
        const { rows } = await evaluationDataset(this.dataTables, trigger, this.helpersFor(trigger));
        if (!rows.length) {
          this.updateRun(id, { status: 'error', completedAt: now(), errorCode: 'EVALUATION_DATASET_EMPTY', errorDetails: JSON.stringify({ message: 'The dataset has no rows' }) });
          return;
        }
        const caseIds = rows.map((row) => {
          const caseId = newId();
          this.db.prepare("INSERT INTO test_case_executions (id, testRunId, status, inputs, createdAt) VALUES (?, ?, 'new', ?, ?)").run(caseId, id, JSON.stringify(row), now());
          return caseId;
        });
        const metrics: Array<Record<string, number>> = [];
        for (let i = 0; i < rows.length; i++) {
          if (state.cancelled) break;
          this.db.prepare("UPDATE test_case_executions SET status = 'running', runAt = ? WHERE id = ?").run(now(), caseIds[i]);
          // the workflow is read again for every case, so saved edits apply to the next row
          const workflowData = this.database.getWorkflow(workflowId) ?? workflow;
          const { executionId, promise } = this.executions.run({ workflowData, mode: 'evaluation', startNode: trigger.name, triggerData: [{ json: rows[i] as IDataObject }] });
          state.executionId = executionId;
          this.updateCase(caseIds[i], { executionId });
          let run: IRun;
          try {
            run = await promise;
          } catch (e) {
            run = { status: 'error', mode: 'evaluation', startedAt: new Date(), data: { resultData: { runData: {}, error: { message: (e as Error).message } } } };
          }
          state.executionId = undefined;
          if (state.cancelled || run.status === 'canceled') {
            this.updateCase(caseIds[i], { status: 'cancelled', completedAt: now() });
            break;
          }
          const caseMetrics = collectMetrics(workflowData.nodes, (run.data?.resultData?.runData ?? {}) as Parameters<typeof collectMetrics>[1]);
          const error = run.data?.resultData?.error;
          if (run.status !== 'success' || error) {
            this.updateCase(caseIds[i], { status: 'error', completedAt: now(), errorCode: 'FAILED_TO_EXECUTE_WORKFLOW', errorDetails: JSON.stringify({ message: error?.message ?? `Execution ${run.status}` }) });
          } else if (!Object.keys(caseMetrics).length) {
            this.updateCase(caseIds[i], { status: 'error', completedAt: now(), errorCode: 'NO_METRICS_COLLECTED', errorDetails: JSON.stringify({ message: 'No Set Metrics node ran for this row' }) });
          } else {
            metrics.push(caseMetrics);
            this.updateCase(caseIds[i], { status: 'success', completedAt: now(), metrics: JSON.stringify(caseMetrics) });
          }
        }
        if (state.cancelled) {
          this.db.prepare("UPDATE test_case_executions SET status = 'cancelled', completedAt = ? WHERE testRunId = ? AND status IN ('new', 'running')").run(now(), id);
          this.updateRun(id, { status: 'cancelled', completedAt: now(), metrics: JSON.stringify(averageMetrics(metrics)) });
          return;
        }
        if (!metrics.length) {
          this.updateRun(id, { status: 'error', completedAt: now(), errorCode: 'TEST_CASES_FAILED', errorDetails: JSON.stringify({ message: 'Every test case failed' }) });
          return;
        }
        this.updateRun(id, { status: 'completed', completedAt: now(), metrics: JSON.stringify(averageMetrics(metrics)) });
      } catch (e) {
        this.updateRun(id, { status: 'error', completedAt: now(), errorCode: 'UNKNOWN_ERROR', errorDetails: JSON.stringify({ message: (e as Error).message }) });
      } finally {
        this.active.delete(id);
      }
    })();

    return { run: this.getRun(workflowId, id)!, done: state.promise };
  }

  async cancelRun(workflowId: string, id: string) {
    const run = this.getRun(workflowId, id);
    if (!run) throw new EvaluationError('Test run not found', 404);
    const state = this.active.get(id);
    if (!state) return run;
    state.cancelled = true;
    if (state.executionId) await this.executions.stop(state.executionId).catch(() => {});
    await state.promise;
    return this.getRun(workflowId, id)!;
  }

  deleteRun(workflowId: string, id: string) {
    if (!this.getRun(workflowId, id)) throw new EvaluationError('Test run not found', 404);
    if (this.active.has(id)) throw new EvaluationError('Cancel the test run before deleting it', 409);
    this.db.prepare('DELETE FROM test_case_executions WHERE testRunId = ?').run(id);
    this.db.prepare('DELETE FROM test_runs WHERE id = ?').run(id);
  }

  /** Lets the server shut down without leaving runs marked as running. */
  async stopAll() {
    await Promise.all([...this.active.keys()].map(async (id) => {
      const state = this.active.get(id);
      if (!state) return;
      state.cancelled = true;
      if (state.executionId) await this.executions.stop(state.executionId).catch(() => {});
      await state.promise;
    }));
  }
}
