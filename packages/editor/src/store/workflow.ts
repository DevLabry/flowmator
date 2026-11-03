import {
  getNodeParametersWithDefaults,
  renameInExpression,
  Workflow,
  type ConnectionType,
  type IConnection,
  type IConnections,
  type INode,
  type INodeExecutionData,
  type INodeParameters,
  type INodeTypes,
  type IRunData,
  type ITaskData,
  type IWorkflowSettings,
} from '@flowmator/workflow';
import { create } from 'zustand';
import { Api, type NodeIO, type WorkflowData } from '../lib/api';
import { getNodeType, localNodeType, useApp } from './app';

export const pushRef = Math.random().toString(36).slice(2, 12);

/** Adapter so the shared Workflow class can be used in the browser for graph helpers. */
export const browserNodeTypes: INodeTypes = {
  getByNameAndVersion: (type) => {
    const description = getNodeType(type);
    if (!description) throw new Error(`Unknown node type ${type}`);
    return { description };
  },
  getKnownTypes: () => Object.keys(useApp.getState().nodeTypes),
};

export function toWorkflowClass(wf: WorkflowData) {
  return new Workflow({ ...structuredClone(wf), nodeTypes: browserNodeTypes });
}

type Snapshot = { nodes: INode[]; connections: IConnections };

export type RunStatus = 'idle' | 'running' | 'waiting' | 'success' | 'error' | 'canceled' | 'waitingForWebhook';

interface WorkflowState {
  workflow: WorkflowData;
  dirty: boolean;
  readOnly: boolean;
  /** Run data shown on the canvas: last manual run, or a loaded past execution */
  runData: IRunData;
  executionId?: string;
  status: RunStatus;
  executingNodes: string[];
  executionError?: { message: string; node?: string; description?: string };
  testUrls: string[];
  /** Nodes whose parameters changed since the last run (partial re-runs re-execute them) */
  dirtyNodes: string[];
  nodeIO: Record<string, NodeIO>;
  openNode: string | null;
  selected: string[];
  past: Snapshot[];
  future: Snapshot[];

  load(wf: WorkflowData, opts?: { readOnly?: boolean; runData?: IRunData }): void;
  /** A new workflow, saved into `projectId` (default: the personal project) */
  newWorkflow(projectId?: string): void;
  setName(name: string): void;
  setSettings(settings: IWorkflowSettings): void;
  setTags(tags: string[]): void;
  checkpoint(): void;
  undo(): void;
  redo(): void;
  addNode(
    type: string,
    position: [number, number],
    opts?: { connectFrom?: { node: string; output: number; type?: ConnectionType }; name?: string; parameters?: INodeParameters; initialParameters?: INodeParameters },
  ): INode | null;
  addNodes(nodes: INode[], connections: IConnections): string[];
  updateNode(name: string, patch: Partial<INode>): void;
  setParameters(name: string, parameters: INodeParameters): void;
  removeNodes(names: string[]): void;
  renameNode(oldName: string, newName: string): string;
  moveNodes(positions: Record<string, [number, number]>): void;
  connect(source: string, sourceOutput: number, target: string, targetInput: number, type?: ConnectionType): void;
  disconnect(source: string, sourceOutput: number, target: string, targetInput: number, type?: ConnectionType): void;
  setPinData(node: string, items: INodeExecutionData[] | null): void;
  setOpenNode(name: string | null): void;
  setSelected(names: string[]): void;
  refreshIO(name: string): void;
  save(): Promise<WorkflowData>;
  run(opts?: { destinationNode?: string; triggerNode?: string; triggerData?: INodeExecutionData[] }): Promise<void>;
  stop(): Promise<void>;
  clearRunData(): void;
  applyPush(event: { type: string; data: any }): void;
}

const emptyWorkflow = (): WorkflowData => ({
  name: 'My workflow',
  active: false,
  nodes: [],
  connections: {},
  settings: { executionOrder: 'v1' },
  pinData: {},
  tags: [],
});

const uid = () => crypto.randomUUID();

