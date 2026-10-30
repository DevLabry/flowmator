import type {
  ConnectionType,
  DataTableRow,
  IDataObject,
  IDataTableService,
  IExecuteFunctions,
  INode,
  INodeExecutionData,
  INodeInputConfiguration,
  INodeParameters,
  INodeProperties,
  INodeType,
} from '@8n8/workflow';
import { NodeOperationError } from '@8n8/workflow';
import { askJson } from '../ai/chains';
import type { ChatModel } from '../ai/llm';
import { DataTable, buildFilter, filterProps, resolveTable, tableProp } from './data-table';

export const EVALUATION_TRIGGER = '8n8.evaluationTrigger';
export const EVALUATION_NODE = '8n8.evaluation';

/** Set by the Evaluation Trigger so Evaluation nodes later in the run know which dataset row they belong to. */
interface EvaluationRowRef {
  tableId: string;
  rowId: number;
}

const flowRow = (ctx: IExecuteFunctions) => ctx.getContext('flow').evaluation as unknown as EvaluationRowRef | undefined;

/** Reads a node's parameters outside an execution (the test runner lists the dataset this way). */
function staticParams(node: INode): Pick<IExecuteFunctions, 'getNodeParameter'> {
  return {
    getNodeParameter(name: string, _i: number, fallback?: unknown, options?: { extractValue?: boolean }) {
      let v: unknown = node.parameters;
      for (const key of name.split('.')) v = v && typeof v === 'object' ? (v as IDataObject)[key] : undefined;
      if (options?.extractValue && v && typeof v === 'object' && '__rl' in v) v = (v as IDataObject).value;
      return v ?? fallback;
    },
  };
}

/** The rows an evaluation run goes through, as the trigger's parameters select them. */
export async function evaluationDataset(dataTables: IDataTableService, node: INode): Promise<{ tableId: string; rows: DataTableRow[] }> {
  const ctx = staticParams(node);
  const ref = String(ctx.getNodeParameter('dataTableId', 0, '', { extractValue: true }) ?? '').trim();
  if (!ref || ref.startsWith('=')) throw new Error(`Select the dataset table in "${node.name}"`);
  const table = await dataTables.getTable(ref);
  if (!table) throw new Error(`Data table "${ref}" not found`);
  const filter = ctx.getNodeParameter('filterRows', 0, false) ? buildFilter(ctx, 0) : undefined;
  const limit = ctx.getNodeParameter('limitRows', 0, false) ? Math.max(1, Number(ctx.getNodeParameter('maxRows', 0, 10))) : undefined;
  const { data } = await dataTables.getRows(table.id, { filter: filter?.filters.length ? filter : undefined, take: limit, sortBy: { column: 'id', direction: 'ASC' } });
  return { tableId: table.id, rows: data };
}

/* ---------------- Evaluation Trigger ---------------- */

export const EvaluationTrigger: INodeType = {
  description: {
    name: EVALUATION_TRIGGER,
    displayName: 'When fetching a dataset row',
    description: 'Runs an evaluation: the workflow runs once for each row of a test dataset',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'When fetching a dataset row', color: '#ec6b39' },
    icon: 'fa:balance-scale-left',
    codex: { alias: ['Evaluation', 'Test', 'Dataset', 'Eval'] },
    inputs: [],
    outputs: ['main'],
    maxNodes: 1,
    properties: [
      {
        displayName: 'Run the evaluation from the Evaluations tab. Running the workflow from the editor uses the first matching row.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      { displayName: 'Source', name: 'source', type: 'options', default: 'dataTable', options: [{ name: 'Data Table', value: 'dataTable' }] },
      tableProp,
      { displayName: 'Limit Rows', name: 'limitRows', type: 'boolean', default: false, description: 'Whether to only use the first rows of the dataset' },
      { displayName: 'Max Rows to Process', name: 'maxRows', type: 'number', default: 10, typeOptions: { minValue: 1 }, displayOptions: { show: { limitRows: [true] } } },
      { displayName: 'Filter Rows', name: 'filterRows', type: 'boolean', default: false },
      ...filterProps.map((p) => ({ ...p, displayOptions: { show: { filterRows: [true] } } })),
    ],
  },
  methods: { listSearch: { tableSearch: DataTable.methods!.listSearch!.tableSearch } },
  async execute(this: IExecuteFunctions) {
    const table = await resolveTable(this, 0);
    let row: DataTableRow | undefined;
    if (this.getMode() === 'evaluation') {
      // the test runner passes the row as trigger data
      row = this.getInputData()[0]?.json as DataTableRow | undefined;
    } else {
      const filter = this.getNodeParameter('filterRows', 0, false) ? buildFilter(this, 0) : undefined;
      row = (await this.getDataTables().getRows(table.id, { filter: filter?.filters.length ? filter : undefined, take: 1, sortBy: { column: 'id', direction: 'ASC' } })).data[0];
    }
    if (!row) throw new NodeOperationError(this.getNode(), `The dataset "${table.name}" has no rows to evaluate`);
    this.getContext('flow').evaluation = { tableId: table.id, rowId: Number(row.id) } as unknown as IDataObject;
    return [[{ json: row as IDataObject }]];
  },
};

