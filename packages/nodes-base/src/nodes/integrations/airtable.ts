import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, ILoadOptionsFunctions, INodeProperties, INodeType } from '@8n8/workflow';
import { apiRequest, collectPages, forEachItem, forOp, listLimit, operationProp, returnAllProps } from '../../utils/api';

const API = 'https://api.airtable.com/v0';

/** Accepts IDs or any airtable.com URL (app… for bases, tbl… for tables). */
export function airtableId(value: string, prefix: 'app' | 'tbl') {
  const v = String(value ?? '').trim();
  if (!v.includes('airtable.com')) return v;
  return v.match(new RegExp(`\\b(${prefix}[A-Za-z0-9]{14})\\b`))?.[1] ?? v;
}

/** Formula that matches a field value exactly (strings are quoted and escaped). */
export function matchFormula(field: string, value: unknown) {
  const ref = `{${field.replace(/}/g, '\\}')}}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${ref} = ${value}`;
  return `${ref} = '${String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const record = (r: IDataObject): IDataObject => ({ id: r.id, createdTime: r.createdTime, ...(r.fields as IDataObject) });

async function airtable(ctx: { helpers: IExecuteFunctions['helpers'] }, method: IHttpRequestOptions['method'], path: string, body?: IDataObject, qs?: IDataObject, i = 0): Promise<IDataObject> {
  try {
    return await apiRequest(ctx, 'airtableTokenApi', { url: `${API}${path}`, method, ...(body ? { body } : {}), ...(qs ? { qs } : {}) }, i);
  } catch (e) {
    const err = (e as { body?: { error?: { type?: string; message?: string } | string } }).body?.error;
    if (err) throw new Error(`Airtable error: ${typeof err === 'string' ? err : `${err.type}${err.message ? `: ${err.message}` : ''}`}`);
    throw e;
  }
}

const baseProp: INodeProperties = { displayName: 'Base', name: 'base', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'getBases' }, description: 'Base ID (app…) or URL' };
const tableProp: INodeProperties = { displayName: 'Table', name: 'table', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'getTables', loadOptionsDependsOn: ['base'] }, description: 'Table ID (tbl…), name or URL' };
const recordIdProp: INodeProperties = { displayName: 'Record ID', name: 'id', type: 'string', default: '', required: true };

const fieldsInput: INodeProperties[] = [
  { displayName: 'Mapping Column Mode', name: 'dataMode', type: 'options', default: 'autoMapInputData', options: [{ name: 'Map Automatically (field name = input key)', value: 'autoMapInputData' }, { name: 'Map Each Field Manually', value: 'defineBelow' }] },
  {
    displayName: 'Fields',
    name: 'fieldsUi',
    type: 'fixedCollection',
    typeOptions: { multipleValues: true },
    default: {},
    displayOptions: { show: { dataMode: ['defineBelow'] } },
    options: [{ name: 'values', displayName: 'Field', values: [{ displayName: 'Field', name: 'field', type: 'string', default: '' }, { displayName: 'Value', name: 'value', type: 'string', default: '' }] }],
  },
];

export const Airtable: INodeType = {
  description: {
    name: '8n8.airtable',
    displayName: 'Airtable',
    description: 'Read, create, update and delete Airtable records',
    group: ['input'],
    version: [2, 2.1],
    defaults: { name: 'Airtable', color: '#18BFFF' },
    icon: 'fa:airtable',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'airtableTokenApi', required: true }],
    codex: { categories: ['Data & Storage'] },
    properties: [
      { displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true, default: 'record', options: [{ name: 'Record', value: 'record' }, { name: 'Base', value: 'base' }] },
      operationProp('record', [
        { name: 'Create', value: 'create' },
        { name: 'Create or Update', value: 'upsert' },
        { name: 'Update', value: 'update' },
        { name: 'Delete', value: 'deleteRecord' },
        { name: 'Get', value: 'get' },
        { name: 'Search', value: 'search' },
      ]),
      operationProp('base', [{ name: 'Get Many', value: 'getMany' }, { name: 'Get Schema', value: 'getSchema' }]),

      ...forOp('record', ['create', 'upsert', 'update', 'deleteRecord', 'get', 'search'], [baseProp, tableProp]),
      ...forOp('record', ['get', 'deleteRecord'], [recordIdProp]),
      ...forOp('record', ['upsert', 'update'], [
        { displayName: 'Columns to Match On', name: 'columnToMatchOn', type: 'string', default: 'id', description: 'Field(s) that identify the record, comma separated. "id" uses the record ID from the input.' },
      ]),
      ...forOp('record', ['create', 'upsert', 'update'], [
        ...fieldsInput,
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          options: [
            { displayName: 'Typecast', name: 'typecast', type: 'boolean', default: false, description: 'Let Airtable convert strings to the field types (and create missing select options)' },
            { displayName: 'Ignore Fields', name: 'ignoreFields', type: 'string', default: '', description: 'Comma separated input keys not to send' },
          ],
        },
      ]),
      ...forOp('record', 'search', [
        { displayName: 'Filter By Formula', name: 'filterByFormula', type: 'string', default: '', placeholder: "NOT({Name} = '')" },
        ...returnAllProps({ resource: ['record'], operation: ['search'] }),
        {
          displayName: 'Options',
          name: 'searchOptions',
          type: 'collection',
          default: {},
          options: [
            { displayName: 'View', name: 'view', type: 'string', default: '', description: 'Name or ID; records come in the view\'s order and filtering' },
            { displayName: 'Output Fields', name: 'fields', type: 'string', default: '', description: 'Comma separated' },
            {
              displayName: 'Sort',
              name: 'sort',
              type: 'fixedCollection',
              typeOptions: { multipleValues: true },
              default: {},
              options: [{ name: 'values', displayName: 'Rule', values: [{ displayName: 'Field', name: 'field', type: 'string', default: '' }, { displayName: 'Direction', name: 'direction', type: 'options', default: 'asc', options: [{ name: 'Ascending', value: 'asc' }, { name: 'Descending', value: 'desc' }] }] }],
            },
          ],
        },
      ]),
      ...forOp('base', 'getMany', returnAllProps({ resource: ['base'], operation: ['getMany'] })),
      ...forOp('base', 'getSchema', [baseProp]),
    ],
  },
  methods: {
    loadOptions: {
      async getBases(this: ILoadOptionsFunctions) {
        const bases = await collectPages(async (offset) => {
          const r = await airtable(this, 'GET', '/meta/bases', undefined, offset ? { offset } : undefined);
          return { items: r.bases as IDataObject[], next: r.offset as string };
        }, 1000);
        return bases.map((b) => ({ name: String(b.name), value: String(b.id) }));
      },
      async getTables(this: ILoadOptionsFunctions) {
        const base = airtableId(String(this.getCurrentNodeParameters().base ?? ''), 'app');
        if (!base) return [];
        const r = await airtable(this, 'GET', `/meta/bases/${base}/tables`);
        return (r.tables as IDataObject[]).map((t) => ({ name: String(t.name), value: String(t.id) }));
      },
    },
  },
  async execute(this: IExecuteFunctions) {
    return [
      await forEachItem(this, async (i, item) => {
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const resource = p('resource');
        const op = p('operation');
        const call = (method: IHttpRequestOptions['method'], path: string, body?: IDataObject, qs?: IDataObject) => airtable(this, method, path, body, qs, i);

        if (resource === 'base') {
          if (op === 'getSchema') return (await call('GET', `/meta/bases/${airtableId(p('base'), 'app')}/tables`)).tables as IDataObject[];
          return collectPages(async (offset) => {
            const r = await call('GET', '/meta/bases', undefined, offset ? { offset } : undefined);
            return { items: r.bases as IDataObject[], next: r.offset as string };
          }, listLimit(this, i));
        }

        const path = `/${airtableId(p('base'), 'app')}/${encodeURIComponent(airtableId(p('table'), 'tbl'))}`;
        if (op === 'get') return record(await call('GET', `${path}/${p('id')}`));
        if (op === 'deleteRecord') return { id: p('id'), deleted: (await call('DELETE', `${path}/${p('id')}`)).deleted };
        if (op === 'search') {
          const o = p<{ view?: string; fields?: string; sort?: { values?: Array<{ field: string; direction: string }> } }>('searchOptions', {});
          const body: IDataObject = {};
          if (p('filterByFormula', '')) body.filterByFormula = p('filterByFormula');
          if (o.view) body.view = o.view;
          if (o.fields) body.fields = o.fields.split(',').map((f) => f.trim()).filter(Boolean);
          const sort = (o.sort?.values ?? []).filter((s) => s.field);
          if (sort.length) body.sort = sort;
          // POST listRecords: long formulas don't fit in a URL
          const rows = await collectPages(async (offset, size) => {
            const r = await call('POST', `${path}/listRecords`, { ...body, pageSize: size, ...(offset ? { offset } : {}) });
            return { items: r.records as IDataObject[], next: r.offset as string };
          }, listLimit(this, i));
          return rows.map(record);
        }

        // create / upsert / update
        let fields: IDataObject;
        if (p('dataMode', 'autoMapInputData') === 'defineBelow') {
          fields = Object.fromEntries(((p<IDataObject>('fieldsUi', {}).values as Array<{ field: string; value: unknown }>) ?? []).filter((f) => f.field).map((f) => [f.field, f.value])) as IDataObject;
        } else {
          const { id: _id, createdTime: _c, ...rest } = item.json;
          fields = rest;
        }
        const options = p<{ typecast?: boolean; ignoreFields?: string }>('options', {});
        for (const f of String(options.ignoreFields ?? '').split(',').map((s) => s.trim()).filter(Boolean)) delete fields[f];
        const typecast = options.typecast ? { typecast: true } : {};

        if (op === 'create') return record(await call('POST', path, { fields, ...typecast }));

        const matchOn = p('columnToMatchOn', 'id').split(',').map((s) => s.trim()).filter(Boolean);
        if (matchOn.length === 1 && matchOn[0] === 'id') {
          const id = item.json.id ?? p('id', '');
          if (!id) throw new Error('The item has no "id" to match on');
          if (op === 'update') return record(await call('PATCH', `${path}/${id}`, { fields, ...typecast }));
          return record(((await call('PATCH', path, { records: [{ id, fields }], ...typecast })).records as IDataObject[])[0]);
        }
        for (const f of matchOn) if (!(f in fields)) throw new Error(`The item has no value for the match field "${f}"`);
        if (op === 'upsert') {
          const r = await call('PATCH', path, { performUpsert: { fieldsToMergeOn: matchOn }, records: [{ fields }], ...typecast });
          return (r.records as IDataObject[]).map(record);
        }
        // update every record whose match fields equal the item's
        const formula = matchOn.length === 1 ? matchFormula(matchOn[0], fields[matchOn[0]]) : `AND(${matchOn.map((f) => matchFormula(f, fields[f])).join(', ')})`;
        const matches = await collectPages(async (offset) => {
          const r = await call('POST', `${path}/listRecords`, { filterByFormula: formula, fields: [], ...(offset ? { offset } : {}) });
          return { items: r.records as IDataObject[], next: r.offset as string };
        }, undefined);
        const updated: IDataObject[] = [];
        for (let n = 0; n < matches.length; n += 10) {
          const r = await call('PATCH', path, { records: matches.slice(n, n + 10).map((m) => ({ id: m.id, fields })), ...typecast });
          updated.push(...(r.records as IDataObject[]).map(record));
        }
        return updated;
      }),
    ];
  },
};
