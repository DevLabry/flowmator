import type {
  DataTableColumnType,
  DataTableCondition,
  DataTableRow,
  FieldType,
  IDataObject,
  IDataTable,
  IDataTableFilter,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodeProperties,
  INodeType,
  ResourceMapperValue,
} from '@8n8/workflow';
import { NodeOperationError } from '@8n8/workflow';
import { forEachItem, forOp, operationProp } from '../utils/api';
import { errorItem } from '../utils/object';

const FIELD_TYPES: Record<DataTableColumnType, FieldType> = { string: 'string', number: 'number', boolean: 'boolean', date: 'dateTime' };

const CONDITIONS: Array<{ name: string; value: DataTableCondition }> = [
  { name: 'Equals', value: 'eq' },
  { name: 'Not Equals', value: 'neq' },
  { name: 'Contains (Case-Sensitive)', value: 'like' },
  { name: 'Contains (Case-Insensitive)', value: 'ilike' },
  { name: 'Greater Than', value: 'gt' },
  { name: 'Greater Than or Equal', value: 'gte' },
  { name: 'Less Than', value: 'lt' },
  { name: 'Less Than or Equal', value: 'lte' },
  { name: 'Is Empty', value: 'isEmpty' },
  { name: 'Is Not Empty', value: 'isNotEmpty' },
  { name: 'Is True', value: 'isTrue' },
  { name: 'Is False', value: 'isFalse' },
];
const NO_VALUE: DataTableCondition[] = ['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'];

const tableProp: INodeProperties = {
  displayName: 'Data Table',
  name: 'dataTableId',
  type: 'resourceLocator',
  default: { __rl: true, mode: 'list', value: '' },
  required: true,
  modes: [
    { displayName: 'From List', name: 'list', type: 'list', typeOptions: { searchListMethod: 'tableSearch', searchable: true } },
    { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'Table ID or name' },
  ],
};

const filterProps: INodeProperties[] = [
  {
    displayName: 'Must Match',
    name: 'matchType',
    type: 'options',
    default: 'allConditions',
    options: [
      { name: 'All Conditions', value: 'allConditions' },
      { name: 'Any Condition', value: 'anyCondition' },
    ],
  },
  {
    displayName: 'Conditions',
    name: 'filters',
    type: 'fixedCollection',
    typeOptions: { multipleValues: true },
    default: {},
    placeholder: 'Add Condition',
    options: [
      {
        name: 'conditions',
        displayName: 'Conditions',
        values: [
          { displayName: 'Column', name: 'keyName', type: 'options', default: '', typeOptions: { loadOptionsMethod: 'getDataTableColumns', loadOptionsDependsOn: ['dataTableId.value'] } },
          { displayName: 'Condition', name: 'condition', type: 'options', default: 'eq', options: CONDITIONS },
          { displayName: 'Value', name: 'keyValue', type: 'string', default: '', displayOptions: { hide: { condition: NO_VALUE } } },
        ],
      },
    ],
  },
];

const columnsProp = (mode: 'add' | 'update' | 'upsert'): INodeProperties => ({
  displayName: 'Columns',
  name: 'columns',
  type: 'resourceMapper',
  default: { mappingMode: 'defineBelow', value: null },
  required: true,
  typeOptions: {
    loadOptionsDependsOn: ['dataTableId.value'],
    resourceMapper: { resourceMapperMethod: 'getColumns', mode, fieldWords: { singular: 'column', plural: 'columns' }, addAllFields: true, multiKeyMatch: true },
  },
});

/** Turns the node's condition list into a service filter. */
export function buildFilter(ctx: Pick<IExecuteFunctions, 'getNodeParameter'>, i: number): IDataTableFilter {
  const conditions = ((ctx.getNodeParameter('filters.conditions', i, []) as IDataObject[]) ?? []).filter((c) => c.keyName);
  return {
    type: ctx.getNodeParameter('matchType', i, 'allConditions') === 'anyCondition' ? 'or' : 'and',
    filters: conditions.map((c) => ({
      columnName: String(c.keyName),
      condition: (c.condition as DataTableCondition) ?? 'eq',
      value: NO_VALUE.includes(c.condition as DataTableCondition) ? undefined : c.keyValue,
    })),
  };
}