export function uniqueName(base: string, nodes: INode[]): string {
  const names = new Set(nodes.map((n) => n.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\d+$/, '');
  for (let i = 1; ; i++) if (!names.has(`${stem}${i}`)) return `${stem}${i}`;
}

/** Inputs/outputs from the description, unless the node computes them from its parameters. */
export function staticIO(node: INode): NodeIO {
  const d = getNodeType(node.type);
  if (!d) return { inputs: ['main'], outputs: ['main'], inputNames: [], outputNames: [] };
  const outputs = [...d.outputs] as NodeIO['outputs'];
  const outputNames = [...(d.outputNames ?? [])];
  if (node.onError === 'continueErrorOutput') {
    outputs.push('main');
    while (outputNames.length < outputs.length - 1) outputNames.push('');
    outputNames.push('error');
  }
  return { inputs: [...d.inputs] as NodeIO['inputs'], outputs, inputNames: d.inputNames ?? [], outputNames };
}

function renameInConnections(connections: IConnections, oldName: string, newName: string): IConnections {
  const out: IConnections = {};
  for (const [src, byType] of Object.entries(connections)) {
    const mapped: typeof byType = {};
    for (const [type, outputs] of Object.entries(byType)) {
      mapped[type as ConnectionType] = outputs?.map((targets) => targets?.map((t) => (t.node === oldName ? { ...t, node: newName } : t)) ?? null);
    }
    out[src === oldName ? newName : src] = mapped;
  }
  return out;
}

function renameInValue(value: unknown, oldName: string, newName: string): unknown {
  if (typeof value === 'string') return renameInExpression(value, oldName, newName);
  if (Array.isArray(value)) return value.map((v) => renameInValue(v, oldName, newName));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameInValue(v, oldName, newName)]));
  return value;
}

const ioTimers: Record<string, ReturnType<typeof setTimeout>> = {};

