import {
  FilesystemBinaryDataStore,
  WorkflowExecute,
  type IWorkflowExecuteAdditionalData,
  type NodeTypesRegistry,
} from '@8n8/core';
import {
  Workflow,
  type ExecutionMode,
  type IDataObject,
  type IExecuteData,
  type IExecuteWorkflowInfo,
  type IExecutionState,
  type INodeExecutionData,
  type IPinData,
  type IRun,
  type IRunData,
  type IWebhookResponse,
  type IWorkflowBase,
} from '@8n8/workflow';
import type { ServerConfig } from './config';
import type { CredentialsHelper } from './credentials';
import type { Database } from './db';
import type { Push } from './push';

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

export interface RunningExecution {
  id: string;
  workflowId?: string;
  mode: ExecutionMode;
  startedAt: Date;
  abort: AbortController;
  promise: Promise<IRun>;
}

export class ExecutionService {
  private readonly running = new Map<string, RunningExecution>();
  private readonly waitTimers = new Map<string, NodeJS.Timeout>();
  private waitPoller?: NodeJS.Timeout;
  private prunePoller?: NodeJS.Timeout;
  readonly binaryData: FilesystemBinaryDataStore;

  constructor(
    private readonly config: ServerConfig,
    private readonly db: Database,
    private readonly push: Push,
    private readonly nodeTypes: NodeTypesRegistry,
    readonly credentialsHelper: CredentialsHelper,
  ) {
    this.binaryData = new FilesystemBinaryDataStore(config.binaryDataDir);
  }