/** Values to write: the mapped columns, or the input item's keys matching table columns. */
export function rowData(table: IDataTable, columns: ResourceMapperValue | undefined, item: INodeExecutionData): DataTableRow {
  const names = new Set(table.columns.map((c) => c.name));
  if (!columns || columns.mappingMode === 'autoMapInputData') {
    return Object.fromEntries(Object.entries(item.json).filter(([k]) => names.has(k)));
  }
  const removed = new Set((columns.schema ?? []).filter((f) => f.removed).map((f) => f.id));
  return Object.fromEntries(Object.entries(columns.value ?? {}).filter(([k, v]) => names.has(k) && !removed.has(k) && v !== undefined));
}

async function resolveTable(ctx: Pick<IExecuteFunctions, 'getNodeParameter' | 'getDataTables' | 'getNode'>, i: number): Promise<IDataTable> {
  const ref = String(ctx.getNodeParameter('dataTableId', i, '', { extractValue: true }) ?? '').trim();
  if (!ref) throw new NodeOperationError(ctx.getNode(), 'Select a data table', { itemIndex: i });
  const table = await ctx.getDataTables().getTable(ref);
  if (!table) throw new NodeOperationError(ctx.getNode(), `Data table "${ref}" not found`, { itemIndex: i });
  return table;
}

async function tableForLoadOptions(ctx: ILoadOptionsFunctions): Promise<IDataTable | null> {
  const ref = String(ctx.getNodeParameter('dataTableId', '', { extractValue: true }) ?? '').trim();
  return ref && !ref.startsWith('=') ? ctx.getDataTables().getTable(ref) : null;
}

