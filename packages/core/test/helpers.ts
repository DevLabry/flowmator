import { nodes } from '@flowmator/nodes-base';
import { Workflow, type IConnections, type INode, type INodeExecutionData, type IPinData, type IWorkflowSettings } from '@flowmator/workflow';
import { NodeTypesRegistry, WorkflowExecute, type IWorkflowExecuteAdditionalData } from '../src';

export const nodeTypes = new NodeTypesRegistry();
nodeTypes.registerAll(nodes);

let counter = 0;
// test parameters are plain object literals; INodeParameters' index signature is too strict for them
export function node(name: string, type: string, parameters: Record<string, any> = {}, extra: Partial<INode> = {}): INode {
  return { id: `id-${++counter}`, name, type: type.includes('.') ? type : `flowmator.${type}`, typeVersion: 1, position: [0, 0], parameters, ...extra };
}

/** connect("A", "B") or connect("A", "B", outputIndex, inputIndex) */
export function connections(...links: Array<[string, string, number?, number?]>): IConnections {
  const c: IConnections = {};
  for (const [from, to, out = 0, input = 0] of links) {
    const main = ((c[from] ??= {}).main ??= []);
    while (main.length <= out) main.push([]);
    main[out]!.push({ node: to, type: 'main', index: input });
  }
  return c;
}

export function makeWorkflow(nodesList: INode[], conns: IConnections, extra: { pinData?: IPinData; settings?: IWorkflowSettings } = {}) {
  return new Workflow({ id: 'wf1', name: 'Test', nodes: nodesList, connections: conns, nodeTypes, ...extra });
}

export function additionalData(overrides: Partial<IWorkflowExecuteAdditionalData> = {}): IWorkflowExecuteAdditionalData {
  return { executionId: 'exec-1', mode: 'manual', ...overrides };
}

export async function run(wf: Workflow, opts: { triggerData?: any[]; destinationNode?: string; additional?: Partial<IWorkflowExecuteAdditionalData> } = {}) {
  return new WorkflowExecute(additionalData(opts.additional)).run({ workflow: wf, triggerData: opts.triggerData, destinationNode: opts.destinationNode });
}

/** JSON of a node's output (last run, given output index) */
export function out(result: Awaited<ReturnType<typeof run>>, nodeName: string, output = 0, runIndex?: number) {
  const runs = result.data.resultData.runData[nodeName];
  if (!runs) return undefined;
  const r = runs[runIndex ?? runs.length - 1];
  return r.data?.main?.[output]?.map((i) => i.json);
}

export const items = (...objs: Array<Record<string, any>>): INodeExecutionData[] => objs.map((json) => ({ json }));

export const cond = (left: string, operation: string, right?: unknown, type = 'string') => ({
  leftValue: left,
  rightValue: right,
  operator: { type, operation },
});

export const filter = (...conditions: ReturnType<typeof cond>[]) => ({
  options: { caseSensitive: true, typeValidation: 'strict' },
  conditions,
  combinator: 'and',
});
