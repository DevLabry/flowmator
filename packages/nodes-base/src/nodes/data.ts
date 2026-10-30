import { NodeOperationError, type IDataObject, type IExecuteFunctions, type INodeExecutionData, type INodeType } from '@flowmator/workflow';
import { deepCopy, fieldList, getValue, isEqual, setValue } from '../utils/object';

const withPair = (item: INodeExecutionData, i: number): INodeExecutionData => ({ ...item, pairedItem: { item: i } });

export const Limit: INodeType = {
  description: {
    name: 'flowmator.limit',
    displayName: 'Limit',
    description: 'Restricts the number of items',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Limit', color: '#000000' },
    icon: 'fa:hand-paper',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      { displayName: 'Max Items', name: 'maxItems', type: 'number', typeOptions: { minValue: 1 }, default: 1 },
      { displayName: 'Keep', name: 'keep', type: 'options', default: 'firstItems', options: [{ name: 'First Items', value: 'firstItems' }, { name: 'Last Items', value: 'lastItems' }] },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData().map(withPair);
    const max = Number(this.getNodeParameter('maxItems', 0));
    const keep = this.getNodeParameter('keep', 0) as string;
    if (items.length <= max) return [items];
    return [keep === 'lastItems' ? items.slice(items.length - max) : items.slice(0, max)];
  },
};

export const Sort: INodeType = {
  description: {
    name: 'flowmator.sort',
    displayName: 'Sort',
    description: 'Changes the order of items',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Sort', color: '#000000' },
    icon: 'fa:sort-amount-down',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      { displayName: 'Type', name: 'type', type: 'options', default: 'simple',
        options: [{ name: 'Simple', value: 'simple' }, { name: 'Random', value: 'random' }, { name: 'Code', value: 'code' }] },
      {
        displayName: 'Fields To Sort By',
        name: 'sortFieldsUi',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        displayOptions: { show: { type: ['simple'] } },
        options: [
          {
            name: 'sortField',
            displayName: 'Sort Field',
            values: [
              { displayName: 'Field Name', name: 'fieldName', type: 'string', default: '', required: true },
              { displayName: 'Order', name: 'order', type: 'options', default: 'ascending', options: [{ name: 'Ascending', value: 'ascending' }, { name: 'Descending', value: 'descending' }] },
            ],
          },
        ],
      },
      { displayName: 'Code', name: 'code', type: 'string', typeOptions: { editor: 'jsEditor', rows: 10 }, default: '// a and b are items\nif (a.json.name < b.json.name) return -1;\nif (a.json.name > b.json.name) return 1;\nreturn 0;', displayOptions: { show: { type: ['code'] } } },
      { displayName: 'Options', name: 'options', type: 'collection', default: {}, displayOptions: { show: { type: ['simple'] } },
        options: [{ displayName: 'Disable Dot Notation', name: 'disableDotNotation', type: 'boolean', default: false }] },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData().map(withPair);
    const type = this.getNodeParameter('type', 0) as string;
    if (type === 'random') {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return [items];
    }
    if (type === 'code') {
      const code = this.getNodeParameter('code', 0) as string;
      const cmp = new Function('a', 'b', code) as (a: INodeExecutionData, b: INodeExecutionData) => number;
      return [items.sort(cmp)];
    }
    const fields = (this.getNodeParameter('sortFieldsUi.sortField', 0, []) as Array<{ fieldName: string; order: string }>) ?? [];
    if (!fields.length) throw new NodeOperationError(this.getNode(), 'No sorting specified. Please add a field to sort by');
    const dot = !(this.getNodeParameter('options.disableDotNotation', 0, false) as boolean);
    const compare = (a: unknown, b: unknown): number => {
      if (a === b) return 0;
      if (a === undefined || a === null) return 1;
      if (b === undefined || b === null) return -1;
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
      return JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
    };
    items.sort((x, y) => {
      for (const f of fields) {
        const r = compare(getValue(x.json, f.fieldName, dot), getValue(y.json, f.fieldName, dot));
        if (r !== 0) return f.order === 'descending' ? -r : r;
      }
      return 0;
    });
    return [items];
  },
};

