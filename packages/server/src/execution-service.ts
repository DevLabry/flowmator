import {
  FilesystemBinaryDataStore,
  WorkflowExecute,
  type IWorkflowExecuteAdditionalData,
  type NodeTypesRegistry,
} from '@flowmator/core';
import {
  Workflow,
  type ExecutionMode,
  type IDataObject,
  type IDataTableService,
  type IExecuteData,
  type IExecuteWorkflowInfo,
  type IExecutionState,
  type INodeExecutionData,
  type IPinData,
  type IRun,
  type IRunData,
  type IWebhookResponse,
  type IWorkflowBase,
} from '@flowmator/workflow';
import type { ServerConfig } from './config';
import type { CredentialsHelper } from './credentials';
import type { Database, ExecutionEntity } from './db';
import type { EventBus } from './events';
import type { PushSender } from './push';
import type { ExecutionJob, JobResult, ScalingMessage, ScalingService } from './scaling';

export interface RunRequest {
  workflowData: IWorkflowBase;
  mode: ExecutionMode;
  startNode?: string;
  destinationNode?: string;
  triggerData?: INodeExecutionData[];
  /** Partial re-run: previous run data plus nodes changed since. */
  runData?: IRunData;
  dirtyNodes?: string[];
  pinData?: IPinData;
  retryOf?: string;
  /** Editor session that should get live updates */
  pushRef?: string;
  /** Respond to Webhook / responseNode mode */
  onResponse?: (response: IWebhookResponse) => void;
  parentExecutionId?: string;
}

/** The part of a RunRequest a worker needs; the workflow itself is stored with the execution. */
export type QueuedRunRequest = Omit<RunRequest, 'workflowData' | 'onResponse'> & { respond?: boolean };

/**
 * main: editor, API, triggers and the wait/prune timers. worker: only runs queued executions.
 * webhook: only receives production webhooks (queue mode).
 */
export type ProcessRole = 'main' | 'worker' | 'webhook';

export interface RunningExecution {
  id: string;
  workflowId?: string;
  mode: ExecutionMode;
  startedAt: Date;
  abort: AbortController;
  promise: Promise<IRun>;
}

interface LocalRun {
  mode: ExecutionMode;
  workflowData: IWorkflowBase;
  pushRef?: string;
  retryOf?: string;
  customData?: IDataObject;
  onResponse?: (response: IWebhookResponse) => void;
  /** Sends executionStarted (not for resumed executions, which the editor already knows) */
  announce: boolean;
}

/** An execution handed to a worker, waiting for its result in this process. */
interface PendingJob {
  resolve: (run: IRun) => void;
  onResponse?: (response: IWebhookResponse) => void;
}

export class ExecutionService {
  private readonly running = new Map<string, RunningExecution>();
  private readonly pending = new Map<string, PendingJob>();
  private readonly waitTimers = new Map<string, NodeJS.Timeout>();
  private waitPoller?: NodeJS.Timeout;
  private prunePoller?: NodeJS.Timeout;
  readonly binaryData: FilesystemBinaryDataStore;
  /** Set by the app context; the Data Table node reads and writes through it. */
  dataTables?: IDataTableService;
  /** Execution and node events for log streaming and insights */
  events?: EventBus;

  constructor(
    private readonly config: ServerConfig,
    private readonly db: Database,
    private readonly push: PushSender,
    private readonly nodeTypes: NodeTypesRegistry,
    readonly credentialsHelper: CredentialsHelper,
    readonly role: ProcessRole = 'main',
    readonly scaling?: ScalingService,
  ) {
    this.binaryData = new FilesystemBinaryDataStore(config.binaryDataDir);
  }

  /** Main process: recovers crashed executions and starts the wait/prune timers. */
  async start() {
    let crashed: number;
    if (this.scaling) {
      await this.connectQueue();
      await this.scaling.onJobCrashed((executionId, reason) => this.onJobCrashed(executionId, reason));
      // executions still queued or on a worker are fine; anything else left running died with its process
      crashed = this.db.markCrashedExecutions(await this.scaling.queuedExecutionIds());
    } else {
      crashed = this.db.markCrashedExecutions();
    }
    if (crashed) console.warn(`Marked ${crashed} unfinished execution(s) as crashed`);
    this.checkWaiting();
    this.waitPoller = setInterval(() => this.checkWaiting(), 30_000);
    this.prunePoller = setInterval(() => this.prune(), 3_600_000);
  }

