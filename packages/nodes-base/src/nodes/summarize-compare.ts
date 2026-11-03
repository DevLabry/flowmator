import { NodeOperationError, type IDataObject, type IExecuteFunctions, type INodeExecutionData, type INodeType, type IPairedItem } from '@flowmator/workflow';
import { deepCopy, fieldList, getValue, isEqual, setValue } from '../utils/object';

/* ---------------- Summarize ---------------- */

type Aggregation = 'append' | 'average' | 'concatenate' | 'count' | 'countUnique' | 'max' | 'min' | 'sum';

interface SummarizeField {
  aggregation: Aggregation;
  field: string;
  separateBy?: 'comma' | 'comma+space' | 'newline' | 'nothing' | 'space' | 'other';
  customSeparator?: string;
  includeEmpty?: boolean;
}

const SEPARATORS: Record<string, string> = { comma: ',', 'comma+space': ', ', newline: '\n', nothing: '', space: ' ' };

function aggregate(values: unknown[], f: SummarizeField): unknown {
  const present = f.includeEmpty ? values : values.filter((v) => v !== undefined && v !== null && v !== '');
  const nums = () => present.map(Number).filter((n) => !Number.isNaN(n));
  switch (f.aggregation) {
    case 'count':
      return present.length;
    case 'countUnique':
      return new Set(present.map((v) => JSON.stringify(v))).size;
    case 'sum':
      return nums().reduce((a, b) => a + b, 0);
    case 'average': {
      const n = nums();
      return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
    }
    case 'min':
      return nums().length ? Math.min(...nums()) : null;
    case 'max':
      return nums().length ? Math.max(...nums()) : null;
    case 'append':
      return present;
    case 'concatenate': {
      const sep = f.separateBy === 'other' ? (f.customSeparator ?? '') : SEPARATORS[f.separateBy ?? 'comma+space'];
      return present.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(sep);
    }
  }
}

const outputName = (f: SummarizeField) => `${f.aggregation === 'countUnique' ? 'unique_count' : f.aggregation === 'average' ? 'average' : f.aggregation === 'append' ? 'appended' : f.aggregation === 'concatenate' ? 'concatenated' : f.aggregation}_${f.field.replace(/\./g, '_')}`;