export const Aggregate: INodeType = {
  description: {
    name: 'flowmator.aggregate',
    displayName: 'Aggregate',
    description: 'Combines a field from many items into a list in a single item',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Aggregate', color: '#000000' },
    icon: 'fa:object-group',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      { displayName: 'Aggregate', name: 'aggregate', type: 'options', default: 'aggregateIndividualFields',
        options: [{ name: 'Individual Fields', value: 'aggregateIndividualFields' }, { name: 'All Item Data (Into a Single List)', value: 'aggregateAllItemData' }] },
      {
        displayName: 'Fields To Aggregate',
        name: 'fieldsToAggregate',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { fieldToAggregate: [{ fieldToAggregate: '', renameField: false }] },
        displayOptions: { show: { aggregate: ['aggregateIndividualFields'] } },
        options: [
          {
            name: 'fieldToAggregate',
            displayName: '',
            values: [
              { displayName: 'Input Field Name', name: 'fieldToAggregate', type: 'string', default: '' },
              { displayName: 'Rename Field', name: 'renameField', type: 'boolean', default: false },
              { displayName: 'Output Field Name', name: 'outputFieldName', type: 'string', default: '', displayOptions: { show: { renameField: [true] } } },
            ],
          },
        ],
      },
      { displayName: 'Put Output in Field', name: 'destinationFieldName', type: 'string', default: 'data', displayOptions: { show: { aggregate: ['aggregateAllItemData'] } } },
      { displayName: 'Include', name: 'include', type: 'options', default: 'allFields', displayOptions: { show: { aggregate: ['aggregateAllItemData'] } },
        options: [{ name: 'All Fields', value: 'allFields' }, { name: 'Specified Fields', value: 'specifiedFields' }, { name: 'All Fields Except', value: 'allFieldsExcept' }] },
      { displayName: 'Fields To Include', name: 'fieldsToInclude', type: 'string', default: '', displayOptions: { show: { include: ['specifiedFields'] } } },
      { displayName: 'Fields To Exclude', name: 'fieldsToExclude', type: 'string', default: '', displayOptions: { show: { include: ['allFieldsExcept'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Disable Dot Notation', name: 'disableDotNotation', type: 'boolean', default: false },
          { displayName: 'Merge Lists', name: 'mergeLists', type: 'boolean', default: false },
          { displayName: 'Keep Missing And Null Values', name: 'keepMissing', type: 'boolean', default: false },
          { displayName: 'Include Binaries', name: 'includeBinaries', type: 'boolean', default: false },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const mode = this.getNodeParameter('aggregate', 0) as string;
    const dot = !(this.getNodeParameter('options.disableDotNotation', 0, false) as boolean);
    const keepMissing = this.getNodeParameter('options.keepMissing', 0, false) as boolean;
    const mergeLists = this.getNodeParameter('options.mergeLists', 0, false) as boolean;
    const includeBinaries = this.getNodeParameter('options.includeBinaries', 0, false) as boolean;
    const pairedItem = items.map((_, i) => ({ item: i }));
    const json: IDataObject = {};

    if (mode === 'aggregateAllItemData') {
      const dest = this.getNodeParameter('destinationFieldName', 0) as string;
      const include = this.getNodeParameter('include', 0, 'allFields') as string;
      const pick = (src: IDataObject): IDataObject => {
        if (include === 'specifiedFields') {
          const o: IDataObject = {};
          for (const f of fieldList(this.getNodeParameter('fieldsToInclude', 0, ''))) setValue(o, f, getValue(src, f, dot), dot);
          return o;
        }
        if (include === 'allFieldsExcept') {
          const o = deepCopy(src);
          for (const f of fieldList(this.getNodeParameter('fieldsToExclude', 0, ''))) delete o[f];
          return o;
        }
        return deepCopy(src);
      };
      json[dest] = items.map((i) => pick(i.json));
    } else {
      const fields = (this.getNodeParameter('fieldsToAggregate.fieldToAggregate', 0, []) as Array<{ fieldToAggregate: string; renameField?: boolean; outputFieldName?: string }>) ?? [];
      for (const f of fields) {
        if (!f.fieldToAggregate) continue;
        const outName = f.renameField && f.outputFieldName ? f.outputFieldName : f.fieldToAggregate;
        let values: unknown[] = [];
        let found = false;
        for (const item of items) {
          const v = getValue(item.json, f.fieldToAggregate, dot);
          if (v !== undefined) found = true;
          if ((v === undefined || v === null) && !keepMissing) continue;
          if (mergeLists && Array.isArray(v)) values.push(...v);
          else values.push(v);
        }
        if (!found && items.length) {
          throw new NodeOperationError(this.getNode(), `The field '${f.fieldToAggregate}' wasn't found in any input item`);
        }
        if (keepMissing) values = values.map((v) => (v === undefined ? null : v));
        setValue(json, outName, values, dot && !f.renameField);
      }
    }

    const result: INodeExecutionData = { json, pairedItem };
    if (includeBinaries) {
      const binary: INodeExecutionData['binary'] = {};
      let n = 0;
      for (const item of items) for (const b of Object.values(item.binary ?? {})) binary[`data_${n++}`] = b;
      if (n) result.binary = binary;
    }
    return [[result]];
  },
};

export const SplitOut: INodeType = {
  description: {
    name: 'flowmator.splitOut',
    displayName: 'Split Out',
    description: 'Turns a list inside an item into separate items',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Split Out', color: '#000000' },
    icon: 'fa:th-large',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      { displayName: 'Fields To Split Out', name: 'fieldToSplitOut', type: 'string', default: '', required: true },
      { displayName: 'Include', name: 'include', type: 'options', default: 'noOtherFields',
        options: [{ name: 'No Other Fields', value: 'noOtherFields' }, { name: 'All Other Fields', value: 'allOtherFields' }, { name: 'Selected Other Fields', value: 'selectedOtherFields' }] },
      { displayName: 'Fields To Include', name: 'fieldsToInclude', type: 'string', default: '', displayOptions: { show: { include: ['selectedOtherFields'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Disable Dot Notation', name: 'disableDotNotation', type: 'boolean', default: false },
          { displayName: 'Destination Field Name', name: 'destinationFieldName', type: 'string', default: '' },
          { displayName: 'Include Binary', name: 'includeBinary', type: 'boolean', default: false },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    items.forEach((item, i) => {
      const fields = fieldList(this.getNodeParameter('fieldToSplitOut', i));
      const include = this.getNodeParameter('include', i) as string;
      const dot = !(this.getNodeParameter('options.disableDotNotation', i, false) as boolean);
      const destNames = fieldList(this.getNodeParameter('options.destinationFieldName', i, ''));
      const includeBinary = this.getNodeParameter('options.includeBinary', i, false) as boolean;

      const lists = fields.map((f) => {
        const v = getValue(item.json, f, dot);
        if (v === undefined) throw new NodeOperationError(this.getNode(), `The field '${f}' wasn't found in item ${i}`, { itemIndex: i });
        if (Array.isArray(v)) return v;
        if (v && typeof v === 'object') return Object.values(v);
        return [v];
      });
      const length = Math.max(0, ...lists.map((l) => l.length));
      for (let n = 0; n < length; n++) {
        let json: IDataObject = {};
        if (include === 'allOtherFields') {
          json = deepCopy(item.json);
          for (const f of fields) delete json[f];
        } else if (include === 'selectedOtherFields') {
          for (const f of fieldList(this.getNodeParameter('fieldsToInclude', i, ''))) setValue(json, f, deepCopy(getValue(item.json, f, dot)), dot);
        }
        fields.forEach((f, idx) => {
          const value = lists[idx][n];
          const dest = destNames[idx] ?? f;
          if (value && typeof value === 'object' && !Array.isArray(value) && fields.length === 1 && !destNames.length && include === 'noOtherFields') {
            Object.assign(json, deepCopy(value));
          } else setValue(json, dest, deepCopy(value), false);
        });
        out.push({ json, ...(includeBinary && item.binary ? { binary: item.binary } : {}), pairedItem: { item: i } });
      }
    });
    return [out];
  },
};

export const RemoveDuplicates: INodeType = {
  description: {
    name: 'flowmator.removeDuplicates',
    displayName: 'Remove Duplicates',
    description: 'Deletes items with matching field values',
    group: ['transform'],
    version: [1, 1.1],
    defaults: { name: 'Remove Duplicates', color: '#000000' },
    icon: 'fa:clone',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      { displayName: 'Compare', name: 'compare', type: 'options', default: 'allFields',
        options: [{ name: 'All Fields', value: 'allFields' }, { name: 'All Fields Except', value: 'allFieldsExcept' }, { name: 'Selected Fields', value: 'selectedFields' }] },
      { displayName: 'Fields To Exclude', name: 'fieldsToExclude', type: 'string', default: '', displayOptions: { show: { compare: ['allFieldsExcept'] } } },
      { displayName: 'Fields To Compare', name: 'fieldsToCompare', type: 'string', default: '', displayOptions: { show: { compare: ['selectedFields'] } } },
      { displayName: 'Options', name: 'options', type: 'collection', default: {},
        options: [
          { displayName: 'Disable Dot Notation', name: 'disableDotNotation', type: 'boolean', default: false },
          { displayName: 'Remove Other Fields', name: 'removeOtherFields', type: 'boolean', default: false },
        ] },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const compare = this.getNodeParameter('compare', 0) as string;
    const dot = !(this.getNodeParameter('options.disableDotNotation', 0, false) as boolean);
    const removeOther = this.getNodeParameter('options.removeOtherFields', 0, false) as boolean;
    let keys: string[] | null = null;
    if (compare === 'selectedFields') keys = fieldList(this.getNodeParameter('fieldsToCompare', 0));
    const exclude = compare === 'allFieldsExcept' ? fieldList(this.getNodeParameter('fieldsToExclude', 0)) : [];

    const signature = (json: IDataObject) => {
      if (keys) return keys.map((k) => getValue(json, k, dot));
      const copy = deepCopy(json);
      for (const k of exclude) delete copy[k];
      return copy;
    };
    const seen: unknown[] = [];
    const out: INodeExecutionData[] = [];
    items.forEach((item, i) => {
      const sig = signature(item.json);
      if (seen.some((s) => isEqual(s, sig))) return;
      seen.push(sig);
      if (removeOther && keys) {
        const json: IDataObject = {};
        for (const k of keys) setValue(json, k, getValue(item.json, k, dot), dot);
        out.push({ json, pairedItem: { item: i } });
      } else out.push(withPair(item, i));
    });
    return [out];
  },
};