export const useWorkflow = create<WorkflowState>((set, get) => ({
  workflow: emptyWorkflow(),
  dirty: false,
  readOnly: false,
  runData: {},
  status: 'idle',
  executingNodes: [],
  testUrls: [],
  dirtyNodes: [],
  nodeIO: {},
  openNode: null,
  selected: [],
  past: [],
  future: [],

  load(wf, opts = {}) {
    const workflow = { ...emptyWorkflow(), ...structuredClone(wf), pinData: wf.pinData ?? {}, tags: wf.tags ?? [] };
    set({ workflow, dirty: false, readOnly: !!opts.readOnly, runData: opts.runData ?? {}, status: 'idle', executingNodes: [], executionError: undefined, executionId: undefined, testUrls: [], dirtyNodes: [], nodeIO: {}, openNode: null, selected: [], past: [], future: [] });
    for (const n of workflow.nodes) if (getNodeType(n.type)?.hasDynamicIO) get().refreshIO(n.name);
  },

  newWorkflow(projectId) {
    get().load({ ...emptyWorkflow(), homeProject: projectId ? { id: projectId, name: '', type: 'team', icon: null } : null, scopes: ['read', 'update', 'execute', 'delete', 'share', 'move'] });
  },

  setName(name) {
    set({ workflow: { ...get().workflow, name }, dirty: true });
  },
  setSettings(settings) {
    set({ workflow: { ...get().workflow, settings }, dirty: true });
  },
  setTags(tags) {
    set({ workflow: { ...get().workflow, tags }, dirty: true });
  },

  checkpoint() {
    const { workflow, past } = get();
    set({ past: [...past.slice(-99), { nodes: structuredClone(workflow.nodes), connections: structuredClone(workflow.connections) }], future: [] });
  },
  undo() {
    const { past, future, workflow } = get();
    const prev = past.at(-1);
    if (!prev) return;
    set({ past: past.slice(0, -1), future: [{ nodes: workflow.nodes, connections: workflow.connections }, ...future], workflow: { ...workflow, ...prev }, dirty: true });
  },
  redo() {
    const { past, future, workflow } = get();
    const next = future[0];
    if (!next) return;
    set({ future: future.slice(1), past: [...past, { nodes: workflow.nodes, connections: workflow.connections }], workflow: { ...workflow, ...next }, dirty: true });
  },

  addNode(type, position, opts = {}) {
    const d = getNodeType(type);
    if (!d) return null;
    const { workflow } = get();
    if (d.maxNodes && workflow.nodes.filter((n) => n.type === type).length >= d.maxNodes) {
      useApp.getState().toast('error', `Only ${d.maxNodes} "${d.displayName}" node allowed per workflow`);
      return null;
    }
    get().checkpoint();
    const version = Array.isArray(d.version) ? d.version[d.version.length - 1] : d.version;
    const node: INode = {
      id: uid(),
      name: uniqueName(opts.name ?? d.defaults.name, workflow.nodes),
      type,
      typeVersion: version,
      position,
      parameters: opts.parameters ?? getNodeParametersWithDefaults(d.properties.filter((p) => p.type !== 'notice'), opts.initialParameters ?? {}, version),
      ...(d.hasWebhook ? { webhookId: uid() } : {}),
    };
    set({ workflow: { ...workflow, nodes: [...workflow.nodes, node] }, dirty: true });
    if (opts.connectFrom) get().connect(opts.connectFrom.node, opts.connectFrom.output, node.name, 0, opts.connectFrom.type);
    if (d.hasDynamicIO) get().refreshIO(node.name);
    return node;
  },

  addNodes(nodes, connections) {
    get().checkpoint();
    const { workflow } = get();
    const existing = [...workflow.nodes];
    const renames: Record<string, string> = {};
    const added: INode[] = [];
    for (const n of nodes) {
      const name = uniqueName(n.name, existing);
      renames[n.name] = name;
      const node = { ...structuredClone(n), id: uid(), name, type: localNodeType(n.type) };
      existing.push(node);
      added.push(node);
    }
    let conns = structuredClone(connections);
    for (const [from, to] of Object.entries(renames)) if (from !== to) conns = renameInConnections(conns, from, to);
    const merged: IConnections = { ...workflow.connections };
    for (const [src, byType] of Object.entries(conns)) {
      if (!added.some((n) => n.name === src)) continue;
      const filtered: typeof byType = {};
      for (const [type, outputs] of Object.entries(byType)) {
        filtered[type as ConnectionType] = outputs?.map((targets) => targets?.filter((t) => added.some((n) => n.name === t.node)) ?? null);
      }
      merged[src] = filtered;
    }
    set({ workflow: { ...workflow, nodes: existing, connections: merged }, dirty: true, selected: added.map((n) => n.name) });
    for (const n of added) if (getNodeType(n.type)?.hasDynamicIO) get().refreshIO(n.name);
    return added.map((n) => n.name);
  },

  updateNode(name, patch) {
    const { workflow } = get();
    get().checkpoint();
    set({
      workflow: { ...workflow, nodes: workflow.nodes.map((n) => (n.name === name ? { ...n, ...patch } : n)) },
      dirty: true,
      dirtyNodes: [...new Set([...get().dirtyNodes, name])],
    });
    if ('onError' in patch) get().refreshIO(name);
  },

  setParameters(name, parameters) {
    const { workflow } = get();
    set({
      workflow: { ...workflow, nodes: workflow.nodes.map((n) => (n.name === name ? { ...n, parameters } : n)) },
      dirty: true,
      dirtyNodes: [...new Set([...get().dirtyNodes, name])],
    });
    const node = workflow.nodes.find((n) => n.name === name);
    if (node && getNodeType(node.type)?.hasDynamicIO) get().refreshIO(name);
  },

  removeNodes(names) {
    if (!names.length) return;
    get().checkpoint();
    const { workflow, runData } = get();
    const drop = new Set(names);
    const connections: IConnections = {};
    for (const [src, byType] of Object.entries(workflow.connections)) {
      if (drop.has(src)) continue;
      const mapped: typeof byType = {};
      for (const [type, outputs] of Object.entries(byType)) {
        mapped[type as ConnectionType] = outputs?.map((targets) => targets?.filter((t) => !drop.has(t.node)) ?? null);
      }
      connections[src] = mapped;
    }
    const pinData = Object.fromEntries(Object.entries(workflow.pinData ?? {}).filter(([k]) => !drop.has(k)));
    const rd = Object.fromEntries(Object.entries(runData).filter(([k]) => !drop.has(k)));
    set({ workflow: { ...workflow, nodes: workflow.nodes.filter((n) => !drop.has(n.name)), connections, pinData }, runData: rd, dirty: true, selected: [], openNode: drop.has(get().openNode ?? '') ? null : get().openNode });
  },

  renameNode(oldName, newName) {
    const { workflow, runData } = get();
    const name = uniqueName(newName.trim() || oldName, workflow.nodes.filter((n) => n.name !== oldName));
    if (name === oldName) return oldName;
    get().checkpoint();
    const nodes = workflow.nodes.map((n) => ({
      ...n,
      name: n.name === oldName ? name : n.name,
      parameters: renameInValue(n.parameters, oldName, name) as INodeParameters,
    }));
    const pinData = { ...workflow.pinData };
    if (pinData[oldName]) {
      pinData[name] = pinData[oldName];
      delete pinData[oldName];
    }
    const rd = { ...runData };
    if (rd[oldName]) {
      rd[name] = rd[oldName];
      delete rd[oldName];
    }
    const nodeIO = { ...get().nodeIO };
    if (nodeIO[oldName]) nodeIO[name] = nodeIO[oldName];
    set({
      workflow: { ...workflow, nodes, connections: renameInConnections(workflow.connections, oldName, name), pinData },
      runData: rd,
      nodeIO,
      dirty: true,
      openNode: get().openNode === oldName ? name : get().openNode,
      selected: get().selected.map((s) => (s === oldName ? name : s)),
    });
    return name;
  },

  moveNodes(positions) {
    const { workflow } = get();
    set({ workflow: { ...workflow, nodes: workflow.nodes.map((n) => (positions[n.name] ? { ...n, position: positions[n.name] } : n)) }, dirty: true });
  },

  connect(source, sourceOutput, target, targetInput, type = 'main') {
    if (source === target) return;
    const { workflow } = get();
    const connections = structuredClone(workflow.connections);
    const outputs = ((connections[source] ??= {})[type] ??= []);
    while (outputs.length <= sourceOutput) outputs.push([]);
    const list = (outputs[sourceOutput] ??= []) as IConnection[];
    if (list.some((c) => c.node === target && c.index === targetInput)) return;
    get().checkpoint();
    list.push({ node: target, type, index: targetInput });
    set({ workflow: { ...workflow, connections }, dirty: true });
  },

  disconnect(source, sourceOutput, target, targetInput, type = 'main') {
    const { workflow } = get();
    const connections = structuredClone(workflow.connections);
    const list = connections[source]?.[type]?.[sourceOutput];
    if (!list) return;
    get().checkpoint();
    connections[source]![type]![sourceOutput] = list.filter((c) => !(c.node === target && c.index === targetInput));
    set({ workflow: { ...workflow, connections }, dirty: true });
  },

  setPinData(node, items) {
    const { workflow } = get();
    const pinData = { ...(workflow.pinData ?? {}) };
    if (items) pinData[node] = items;
    else delete pinData[node];
    set({ workflow: { ...workflow, pinData }, dirty: true });
  },

  setOpenNode(name) {
    set({ openNode: name });
  },
  setSelected(names) {
    set({ selected: names });
  },

  refreshIO(name) {
    clearTimeout(ioTimers[name]);
    ioTimers[name] = setTimeout(async () => {
      const node = get().workflow.nodes.find((n) => n.name === name);
      if (!node) return;
      const d = getNodeType(node.type);
      if (!d?.hasDynamicIO) {
        const { [name]: _drop, ...rest } = get().nodeIO;
        set({ nodeIO: rest });
        return;
      }
      try {
        const io = await Api.nodeIO(node.type, node.parameters, node.onError);
        set({ nodeIO: { ...get().nodeIO, [name]: io } });
      } catch {
        /* keep the static description */
      }
    }, 150);
  },

  async save() {
    const { workflow } = get();
    const body = { name: workflow.name, nodes: workflow.nodes, connections: workflow.connections, settings: workflow.settings, pinData: workflow.pinData, tags: workflow.tags };
    const saved = workflow.id
      ? await Api.updateWorkflow(workflow.id, { ...body, versionId: workflow.versionId })
      : await Api.createWorkflow({ ...body, projectId: workflow.homeProject?.id });
    const { homeProject, sharedWithProjects, scopes } = saved;
    set({ workflow: { ...get().workflow, id: saved.id, versionId: saved.versionId, active: saved.active, activationError: saved.activationError, homeProject, sharedWithProjects, scopes }, dirty: false });
    return saved;
  },

  async run(opts = {}) {
    let { workflow } = get();
    if (!workflow.id || get().dirty) {
      await get().save();
      workflow = get().workflow;
    }
    const partial = !!opts.destinationNode && Object.keys(get().runData).length > 0;
    set({
      status: 'running',
      executionError: undefined,
      executingNodes: [],
      testUrls: [],
      runData: partial ? get().runData : {},
    });
    try {
      const res = await Api.run(
        workflow.id!,
        {
          workflowData: { name: workflow.name, nodes: workflow.nodes, connections: workflow.connections, settings: workflow.settings, pinData: workflow.pinData },
          destinationNode: opts.destinationNode,
          triggerToStartFrom: opts.triggerNode ? { name: opts.triggerNode, ...(opts.triggerData ? { data: { main: [opts.triggerData] } } : {}) } : undefined,
          runData: partial ? get().runData : undefined,
          dirtyNodeNames: partial ? get().dirtyNodes : undefined,
        },
        pushRef,
      );
      if (res.waitingForWebhook) set({ status: 'waitingForWebhook', testUrls: res.testUrls ?? [] });
      else set({ executionId: res.executionId, dirtyNodes: [] });
    } catch (e) {
      set({ status: 'error', executionError: { message: (e as Error).message } });
    }
  },

  async stop() {
    const { status, executionId, workflow } = get();
    if (status === 'waitingForWebhook' && workflow.id) {
      await Api.cancelTestWebhook(workflow.id);
      set({ status: 'idle', testUrls: [] });
      return;
    }
    if (executionId) await Api.stopExecution(executionId).catch(() => {});
  },

  clearRunData() {
    set({ runData: {}, status: 'idle', executionError: undefined, executionId: undefined });
  },

  applyPush(event) {
    const s = get();
    const d = event.data ?? {};
    switch (event.type) {
      case 'executionStarted':
        if (d.workflowId === s.workflow.id && (s.status === 'running' || s.status === 'waitingForWebhook')) {
          set({ executionId: d.executionId, status: 'running', testUrls: [] });
        }
        break;
      case 'nodeExecuteBefore':
        if (d.executionId === s.executionId) set({ executingNodes: [...s.executingNodes, d.nodeName] });
        break;
      case 'nodeExecuteAfter': {
        if (d.executionId !== s.executionId) break;
        const task = d.data as ITaskData;
        const runs = task.executionStatus === 'waiting' ? s.runData[d.nodeName] ?? [] : [...(s.runData[d.nodeName] ?? []), task];
        set({ runData: { ...s.runData, [d.nodeName]: runs }, executingNodes: s.executingNodes.filter((n) => n !== d.nodeName) });
        if (task.error) set({ executionError: { message: task.error.message, node: d.nodeName, description: task.error.description } });
        break;
      }
      case 'executionWaiting':
        if (d.executionId === s.executionId) set({ status: 'waiting' });
        break;
      case 'executionFinished':
        if (d.executionId === s.executionId) set({ status: d.status, executingNodes: [] });
        break;
      case 'testWebhookDeleted':
        if (d.workflowId === s.workflow.id && s.status === 'waitingForWebhook') set({ status: 'idle', testUrls: [] });
        break;
      case 'workflowActivated':
      case 'workflowDeactivated':
        if (d.workflowId === s.workflow.id) set({ workflow: { ...s.workflow, active: event.type === 'workflowActivated', activationError: null } });
        break;
      case 'workflowFailedToActivate':
        if (d.workflowId === s.workflow.id) set({ workflow: { ...s.workflow, active: false, activationError: d.errorMessage } });
        break;
      case 'sendConsoleMessage':
        console.log(d.source, ...(d.messages ?? []));
        break;
    }
  },
}));

