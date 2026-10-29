import jmespath from 'jmespath';
import { DateTime, Duration, Interval } from 'luxon';
import { ExpressionError } from '../errors';
import type { Workflow } from '../workflow';
import type {
  ExecutionMode,
  IDataObject,
  IExecuteData,
  INodeExecutionData,
  IPairedItem,
  IRunData,
} from '../types';

export interface IExpressionContextParams {
  workflow: Workflow;
  runData: IRunData;
  activeNodeName: string;
  itemIndex: number;
  runIndex: number;
  /** Items of the current node's first main input */
  inputData: INodeExecutionData[];
  executeData?: IExecuteData;
  mode?: ExecutionMode;
  executionId?: string;
  timezone?: string;
  variables?: IDataObject;
  env?: IDataObject;
  resumeUrl?: string;
  resumeFormUrl?: string;
  customData?: IDataObject;
  /** Per-node and per-flow context (used by $input.context) */
  getContext?: (type: 'flow' | 'node', nodeName?: string) => IDataObject;
}

export function normalizePairedItems(paired: INodeExecutionData['pairedItem'], fallbackIndex?: number): IPairedItem[] {
  if (paired === undefined) return fallbackIndex === undefined ? [] : [{ item: fallbackIndex }];
  if (typeof paired === 'number') return [{ item: paired }];
  return Array.isArray(paired) ? paired : [paired];
}

/**
 * Walks pairedItem links backwards from (sourceNode, output, run, item) until `target` is reached.
 */
export function resolvePairedItem(
  runData: IRunData,
  target: string,
  sourceNode: string,
  sourceOutput: number,
  sourceRun: number,
  itemIndex: number,
  depth = 0,
): INodeExecutionData {
  if (depth > 200) throw new ExpressionError('Paired item resolution exceeded max depth');
  const task = runData[sourceNode]?.[sourceRun];
  if (!task) throw new ExpressionError(`Node "${sourceNode}" hasn't been executed`, { description: `Execute "${sourceNode}" first` });
  const items = task.data?.main?.[sourceOutput] ?? [];
  const item = items[itemIndex];
  if (!item) throw new ExpressionError(`Can't get data for expression`, { description: `Item ${itemIndex} of "${sourceNode}" does not exist` });
  if (sourceNode === target) return item;

  let pairs = normalizePairedItems(item.pairedItem);
  if (pairs.length === 0) {
    const inputItems = task.source[0] ? runData[task.source[0].previousNode]?.[task.source[0].previousNodeRun ?? 0]?.data?.main?.[task.source[0].previousNodeOutput ?? 0] : undefined;
    if (inputItems?.length === 1) pairs = [{ item: 0 }];
    else
      throw new ExpressionError(`Paired item data for item from node "${sourceNode}" is unavailable`, {
        description: `Make sure "${sourceNode}" returns pairedItem info, or use .first()/.all() instead of .item`,
      });
  }
  if (task.source.length === 0 || task.source.every((s) => !s)) {
    throw new ExpressionError(`Node "${target}" is not connected to "${sourceNode}"`, {
      description: 'Referenced node is not an ancestor of the current node',
    });
  }

  const results = new Set<INodeExecutionData>();
  let lastError: unknown;
  for (const pair of pairs) {
    const src = task.source[pair.input ?? 0];
    if (!src) continue;
    try {
      results.add(
        resolvePairedItem(runData, target, src.previousNode, src.previousNodeOutput ?? 0, src.previousNodeRun ?? 0, pair.item, depth + 1),
      );
    } catch (e) {
      lastError = e;
    }
  }
  if (results.size === 0) throw lastError ?? new ExpressionError(`Could not resolve paired item for "${target}"`);
  if (results.size > 1) {
    throw new ExpressionError(`Multiple matching items for expression`, {
      description: `More than one item of "${target}" matches. Use .first(), .last() or .all() instead of .item`,
    });
  }
  return [...results][0];
}