  /** Main and webhook processes: listen for worker results, webhook responses and editor events. */
  async connectQueue() {
    await this.scaling!.ping();
    await this.scaling!.subscribe((m) => this.onQueueMessage(m));
  }

  /** Worker process: take jobs from the queue. */
  async startWorker(concurrency: number) {
    const scaling = this.scaling!;
    await scaling.ping();
    await scaling.subscribe((m) => {
      if (m.type === 'stop') this.running.get(m.executionId)?.abort.abort();
    });
    return scaling.startWorker(concurrency, (job) => this.processJob(job));
  }

  async stopAll() {
    clearInterval(this.waitPoller);
    clearInterval(this.prunePoller);
    for (const t of this.waitTimers.values()) clearTimeout(t);
    this.waitTimers.clear();
    for (const r of this.running.values()) r.abort.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.promise));
  }

  getRunning() {
    const local = [...this.running.values()].map(({ id, workflowId, mode, startedAt }) => ({ id, workflowId, mode, startedAt, status: 'running' }));
    if (!this.scaling) return local;
    // in queue mode most executions run elsewhere; the database knows about all of them
    const ids = new Set(local.map((r) => r.id));
    const queued = this.db
      .listExecutions({ status: ['new', 'running'], limit: 1000 })
      .results.filter((e) => !ids.has(e.id))
      .map((e) => ({ id: e.id, workflowId: e.workflowId ?? undefined, mode: e.mode, startedAt: new Date(e.startedAt ?? e.createdAt), status: e.status }));
    return [...local, ...queued];
  }

  buildWorkflow(data: IWorkflowBase) {
    return new Workflow({ ...structuredClone(data), nodeTypes: this.nodeTypes });
  }

  private variables(): IDataObject {
    return Object.fromEntries(this.db.listVariables().map((v) => [v.key, v.value]));
  }

  private baseUrl(endpoint: string) {
    return `${this.config.webhookUrl}${endpoint}`;
  }

  /** Main/webhook processes hand production runs to workers; manual runs stay here unless offloaded. */
  private shouldQueue(mode: ExecutionMode) {
    if (!this.scaling || this.role === 'worker') return false;
    // sub-workflows run next to their parent, which is waiting for them
    if (mode === 'integrated') return false;
    return mode !== 'manual' || this.config.queue.offloadManual;
  }

  /** What webhook handlers run with: credentials, data tables, sub-workflows (for tools of an MCP Server Trigger). */
  webhookAdditionalData(mode: ExecutionMode): IWorkflowExecuteAdditionalData {
    return {
      executionId: '',
      mode,
      credentialsHelper: this.credentialsHelper,
      variables: this.variables(),
      timezone: this.config.timezone,
      instanceBaseUrl: this.config.webhookUrl.replace(/\/$/, ''),
      binaryData: this.binaryData,
      dataTables: this.dataTables,
      executeWorkflow: (info, items, options) => this.executeSubWorkflow(info, items, '', options.waitForSubWorkflow),
    };
  }

  private additionalData(executionId: string, req: Pick<LocalRun, 'mode' | 'pushRef' | 'onResponse'>, workflow: Workflow, abort: AbortController): IWorkflowExecuteAdditionalData {
    const pushRef = req.pushRef;
    // manual runs only go to the editor that started them; production runs go to everyone watching
    const target = req.mode === 'manual' ? pushRef : undefined;
    return {
      executionId,
      mode: req.mode,
      credentialsHelper: this.credentialsHelper,
      variables: this.variables(),
      timezone: this.config.timezone,
      instanceBaseUrl: this.config.webhookUrl.replace(/\/$/, ''),
      restApiUrl: this.baseUrl(this.config.endpoints.rest),
      webhookBaseUrl: this.baseUrl(this.config.endpoints.webhook),
      webhookTestBaseUrl: this.baseUrl(this.config.endpoints.webhookTest),
      webhookWaitingBaseUrl: this.baseUrl(this.config.endpoints.webhookWaiting),
      formWaitingBaseUrl: this.baseUrl(this.config.endpoints.formWaiting),
      signal: abort.signal,
      binaryData: this.binaryData,
      dataTables: this.dataTables,
      sendResponse: req.onResponse,
      executionCustomData: {},
      executeWorkflow: (info, items, options) => this.executeSubWorkflow(info, items, executionId, options.waitForSubWorkflow),
      hooks: {
        nodeExecuteBefore: (nodeName) => {
          this.push.send({ type: 'nodeExecuteBefore', data: { executionId, nodeName } }, target);
          this.events?.emit('n8n.node.started', { executionId, workflowId: workflow.id, workflowName: workflow.name, nodeName, nodeType: workflow.getNode(nodeName)?.type });
        },
        nodeExecuteAfter: (nodeName, task, state) => {
          this.push.send({ type: 'nodeExecuteAfter', data: { executionId, nodeName, data: task } }, target);
          this.events?.emit('n8n.node.finished', { executionId, workflowId: workflow.id, workflowName: workflow.name, nodeName, nodeType: workflow.getNode(nodeName)?.type, executionTime: task.executionTime, status: task.error ? 'error' : 'success' });
          if (workflow.settings.saveExecutionProgress) {
            this.db.updateExecution(executionId, { data: { resultData: { runData: state.runData, lastNodeExecuted: state.lastNodeExecuted }, executionData: state } });
          }
        },
        sendMessageToUI: (nodeName, args) => this.push.send({ type: 'sendConsoleMessage', data: { source: `[Node: "${nodeName}"]`, messages: args } }, target),
      },
    };
  }

  /** Starts an execution and returns immediately with its id and a promise for the result. */
  run(req: RunRequest): { executionId: string; promise: Promise<IRun> } {
    const workflowData = { ...req.workflowData, pinData: req.pinData ?? (req.mode === 'manual' ? req.workflowData.pinData : undefined) };
    const queued = this.shouldQueue(req.mode);
    const executionId = this.db.createExecution({ workflowId: workflowData.id, mode: req.mode, status: queued ? 'new' : 'running', workflowData, retryOf: req.retryOf });
    if (queued) {
      const { workflowData: _w, onResponse, ...request } = req;
      return { executionId, promise: this.enqueue({ kind: 'run', executionId, request: { ...request, respond: !!onResponse } }, req.mode, onResponse) };
    }
    return { executionId, promise: this.runLocal(executionId, { ...req, workflowData }) };
  }

  private runLocal(executionId: string, req: RunRequest) {
    return this.startLocal(executionId, { ...req, announce: true }, (engine, workflow) =>
      req.runData && req.destinationNode
        ? engine.runPartial({ workflow, destinationNode: req.destinationNode, runData: req.runData, dirtyNodes: req.dirtyNodes })
        : engine.run({ workflow, startNode: req.startNode, destinationNode: req.destinationNode, triggerData: req.triggerData }),
    );
  }

  /** Runs an execution in this process: engine, live events, saving the result. */
  private startLocal(executionId: string, opts: LocalRun, execute: (engine: WorkflowExecute, workflow: Workflow) => Promise<IRun>): Promise<IRun> {
    const workflow = this.buildWorkflow(opts.workflowData);
    const staticBefore = JSON.stringify(workflow.staticData);
    const abort = new AbortController();
    const additionalData = this.additionalData(executionId, opts, workflow, abort);
    if (opts.customData) Object.assign(additionalData.executionCustomData!, opts.customData);
    const engine = new WorkflowExecute(additionalData);
    const startedAt = new Date();
    const workflowId = opts.workflowData.id;

    if (opts.announce) {
      this.push.send(
        { type: 'executionStarted', data: { executionId, workflowId, workflowName: opts.workflowData.name, mode: opts.mode, startedAt: startedAt.toISOString() } },
        opts.mode === 'manual' ? opts.pushRef : undefined,
      );
    }

    this.events?.emit('n8n.workflow.started', { executionId, workflowId, workflowName: opts.workflowData.name, mode: opts.mode });

    const timeoutSec = workflow.settings.executionTimeout && workflow.settings.executionTimeout > 0 ? workflow.settings.executionTimeout : this.config.executions.timeoutSeconds;
    if (timeoutSec > 0) workflow.settings.executionTimeout = timeoutSec;

    const promise = (async () => {
      let run: IRun;
      try {
        run = await execute(engine, workflow);
      } catch (error) {
        run = {
          status: 'error',
          mode: opts.mode,
          startedAt,
          stoppedAt: new Date(),
          data: { resultData: { runData: {}, error: { message: (error as Error).message, stack: (error as Error).stack } } },
        };
      }
      await this.finish(executionId, workflow, run, opts, additionalData.executionCustomData ?? {}, staticBefore);
      return run;
    })();

    this.running.set(executionId, { id: executionId, workflowId, mode: opts.mode, startedAt, abort, promise });
    promise.finally(() => this.running.delete(executionId));
    return promise;
  }

  private async finish(executionId: string, workflow: Workflow, run: IRun, req: Pick<LocalRun, 'mode' | 'pushRef' | 'retryOf'>, customData: IDataObject, staticBefore: string) {
    if (workflow.id && JSON.stringify(workflow.staticData) !== staticBefore && this.db.getWorkflow(workflow.id)) {
      this.db.saveStaticData(workflow.id, workflow.staticData);
    }

    const settings = workflow.settings;
    const keep =
      run.status === 'waiting' ||
      (req.mode === 'manual' ? (settings.saveManualExecutions ?? this.config.executions.saveManual) : true) &&
        (run.status === 'success' ? settings.saveDataSuccessExecution !== 'none' : settings.saveDataErrorExecution !== 'none');

    if (keep) {
      this.db.updateExecution(executionId, {
        status: run.status,
        stoppedAt: run.status === 'waiting' ? null : (run.stoppedAt ?? new Date()),
        waitTill: run.waitTill ?? null,
        data: run.data,
        customData,
      });
    } else {
      this.db.deleteExecutions([executionId]);
    }
    if (req.retryOf && run.status === 'success') this.db.updateExecution(req.retryOf, { retrySuccessId: executionId });

    const target = req.mode === 'manual' ? req.pushRef : undefined;
    if (run.status === 'waiting') {
      this.push.send({ type: 'executionWaiting', data: { executionId, waitTill: run.waitTill?.toISOString() } }, target);
      // on a worker, main picks the wait up from the job result
      if (run.waitTill && this.role === 'main') this.scheduleResume(executionId, run.waitTill);
    }
    this.push.send(
      { type: 'executionFinished', data: { executionId, workflowId: workflow.id, status: run.status, lastNodeExecuted: run.data.resultData.lastNodeExecuted } },
      target,
    );

    const eventName = { success: 'n8n.workflow.success', error: 'n8n.workflow.failed', crashed: 'n8n.workflow.failed', canceled: 'n8n.workflow.cancelled', waiting: 'n8n.workflow.waiting' }[run.status as string];
    if (eventName) {
      const started = new Date(run.startedAt).getTime();
      const stopped = run.stoppedAt ? new Date(run.stoppedAt).getTime() : Date.now();
      this.events?.emit(eventName, {
        executionId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        mode: req.mode,
        status: run.status,
        runtimeMs: Math.max(0, stopped - started),
        lastNodeExecuted: run.data.resultData.lastNodeExecuted,
        ...(run.data.resultData.error ? { errorMessage: run.data.resultData.error.message } : {}),
        timeSavedPerExecution: workflow.settings.timeSavedPerExecution ?? 0,
      });
    }

    if (run.status === 'error' && req.mode !== 'manual' && req.mode !== 'error') this.runErrorWorkflow(executionId, workflow, run);
  }

  /** Starts the workflow's configured error workflow with details of the failure. */
  private runErrorWorkflow(executionId: string, workflow: Workflow, run: IRun) {
    const errorWorkflowId = workflow.settings.errorWorkflow;
    if (!errorWorkflowId) return;
    const target = this.db.getWorkflow(errorWorkflowId);
    if (!target) return console.warn(`Error workflow ${errorWorkflowId} not found`);
    const errorNode = target.nodes.find((n) => n.type.endsWith('errorTrigger') && !n.disabled);
    if (!errorNode) return console.warn(`Error workflow "${target.name}" has no Error Trigger node`);
    const item = {
      json: {
        execution: {
          id: executionId,
          url: `${this.config.webhookUrl}workflow/${workflow.id}/executions/${executionId}`,
          error: run.data.resultData.error,
          lastNodeExecuted: run.data.resultData.lastNodeExecuted,
          mode: run.mode,
        },
        workflow: { id: workflow.id, name: workflow.name },
      } as IDataObject,
    };
    this.run({ workflowData: target, mode: 'error', startNode: errorNode.name, triggerData: [item] });
  }

  private async executeSubWorkflow(info: IExecuteWorkflowInfo, items: INodeExecutionData[], parentExecutionId: string, wait: boolean) {
    let data: IWorkflowBase;
    if (info.code) data = info.code;
    else {
      const wf = info.id ? this.db.getWorkflow(info.id) : null;
      if (!wf) throw new Error(`Workflow with ID "${info.id}" does not exist`);
      data = wf;
    }
    const startNode = data.nodes.find((n) => n.type.endsWith('executeWorkflowTrigger') && !n.disabled)?.name;
    const { executionId, promise } = this.run({ workflowData: data, mode: 'integrated', startNode, triggerData: items, parentExecutionId: parentExecutionId || undefined });
    if (!wait) return { data: [items], executionId };
    const run = await promise;
    if (run.status === 'error') {
      const err = new Error(run.data.resultData.error?.message ?? 'Sub-workflow failed');
      (err as Error & { description?: string }).description = `Error in sub-workflow "${data.name}" (execution ${executionId})`;
      throw err;
    }
    const last = run.data.resultData.lastNodeExecuted;
    const output = last ? run.data.resultData.runData[last]?.at(-1)?.data?.main : undefined;
    return { data: (output?.filter(Boolean) as INodeExecutionData[][]) ?? null, executionId };
  }

  /* ---------- queue mode ---------- */

  /** Hands an execution to the workers; the promise settles when one of them reports back. */
  private enqueue(job: ExecutionJob, mode: ExecutionMode, onResponse?: (response: IWebhookResponse) => void): Promise<IRun> {
    const promise = new Promise<IRun>((resolve) => this.pending.set(job.executionId, { resolve, onResponse }));
    // manual runs jump the queue: someone is watching the canvas
    this.scaling!.enqueue(job, mode === 'manual' ? 1 : undefined).catch((e) => {
      this.db.updateExecution(job.executionId, { status: 'crashed', stoppedAt: new Date() });
      this.settle(job.executionId, { executionId: job.executionId, status: 'crashed' }, { resultData: { runData: {}, error: { message: `Could not queue the execution: ${(e as Error).message}` } } });
    });
    return promise;
  }

  /** Builds the result for whoever waits on a queued execution (from the database, or the message when it wasn't saved). */
  private settle(executionId: string, result: JobResult, data?: IRun['data']) {
    const waiting = this.pending.get(executionId);
    if (!waiting) return;
    this.pending.delete(executionId);
    const row = this.db.getExecution(executionId);
    waiting.resolve({
      status: row?.status ?? result.status,
      mode: row?.mode ?? 'webhook',
      startedAt: new Date(row?.startedAt ?? Date.now()),
      stoppedAt: row?.stoppedAt ? new Date(row.stoppedAt) : new Date(),
      waitTill: result.waitTill ? new Date(result.waitTill) : undefined,
      data: data ?? row?.data ?? { resultData: { runData: {} } },
    });
  }

  private onQueueMessage(m: ScalingMessage) {
    switch (m.type) {
      case 'push':
        if (this.role === 'main') this.push.send(m.event, m.pushRef);
        break;
      case 'respond':
        this.pending.get(m.executionId)?.onResponse?.(m.response);
        break;
      case 'finished':
        if (m.result.status === 'waiting' && m.result.waitTill && this.role === 'main') this.scheduleResume(m.executionId, new Date(m.result.waitTill));
        this.settle(m.executionId, m.result, m.data);
        break;
    }
  }

  private onJobCrashed(executionId: string, reason: string) {
    console.warn(`Execution ${executionId} crashed on its worker: ${reason}`);
    const row = this.db.getExecution(executionId);
    if (row && (row.status === 'running' || row.status === 'new')) this.db.updateExecution(executionId, { status: 'crashed', stoppedAt: new Date() });
    this.settle(executionId, { executionId, status: 'crashed' });
  }

  /** Worker: runs one job and reports the outcome. Never throws, so BullMQ only sees real crashes. */
  private async processJob(job: ExecutionJob): Promise<JobResult> {
    const scaling = this.scaling!;
    const { executionId } = job;
    let run: IRun | undefined;
    try {
      run = await this.runJob(job, (response) => void scaling.publish({ type: 'respond', executionId, response }));
    } catch (e) {
      console.error(`Execution ${executionId} could not run:`, (e as Error).message);
      const row = this.db.getExecution(executionId);
      if (row && (row.status === 'new' || row.status === 'running')) this.db.updateExecution(executionId, { status: 'crashed', stoppedAt: new Date() });
    }
    const row = this.db.getExecution(executionId);
    const result: JobResult = { executionId, status: run?.status ?? row?.status ?? 'crashed', waitTill: run?.waitTill?.toISOString() ?? null };
    await scaling.publish({ type: 'finished', executionId, result, data: row ? undefined : run?.data });
    return result;
  }

  /** Runs a queued job in this process (worker side of enqueue). */
  runJob(job: ExecutionJob, onResponse?: (response: IWebhookResponse) => void): Promise<IRun> {
    switch (job.kind) {
      case 'resume':
        return this.resumeLocal(job.executionId, job.resumeData, true);
      case 'retry':
        return this.retryLocal(job.executionId, job.retryOf);
      case 'run': {
        const row = this.db.getExecution(job.executionId);
        if (!row) throw new Error(`Execution ${job.executionId} not found`);
        if (row.status !== 'new') throw new Error(`Execution ${job.executionId} was already started (status: ${row.status})`);
        this.db.updateExecution(job.executionId, { status: 'running', startedAt: new Date() });
        const { respond, ...request } = job.request;
        return this.runLocal(job.executionId, { ...request, workflowData: row.workflowData, onResponse: respond ? onResponse : undefined });
      }
    }
  }

  /* ---------- waiting executions ---------- */

  private checkWaiting() {
    for (const { id, waitTill } of this.db.dueWaitingExecutions(70_000)) this.scheduleResume(id, new Date(waitTill));
  }

  private scheduleResume(executionId: string, waitTill: Date) {
    const ms = waitTill.getTime() - Date.now();
    if (ms > 70_000 || this.waitTimers.has(executionId)) return; // picked up later by the poller
    const timer = setTimeout(() => {
      this.waitTimers.delete(executionId);
      this.resume(executionId).catch((e) => console.error(`Failed to resume execution ${executionId}:`, e));
    }, Math.max(0, ms));
    this.waitTimers.set(executionId, timer);
  }

  /** Continues a waiting execution. `resumeData` is what a resume webhook/form received. */
  async resume(executionId: string, resumeData?: INodeExecutionData[]): Promise<IRun> {
    const timer = this.waitTimers.get(executionId);
    if (timer) {
      clearTimeout(timer);
      this.waitTimers.delete(executionId);
    }
    const execution = this.waitingExecution(executionId);
    if (this.shouldQueue(execution.mode)) {
      // claim it now so a second resume (timer + webhook) can't queue it twice
      this.db.updateExecution(executionId, { status: 'new', waitTill: null });
      return this.enqueue({ kind: 'resume', executionId, resumeData }, execution.mode);
    }
    return this.resumeLocal(executionId, resumeData, false);
  }

  private waitingExecution(executionId: string, claimed = false): ExecutionEntity {
    const execution = this.db.getExecution(executionId);
    if (!execution) throw new Error(`Execution ${executionId} not found`);
    if (execution.status !== (claimed ? 'new' : 'waiting')) throw new Error(`Execution ${executionId} is not waiting (status: ${execution.status})`);
    if (!execution.data?.executionData) throw new Error(`Execution ${executionId} has no saved state`);
    return execution;
  }

  private resumeLocal(executionId: string, resumeData: INodeExecutionData[] | undefined, claimed: boolean) {
    const execution = this.waitingExecution(executionId, claimed);
    const state = execution.data!.executionData!;
    this.db.updateExecution(executionId, { status: 'running', waitTill: null });
    return this.startLocal(executionId, { mode: execution.mode, workflowData: execution.workflowData, customData: execution.customData, announce: false }, (engine, workflow) =>
      engine.resume(workflow, state, resumeData),
    );
  }

  /** Waiting executions are paused at a node; returns that node's name. */
  getWaitingNode(executionId: string): { execution: ExecutionEntity; nodeName: string } | null {
    const execution = this.db.getExecution(executionId);
    const nodeName = execution?.data?.executionData?.nodeExecutionStack[0]?.node.name;
    if (!execution || execution.status !== 'waiting' || !nodeName) return null;
    return { execution, nodeName };
  }

  /* ---------- stop / retry ---------- */

  async stop(executionId: string) {
    const running = this.running.get(executionId);
    if (running) {
      running.abort.abort();
      await running.promise.catch(() => {});
      return { status: 'canceled' };
    }
    const execution = this.db.getExecution(executionId);
    if (this.scaling && execution && (execution.status === 'new' || execution.status === 'running')) {
      const job = await this.scaling.findPendingJob(executionId);
      if (job) {
        // not picked up yet: take it off the queue
        await job.remove();
        this.db.updateExecution(executionId, { status: 'canceled', stoppedAt: new Date() });
        this.settle(executionId, { executionId, status: 'canceled' });
        return { status: 'canceled' };
      }
      await this.scaling.publish({ type: 'stop', executionId });
      await this.waitForStatusChange(executionId, 10_000);
      return { status: 'canceled' };
    }
    if (execution?.status === 'waiting') {
      const timer = this.waitTimers.get(executionId);
      if (timer) clearTimeout(timer);
      this.waitTimers.delete(executionId);
      this.db.updateExecution(executionId, { status: 'canceled', stoppedAt: new Date(), waitTill: null });
      return { status: 'canceled' };
    }
    throw new Error(`Execution ${executionId} is not running`);
  }

  private async waitForStatusChange(executionId: string, timeoutMs: number) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const status = this.db.getExecution(executionId)?.status;
      if (status !== 'running' && status !== 'new') return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Re-runs a failed execution from the node that failed, reusing the data of nodes that succeeded. */
  async retry(executionId: string, loadWorkflow: boolean): Promise<IRun> {
    const execution = this.db.getExecution(executionId);
    if (!execution) throw new Error('Execution not found');
    if (!['error', 'crashed', 'canceled'].includes(execution.status)) throw new Error('Only failed executions can be retried');
    let workflowData = execution.workflowData;
    if (loadWorkflow && execution.workflowId) {
      const wf = this.db.getWorkflow(execution.workflowId);
      if (wf) workflowData = wf;
    }
    const queued = this.shouldQueue('retry');
    const newId = this.db.createExecution({ workflowId: workflowData.id, mode: 'retry', status: queued ? 'new' : 'running', workflowData, retryOf: executionId });
    if (queued) return this.enqueue({ kind: 'retry', executionId: newId, retryOf: executionId }, 'retry');
    return this.retryLocal(newId, executionId);
  }

  /** `executionId` is the new (retry) execution, whose row holds the workflow to run. */
  private retryLocal(executionId: string, retryOf: string) {
    const row = this.db.getExecution(executionId);
    const original = this.db.getExecution(retryOf);
    if (!row || !original) throw new Error('Execution not found');
    if (row.status === 'new') this.db.updateExecution(executionId, { status: 'running', startedAt: new Date() });
    const workflowData = row.workflowData;
    const state = original.data?.executionData;
    const opts: LocalRun = { mode: 'retry', workflowData, retryOf, announce: true };
    if (!state) return this.startLocal(executionId, opts, (engine, workflow) => engine.run({ workflow }));

    const retryState: IExecutionState = structuredClone(state);
    const failed = retryState.lastNodeExecuted;
    const failedTask = failed ? retryState.runData[failed]?.at(-1) : undefined;
    if (failed && failedTask?.error) {
      retryState.runData[failed].pop();
      if (!retryState.runData[failed].length) delete retryState.runData[failed];
      const node = workflowData.nodes.find((n) => n.name === failed);
      if (node) {
        const main = failedTask.source.map((src) =>
          src ? (retryState.runData[src.previousNode]?.[src.previousNodeRun ?? 0]?.data?.main?.[src.previousNodeOutput ?? 0] ?? []) : null,
        );
        const execData: IExecuteData = {
          node,
          data: { main: main.length ? main : [original.workflowData.pinData?.[failed] ?? [{ json: {} }]] },
          source: failedTask.source.length ? { main: failedTask.source } : null,
        };
        retryState.nodeExecutionStack.unshift(execData);
      }
    }
    return this.startLocal(executionId, opts, (engine, workflow) => engine.runFromState(workflow, retryState));
  }

  prune() {
    const ids = this.db.pruneExecutions(this.config.executions.pruneAfterHours, this.config.executions.pruneMaxCount);
    for (const id of ids) this.binaryData.deleteForExecution(id).catch(() => {});
    return ids.length;
  }
}
