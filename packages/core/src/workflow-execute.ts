import {
  ExecutionCancelledError,
  NodeOperationError,
  toErrorJson,
  type ExecutionStatus,
  type IExecuteData,
  type IExecutionState,
  type INode,
  type INodeExecutionData,
  type IRun,
  type IRunData,
  type ISourceData,
  type ITaskData,
  type NodeErrorJson,
  type Workflow,
} from '@flowmator/workflow';
import type { IWorkflowExecuteAdditionalData } from './additional-data';
import { ExecuteContext } from './node-context';
import { PollContext, TriggerContext } from './trigger-context';

export interface RunOptions {
  workflow: Workflow;
  /** Node to start from; defaults to the workflow's trigger (or the trigger leading to destinationNode). */
  startNode?: string;
  /** Stop once this node has run; only its ancestors are executed. */
  destinationNode?: string;
  /** Items handed to the start node (webhook payload, poll result, sub-workflow input...) */
  triggerData?: INodeExecutionData[];
}

export interface PartialRunOptions {
  workflow: Workflow;
  destinationNode: string;
  /** Run data of a previous execution; nodes in it are reused instead of re-run. */
  runData: IRunData;
  /** Nodes whose parameters changed since runData was produced; they and their descendants re-run. */
  dirtyNodes?: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Executes a workflow graph.
 *
 * Order (settings.executionOrder "v1", the default): depth first. When a node finishes, the nodes connected
 * to its first output run before those on its second output, and all of them before anything queued earlier.
 * Nodes with several main inputs wait until every input has data; if nothing else can run, they run with
 * whatever arrived.
 */
export class WorkflowExecute {
  private state!: IExecutionState;
  private workflow!: Workflow;
  private status: ExecutionStatus = 'running';
  private error?: NodeErrorJson;
  private waitTill?: Date;
  private allowedNodes?: Set<string>;
  private readonly startedAt = new Date();

  constructor(private readonly additionalData: IWorkflowExecuteAdditionalData) {}

  async run(opts: RunOptions): Promise<IRun> {
    this.workflow = opts.workflow;
    const start = opts.startNode ? opts.workflow.getNode(opts.startNode) : opts.workflow.getStartNode(opts.destinationNode);
    if (!start) throw new Error('No node to start the workflow from could be found');
    if (opts.destinationNode) this.allowedNodes = new Set([opts.destinationNode, ...opts.workflow.getParentNodes(opts.destinationNode)]);
    this.state = {
      runData: {},
      pinData: opts.workflow.pinData,
      nodeExecutionStack: [
        { node: start, data: { main: [opts.triggerData ?? [{ json: {} }]] }, source: null },
      ],
      waitingExecution: {},
      destinationNode: opts.destinationNode,
      contextData: {},
    };
    return this.process();
  }

  /** Re-runs only what is needed to (re)compute `destinationNode`, reusing previous run data. */
  async runPartial(opts: PartialRunOptions): Promise<IRun> {
    const wf = opts.workflow;
    this.workflow = wf;
    const dest = opts.destinationNode;
    this.allowedNodes = new Set([dest, ...wf.getParentNodes(dest)]);

    const dirty = new Set<string>();
    for (const d of opts.dirtyNodes ?? []) {
      dirty.add(d);
      for (const c of wf.getChildNodes(d)) dirty.add(c);
    }
    dirty.add(dest);

    const runData: IRunData = {};
    for (const [name, runs] of Object.entries(opts.runData)) {
      if (this.allowedNodes.has(name) && !dirty.has(name) && wf.getNode(name)) runData[name] = runs;
    }

    const stack: IExecuteData[] = [];
    const startNodes = [...this.allowedNodes].filter((name) => {
      if (runData[name] || wf.pinData?.[name]) return false;
      const parents = wf.getDirectParents(name).filter((p) => this.allowedNodes!.has(p.node));
      return parents.every((p) => runData[p.node] || wf.pinData?.[p.node]);
    });

    for (const name of startNodes) {
      const node = wf.getNode(name)!;
      const parents = wf.connectionsByDestination[name]?.main ?? [];
      if (parents.length === 0) {
        stack.push({ node, data: { main: [[{ json: {} }]] }, source: null });
        continue;
      }
      const main: Array<INodeExecutionData[] | null> = [];
      const source: Array<ISourceData | null> = [];
      parents.forEach((conns, inputIndex) => {
        for (const c of conns) {
          const items = runData[c.node]?.at(-1)?.data?.main?.[c.index] ?? wf.pinData?.[c.node];
          if (items) {
            main[inputIndex] = items;
            source[inputIndex] = { previousNode: c.node, previousNodeOutput: c.index, previousNodeRun: Math.max(0, (runData[c.node]?.length ?? 1) - 1) };
            break;
          }
        }
        main[inputIndex] ??= null;
        source[inputIndex] ??= null;
      });
      stack.push({ node, data: { main }, source: { main: source } });
    }

    this.state = {
      runData,
      pinData: wf.pinData,
      nodeExecutionStack: stack,
      waitingExecution: {},
      destinationNode: dest,
      contextData: {},
    };
    return this.process();
  }