/* ---------------- Evaluation ---------------- */

type Metric = 'customMetrics' | 'correctness' | 'helpfulness' | 'stringSimilarity' | 'categorization' | 'toolsUsed';
const LLM_METRICS: Metric[] = ['correctness', 'helpfulness'];

const metricOf = (p: INodeParameters) => (p.metric as Metric | undefined) ?? 'correctness';

function evaluationInputs(p: INodeParameters): Array<ConnectionType | INodeInputConfiguration> {
  const usesModel = (p.operation ?? 'setOutputs') === 'setMetrics' && LLM_METRICS.includes(metricOf(p));
  return usesModel ? ['main', { type: 'ai_languageModel', displayName: 'Model', required: true, maxConnections: 1 }] : ['main'];
}

const forMetric = (metrics: Metric[]) => ({ show: { operation: ['setMetrics'], metric: metrics } });

const CORRECTNESS_PROMPT = `You are an expert factual evaluator assessing the accuracy of answers compared to established ground truths.

Evaluate the factual correctness of a given output compared to the provided ground truth on a scale from 1 to 5:
5 - Highly similar: the output and ground truth are nearly identical, with only minor, insignificant differences.
4 - Somewhat similar: the output is largely similar to the ground truth but has a few noticeable differences.
3 - Moderately similar: there are some evident differences, but the core essence is captured.
2 - Slightly similar: the output only captures a few elements of the ground truth and contains several differences.
1 - Not similar: the output is significantly different from the ground truth, with few or no matching elements.

Explain your reasoning briefly before giving the score.`;

const HELPFULNESS_PROMPT = `You are an expert evaluator assessing the helpfulness of responses to user queries.

Rate how helpful the response is for the user's query on a scale from 1 to 5:
5 - Extremely helpful: completely addresses the query with comprehensive, accurate and relevant information.
4 - Very helpful: addresses most aspects of the query with mostly accurate and relevant information.
3 - Moderately helpful: addresses some aspects of the query but lacks detail or contains minor inaccuracies.
2 - Slightly helpful: provides minimal relevant information.
1 - Not helpful: does not address the query or is irrelevant.

Explain your reasoning briefly before giving the score.`;

const JUDGE_SCHEMA = {
  type: 'object',
  properties: { extended_reasoning: { type: 'string' }, score: { type: 'integer', minimum: 1, maximum: 5 } },
  required: ['extended_reasoning', 'score'],
};

export function levenshtein(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** 1 for identical strings, 0 when every character differs. */
export function stringSimilarity(expected: string, actual: string) {
  const max = Math.max(expected.length, actual.length);
  return max === 0 ? 1 : 1 - levenshtein(expected, actual) / max;
}

/** Share of the expected tools the agent called (from its intermediate steps). */
export function toolsUsedScore(expectedTools: string, steps: unknown) {
  const expected = expectedTools.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!expected.length) return 1;
  const list = typeof steps === 'string' ? (JSON.parse(steps) as unknown) : steps;
  const used = new Set((Array.isArray(list) ? list : []).map((s) => String((s as { action?: { tool?: string } })?.action?.tool ?? '').toLowerCase()));
  return expected.filter((t) => used.has(t)).length / expected.length;
}

const OPERATIONS = [
  { name: 'Set Outputs', value: 'setOutputs', description: 'Write the workflow outputs back to the dataset row', action: 'Set outputs' },
  { name: 'Set Metrics', value: 'setMetrics', description: 'Score this run so the evaluation can report it', action: 'Set metrics' },
  { name: 'Check If Evaluating', value: 'checkIfEvaluating', description: 'Route items depending on whether an evaluation is running', action: 'Check if evaluating' },
];