export const DataTable: INodeType = {
  description: {
    name: '8n8.dataTable',
    displayName: 'Data Table',
    description: 'Store and read rows in a data table kept by 8n8',
    group: ['input', 'transform'],
    version: 1,
    defaults: { name: 'Data Table', color: '#7C4DFF' },
    icon: 'fa:data-table',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    codex: { categories: ['Core Nodes', 'Data & Storage'], alias: ['database', 'table', 'store', 'storage', 'rows'] },
    properties: [
      { displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true, default: 'row', options: [{ name: 'Row', value: 'row' }, { name: 'Table', value: 'table' }] },
      operationProp('row', [
        { name: 'Insert', value: 'insert', description: 'Insert a new row' },
        { name: 'Get', value: 'get', description: 'Get rows matching conditions' },
        { name: 'Update', value: 'update', description: 'Update rows matching conditions' },
        { name: 'Upsert', value: 'upsert', description: 'Update matching rows, or insert one when none match' },
        { name: 'Delete', value: 'deleteRows', description: 'Delete rows matching conditions' },
        { name: 'If Row Exists', value: 'rowExists', description: 'Pass the item on only if a matching row exists' },
        { name: 'If Row Does Not Exist', value: 'rowNotExists', description: 'Pass the item on only if no row matches' },
      ]),
      operationProp('table', [
        { name: 'Create', value: 'create', description: 'Create a data table' },
        { name: 'List', value: 'list', description: 'List data tables' },
        { name: 'Update', value: 'update', description: 'Rename a data table' },
        { name: 'Delete', value: 'delete', description: 'Delete a data table and its rows' },
      ]),

      ...forOp('row', ['insert', 'get', 'update', 'upsert', 'deleteRows', 'rowExists', 'rowNotExists'], [tableProp]),
      ...forOp('row', 'insert', [columnsProp('add')]),
      ...forOp('row', ['get', 'update', 'upsert', 'deleteRows', 'rowExists', 'rowNotExists'], filterProps),
      ...forOp('row', 'update', [columnsProp('update')]),
      ...forOp('row', 'upsert', [columnsProp('upsert')]),
      ...forOp('row', 'get', [
        { displayName: 'Return All', name: 'returnAll', type: 'boolean', default: false },
        { displayName: 'Limit', name: 'limit', type: 'number', default: 50, typeOptions: { minValue: 1 }, displayOptions: { show: { returnAll: [false] } } },
        {
          displayName: 'Order By',
          name: 'orderBy',
          type: 'boolean',
          default: false,
          description: 'Whether to sort the rows (otherwise they come in insertion order)',
        },
        { displayName: 'Order By Column', name: 'orderByColumn', type: 'options', default: 'createdAt', typeOptions: { loadOptionsMethod: 'getDataTableColumns', loadOptionsDependsOn: ['dataTableId.value'] }, displayOptions: { show: { orderBy: [true] } } },
        { displayName: 'Direction', name: 'orderByDirection', type: 'options', default: 'DESC', options: [{ name: 'Ascending', value: 'ASC' }, { name: 'Descending', value: 'DESC' }], displayOptions: { show: { orderBy: [true] } } },
      ]),
      ...forOp('row', ['update', 'deleteRows'], [
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          options: [{ displayName: 'Dry Run', name: 'dryRun', type: 'boolean', default: false, description: 'Whether to only return the rows that would change, without changing them' }],
        },
      ]),

      ...forOp('table', 'create', [
        { displayName: 'Name', name: 'tableName', type: 'string', default: '', required: true },
        {
          displayName: 'Columns',
          name: 'columnsUi',
          type: 'fixedCollection',
          typeOptions: { multipleValues: true },
          default: {},
          placeholder: 'Add Column',
          options: [
            {
              name: 'column',
              displayName: 'Column',
              values: [
                { displayName: 'Name', name: 'name', type: 'string', default: '' },
                { displayName: 'Type', name: 'type', type: 'options', default: 'string', options: [{ name: 'String', value: 'string' }, { name: 'Number', value: 'number' }, { name: 'Boolean', value: 'boolean' }, { name: 'Date', value: 'date' }] },
              ],
            },
          ],
        },
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          options: [{ displayName: 'Reuse Existing Table', name: 'reuseExisting', type: 'boolean', default: false, description: 'Whether to return the table with this name instead of failing when it exists' }],
        },
      ]),
      ...forOp('table', ['update', 'delete'], [tableProp]),
      ...forOp('table', 'update', [{ displayName: 'New Name', name: 'newName', type: 'string', default: '', required: true }]),
      ...forOp('table', 'list', [
        { displayName: 'Filter by Name', name: 'nameFilter', type: 'string', default: '', description: 'Only tables whose name contains this text' },
      ]),
    ],
  },

  methods: {
    listSearch: {
      async tableSearch(this: ILoadOptionsFunctions, filter?: string) {
        const tables = await this.getDataTables().listTables({ name: filter || undefined });
        return { results: tables.map((t) => ({ name: t.name, value: t.id })) };
      },
    },
    loadOptions: {
      async getDataTableColumns(this: ILoadOptionsFunctions) {
        const table = await tableForLoadOptions(this);
        const columns = table?.columns.map((c) => ({ name: c.name, value: c.name, description: c.type })) ?? [];
        return [{ name: 'id', value: 'id', description: 'number' }, ...columns, { name: 'createdAt', value: 'createdAt', description: 'date' }, { name: 'updatedAt', value: 'updatedAt', description: 'date' }];
      },
    },
    resourceMapping: {
      async getColumns(this: ILoadOptionsFunctions) {
        const table = await tableForLoadOptions(this);
        return {
          fields: (table?.columns ?? []).map((c) => ({ id: c.name, displayName: c.name, required: false, defaultMatch: false, display: true, type: FIELD_TYPES[c.type], canBeUsedToMatch: true })),
          emptyFieldsNotice: table ? 'This table has no columns yet. Add some in Data tables.' : 'Select a data table first',
        };
      },
    },
  },

  async execute(this: IExecuteFunctions) {
    const resource = this.getNodeParameter('resource', 0) as string;
    const operation = this.getNodeParameter('operation', 0) as string;
    const tables = this.getDataTables();

    if (resource === 'table') {
      if (operation === 'list') {
        const out: INodeExecutionData[] = [];
        const items = this.getInputData();
        for (let i = 0; i < Math.max(items.length, 1); i++) {
          try {
            const list = await tables.listTables({ name: (this.getNodeParameter('nameFilter', i, '') as string) || undefined });
            out.push(...list.map((t) => ({ json: t as unknown as IDataObject, pairedItem: { item: i } })));
          } catch (e) {
            if (!this.continueOnFail()) throw e;
            out.push(errorItem(e, i));
          }
        }
        return [out];
      }
      return [
        await forEachItem(this, async (i) => {
          if (operation === 'create') {
            const name = String(this.getNodeParameter('tableName', i)).trim();
            const columns = ((this.getNodeParameter('columnsUi.column', i, []) as IDataObject[]) ?? [])
              .filter((c) => c.name)
              .map((c) => ({ name: String(c.name), type: (c.type as DataTableColumnType) ?? 'string' }));
            if ((this.getNodeParameter('options.reuseExisting', i, false) as boolean)) {
              const existing = await tables.getTable(name);
              if (existing && existing.name === name) return existing as unknown as IDataObject;
            }
            return (await tables.createTable(name, columns)) as unknown as IDataObject;
          }
          const table = await resolveTable(this, i);
          if (operation === 'update') return (await tables.renameTable(table.id, String(this.getNodeParameter('newName', i)))) as unknown as IDataObject;
          if (operation === 'delete') {
            await tables.deleteTable(table.id);
            return { id: table.id, name: table.name, deleted: true };
          }
          throw new Error(`Unknown operation "${operation}"`);
        }),
      ];
    }

    // row filters: keep or drop the incoming item
    if (operation === 'rowExists' || operation === 'rowNotExists') {
      const out: INodeExecutionData[] = [];
      const items = this.getInputData();
      for (let i = 0; i < items.length; i++) {
        try {
          const table = await resolveTable(this, i);
          const { count } = await tables.getRows(table.id, { filter: buildFilter(this, i), take: 1 });
          if ((count > 0) === (operation === 'rowExists')) out.push({ ...items[i], pairedItem: { item: i } });
        } catch (e) {
          if (!this.continueOnFail()) throw e;
          out.push(errorItem(e, i));
        }
      }
      return [out];
    }

    return [
      await forEachItem(this, async (i, item) => {
        const table = await resolveTable(this, i);
        switch (operation) {
          case 'insert': {
            const [row] = await tables.insertRows(table.id, [rowData(table, this.getNodeParameter('columns', i, undefined) as ResourceMapperValue, item)]);
            return row as IDataObject;
          }
          case 'get': {
            const sort = this.getNodeParameter('orderBy', i, false)
              ? { column: String(this.getNodeParameter('orderByColumn', i, 'createdAt')), direction: this.getNodeParameter('orderByDirection', i, 'DESC') as 'ASC' | 'DESC' }
              : undefined;
            const take = this.getNodeParameter('returnAll', i, false) ? undefined : Number(this.getNodeParameter('limit', i, 50));
            const { data } = await tables.getRows(table.id, { filter: buildFilter(this, i), sortBy: sort, take });
            return data as IDataObject[];
          }
          case 'update': {
            const data = rowData(table, this.getNodeParameter('columns', i, undefined) as ResourceMapperValue, item);
            return (await tables.updateRows(table.id, buildFilter(this, i), data, { dryRun: this.getNodeParameter('options.dryRun', i, false) as boolean })) as IDataObject[];
          }
          case 'upsert': {
            const data = rowData(table, this.getNodeParameter('columns', i, undefined) as ResourceMapperValue, item);
            return (await tables.upsertRow(table.id, buildFilter(this, i), data)) as IDataObject[];
          }
          case 'deleteRows':
            return (await tables.deleteRows(table.id, buildFilter(this, i), { dryRun: this.getNodeParameter('options.dryRun', i, false) as boolean })) as IDataObject[];
          default:
            throw new Error(`Unknown operation "${operation}"`);
        }
      }),
    ];
  },
};
