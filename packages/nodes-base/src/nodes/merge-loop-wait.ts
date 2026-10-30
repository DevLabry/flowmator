import {
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type IWebhookFunctions,
} from '@flowmator/workflow';
import { DateTime } from 'luxon';
import { getValue, isEqual } from '../utils/object';

const pair = (item: INodeExecutionData, i: number, input = 0): INodeExecutionData => ({ ...item, pairedItem: { item: i, input } });

export const Merge: INodeType = {
  description: {
    name: 'flowmator.merge',
    displayName: 'Merge',
    description: 'Combines data from several inputs once data from all of them is available',
    group: ['transform'],
    version: [3, 3.1, 3.2],
    defaults: { name: 'Merge', color: '#00bbcc' },
    icon: 'fa:code-branch',
    inputs: ['main', 'main'],
    outputs: ['main'],
    dynamicInputs: (p) => Array.from({ length: Number(p.numberInputs ?? 2) }, () => 'main' as const),
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        noDataExpression: true,
        default: 'append',
        options: [
          { name: 'Append', value: 'append', description: 'Output items of each input, one after another' },
          { name: 'Combine', value: 'combine', description: 'Merge matching items together' },
          { name: 'Choose Branch', value: 'chooseBranch', description: 'Output data from a specific branch, without modifying it' },
        ],
      },
      { displayName: 'Number of Inputs', name: 'numberInputs', type: 'options', default: 2, displayOptions: { show: { mode: ['append', 'chooseBranch'] } },
        options: Array.from({ length: 9 }, (_, i) => ({ name: String(i + 2), value: i + 2 })) },
      {
        displayName: 'Combine By',
        name: 'combineBy',
        type: 'options',
        default: 'combineByFields',
        displayOptions: { show: { mode: ['combine'] } },
        options: [
          { name: 'Matching Fields', value: 'combineByFields' },
          { name: 'Position', value: 'combineByPosition' },
          { name: 'All Possible Combinations', value: 'combineAll' },
        ],
      },
      {
        displayName: 'Fields To Match',
        name: 'fieldsToMatchString',
        type: 'string',
        default: '',
        placeholder: 'e.g. id, name',
        displayOptions: { show: { mode: ['combine'], combineBy: ['combineByFields'], advanced: [false] } },
      },
      { displayName: 'Fields To Match Have Different Names', name: 'advanced', type: 'boolean', default: false, displayOptions: { show: { mode: ['combine'], combineBy: ['combineByFields'] } } },
      {
        displayName: 'Fields To Match',
        name: 'mergeByFields',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { values: [{ field1: '', field2: '' }] },
        displayOptions: { show: { mode: ['combine'], combineBy: ['combineByFields'], advanced: [true] } },
        options: [
          {
            name: 'values',
            displayName: 'Values',
            values: [
              { displayName: 'Input 1 Field', name: 'field1', type: 'string', default: '' },
              { displayName: 'Input 2 Field', name: 'field2', type: 'string', default: '' },
            ],
          },
        ],
      },
      {
        displayName: 'Output Type',
        name: 'joinMode',
        type: 'options',
        default: 'keepMatches',
        displayOptions: { show: { mode: ['combine'], combineBy: ['combineByFields'] } },
        options: [
          { name: 'Keep Matches', value: 'keepMatches' },
          { name: 'Keep Non-Matches', value: 'keepNonMatches' },
          { name: 'Keep Everything', value: 'keepEverything' },
          { name: 'Enrich Input 1', value: 'enrichInput1' },
          { name: 'Enrich Input 2', value: 'enrichInput2' },
        ],
      },
      {
        displayName: 'Output Data From',
        name: 'outputDataFrom',
        type: 'options',
        default: 'both',
        displayOptions: { show: { mode: ['combine'], combineBy: ['combineByFields'], joinMode: ['keepMatches', 'keepNonMatches'] } },
        options: [
          { name: 'Both Inputs Merged Together', value: 'both' },
          { name: 'Input 1', value: 'input1' },
          { name: 'Input 2', value: 'input2' },
        ],
      },
      {
        displayName: 'Output Type',
        name: 'chooseBranchMode',
        type: 'options',
        default: 'waitForAll',
        displayOptions: { show: { mode: ['chooseBranch'] } },
        options: [{ name: 'Wait for All Inputs to Arrive', value: 'waitForAll' }],
      },
      {
        displayName: 'Output',
        name: 'output',
        type: 'options',
        default: 'specifiedInput',
        displayOptions: { show: { mode: ['chooseBranch'] } },
        options: [
          { name: 'Data of Specified Input', value: 'specifiedInput' },
          { name: 'A Single, Empty Item', value: 'empty' },
        ],
      },
      { displayName: 'Use Data of Input', name: 'useDataOfInput', type: 'number', default: 1, displayOptions: { show: { mode: ['chooseBranch'], output: ['specifiedInput'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        displayOptions: { show: { mode: ['combine'] } },
        options: [
          {
            displayName: 'Clash Handling',
            name: 'clashHandling',
            type: 'fixedCollection',
            default: { values: { resolveClash: 'preferLast' } },
            options: [
              {
                name: 'values',
                displayName: 'Values',
                values: [
                  {
                    displayName: 'When Field Values Clash',
                    name: 'resolveClash',
                    type: 'options',
                    default: 'preferLast',
                    options: [
                      { name: 'Prefer Input 1 Version', value: 'preferInput1' },
                      { name: 'Prefer Input 2 Version', value: 'preferLast' },
                      { name: 'Add Input Number to Field Names', value: 'addSuffix' },
                    ],
                  },
                  { displayName: 'Merging Nested Fields', name: 'mergeMode', type: 'options', default: 'deepMerge', options: [{ name: 'Deep Merge', value: 'deepMerge' }, { name: 'Shallow Merge', value: 'shallowMerge' }] },
                ],
              },
            ],
          },
          { displayName: 'Include Unpaired Items', name: 'includeUnpaired', type: 'boolean', default: false },
          { displayName: 'Fuzzy Compare', name: 'fuzzyCompare', type: 'boolean', default: false },
          { displayName: 'Disable Dot Notation', name: 'disableDotNotation', type: 'boolean', default: false },
          { displayName: 'Multiple Matches', name: 'multipleMatches', type: 'options', default: 'all', options: [{ name: 'Include All Matches', value: 'all' }, { name: 'Include First Match Only', value: 'first' }] },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const mode = this.getNodeParameter('mode', 0) as string;
    const inputCount = Number(this.getNodeParameter('numberInputs', 0, 2));

    if (mode === 'append') {
      const out: INodeExecutionData[] = [];
      for (let input = 0; input < inputCount; input++) this.getInputData(input).forEach((item, i) => out.push(pair(item, i, input)));
      return [out];
    }

    if (mode === 'chooseBranch') {
      if (this.getNodeParameter('output', 0) === 'empty') return [[{ json: {}, pairedItem: [] }]];
      const which = Number(this.getNodeParameter('useDataOfInput', 0)) - 1;
      return [this.getInputData(which).map((item, i) => pair(item, i, which))];
    }

    const in1 = this.getInputData(0);
    const in2 = this.getInputData(1);
    const clash = this.getNodeParameter('options.clashHandling.values', 0, { resolveClash: 'preferLast', mergeMode: 'deepMerge' }) as IDataObject;
    const combine = (a: INodeExecutionData | undefined, b: INodeExecutionData | undefined, ia: number, ib: number): INodeExecutionData => {
      const paired = [...(a ? [{ item: ia, input: 0 }] : []), ...(b ? [{ item: ib, input: 1 }] : [])];
      const binary = { ...(a?.binary ?? {}), ...(b?.binary ?? {}) };
      const json = mergeJson(a?.json ?? {}, b?.json ?? {}, clash.resolveClash as string, clash.mergeMode as string);
      return { json, ...(Object.keys(binary).length ? { binary } : {}), pairedItem: paired };
    };
    const combineBy = this.getNodeParameter('combineBy', 0) as string;

    if (combineBy === 'combineByPosition') {
      const includeUnpaired = this.getNodeParameter('options.includeUnpaired', 0, false) as boolean;
      const len = includeUnpaired ? Math.max(in1.length, in2.length) : Math.min(in1.length, in2.length);
      return [Array.from({ length: len }, (_, i) => combine(in1[i], in2[i], i, i))];
    }

    if (combineBy === 'combineAll') {
      const out: INodeExecutionData[] = [];
      in1.forEach((a, i) => in2.forEach((b, j) => out.push(combine(a, b, i, j))));
      return [out];
    }

    // combineByFields
    const advanced = this.getNodeParameter('advanced', 0, false) as boolean;
    const pairs: Array<{ field1: string; field2: string }> = advanced
      ? ((this.getNodeParameter('mergeByFields.values', 0, []) as Array<{ field1: string; field2: string }>) ?? [])
      : String(this.getNodeParameter('fieldsToMatchString', 0, ''))
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((f) => ({ field1: f, field2: f }));
    if (!pairs.length) throw new NodeOperationError(this.getNode(), 'You need to define at least one pair of fields in "Fields to Match"');

    const fuzzy = this.getNodeParameter('options.fuzzyCompare', 0, false) as boolean;
    const dot = !(this.getNodeParameter('options.disableDotNotation', 0, false) as boolean);
    const firstOnly = this.getNodeParameter('options.multipleMatches', 0, 'all') === 'first';
    const eq = (x: unknown, y: unknown) => (fuzzy ? String(x) === String(y) : isEqual(x, y));
    const matches = (a: INodeExecutionData, b: INodeExecutionData) =>
      pairs.every((p) => {
        const va = getValue(a.json, p.field1, dot);
        return va !== undefined && eq(va, getValue(b.json, p.field2, dot));
      });

    const joinMode = this.getNodeParameter('joinMode', 0) as string;
    const outputFrom = this.getNodeParameter('outputDataFrom', 0, 'both') as string;
    const matched2 = new Set<number>();
    const out: INodeExecutionData[] = [];
    const unmatched1: number[] = [];

    in1.forEach((a, i) => {
      let found = false;
      for (let j = 0; j < in2.length; j++) {
        if (!matches(a, in2[j])) continue;
        found = true;
        matched2.add(j);
        if (joinMode === 'keepMatches' || joinMode === 'keepEverything' || joinMode === 'enrichInput1' || joinMode === 'enrichInput2') {
          if (joinMode === 'keepMatches' && outputFrom === 'input1') out.push(pair(a, i, 0));
          else if (joinMode === 'keepMatches' && outputFrom === 'input2') out.push(pair(in2[j], j, 1));
          else out.push(combine(a, in2[j], i, j));
        }
        if (firstOnly) break;
      }
      if (!found) unmatched1.push(i);
    });

    const unmatched2 = in2.map((_, j) => j).filter((j) => !matched2.has(j));
    switch (joinMode) {
      case 'keepNonMatches': {
        const r: INodeExecutionData[] = [];
        if (outputFrom !== 'input2') unmatched1.forEach((i) => r.push(pair(in1[i], i, 0)));
        if (outputFrom !== 'input1') unmatched2.forEach((j) => r.push(pair(in2[j], j, 1)));
        return [r];
      }
      case 'keepEverything':
        unmatched1.forEach((i) => out.push(pair(in1[i], i, 0)));
        unmatched2.forEach((j) => out.push(pair(in2[j], j, 1)));
        return [out];
      case 'enrichInput1':
        unmatched1.forEach((i) => out.push(pair(in1[i], i, 0)));
        return [out];
      case 'enrichInput2':
        unmatched2.forEach((j) => out.push(pair(in2[j], j, 1)));
        return [out];
      default:
        return [out];
    }
  },
};

function mergeJson(a: IDataObject, b: IDataObject, resolve = 'preferLast', mode = 'deepMerge'): IDataObject {
  if (resolve === 'addSuffix') {
    const out: IDataObject = {};
    for (const [k, v] of Object.entries(a)) out[k in b ? `${k}_1` : k] = v;
    for (const [k, v] of Object.entries(b)) out[k in a ? `${k}_2` : k] = v;
    return out;
  }
  const [base, over] = resolve === 'preferInput1' ? [b, a] : [a, b];
  if (mode === 'shallowMerge') return { ...base, ...over };
  return deepMerge(structuredClone(base), over);
}

function deepMerge(target: IDataObject, source: IDataObject): IDataObject {
  for (const [k, v] of Object.entries(source)) {
    const t = target[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && t && typeof t === 'object' && !Array.isArray(t)) {
      target[k] = deepMerge(t as IDataObject, v as IDataObject);
    } else target[k] = structuredClone(v) as never;
  }
  return target;
}

interface LoopContext extends IDataObject {
  items?: INodeExecutionData[];
  processedItems?: INodeExecutionData[];
  sourceIndexes?: number[];
}

export const LoopOverItems: INodeType = {
  description: {
    name: 'flowmator.splitInBatches',
    displayName: 'Loop Over Items (Split in Batches)',
    description: 'Splits data into batches and iterates over each batch',
    group: ['organization'],
    version: 3,
    defaults: { name: 'Loop Over Items', color: '#007755' },
    icon: 'fa:sync',
    inputs: ['main'],
    outputs: ['main', 'main'],
    outputNames: ['done', 'loop'],
    codex: { alias: ['Loop', 'Batch', 'Iterate', 'For each'] },
    properties: [
      { displayName: 'Batch Size', name: 'batchSize', type: 'number', typeOptions: { minValue: 1 }, default: 1 },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [{ displayName: 'Reset', name: 'reset', type: 'boolean', default: false, description: 'Treat incoming data as a new set of items to loop over' }],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const ctx = this.getContext('node') as LoopContext;
    const input = this.getInputData();
    const batchSize = Math.max(1, Number(this.getNodeParameter('batchSize', 0)));
    const reset = this.getNodeParameter('options.reset', 0, false) as boolean;

    if (ctx.items === undefined || reset) {
      ctx.items = input.map((item, i) => ({ ...item, pairedItem: { item: i } }));
      ctx.processedItems = [];
      const batch = ctx.items.splice(0, batchSize);
      ctx.noItemsLeft = ctx.items.length === 0;
      ctx.done = false;
      return [[], batch];
    }

    ctx.processedItems!.push(...input.map((item) => ({ ...item, pairedItem: item.pairedItem ?? { item: 0 } })));
    const batch = ctx.items.splice(0, batchSize);
    if (batch.length === 0) {
      const done = ctx.processedItems!.map((item, i) => ({ ...item, pairedItem: { item: i } }));
      delete ctx.items;
      delete ctx.processedItems;
      ctx.done = true;
      return [done, []];
    }
    ctx.noItemsLeft = ctx.items.length === 0;
    return [[], batch.map((item, i) => ({ ...item, pairedItem: { item: i } }))];
  },
};

const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
/** Waits shorter than this happen in-process instead of persisting the execution. */
const IN_PROCESS_WAIT_LIMIT_MS = 65_000;

export const Wait: INodeType = {
  description: {
    name: 'flowmator.wait',
    displayName: 'Wait',
    description: 'Pauses the workflow for a time, until a date, or until a webhook or form is received',
    group: ['organization'],
    version: [1, 1.1],
    defaults: { name: 'Wait', color: '#804050' },
    icon: 'fa:pause-circle',
    inputs: ['main'],
    outputs: ['main'],
    webhooks: [{ name: 'default', httpMethod: '={{$parameter["httpMethod"] || "POST"}}', path: '', restartWebhook: true }],
    properties: [
      {
        displayName: 'Resume',
        name: 'resume',
        type: 'options',
        default: 'timeInterval',
        options: [
          { name: 'After Time Interval', value: 'timeInterval' },
          { name: 'At Specified Time', value: 'specificTime' },
          { name: 'On Webhook Call', value: 'webhook' },
          { name: 'On Form Submitted', value: 'form' },
        ],
      },
      { displayName: 'Wait Amount', name: 'amount', type: 'number', default: 1, typeOptions: { minValue: 0, numberPrecision: 2 }, displayOptions: { show: { resume: ['timeInterval'] } } },
      {
        displayName: 'Wait Unit',
        name: 'unit',
        type: 'options',
        default: 'hours',
        displayOptions: { show: { resume: ['timeInterval'] } },
        options: ['seconds', 'minutes', 'hours', 'days'].map((u) => ({ name: u[0].toUpperCase() + u.slice(1), value: u })),
      },
      { displayName: 'Date and Time', name: 'dateTime', type: 'dateTime', default: '', required: true, displayOptions: { show: { resume: ['specificTime'] } } },
      { displayName: 'HTTP Method', name: 'httpMethod', type: 'options', default: 'POST', displayOptions: { show: { resume: ['webhook'] } },
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ name: m, value: m })) },
      { displayName: 'Limit Wait Time', name: 'limitWaitTime', type: 'boolean', default: false, displayOptions: { show: { resume: ['webhook', 'form'] } } },
      { displayName: 'Limit Type', name: 'limitType', type: 'options', default: 'afterTimeInterval', displayOptions: { show: { resume: ['webhook', 'form'], limitWaitTime: [true] } },
        options: [{ name: 'After Time Interval', value: 'afterTimeInterval' }, { name: 'At Specified Time', value: 'atSpecifiedTime' }] },
      { displayName: 'Amount', name: 'resumeAmount', type: 'number', default: 1, displayOptions: { show: { limitType: ['afterTimeInterval'], limitWaitTime: [true] } } },
      { displayName: 'Unit', name: 'resumeUnit', type: 'options', default: 'hours', displayOptions: { show: { limitType: ['afterTimeInterval'], limitWaitTime: [true] } },
        options: ['seconds', 'minutes', 'hours', 'days'].map((u) => ({ name: u, value: u })) },
      { displayName: 'Max Date and Time', name: 'maxDateAndTime', type: 'dateTime', default: '', displayOptions: { show: { limitType: ['atSpecifiedTime'], limitWaitTime: [true] } } },
      { displayName: 'Form Title', name: 'formTitle', type: 'string', default: '', displayOptions: { show: { resume: ['form'] } } },
      { displayName: 'Form Description', name: 'formDescription', type: 'string', default: '', displayOptions: { show: { resume: ['form'] } } },
      {
        displayName: 'Form Fields',
        name: 'formFields',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        displayOptions: { show: { resume: ['form'] } },
        options: [
          {
            name: 'values',
            displayName: 'Values',
            values: [
              { displayName: 'Field Label', name: 'fieldLabel', type: 'string', default: '' },
              { displayName: 'Element Type', name: 'fieldType', type: 'options', default: 'text',
                options: ['text', 'textarea', 'number', 'email', 'password', 'date', 'dropdown', 'checkbox', 'file'].map((t) => ({ name: t, value: t })) },
              { displayName: 'Required Field', name: 'requiredField', type: 'boolean', default: false },
            ],
          },
        ],
      },
    ],
  },
  async webhook(this: IWebhookFunctions) {
    const req = this.getRequestObject();
    return {
      workflowData: [[{ json: { headers: req.headers, params: req.params, query: req.query, body: req.body } as IDataObject }]],
    };
  },
  async execute(this: IExecuteFunctions) {
    const input = this.getInputData();
    const resumed = this.getResumeData();
    if (resumed) return [resumed.data ?? input];

    const resume = this.getNodeParameter('resume', 0) as string;
    if (resume === 'webhook' || resume === 'form') {
      let until = new Date('3000-01-01T00:00:00Z');
      if (this.getNodeParameter('limitWaitTime', 0, false)) {
        if (this.getNodeParameter('limitType', 0) === 'afterTimeInterval') {
          const ms = Number(this.getNodeParameter('resumeAmount', 0)) * UNIT_MS[this.getNodeParameter('resumeUnit', 0) as string];
          until = new Date(Date.now() + ms);
        } else until = new Date(this.getNodeParameter('maxDateAndTime', 0) as string);
      }
      await this.putExecutionToWait(until);
      return [input];
    }

    let waitTill: Date;
    if (resume === 'timeInterval') {
      const amount = Number(this.getNodeParameter('amount', 0));
      const unit = this.getNodeParameter('unit', 0) as string;
      waitTill = new Date(Date.now() + amount * UNIT_MS[unit]);
    } else {
      const dt = this.getNodeParameter('dateTime', 0) as string;
      const parsed = DateTime.fromISO(dt, { zone: this.getTimezone() });
      if (!parsed.isValid) throw new NodeOperationError(this.getNode(), `Invalid date "${dt}"`);
      waitTill = parsed.toJSDate();
    }

    const ms = waitTill.getTime() - Date.now();
    if (ms < IN_PROCESS_WAIT_LIMIT_MS) {
      if (ms > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          this.getExecutionCancelSignal()?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Execution cancelled'));
          });
        });
      }
      return [input];
    }
    await this.putExecutionToWait(waitTill);
    return [input];
  },
};