export function createExpressionContext(p: IExpressionContextParams): Record<string, unknown> {
  const { workflow, runData, activeNodeName, itemIndex, runIndex, inputData } = p;
  const activeNode = workflow.getNode(activeNodeName);
  const currentItem = inputData[itemIndex];
  const firstSource = p.executeData?.source?.main?.[0] ?? null;

  const outputOf = (nodeName: string, branch?: number, run?: number): INodeExecutionData[] => {
    const runs = runData[nodeName];
    if (!runs?.length) {
      if (workflow.pinData?.[nodeName]) return workflow.pinData[nodeName];
      throw new ExpressionError(`Node "${nodeName}" hasn't been executed`, { description: `Execute "${nodeName}" first` });
    }
    const r = run ?? runs.length - 1;
    let b = branch;
    if (b === undefined) b = firstSource?.previousNode === nodeName ? (firstSource.previousNodeOutput ?? 0) : 0;
    return runs[r]?.data?.main?.[b] ?? [];
  };

  const pairedItemFor = (target: string, idx: number) => {
    if (!workflow.getNode(target)) throw new ExpressionError(`Referenced node "${target}" doesn't exist`);
    if (target === activeNodeName) throw new ExpressionError(`Use $input instead of referencing the current node`);
    if (!firstSource) {
      // no source info (e.g. editor preview without run): fall back to same index
      return outputOf(target)[idx];
    }
    return resolvePairedItem(
      runData,
      target,
      firstSource.previousNode,
      firstSource.previousNodeOutput ?? 0,
      firstSource.previousNodeRun ?? 0,
      idx,
    );
  };

  const nodeAccessor = (nodeName: string) => {
    const node = workflow.getNode(nodeName);
    if (!node) throw new ExpressionError(`Referenced node "${nodeName}" doesn't exist`);
    return {
      get item() {
        return pairedItemFor(nodeName, itemIndex);
      },
      itemMatching: (idx: number) => pairedItemFor(nodeName, idx),
      pairedItem: (idx = itemIndex) => pairedItemFor(nodeName, idx),
      all: (branch?: number, run?: number) => outputOf(nodeName, branch, run),
      first: (branch?: number, run?: number) => outputOf(nodeName, branch, run)[0],
      last: (branch?: number, run?: number) => {
        const items = outputOf(nodeName, branch, run);
        return items[items.length - 1];
      },
      get params() {
        return node.parameters;
      },
      get isExecuted() {
        return !!runData[nodeName]?.length;
      },
      get runIndex() {
        return (runData[nodeName]?.length ?? 1) - 1;
      },
      get context() {
        return p.getContext?.('node', nodeName) ?? {};
      },
    };
  };

  /** Legacy `$node["Name"].json` access: item at the same index, output 0, last run */
  const legacyNode = new Proxy({} as Record<string, unknown>, {
    get(_, name: string) {
      const node = workflow.getNode(name);
      if (!node) throw new ExpressionError(`Referenced node "${name}" doesn't exist`);
      const items = () => outputOf(name, 0);
      return {
        get json() {
          return (items()[itemIndex] ?? items()[0])?.json;
        },
        get binary() {
          return (items()[itemIndex] ?? items()[0])?.binary;
        },
        get data() {
          return (items()[itemIndex] ?? items()[0])?.json;
        },
        parameter: node.parameters,
        get runIndex() {
          return (runData[name]?.length ?? 1) - 1;
        },
        get context() {
          return p.getContext?.('node', name) ?? {};
        },
      };
    },
  });

  const now = DateTime.now().setZone(p.timezone ?? 'system');

  const ctx: Record<string, unknown> = {
    $json: currentItem?.json ?? {},
    $binary: currentItem?.binary ?? {},
    $data: currentItem?.json ?? {},
    $input: {
      item: currentItem,
      all: () => inputData,
      first: () => inputData[0],
      last: () => inputData[inputData.length - 1],
      params: activeNode?.parameters ?? {},
      get context() {
        return p.getContext?.('node', activeNodeName) ?? {};
      },
    },
    $: nodeAccessor,
    $node: legacyNode,
    $items: (nodeName?: string, outputIndex?: number, run?: number) =>
      nodeName ? outputOf(nodeName, outputIndex ?? 0, run) : inputData,
    $item: (idx: number) => createExpressionContext({ ...p, itemIndex: idx }),
    $parameter: activeNode?.parameters ?? {},
    $prevNode: firstSource
      ? { name: firstSource.previousNode, outputIndex: firstSource.previousNodeOutput ?? 0, runIndex: firstSource.previousNodeRun ?? 0 }
      : {},
    $workflow: { id: workflow.id, name: workflow.name, active: workflow.active },
    $execution: {
      id: p.executionId ?? '__UNKNOWN__',
      mode: p.mode === 'manual' ? 'test' : 'production',
      resumeUrl: p.resumeUrl,
      resumeFormUrl: p.resumeFormUrl,
      customData: {
        set: (k: string, v: string) => (p.customData ? (p.customData[k] = v) : undefined),
        get: (k: string) => p.customData?.[k],
        setAll: (o: IDataObject) => p.customData && Object.assign(p.customData, o),
        getAll: () => p.customData ?? {},
      },
    },
    $vars: p.variables ?? {},
    $env: p.env ?? {},
    $now: now,
    $today: now.startOf('day'),
    $itemIndex: itemIndex,
    $runIndex: runIndex,
    $jmespath: (data: unknown, query: string) => jmespath.search(data as any, query),
    $ifEmpty: (value: unknown, fallback: unknown) =>
      value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0) ||
      (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
        ? fallback
        : value,
    $max: (...n: number[]) => Math.max(...n),
    $min: (...n: number[]) => Math.min(...n),
    DateTime,
    Duration,
    Interval,
  };
  return ctx;
}
