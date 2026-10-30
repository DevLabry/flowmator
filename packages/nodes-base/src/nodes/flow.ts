import {
  NodeOperationError,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowmator/workflow';
import { evaluateFilter, type FilterValue } from '../utils/filter';

export const ManualTrigger: INodeType = {
  description: {
    name: 'flowmator.manualTrigger',
    displayName: 'Manual Trigger',
    description: 'Starts the workflow when you click "Execute workflow"',
    group: ['trigger'],
    version: 1,
    defaults: { name: "When clicking 'Execute workflow'", color: '#909298' },
    icon: 'fa:mouse-pointer',
    inputs: [],
    outputs: ['main'],
    maxNodes: 1,
    properties: [
      { displayName: 'This node is where the workflow starts when you run it from the editor.', name: 'notice', type: 'notice', default: '' },
    ],
  },
  async execute(this: IExecuteFunctions) {
    return [this.getInputData()];
  },
};

export const NoOp: INodeType = {
  description: {
    name: 'flowmator.noOp',
    displayName: 'No Operation, do nothing',
    description: 'Passes its input through unchanged',
    group: ['organization'],
    version: 1,
    defaults: { name: 'No Operation, do nothing', color: '#b0b0b0' },
    icon: 'fa:arrow-right',
    inputs: ['main'],
    outputs: ['main'],
    properties: [],
  },
  async execute(this: IExecuteFunctions) {
    return [this.getInputData()];
  },
};

export const StickyNote: INodeType = {
  description: {
    name: 'flowmator.stickyNote',
    displayName: 'Sticky Note',
    description: 'A note on the canvas',
    group: ['input'],
    version: 1,
    defaults: { name: 'Sticky Note', color: '#FFD233' },
    inputs: [],
    outputs: [],
    properties: [
      { displayName: 'Content', name: 'content', type: 'string', default: '## Note\nDouble click to edit' },
      { displayName: 'Height', name: 'height', type: 'number', default: 160 },
      { displayName: 'Width', name: 'width', type: 'number', default: 240 },
      { displayName: 'Color', name: 'color', type: 'number', default: 1 },
    ],
  },
};

export const StopAndError: INodeType = {
  description: {
    name: 'flowmator.stopAndError',
    displayName: 'Stop and Error',
    description: 'Throws an error, stopping the workflow',
    group: ['input'],
    version: 1,
    defaults: { name: 'Stop and Error', color: '#ff0000' },
    icon: 'fa:exclamation-triangle',
    inputs: ['main'],
    outputs: [],
    properties: [
      {
        displayName: 'Error Type',
        name: 'errorType',
        type: 'options',
        options: [
          { name: 'Error Message', value: 'errorMessage' },
          { name: 'Error Object', value: 'errorObject' },
        ],
        default: 'errorMessage',
      },
      { displayName: 'Error Message', name: 'errorMessage', type: 'string', default: '', required: true, displayOptions: { show: { errorType: ['errorMessage'] } } },
      { displayName: 'Error Object', name: 'errorObject', type: 'json', default: '{\n  "code": "404",\n  "message": "Not found"\n}', displayOptions: { show: { errorType: ['errorObject'] } } },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const type = this.getNodeParameter('errorType', 0) as string;
    if (type === 'errorObject') {
      const raw = this.getNodeParameter('errorObject', 0);
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      throw new NodeOperationError(this.getNode(), obj.message ?? obj.description ?? JSON.stringify(obj), { description: obj.description });
    }
    throw new NodeOperationError(this.getNode(), this.getNodeParameter('errorMessage', 0) as string);
  },
};

const conditionsProp = {
  displayName: 'Conditions',
  name: 'conditions',
  type: 'filter' as const,
  default: { options: { caseSensitive: true, typeValidation: 'strict' }, conditions: [], combinator: 'and' },
};

const ifOptions = {
  displayName: 'Options',
  name: 'options',
  type: 'collection' as const,
  default: {},
  options: [
    { displayName: 'Ignore Case', name: 'ignoreCase', type: 'boolean' as const, default: false },
  ],
};

function filterOptions(this: IExecuteFunctions, itemIndex: number) {
  const loose = this.getNodeParameter('looseTypeValidation', itemIndex, false) as boolean;
  const ignoreCase = this.getNodeParameter('options.ignoreCase', itemIndex, false) as boolean;
  return {
    ...(loose ? { typeValidation: 'loose' as const } : {}),
    ...(ignoreCase ? { caseSensitive: false } : {}),
  };
}

/** Evaluates the filter for each item, collecting kept/discarded items and honoring continueOnFail. */
function splitByFilter(ctx: IExecuteFunctions, param = 'conditions') {
  const kept: INodeExecutionData[] = [];
  const discarded: INodeExecutionData[] = [];
  ctx.getInputData().forEach((item, i) => {
    try {
      const filter = ctx.getNodeParameter(param, i) as FilterValue;
      const pass = evaluateFilter(filter, filterOptions.call(ctx, i));
      (pass ? kept : discarded).push({ ...item, pairedItem: { item: i } });
    } catch (error) {
      if (ctx.continueOnFail()) {
        discarded.push({ ...item, pairedItem: { item: i } });
        return;
      }
      throw new NodeOperationError(ctx.getNode(), error as Error, { itemIndex: i });
    }
  });
  return { kept, discarded };
}

export const If: INodeType = {
  description: {
    name: 'flowmator.if',
    displayName: 'If',
    description: 'Routes items to "true" or "false" based on conditions',
    group: ['transform'],
    version: [1, 2, 2.1, 2.2],
    defaults: { name: 'If', color: '#408000' },
    icon: 'fa:map-signs',
    inputs: ['main'],
    outputs: ['main', 'main'],
    outputNames: ['true', 'false'],
    properties: [conditionsProp, { displayName: 'Convert types where required', name: 'looseTypeValidation', type: 'boolean', default: false }, ifOptions],
  },
  async execute(this: IExecuteFunctions) {
    const { kept, discarded } = splitByFilter(this);
    return [kept, discarded];
  },
};

export const Filter: INodeType = {
  description: {
    name: 'flowmator.filter',
    displayName: 'Filter',
    description: 'Keeps only items that match the conditions',
    group: ['transform'],
    version: [1, 2, 2.1, 2.2],
    defaults: { name: 'Filter', color: '#229eff' },
    icon: 'fa:filter',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      conditionsProp,
      { displayName: 'Convert types where required', name: 'looseTypeValidation', type: 'boolean', default: false },
      {
        ...ifOptions,
        options: [...ifOptions.options, { displayName: 'Always Output Discarded Items', name: 'allowDiscardedOutput', type: 'boolean' as const, default: false }],
      },
    ],
    dynamicOutputs: (p) => ((p.options as { allowDiscardedOutput?: boolean })?.allowDiscardedOutput ? ['main', 'main'] : ['main']),
    dynamicOutputNames: (p) => ((p.options as { allowDiscardedOutput?: boolean })?.allowDiscardedOutput ? ['Kept', 'Discarded'] : []),
  },
  async execute(this: IExecuteFunctions) {
    const { kept, discarded } = splitByFilter(this);
    const withDiscarded = this.getNodeParameter('options.allowDiscardedOutput', 0, false) as boolean;
    return withDiscarded ? [kept, discarded] : [kept];
  },
};

interface SwitchRule {
  conditions: FilterValue;
  renameOutput?: boolean;
  outputKey?: string;
}

const rulesOf = (p: Record<string, unknown>) => ((p.rules as { values?: SwitchRule[] })?.values ?? []);

export const Switch: INodeType = {
  description: {
    name: 'flowmator.switch',
    displayName: 'Switch',
    description: 'Routes items to different outputs by rules or by an expression',
    group: ['transform'],
    version: [3, 3.1, 3.2],
    defaults: { name: 'Switch', color: '#506000' },
    icon: 'fa:map-signs',
    inputs: ['main'],
    outputs: ['main'],
    dynamicOutputs: (p) => {
      if (p.mode === 'expression') return Array.from({ length: Number(p.numberOutputs ?? 4) }, () => 'main' as const);
      const extra = (p.options as { fallbackOutput?: string | number })?.fallbackOutput === 'extra' ? 1 : 0;
      return Array.from({ length: rulesOf(p).length + extra }, () => 'main' as const);
    },
    dynamicOutputNames: (p) => {
      if (p.mode === 'expression') return Array.from({ length: Number(p.numberOutputs ?? 4) }, (_, i) => String(i));
      const names = rulesOf(p).map((r, i) => (r.renameOutput && r.outputKey ? r.outputKey : String(i)));
      const opts = p.options as { fallbackOutput?: string | number; renameFallbackOutput?: string };
      if (opts?.fallbackOutput === 'extra') names.push(opts.renameFallbackOutput || 'Fallback');
      return names;
    },
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        noDataExpression: true,
        options: [
          { name: 'Rules', value: 'rules', description: 'Build a matching rule for each output' },
          { name: 'Expression', value: 'expression', description: 'Write an expression that returns the output index' },
        ],
        default: 'rules',
      },
      { displayName: 'Number of Outputs', name: 'numberOutputs', type: 'number', default: 4, displayOptions: { show: { mode: ['expression'] } } },
      { displayName: 'Output Index', name: 'output', type: 'number', default: '={{ }}', displayOptions: { show: { mode: ['expression'] } } },
      {
        displayName: 'Routing Rules',
        name: 'rules',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true, sortable: true, multipleValueButtonText: 'Add Routing Rule' },
        default: { values: [{ conditions: conditionsProp.default }] },
        displayOptions: { show: { mode: ['rules'] } },
        options: [
          {
            name: 'values',
            displayName: 'Values',
            values: [
              conditionsProp,
              { displayName: 'Rename Output', name: 'renameOutput', type: 'boolean', default: false },
              { displayName: 'Output Name', name: 'outputKey', type: 'string', default: '', displayOptions: { show: { renameOutput: [true] } } },
            ],
          },
        ],
      },
      { displayName: 'Convert types where required', name: 'looseTypeValidation', type: 'boolean', default: false, displayOptions: { show: { mode: ['rules'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        displayOptions: { show: { mode: ['rules'] } },
        options: [
          { displayName: 'Fallback Output', name: 'fallbackOutput', type: 'options', default: 'none', options: [{ name: 'None (Default)', value: 'none' }, { name: 'Extra Output', value: 'extra' }] },
          { displayName: 'Rename Fallback Output', name: 'renameFallbackOutput', type: 'string', default: '' },
          { displayName: 'Ignore Case', name: 'ignoreCase', type: 'boolean', default: false },
          { displayName: 'Send data to all matching outputs', name: 'allMatchingOutputs', type: 'boolean', default: false },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const node = this.getNode();
    const mode = this.getNodeParameter('mode', 0) as string;

    if (mode === 'expression') {
      const count = this.getNodeParameter('numberOutputs', 0) as number;
      const outputs: INodeExecutionData[][] = Array.from({ length: count }, () => []);
      items.forEach((item, i) => {
        const index = Number(this.getNodeParameter('output', i));
        if (!Number.isInteger(index) || index < 0 || index >= count) {
          throw new NodeOperationError(node, `The output ${index} is not allowed. It has to be between 0 and ${count - 1}`, { itemIndex: i });
        }
        outputs[index].push({ ...item, pairedItem: { item: i } });
      });
      return outputs;
    }

    const rules = rulesOf(node.parameters as Record<string, unknown>);
    const fallback = this.getNodeParameter('options.fallbackOutput', 0, 'none') as string | number;
    const allMatching = this.getNodeParameter('options.allMatchingOutputs', 0, false) as boolean;
    const outputs: INodeExecutionData[][] = Array.from({ length: rules.length + (fallback === 'extra' ? 1 : 0) }, () => []);

    items.forEach((item, i) => {
      const loose = this.getNodeParameter('looseTypeValidation', i, false) as boolean;
      const ignoreCase = this.getNodeParameter('options.ignoreCase', i, false) as boolean;
      let matched = false;
      for (let r = 0; r < rules.length; r++) {
        const filter = this.getNodeParameter(`rules.values.${r}.conditions`, i) as FilterValue;
        if (evaluateFilter(filter, { ...(loose ? { typeValidation: 'loose' } : {}), ...(ignoreCase ? { caseSensitive: false } : {}) })) {
          outputs[r].push({ ...item, pairedItem: { item: i } });
          matched = true;
          if (!allMatching) break;
        }
      }
      if (!matched && fallback !== 'none') {
        const idx = fallback === 'extra' ? rules.length : Number(fallback);
        outputs[idx]?.push({ ...item, pairedItem: { item: i } });
      }
    });
    return outputs;
  },
};

export const ErrorTrigger: INodeType = {
  description: {
    name: 'flowmator.errorTrigger',
    displayName: 'Error Trigger',
    description: 'Starts this workflow when another workflow that uses it as its error workflow fails',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Error Trigger', color: '#0000FF' },
    icon: 'fa:bug',
    inputs: [],
    outputs: ['main'],
    maxNodes: 1,
    properties: [
      { displayName: 'Set this workflow as "Error Workflow" in the settings of the workflows you want to monitor.', name: 'notice', type: 'notice', default: '' },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    if (this.getMode() === 'manual' && !Object.keys(items[0]?.json ?? {}).length) {
      // sample data so the workflow can be built and tested from the editor
      return [[{ json: {
        execution: { id: '231', url: 'http://localhost:5678/execution/231', retryOf: '34', error: { message: 'Example Error Message', stack: 'Stacktrace' }, lastNodeExecuted: 'Node With Error', mode: 'manual' },
        workflow: { id: '1', name: 'Example Workflow' },
      } }]];
    }
    return [items];
  },
};