  /** Continues from a saved state as-is (used to retry a failed execution from the failed node). */
  async runFromState(workflow: Workflow, state: IExecutionState): Promise<IRun> {
    this.workflow = workflow;
    this.state = structuredClone(state);
    if (state.destinationNode) this.allowedNodes = new Set([state.destinationNode, ...workflow.getParentNodes(state.destinationNode)]);
    return this.process();
  }

  /** Continues a saved execution (after a Wait). `resumeData` is what the resume webhook/form received. */
  async resume(workflow: Workflow, saved: IExecutionState, resumeData?: INodeExecutionData[]): Promise<IRun> {
    this.workflow = workflow;
    this.state = structuredClone(saved);
    if (saved.destinationNode) this.allowedNodes = new Set([saved.destinationNode, ...workflow.getParentNodes(saved.destinationNode)]);
    const first = this.state.nodeExecutionStack[0];
    if (first) {
      first.resume = { data: resumeData };
      // drop the placeholder "waiting" task recorded when the node paused
      const runs = this.state.runData[first.node.name];
      if (runs?.at(-1)?.executionStatus === 'waiting') runs.pop();
      if (runs?.length === 0) delete this.state.runData[first.node.name];
    }
    return this.process();
  }

  private async process(): Promise<IRun> {
    const hooks = this.additionalData.hooks;
    await hooks?.workflowExecuteBefore?.();
    const timeout = this.workflow.settings.executionTimeout;
    const deadline = timeout && timeout > 0 ? Date.now() + timeout * 1000 : undefined;

    try {
      while (true) {
        if (this.additionalData.signal?.aborted) throw new ExecutionCancelledError();
        if (deadline && Date.now() > deadline) {
          throw new Error(`Workflow execution timed out after ${timeout} seconds`);
        }
        let execData = this.state.nodeExecutionStack.shift();
        if (!execData) execData = this.takeWaitingNode();
        if (!execData) break;

        const stop = await this.executeNode(execData);
        if (stop) break;
      }
    } catch (error) {
      if (error instanceof ExecutionCancelledError) this.status = 'canceled';
      else this.status = 'error';
      this.error = toErrorJson(error);
    }

    if (this.status === 'running') this.status = 'success';
    const run: IRun = {
      status: this.status,
      mode: this.additionalData.mode,
      startedAt: this.startedAt,
      stoppedAt: new Date(),
      waitTill: this.waitTill ?? null,
      data: {
        resultData: {
          runData: this.state.runData,
          pinData: this.state.pinData,
          lastNodeExecuted: this.state.lastNodeExecuted,
          error: this.error,
        },
        executionData: this.state,
      },
    };
    await hooks?.workflowExecuteAfter?.(run);
    return run;
  }

  /** When nothing else can run, multi-input nodes that only received part of their inputs run anyway. */
  private takeWaitingNode(): IExecuteData | undefined {
    for (const [name, entries] of Object.entries(this.state.waitingExecution)) {
      const entry = entries.shift();
      if (!entries.length) delete this.state.waitingExecution[name];
      if (!entry) continue;
      const node = this.workflow.getNode(name);
      if (!node) continue;
      return { node, data: { main: entry.main }, source: { main: entry.source } };
    }
    return undefined;
  }

