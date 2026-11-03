import { NodeOperationError, type IDataObject, type IExecuteFunctions, type INodeExecutionData, type INodeType } from '@flowmator/workflow';
import { deepCopy, errorItem, fieldList, getValue, setValue, unsetValue } from '../utils/object';

interface Assignment {
  id?: string;
  name: string;
  value: unknown;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
}

function convert(value: unknown, type: Assignment['type'], name: string, ignoreErrors: boolean): unknown {
  const fail = () => {
    if (ignoreErrors) return value;
    throw new Error(`'${name}' expects a ${type} but we got '${typeof value === 'object' ? JSON.stringify(value) : String(value)}'`);
  };
  if (value === null || value === undefined) return value;
  switch (type) {
    case 'number': {
      if (typeof value === 'number') return value;
      if (value === '') return null;
      const n = Number(value);
      return Number.isNaN(n) ? fail() : n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).trim().toLowerCase();
      if (['true', '1', 'yes'].includes(s)) return true;
      if (['false', '0', 'no', ''].includes(s)) return false;
      return fail();
    }
    case 'array':
    case 'object': {
      if (type === 'array' && Array.isArray(value)) return value;
      if (type === 'object' && typeof value === 'object' && !Array.isArray(value)) return value;
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (type === 'array' ? Array.isArray(parsed) : parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {}
      }
      return fail();
    }
    case 'string':
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

export const EditFields: INodeType = {
  description: {
    name: 'flowmator.set',
    displayName: 'Edit Fields (Set)',
    description: 'Adds, modifies or removes item fields',
    group: ['input'],
    version: [3, 3.1, 3.2, 3.3, 3.4],
    defaults: { name: 'Edit Fields', color: '#0000FF' },
    icon: 'fa:pen',
    inputs: ['main'],
    outputs: ['main'],
    codex: { alias: ['Set', 'JSON', 'Transform', 'Map'] },
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        noDataExpression: true,
        default: 'manual',
        options: [
          { name: 'Manual Mapping', value: 'manual', description: 'Edit item fields one by one' },
          { name: 'JSON', value: 'raw', description: 'Customize item output with JSON' },
        ],
      },
      { displayName: 'Fields to Set', name: 'assignments', type: 'assignmentCollection', default: {}, displayOptions: { show: { mode: ['manual'] } } },
      { displayName: 'JSON', name: 'jsonOutput', type: 'json', default: '{\n  "my_field_1": "value",\n  "my_field_2": 1\n}', displayOptions: { show: { mode: ['raw'] } } },
      { displayName: 'Include Other Input Fields', name: 'includeOtherFields', type: 'boolean', default: false },
      {
        displayName: 'Input Fields to Include',
        name: 'include',
        type: 'options',
        default: 'all',
        displayOptions: { show: { includeOtherFields: [true] } },
        options: [
          { name: 'All', value: 'all' },
          { name: 'Selected', value: 'selected' },
          { name: 'All Except', value: 'except' },
        ],
      },
      { displayName: 'Fields to Include', name: 'includeFields', type: 'string', default: '', displayOptions: { show: { include: ['selected'], includeOtherFields: [true] } } },
      { displayName: 'Fields to Exclude', name: 'excludeFields', type: 'string', default: '', displayOptions: { show: { include: ['except'], includeOtherFields: [true] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Include Binary File', name: 'includeBinary', type: 'boolean', default: true },
          { displayName: 'Ignore Type Conversion Errors', name: 'ignoreConversionErrors', type: 'boolean', default: false },
          { displayName: 'Support Dot Notation', name: 'dotNotation', type: 'boolean', default: true },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const mode = this.getNodeParameter('mode', i) as string;
        const includeOther = this.getNodeParameter('includeOtherFields', i, false) as boolean;
        const include = this.getNodeParameter('include', i, 'all') as string;
        const dot = this.getNodeParameter('options.dotNotation', i, true) as boolean;
        const ignoreErrors = this.getNodeParameter('options.ignoreConversionErrors', i, false) as boolean;
        const includeBinary = this.getNodeParameter('options.includeBinary', i, true) as boolean;
        const input = items[i];

        let json: IDataObject = {};
        if (includeOther) {
          if (include === 'all') json = deepCopy(input.json);
          else if (include === 'selected') {
            for (const f of fieldList(this.getNodeParameter('includeFields', i, ''))) {
              const v = getValue(input.json, f, dot);
              if (v !== undefined) setValue(json, f, deepCopy(v), dot);
            }
          } else {
            json = deepCopy(input.json);
            for (const f of fieldList(this.getNodeParameter('excludeFields', i, ''))) unsetValue(json, f, dot);
          }
        }

        if (mode === 'raw') {
          const raw = this.getNodeParameter('jsonOutput', i);
          let parsed: unknown = raw;
          if (typeof raw === 'string') {
            try {
              parsed = JSON.parse(raw);
            } catch (e) {
              throw new NodeOperationError(this.getNode(), `The 'JSON Output' in item ${i} contains invalid JSON`, { itemIndex: i, description: (e as Error).message });
            }
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new NodeOperationError(this.getNode(), `The 'JSON Output' in item ${i} must be an object`, { itemIndex: i });
          }
          json = { ...json, ...(parsed as IDataObject) };
        } else {
          const assignments = (this.getNodeParameter('assignments.assignments', i, []) as Assignment[]) ?? [];
          for (const a of assignments) {
            if (!a.name) continue;
            setValue(json, a.name, convert(a.value, a.type ?? 'string', a.name, ignoreErrors), dot);
          }
        }

        const item: INodeExecutionData = { json, pairedItem: { item: i } };
        if (includeBinary && input.binary) item.binary = input.binary;
        out.push(item);
      } catch (error) {
        if (this.continueOnFail()) {
          out.push(errorItem(error, i));
          continue;
        }
        throw error instanceof NodeOperationError ? error : new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
      }
    }
    return [out];
  },
};