  start() {
    const crashed = this.db.markCrashedExecutions();
    if (crashed) console.warn(`Marked ${crashed} unfinished execution(s) as crashed`);
    this.checkWaiting();
    this.waitPoller = setInterval(() => this.checkWaiting(), 30_000);
    this.prunePoller = setInterval(() => this.prune(), 3_600_000);
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
    return [...this.running.values()].map(({ id, workflowId, mode, startedAt }) => ({ id, workflowId, mode, startedAt }));
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

  private additionalData(executionId: string, req: Pick<RunRequest, 'mode' | 'pushRef' | 'onResponse'>, workflow: Workflow, abort: AbortController): IWorkflowExecuteAdditionalData {
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
      sendResponse: req.onResponse,
      executionCustomData: {},
      executeWorkflow: (info, items, options) => this.executeSubWorkflow(info, items, executionId, options.waitForSubWorkflow),
      hooks: {
        nodeExecuteBefore: (nodeName) => this.push.send({ type: 'nodeExecuteBefore', data: { executionId, nodeName } }, target),
        nodeExecuteAfter: (nodeName, task, state) => {
          this.push.send({ type: 'nodeExecuteAfter', data: { executionId, nodeName, data: task } }, target);
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
    const workflow = this.buildWorkflow(workflowData);
    const staticBefore = JSON.stringify(workflow.staticData);
    const executionId = this.db.createExecution({ workflowId: workflowData.id, mode: req.mode, status: 'running', workflowData, retryOf: req.retryOf });
    const abort = new AbortController();
    const additionalData = this.additionalData(executionId, req, workflow, abort);
    const engine = new WorkflowExecute(additionalData);
    const startedAt = new Date();

    this.push.send(
      { type: 'executionStarted', data: { executionId, workflowId: workflowData.id, workflowName: workflowData.name, mode: req.mode, startedAt: startedAt.toISOString() } },
      req.mode === 'manual' ? req.pushRef : undefined,
    );

    const timeoutSec = workflow.settings.executionTimeout && workflow.settings.executionTimeout > 0 ? workflow.settings.executionTimeout : this.config.executions.timeoutSeconds;
    if (timeoutSec > 0) workflow.settings.executionTimeout = timeoutSec;

    const promise = (async () => {
      let run: IRun;
      try {
        if (req.runData && req.destinationNode) {
          run = await engine.runPartial({ workflow, destinationNode: req.destinationNode, runData: req.runData, dirtyNodes: req.dirtyNodes });
        } else {
          run = await engine.run({ workflow, startNode: req.startNode, destinationNode: req.destinationNode, triggerData: req.triggerData });
        }
      } catch (error) {
        run = {
          status: 'error',
          mode: req.mode,
          startedAt,
          stoppedAt: new Date(),
          data: { resultData: { runData: {}, error: { message: (error as Error).message, stack: (error as Error).stack } } },
        };
      }
      await this.finish(executionId, workflow, run, req, additionalData.executionCustomData ?? {}, staticBefore);
      return run;
    })();

    this.running.set(executionId, { id: executionId, workflowId: workflowData.id, mode: req.mode, startedAt, abort, promise });
    promise.finally(() => this.running.delete(executionId));
    return { executionId, promise };
  }

  private async finish(executionId: string, workflow: Workflow, run: IRun, req: Pick<RunRequest, 'mode' | 'pushRef' | 'retryOf'>, customData: IDataObject, staticBefore: string) {
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
      if (run.waitTill) this.scheduleResume(executionId, run.waitTill);
    }
    this.push.send(
      { type: 'executionFinished', data: { executionId, workflowId: workflow.id, status: run.status, lastNodeExecuted: run.data.resultData.lastNodeExecuted } },
      target,
    );

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
    const { executionId, promise } = this.run({ workflowData: data, mode: 'integrated', startNode, triggerData: items, parentExecutionId });
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
    const execution = this.db.getExecution(executionId);
    if (!execution) throw new Error(`Execution ${executionId} not found`);
    if (execution.status !== 'waiting') throw new Error(`Execution ${executionId} is not waiting (status: ${execution.status})`);
    const state = execution.data?.executionData;
    if (!state) throw new Error(`Execution ${executionId} has no saved state`);

    this.db.updateExecution(executionId, { status: 'running', waitTill: null });
    const workflow = this.buildWorkflow(execution.workflowData);
    const abort = new AbortController();
    const req = { mode: execution.mode } as RunRequest;
    const engine = new WorkflowExecute(this.additionalData(executionId, req, workflow, abort));
    const staticBefore = JSON.stringify(workflow.staticData);
    const promise = (async () => {
      const run = await engine.resume(workflow, state, resumeData);
      await this.finish(executionId, workflow, run, req, execution.customData, staticBefore);
      return run;
    })();
    this.running.set(executionId, { id: executionId, workflowId: execution.workflowId ?? undefined, mode: execution.mode, startedAt: new Date(), abort, promise });
    promise.finally(() => this.running.delete(executionId));
    return promise;
  }

  /** Waiting executions are paused at a node; returns that node's name. */
  getWaitingNode(executionId: string): { execution: NonNullable<ReturnType<Database['getExecution']>>; nodeName: string } | null {
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
    if (execution?.status === 'waiting') {
      const timer = this.waitTimers.get(executionId);
      if (timer) clearTimeout(timer);
      this.waitTimers.delete(executionId);
      this.db.updateExecution(executionId, { status: 'canceled', stoppedAt: new Date(), waitTill: null });
      return { status: 'canceled' };
    }
    throw new Error(`Execution ${executionId} is not running`);
  }

  /** Re-runs a failed execution from the node that failed, reusing the data of nodes that succeeded. */
  async retry(executionId: string, loadWorkflow: boolean): Promise<IRun> {
    const execution = this.db.getExecution(executionId);
    if (!execution) throw new Error('Execution not found');
    if (!['error', 'crashed', 'canceled'].includes(execution.status)) throw new Error('Only failed executions can be retried');
    const state = execution.data?.executionData;
    let workflowData = execution.workflowData;
    if (loadWorkflow && execution.workflowId) {
      const wf = this.db.getWorkflow(execution.workflowId);
      if (wf) workflowData = wf;
    }
    if (!state) {
      return this.run({ workflowData, mode: 'retry', retryOf: executionId }).promise;
    }

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
          data: { main: main.length ? main : [execution.workflowData.pinData?.[failed] ?? [{ json: {} }]] },
          source: failedTask.source.length ? { main: failedTask.source } : null,
        };
        retryState.nodeExecutionStack.unshift(execData);
      }
    }

    const workflow = this.buildWorkflow(workflowData);
    const newId = this.db.createExecution({ workflowId: workflowData.id, mode: 'retry', status: 'running', workflowData, retryOf: executionId });
    const abort = new AbortController();
    const req = { mode: 'retry' as const, retryOf: executionId };
    const engine = new WorkflowExecute(this.additionalData(newId, req, workflow, abort));
    const promise = (async () => {
      const run = await engine.runFromState(workflow, retryState);
      await this.finish(newId, workflow, run, req, {}, JSON.stringify(workflow.staticData));
      return run;
    })();
    this.running.set(newId, { id: newId, workflowId: workflowData.id, mode: 'retry', startedAt: new Date(), abort, promise });
    promise.finally(() => this.running.delete(newId));
    return promise;
  }

  prune() {
    const ids = this.db.pruneExecutions(this.config.executions.pruneAfterHours, this.config.executions.pruneMaxCount);
    for (const id of ids) this.binaryData.deleteForExecution(id).catch(() => {});
    return ids.length;
  }
}