export const Summarize: INodeType = {
  description: {
    name: 'flowmator.summarize',
    displayName: 'Summarize',
    description: 'Sum, count, average and concatenate fields, optionally grouped (like a pivot table)',
    group: ['transform'],
    version: [1, 1.1],
    defaults: { name: 'Summarize', color: '#408000' },
    icon: 'fa:table',
    inputs: ['main'],
    outputs: ['main'],
    codex: { alias: ['Group by', 'Pivot', 'Sum', 'Count', 'Average'] },
    properties: [
      {
        displayName: 'Fields to Summarize',
        name: 'fieldsToSummarize',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { values: [{ aggregation: 'count', field: '' }] },
        options: [
          {
            name: 'values',
            displayName: '',
            values: [
              {
                displayName: 'Aggregation',
                name: 'aggregation',
                type: 'options',
                default: 'count',
                options: [
                  { name: 'Append', value: 'append' },
                  { name: 'Average', value: 'average' },
                  { name: 'Concatenate', value: 'concatenate' },
                  { name: 'Count', value: 'count' },
                  { name: 'Count Unique', value: 'countUnique' },
                  { name: 'Max', value: 'max' },
                  { name: 'Min', value: 'min' },
                  { name: 'Sum', value: 'sum' },
                ],
              },
              { displayName: 'Field', name: 'field', type: 'string', default: '' },
              { displayName: 'Include Empty Values', name: 'includeEmpty', type: 'boolean', default: false, displayOptions: { show: { aggregation: ['append', 'concatenate', 'count', 'countUnique'] } } },
              {
                displayName: 'Separator',
                name: 'separateBy',
                type: 'options',
                default: 'comma+space',
                displayOptions: { show: { aggregation: ['concatenate'] } },
                options: [
                  { name: 'Comma', value: 'comma' },
                  { name: 'Comma and Space', value: 'comma+space' },
                  { name: 'New Line', value: 'newline' },
                  { name: 'None', value: 'nothing' },
                  { name: 'Space', value: 'space' },
                  { name: 'Other', value: 'other' },
                ],
              },
              { displayName: 'Custom Separator', name: 'customSeparator', type: 'string', default: '', displayOptions: { show: { aggregation: ['concatenate'], separateBy: ['other'] } } },
            ],
          },
        ],
      },
      { displayName: 'Fields to Split By', name: 'fieldsToSplitBy', type: 'string', default: '', placeholder: 'e.g. country, city', hint: 'Group results by these fields' },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Continue if Field Not Found', name: 'continueIfFieldNotFound', type: 'boolean', default: false },
          { displayName: 'Disable Dot Notation', name: 'disableDotNotation', type: 'boolean', default: false },
          { displayName: 'Output Format', name: 'outputFormat', type: 'options', default: 'separateItems',
            options: [{ name: 'Each Split in a Separate Item', value: 'separateItems' }, { name: 'All Splits in a Single Item', value: 'singleItem' }] },
          { displayName: 'Ignore Items Without Valid Fields to Group By', name: 'skipEmptySplitFields', type: 'boolean', default: false },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const fields = (this.getNodeParameter('fieldsToSummarize.values', 0, []) as SummarizeField[]).filter((f) => f.field);
    const splitBy = fieldList(this.getNodeParameter('fieldsToSplitBy', 0, ''));
    const opts = this.getNodeParameter('options', 0, {}) as IDataObject;
    const dot = !opts.disableDotNotation;

    if (!opts.continueIfFieldNotFound) {
      for (const f of fields) {
        if (items.length && !items.some((it) => getValue(it.json, f.field, dot) !== undefined)) {
          throw new NodeOperationError(this.getNode(), `The field '${f.field}' does not exist in any items`, { description: 'Enable "Continue if Field Not Found" to ignore it' });
        }
      }
    }

    const groups = new Map<string, { keys: unknown[]; indexes: number[] }>();
    items.forEach((item, i) => {
      const keys = splitBy.map((f) => getValue(item.json, f, dot));
      if (opts.skipEmptySplitFields && keys.some((k) => k === undefined || k === null || k === '')) return;
      const id = JSON.stringify(keys);
      const g = groups.get(id) ?? { keys, indexes: [] };
      g.indexes.push(i);
      groups.set(id, g);
    });
    if (!groups.size && !splitBy.length) groups.set('[]', { keys: [], indexes: [] });

    const summaries = [...groups.values()].map(({ keys, indexes }) => {
      const json: IDataObject = {};
      splitBy.forEach((f, k) => setValue(json, f, keys[k] ?? null, false));
      for (const f of fields) json[outputName(f)] = aggregate(indexes.map((i) => getValue(items[i].json, f.field, dot)), f) as never;
      return { json, pairedItem: indexes.map((i) => ({ item: i })) as IPairedItem[] };
    });

    if (opts.outputFormat === 'singleItem' && splitBy.length) {
      return [[{ json: { data: summaries.map((s) => s.json) }, pairedItem: items.map((_, i) => ({ item: i })) }]];
    }
    return [summaries];
  },
};

/* ---------------- Compare Datasets ---------------- */

export const CompareDatasets: INodeType = {
  description: {
    name: 'flowmator.compareDatasets',
    displayName: 'Compare Datasets',
    description: 'Compares two inputs and splits items by whether they match',
    group: ['transform'],
    version: [2, 2.1, 2.2, 2.3],
    defaults: { name: 'Compare Datasets', color: '#8b6d9c' },
    icon: 'fa:equals',
    inputs: ['main', 'main'],
    inputNames: ['Input A', 'Input B'],
    outputs: ['main', 'main', 'main', 'main'],
    outputNames: ['In A only', 'Same', 'Different', 'In B only'],
    properties: [
      {
        displayName: 'Fields to Match',
        name: 'mergeByFields',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { values: [{ field1: '', field2: '' }] },
        options: [
          {
            name: 'values',
            displayName: 'Values',
            values: [
              { displayName: 'Input A Field', name: 'field1', type: 'string', default: '' },
              { displayName: 'Input B Field', name: 'field2', type: 'string', default: '' },
            ],
          },
        ],
      },
      {
        displayName: 'When There Are Differences',
        name: 'resolve',
        type: 'options',
        default: 'includeBoth',
        options: [
          { name: 'Include Both Versions', value: 'includeBoth' },
          { name: 'Use Input A Version', value: 'preferInput1' },
          { name: 'Use Input B Version', value: 'preferInput2' },
          { name: 'Use a Mix of Versions', value: 'mix' },
        ],
      },
      { displayName: 'Prefer', name: 'preferWhenMix', type: 'options', default: 'input1', displayOptions: { show: { resolve: ['mix'] } },
        options: [{ name: 'Input A Version', value: 'input1' }, { name: 'Input B Version', value: 'input2' }] },
      { displayName: 'For Everything Except', name: 'exceptWhenMix', type: 'string', default: '', displayOptions: { show: { resolve: ['mix'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Fields to Skip Comparing', name: 'skipFields', type: 'string', default: '' },
          { displayName: 'Fuzzy Compare', name: 'fuzzyCompare', type: 'boolean', default: false, description: 'Treat values of different types as equal when they look the same (e.g. "3" and 3)' },
          { displayName: 'Disable Dot Notation', name: 'disableDotNotation', type: 'boolean', default: false },
          { displayName: 'Multiple Matches', name: 'multipleMatches', type: 'options', default: 'first', options: [{ name: 'Include First Match Only', value: 'first' }, { name: 'Include All Matches', value: 'all' }] },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const a = this.getInputData(0);
    const b = this.getInputData(1);
    const pairs = (this.getNodeParameter('mergeByFields.values', 0, []) as Array<{ field1: string; field2: string }>).filter((p) => p.field1 && p.field2);
    if (!pairs.length) throw new NodeOperationError(this.getNode(), 'You need to define at least one pair of fields in "Fields to Match"');
    const opts = this.getNodeParameter('options', 0, {}) as IDataObject;
    const dot = !opts.disableDotNotation;
    const fuzzy = !!opts.fuzzyCompare;
    const skip = new Set(fieldList(opts.skipFields));
    const resolve = this.getNodeParameter('resolve', 0) as string;
    const eq = (x: unknown, y: unknown) => (fuzzy ? String(x ?? '') === String(y ?? '') : isEqual(x, y));

    const keyA = (j: IDataObject) => pairs.map((p) => getValue(j, p.field1, dot));
    const keyB = (j: IDataObject) => pairs.map((p) => getValue(j, p.field2, dot));

    const inAOnly: INodeExecutionData[] = [];
    const same: INodeExecutionData[] = [];
    const different: INodeExecutionData[] = [];
    const matchedB = new Set<number>();

    a.forEach((itemA, i) => {
      const ka = keyA(itemA.json);
      const matches = b.map((itemB, j) => ({ itemB, j })).filter(({ itemB }) => ka.every((v, k) => v !== undefined && eq(v, keyB(itemB.json)[k])));
      if (!matches.length) {
        inAOnly.push({ ...itemA, pairedItem: { item: i, input: 0 } });
        return;
      }
      for (const { itemB, j } of opts.multipleMatches === 'all' ? matches : matches.slice(0, 1)) {
        matchedB.add(j);
        const keys = new Set([...Object.keys(itemA.json), ...Object.keys(itemB.json)].filter((k) => !skip.has(k)));
        const diffKeys = [...keys].filter((k) => !eq(itemA.json[k], itemB.json[k]));
        const paired = [{ item: i, input: 0 }, { item: j, input: 1 }];
        if (!diffKeys.length) {
          same.push({ json: deepCopy(itemA.json), pairedItem: paired });
          continue;
        }
        let json: IDataObject;
        if (resolve === 'preferInput1') json = deepCopy(itemA.json);
        else if (resolve === 'preferInput2') json = deepCopy(itemB.json);
        else if (resolve === 'mix') {
          const preferA = this.getNodeParameter('preferWhenMix', 0) === 'input1';
          const except = new Set(fieldList(this.getNodeParameter('exceptWhenMix', 0, '')));
          json = {};
          for (const k of keys) json[k] = (preferA !== except.has(k) ? itemA.json[k] : itemB.json[k]) as never;
        } else {
          json = { keys: Object.fromEntries(pairs.map((p) => [p.field1, getValue(itemA.json, p.field1, dot)])) as IDataObject, same: {}, different: {} };
          for (const k of keys) {
            if (diffKeys.includes(k)) (json.different as IDataObject)[k] = { inputA: itemA.json[k] ?? null, inputB: itemB.json[k] ?? null } as never;
            else (json.same as IDataObject)[k] = itemA.json[k] as never;
          }
        }
        different.push({ json, pairedItem: paired });
      }
    });

    const inBOnly = b.map((item, j) => ({ item, j })).filter(({ j }) => !matchedB.has(j)).map(({ item, j }) => ({ ...item, pairedItem: { item: j, input: 1 } }));
    return [inAOnly, same, different, inBOnly];
  },
};