  /** Returns true when the execution must stop. */
  private async executeNode(execData: IExecuteData): Promise<boolean> {
    const { node } = execData;
    const hooks = this.additionalData.hooks;
    const runData = this.state.runData;
    const runIndex = runData[node.name]?.length ?? 0;
    const startTime = Date.now();
    await hooks?.nodeExecuteBefore?.(node.name);

    let output: Array<INodeExecutionData[] | null> | null = null;
    let nodeError: unknown;
    let waiting = false;

    const pinned = this.state.pinData?.[node.name];
    if (node.disabled) {
      output = [execData.data.main[0] ?? []];
    } else if (pinned && this.additionalData.mode === 'manual') {
      output = [pinned.map((item, i) => ({ ...item, pairedItem: item.pairedItem ?? { item: i } }))];
    } else {
      const tries = node.retryOnFail ? Math.min(Math.max(node.maxTries ?? 3, 2), 5) : 1;
      const waitMs = Math.min(Math.max(node.waitBetweenTries ?? 1000, 0), 5000);
      for (let attempt = 1; attempt <= tries; attempt++) {
        try {
          const result = await this.runNode(execData, runIndex);
          output = result.output;
          waiting = result.waiting;
          nodeError = undefined;
          break;
        } catch (e) {
          nodeError = e;
          if (e instanceof ExecutionCancelledError) throw e;
          if (attempt < tries) await sleep(waitMs);
        }
      }
    }

    const task: ITaskData = {
      startTime,
      executionTime: Date.now() - startTime,
      source: execData.source?.main ?? [],
      executionStatus: 'success',
    };

    if (waiting) {
      task.executionStatus = 'waiting';
      (runData[node.name] ??= []).push(task);
      this.state.nodeExecutionStack.unshift(execData);
      this.state.lastNodeExecuted = node.name;
      this.status = 'waiting';
      await hooks?.nodeExecuteAfter?.(node.name, task, this.state);
      return true;
    }

    if (nodeError !== undefined) {
      const onError = node.onError ?? (node.continueOnFail ? 'continueRegularOutput' : 'stopWorkflow');
      const errorJson = toErrorJson(nodeError, node);
      if (onError === 'stopWorkflow') {
        task.executionStatus = 'error';
        task.error = errorJson;
        (runData[node.name] ??= []).push(task);
        this.state.lastNodeExecuted = node.name;
        await hooks?.nodeExecuteAfter?.(node.name, task, this.state);
        throw nodeError;
      }
      const input = execData.data.main[0] ?? [];
      const errorItems: INodeExecutionData[] = (input.length ? input : [{ json: {} }]).map((item, i) => ({
        json: onError === 'continueErrorOutput' ? { ...item.json, error: errorJson.message } : { error: errorJson.message },
        error: errorJson,
        pairedItem: { item: i },
      }));
      if (onError === 'continueRegularOutput') output = [errorItems];
      else {
        const count = this.workflow.getNodeOutputCount(node);
        output = Array.from({ length: count }, () => []);
        output[count - 1] = errorItems;
      }
    } else if (node.onError === 'continueErrorOutput' && output) {
      output = this.routeItemErrors(node, output);
    }

    output ??= [];
    if (node.alwaysOutputData && output.every((o) => !o?.length)) {
      output[0] = [{ json: {}, pairedItem: { item: 0 } }];
    }

    task.data = { main: output };
    (runData[node.name] ??= []).push(task);
    this.state.lastNodeExecuted = node.name;
    await hooks?.nodeExecuteAfter?.(node.name, task, this.state);

    if (this.state.destinationNode === node.name) return true;
    this.queueChildren(node, output, runIndex);
    return false;
  }

  /** With "continue (using error output)", items a node marked with `error` go to the extra last output. */
  private routeItemErrors(node: INode, output: Array<INodeExecutionData[] | null>) {
    const count = this.workflow.getNodeOutputCount(node);
    const result: Array<INodeExecutionData[] | null> = Array.from({ length: count }, (_, i) => (i < count - 1 ? [] : []));
    output.forEach((items, i) => {
      for (const item of items ?? []) {
        if (item.error) result[count - 1]!.push(item);
        else (result[i] ??= []).push(item);
      }
    });
    return result;
  }

  private async runNode(execData: IExecuteData, runIndex: number): Promise<{ output: Array<INodeExecutionData[] | null> | null; waiting: boolean }> {
    const { node } = execData;
    const nodeType = this.workflow.nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
    const isStart = execData.source === null;

    if (nodeType.execute) {
      if (node.executeOnce) execData = { ...execData, data: { ...execData.data, main: execData.data.main.map((items) => (items ? items.slice(0, 1) : items)) } };
      const context = new ExecuteContext({
        workflow: this.workflow,
        node,
        additionalData: this.additionalData,
        runData: this.state.runData,
        executeData: execData,
        runIndex,
        contextData: (this.state.contextData ??= {}),
      });
      let result;
      try {
        result = await nodeType.execute.call(context);
      } finally {
        await context.closeSubNodes();
      }
      if (context.waitTill) {
        this.waitTill = context.waitTill;
        return { output: null, waiting: true };
      }
      return { output: result ? this.addPairedItems(result, execData.data.main[0] ?? []) : null, waiting: false };
    }

    // Trigger-style nodes: when they start the execution with data, they just pass it on.
    if (isStart && execData.data.main[0] && (nodeType.webhook || this.additionalData.mode !== 'manual' || execData.data.main[0].some((i) => Object.keys(i.json).length))) {
      return { output: [execData.data.main[0].map((item, i) => ({ ...item, pairedItem: item.pairedItem ?? { item: i } }))], waiting: false };
    }
    if (nodeType.poll) {
      const ctx = new PollContext({ workflow: this.workflow, node, additionalData: this.additionalData }, () => {});
      const data = await nodeType.poll.call(ctx);
      return { output: data ?? [[]], waiting: false };
    }
    if (nodeType.trigger) return { output: await this.runManualTrigger(node), waiting: false };
    if (nodeType.webhook) {
      throw new NodeOperationError(node, 'This node is waiting for a test event', {
        description: 'Call the test webhook URL, then the workflow will continue',
      });
    }
    // Nodes with no behavior at all (e.g. sticky notes) produce nothing.
    return { output: null, waiting: false };
  }