const properties: INodeProperties[] = [
  { displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true, default: 'setOutputs', options: OPERATIONS },
  {
    displayName: 'Outputs',
    name: 'outputs',
    type: 'fixedCollection',
    typeOptions: { multipleValues: true },
    default: {},
    placeholder: 'Add Output',
    displayOptions: { show: { operation: ['setOutputs'] } },
    options: [
      {
        name: 'values',
        displayName: 'Values',
        values: [
          { displayName: 'Name', name: 'outputName', type: 'string', default: '', description: 'Dataset column to write (created when missing)' },
          { displayName: 'Value', name: 'outputValue', type: 'string', default: '' },
        ],
      },
    ],
  },
  {
    displayName: 'Metric',
    name: 'metric',
    type: 'options',
    noDataExpression: true,
    default: 'correctness',
    displayOptions: { show: { operation: ['setMetrics'] } },
    options: [
      { name: 'Correctness (AI-Based)', value: 'correctness', description: 'Whether the answer means the same as the expected answer (1-5)' },
      { name: 'Helpfulness (AI-Based)', value: 'helpfulness', description: 'Whether the response addresses the query (1-5)' },
      { name: 'String Similarity', value: 'stringSimilarity', description: 'How close the answer is to the expected one, character by character (0-1)' },
      { name: 'Categorization', value: 'categorization', description: 'Whether the answer exactly matches the expected category (0 or 1)' },
      { name: 'Tools Used', value: 'toolsUsed', description: 'Share of the expected tools the agent called (0-1)' },
      { name: 'Custom Metrics', value: 'customMetrics', description: 'Your own numbers, computed with expressions' },
    ],
  },
  { displayName: 'Expected Answer', name: 'expectedAnswer', type: 'string', typeOptions: { rows: 2 }, default: '', displayOptions: forMetric(['correctness', 'stringSimilarity', 'categorization']) },
  { displayName: 'User Query', name: 'userQuery', type: 'string', typeOptions: { rows: 2 }, default: '', displayOptions: forMetric(['helpfulness']) },
  { displayName: 'Actual Answer', name: 'actualAnswer', type: 'string', typeOptions: { rows: 2 }, default: '', displayOptions: forMetric(['correctness', 'helpfulness', 'stringSimilarity', 'categorization']) },
  { displayName: 'Expected Tools', name: 'expectedTools', type: 'string', default: '', placeholder: 'calculator, wikipedia', description: 'Comma-separated tool names', displayOptions: forMetric(['toolsUsed']) },
  {
    displayName: 'Intermediate Steps (of Agent)',
    name: 'intermediateSteps',
    type: 'string',
    default: '={{ $json.intermediateSteps }}',
    description: "Turn on the agent's Return Intermediate Steps option",
    displayOptions: forMetric(['toolsUsed']),
  },
  {
    displayName: 'Metrics',
    name: 'metrics',
    type: 'fixedCollection',
    typeOptions: { multipleValues: true },
    default: {},
    placeholder: 'Add Metric',
    displayOptions: forMetric(['customMetrics']),
    options: [
      {
        name: 'values',
        displayName: 'Values',
        values: [
          { displayName: 'Name', name: 'name', type: 'string', default: '' },
          { displayName: 'Value', name: 'value', type: 'number', default: 0 },
        ],
      },
    ],
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    displayOptions: { show: { operation: ['setMetrics'], metric: ['correctness', 'helpfulness', 'stringSimilarity', 'categorization', 'toolsUsed'] } },
    options: [
      { displayName: 'Metric Name', name: 'metricName', type: 'string', default: '', description: 'Defaults to the metric type, e.g. "Correctness"' },
      { displayName: 'Prompt', name: 'prompt', type: 'string', typeOptions: { rows: 6 }, default: '', description: 'Replaces the instructions given to the judging model', displayOptions: { show: { '/metric': LLM_METRICS } } },
    ],
  },
];

const DEFAULT_NAMES: Record<Metric, string> = {
  customMetrics: '',
  correctness: 'Correctness',
  helpfulness: 'Helpfulness',
  stringSimilarity: 'String similarity',
  categorization: 'Categorization',
  toolsUsed: 'Tools Used',
};

async function metricsFor(ctx: IExecuteFunctions, i: number): Promise<IDataObject> {
  const metric = ctx.getNodeParameter('metric', i, 'correctness') as Metric;
  if (metric === 'customMetrics') {
    const values = (ctx.getNodeParameter('metrics.values', i, []) as Array<{ name: string; value: unknown }>) ?? [];
    const out: IDataObject = {};
    for (const { name, value } of values) {
      if (!name) continue;
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) throw new NodeOperationError(ctx.getNode(), `Metric "${name}" must be a number`, { itemIndex: i });
      out[name] = n;
    }
    if (!Object.keys(out).length) throw new NodeOperationError(ctx.getNode(), 'Add at least one metric', { itemIndex: i });
    return out;
  }
  const name = String(ctx.getNodeParameter('options.metricName', i, '') || DEFAULT_NAMES[metric]);
  const text = (param: string) => {
    const v = ctx.getNodeParameter(param, i, '');
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  switch (metric) {
    case 'stringSimilarity':
      return { [name]: stringSimilarity(text('expectedAnswer'), text('actualAnswer')) };
    case 'categorization':
      return { [name]: text('expectedAnswer').trim() === text('actualAnswer').trim() ? 1 : 0 };
    case 'toolsUsed':
      return { [name]: toolsUsedScore(text('expectedTools'), ctx.getNodeParameter('intermediateSteps', i, [])) };
    default: {
      const model = (await ctx.getInputConnectionData('ai_languageModel', i)) as ChatModel;
      const system = String(ctx.getNodeParameter('options.prompt', i, '') || (metric === 'correctness' ? CORRECTNESS_PROMPT : HELPFULNESS_PROMPT));
      const prompt =
        metric === 'correctness'
          ? `[BEGIN DATA]\n[Ground truth]: ${text('expectedAnswer')}\n[Output]: ${text('actualAnswer')}\n[END DATA]`
          : `[BEGIN DATA]\n[Query]: ${text('userQuery')}\n[Response]: ${text('actualAnswer')}\n[END DATA]`;
      const verdict = (await askJson(model, system, prompt, JUDGE_SCHEMA)) as { score: number };
      return { [name]: Number(verdict.score) };
    }
  }
}

