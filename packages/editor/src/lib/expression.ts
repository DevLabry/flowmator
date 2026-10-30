import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import {
  createExpressionContext,
  evaluateExpression,
  EXTENSION_METHOD_NAMES,
  stringifyValue,
  type IDataObject,
  type INode,
} from '@flowmator/workflow';
import { getNodeInput, toWorkflowClass, useWorkflow } from '../store/workflow';

/** Evaluates an expression for the open node against the latest run data (item 0 by default). */
export function previewExpression(expression: string, nodeName: string, itemIndex = 0): { ok: boolean; text: string } {
  try {
    const { workflow, runData } = useWorkflow.getState();
    const node = workflow.nodes.find((n) => n.name === nodeName) as INode;
    const { items, from } = getNodeInput(nodeName);
    const result = evaluateExpression(
      expression.startsWith('=') ? expression : `=${expression}`,
      createExpressionContext({
        workflow: toWorkflowClass(workflow),
        runData,
        activeNodeName: nodeName,
        itemIndex,
        runIndex: 0,
        inputData: items,
        executeData: from ? { node, data: { main: [items] }, source: { main: [{ previousNode: from, previousNodeOutput: 0, previousNodeRun: Math.max(0, (runData[from]?.length ?? 1) - 1) }] } } : undefined,
        mode: 'manual',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        variables: (window as unknown as { __flowmatorVars?: IDataObject }).__flowmatorVars ?? {},
      }),
    );
    if (result === undefined) return { ok: true, text: '[undefined]' };
    if (result === null) return { ok: true, text: '[null]' };
    if (typeof result === 'object') return { ok: true, text: JSON.stringify(result, null, 2) };
    return { ok: true, text: stringifyValue(result) || '[empty]' };
  } catch (e) {
    const err = e as Error & { description?: string };
    return { ok: false, text: `${err.message}${err.description ? ` — ${err.description}` : ''}` };
  }
}

const ROOT_VARS: Array<[string, string]> = [
  ['$json', 'Current item JSON'],
  ['$input', 'Input data: .item .all() .first() .last()'],
  ["$('')", 'Output of another node'],
  ['$binary', 'Binary data of the current item'],
  ['$now', 'Current date and time (Luxon)'],
  ['$today', 'Start of today (Luxon)'],
  ['$vars', 'Variables'],
  ['$execution', 'Execution: id, mode, resumeUrl'],
  ['$workflow', 'Workflow: id, name, active'],
  ['$itemIndex', 'Index of the current item'],
  ['$runIndex', 'How many times this node ran'],
  ['$prevNode', 'Previous node: name, outputIndex'],
  ['$parameter', 'Parameters of this node'],
  ['$jmespath()', 'Query JSON with JMESPath'],
  ['$ifEmpty()', 'Fallback when a value is empty'],
  ['DateTime', 'Luxon DateTime'],
];

function keysAt(obj: unknown, path: string[]): string[] {
  let cur = obj;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return [];
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? Object.keys(cur) : [];
}

/** Autocomplete for expressions: root variables, $json paths, node names and helper methods. */
export function expressionCompletions(nodeName: string, requireBraces = true) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.doc.sliceString(0, ctx.pos);
    if (requireBraces) {
      const open = before.lastIndexOf('{{');
      if (open === -1 || before.lastIndexOf('}}') > open) return null;
    }
    const nodeCall = before.match(/\$\(\s*['"]([^'"]*)$/);
    if (nodeCall) {
      const names = useWorkflow.getState().workflow.nodes.map((n) => n.name).filter((n) => n !== nodeName);
      return { from: ctx.pos - nodeCall[1].length, options: names.map((n) => ({ label: n, type: 'variable' })) };
    }
    const jsonPath = before.match(/\$json((?:\.[A-Za-z_$][\w$]*)*)\.([\w$]*)$/);
    if (jsonPath) {
      const path = jsonPath[1].split('.').filter(Boolean);
      const sample = getNodeInput(nodeName).items[0]?.json ?? {};
      return { from: ctx.pos - jsonPath[2].length, options: keysAt(sample, path).map((k) => ({ label: k, type: 'property' })) };
    }
    const nodeJson = before.match(/\$\(['"]([^'"]+)['"]\)\.(?:item|first\(\)|last\(\))\.json((?:\.[\w$]+)*)\.([\w$]*)$/);
    if (nodeJson) {
      const { runData, workflow } = useWorkflow.getState();
      const sample = runData[nodeJson[1]]?.at(-1)?.data?.main?.[0]?.[0]?.json ?? workflow.pinData?.[nodeJson[1]]?.[0]?.json ?? {};
      return { from: ctx.pos - nodeJson[3].length, options: keysAt(sample, nodeJson[2].split('.').filter(Boolean)).map((k) => ({ label: k, type: 'property' })) };
    }
    const afterNode = before.match(/\$\(['"][^'"]+['"]\)\.([\w]*)$/);
    if (afterNode) {
      const opts: Completion[] = ['item', 'first()', 'last()', 'all()', 'params', 'isExecuted'].map((l) => ({ label: l, type: 'method' }));
      return { from: ctx.pos - afterNode[1].length, options: opts };
    }
    const afterInput = before.match(/\$input\.([\w]*)$/);
    if (afterInput) {
      return { from: ctx.pos - afterInput[1].length, options: ['item', 'all()', 'first()', 'last()', 'params'].map((l) => ({ label: l, type: 'method' })) };
    }
    const dollar = before.match(/(\$[\w]*)$/);
    if (dollar) {
      return { from: ctx.pos - dollar[1].length, options: ROOT_VARS.map(([label, detail]) => ({ label, detail, type: 'variable' })) };
    }
    const method = before.match(/[\w)\]'"]\.([\w]*)$/);
    if (method && ctx.explicit !== undefined) {
      return { from: ctx.pos - method[1].length, options: EXTENSION_METHOD_NAMES.map((m) => ({ label: `${m}()`, type: 'function' })) };
    }
    return null;
  };
}