  /** Runs a trigger node once in manual mode and resolves with its first emission. */
  private async runManualTrigger(node: INode): Promise<INodeExecutionData[][]> {
    const nodeType = this.workflow.nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
    let resolveEmit!: (d: INodeExecutionData[][]) => void;
    let rejectEmit!: (e: Error) => void;
    const emitted = new Promise<INodeExecutionData[][]>((res, rej) => {
      resolveEmit = res;
      rejectEmit = rej;
    });
    const ctx = new TriggerContext(
      { workflow: this.workflow, node, additionalData: this.additionalData },
      'manual',
      (data) => resolveEmit(data),
      (e) => rejectEmit(e),
    );
    const response = await nodeType.trigger!.call(ctx);
    try {
      if (response?.manualTriggerFunction) await response.manualTriggerFunction();
      const abort = this.additionalData.signal;
      return await (abort
        ? Promise.race([emitted, new Promise<never>((_, rej) => abort.addEventListener('abort', () => rej(new ExecutionCancelledError())))])
        : emitted);
    } finally {
      await response?.closeFunction?.();
    }
  }

  /** Nodes that don't set pairedItem get it inferred: 1:1 when counts match, otherwise all from item 0 if there was a single input. */
  private addPairedItems(output: INodeExecutionData[][], input: INodeExecutionData[]): INodeExecutionData[][] {
    return output.map((items) =>
      (items ?? []).map((item, i) => {
        if (item.pairedItem !== undefined) return item;
        if (items.length === input.length) return { ...item, pairedItem: { item: i } };
        if (input.length === 1) return { ...item, pairedItem: { item: 0 } };
        return item;
      }),
    );
  }

  private queueChildren(node: INode, output: Array<INodeExecutionData[] | null>, runIndex: number) {
    const v0 = this.workflow.settings.executionOrder === 'v0';
    const newEntries: IExecuteData[] = [];
    const outputs = this.workflow.connectionsBySource[node.name]?.main ?? [];

    outputs.forEach((targets, outputIndex) => {
      const items = output[outputIndex];
      if (!items?.length) return;
      for (const target of targets ?? []) {
        if (this.allowedNodes && !this.allowedNodes.has(target.node)) continue;
        const child = this.workflow.getNode(target.node);
        if (!child) continue;
        const source: ISourceData = { previousNode: node.name, previousNodeOutput: outputIndex, previousNodeRun: runIndex };
        const inputCount = this.workflow.getNodeInputCount(child);

        if (inputCount <= 1) {
          newEntries.push({ node: child, data: { main: [items] }, source: { main: [source] } });
          continue;
        }

        const waiting = (this.state.waitingExecution[child.name] ??= []);
        let entry = waiting.find((w) => !w.main[target.index]);
        if (!entry) {
          entry = { main: Array(inputCount).fill(null), source: Array(inputCount).fill(null) };
          waiting.push(entry);
        }
        entry.main[target.index] = items;
        entry.source[target.index] = source;

        const connectedInputs = (this.workflow.connectionsByDestination[child.name]?.main ?? [])
          .map((conns, i) => (conns.some((c) => !this.allowedNodes || this.allowedNodes.has(c.node)) ? i : -1))
          .filter((i) => i >= 0);
        if (connectedInputs.every((i) => entry!.main[i])) {
          waiting.splice(waiting.indexOf(entry), 1);
          if (!waiting.length) delete this.state.waitingExecution[child.name];
          newEntries.push({ node: child, data: { main: entry.main }, source: { main: entry.source } });
        }
      }
    });

    if (v0) this.state.nodeExecutionStack.push(...newEntries);
    else this.state.nodeExecutionStack.unshift(...newEntries);
  }
}