/** Data a node received on its first input in the latest run, resolved through its parent's output. */
export function getNodeInput(nodeName: string, runIndex?: number): { items: INodeExecutionData[]; from?: string } {
  const { runData, workflow } = useWorkflow.getState();
  const task = runData[nodeName]?.[runIndex ?? (runData[nodeName]?.length ?? 1) - 1];
  const src = task?.source?.[0];
  if (src) {
    const items = runData[src.previousNode]?.[src.previousNodeRun ?? 0]?.data?.main?.[src.previousNodeOutput ?? 0];
    return { items: items ?? workflow.pinData?.[src.previousNode] ?? [], from: src.previousNode };
  }
  // not run yet: use the first parent's latest output (or pinned data)
  const wf = toWorkflowClass(workflow);
  const parent = wf.getDirectParents(nodeName)[0];
  if (!parent) return { items: [] };
  const items = runData[parent.node]?.at(-1)?.data?.main?.[parent.index] ?? workflow.pinData?.[parent.node] ?? [];
  return { items, from: parent.node };
}

export function getNodeOutput(nodeName: string, output = 0, runIndex?: number): INodeExecutionData[] | undefined {
  const { runData, workflow } = useWorkflow.getState();
  const runs = runData[nodeName];
  if (runs?.length) return runs[runIndex ?? runs.length - 1]?.data?.main?.[output] ?? [];
  return workflow.pinData?.[nodeName] && output === 0 ? workflow.pinData[nodeName] : undefined;
}