export const Evaluation: INodeType = {
  description: {
    name: EVALUATION_NODE,
    displayName: 'Evaluation',
    description: 'Records outputs and metrics while an evaluation runs',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Evaluation', color: '#ec6b39' },
    icon: 'fa:balance-scale-left',
    codex: { alias: ['Eval', 'Test', 'Metric', 'Score', 'LLM as a judge'] },
    inputs: ['main'],
    dynamicInputs: evaluationInputs,
    outputs: ['main'],
    dynamicOutputs: (p) => (p.operation === 'checkIfEvaluating' ? ['main', 'main'] : ['main']),
    dynamicOutputNames: (p) => (p.operation === 'checkIfEvaluating' ? ['Evaluation', 'Normal'] : []),
    properties,
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const operation = this.getNodeParameter('operation', 0, 'setOutputs') as string;

    if (operation === 'checkIfEvaluating') {
      return this.getMode() === 'evaluation' ? [items, []] : [[], items];
    }

    if (operation === 'setOutputs') {
      const ref = flowRow(this);
      if (!ref) {
        // not started by the Evaluation Trigger: nothing to write to
        return [items];
      }
      const dataTables = this.getDataTables();
      for (let i = 0; i < items.length; i++) {
        const values = (this.getNodeParameter('outputs.values', i, []) as Array<{ outputName: string; outputValue: unknown }>) ?? [];
        const data: DataTableRow = {};
        for (const { outputName, outputValue } of values) {
          if (outputName) data[outputName] = outputValue == null || typeof outputValue !== 'object' ? (outputValue as string) : JSON.stringify(outputValue);
        }
        if (!Object.keys(data).length) continue;
        const table = await dataTables.getTable(ref.tableId);
        if (!table) throw new NodeOperationError(this.getNode(), 'The dataset table no longer exists', { itemIndex: i });
        const known = new Set(table.columns.map((c) => c.name));
        for (const column of Object.keys(data)) {
          if (!known.has(column)) await dataTables.addColumn(table.id, { name: column, type: 'string' });
        }
        // string columns hold text; stringify the rest so any value fits
        for (const [k, v] of Object.entries(data)) {
          const type = table.columns.find((c) => c.name === k)?.type ?? 'string';
          if (type === 'string' && v != null && typeof v !== 'string') data[k] = String(v);
        }
        await dataTables.updateRows(table.id, { type: 'and', filters: [{ columnName: 'id', condition: 'eq', value: ref.rowId }] }, data);
      }
      return [items];
    }

    const out: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        out.push({ json: await metricsFor(this, i), pairedItem: { item: i } });
      } catch (e) {
        if (this.continueOnFail()) {
          out.push({ json: { error: (e as Error).message }, pairedItem: { item: i } });
          continue;
        }
        throw e instanceof NodeOperationError ? e : new NodeOperationError(this.getNode(), e as Error, { itemIndex: i });
      }
    }
    return [out];
  },
};

/** Metrics an evaluation run recorded: every number the Set Metrics nodes output, later ones winning. */
export function collectMetrics(nodes: INode[], runData: Record<string, Array<{ data?: { main?: Array<INodeExecutionData[] | null> } }>>): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const node of nodes) {
    if (node.type !== EVALUATION_NODE || node.disabled || (node.parameters.operation ?? 'setOutputs') !== 'setMetrics') continue;
    for (const run of runData[node.name] ?? []) {
      for (const item of run.data?.main?.[0] ?? []) {
        for (const [k, v] of Object.entries(item.json)) if (typeof v === 'number' && Number.isFinite(v)) metrics[k] = v;
      }
    }
  }
  return metrics;
}

export const evaluationNodes: INodeType[] = [EvaluationTrigger, Evaluation];
