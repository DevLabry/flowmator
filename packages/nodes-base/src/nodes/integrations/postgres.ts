import pg from 'pg';
import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, INodeType } from '@8n8/workflow';
import { NodeOperationError } from '@8n8/workflow';
import { errorItem } from '../../utils/object';

interface PgCreds {
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  ssl?: 'disable' | 'allow' | 'require';
}

export const quoteIdent = (name: string) => `"${String(name).replace(/"/g, '""')}"`;
const tableRef = (schema: string, table: string) => `${quoteIdent(schema || 'public')}.${quoteIdent(table)}`;

const CONDITIONS: Record<string, string> = { equal: '=', '!=': '<>', LIKE: 'LIKE', ILIKE: 'ILIKE', '>': '>', '<': '<', '>=': '>=', '<=': '<=' };

type Where = { column: string; condition: string; value?: unknown };

/** WHERE clause with numbered parameters starting at $start+1. */
export function buildWhere(conditions: Where[], combine: 'AND' | 'OR', start = 0) {
  const params: unknown[] = [];
  const parts = conditions
    .filter((c) => c.column)
    .map((c) => {
      if (c.condition === 'IS NULL' || c.condition === 'IS NOT NULL') return `${quoteIdent(c.column)} ${c.condition}`;
      params.push(c.value);
      return `${quoteIdent(c.column)} ${CONDITIONS[c.condition] ?? '='} $${start + params.length}`;
    });
  return { sql: parts.length ? ` WHERE ${parts.join(` ${combine} `)}` : '', params };
}

const show = (operation: string[]) => ({ show: { operation } });

const columnsMapping: INodeProperties[] = [
  { displayName: 'Mapping Column Mode', name: 'dataMode', type: 'options', default: 'autoMapInputData', displayOptions: show(['insert', 'upsert', 'update']), options: [{ name: 'Map Automatically (field name = column name)', value: 'autoMapInputData' }, { name: 'Map Each Column Manually', value: 'defineBelow' }] },
  {
    displayName: 'Values to Send',
    name: 'valuesToSend',
    type: 'fixedCollection',
    typeOptions: { multipleValues: true },
    default: {},
    displayOptions: { show: { operation: ['insert', 'upsert', 'update'], dataMode: ['defineBelow'] } },
    options: [{ name: 'values', displayName: 'Values', values: [{ displayName: 'Column', name: 'column', type: 'string', default: '' }, { displayName: 'Value', name: 'value', type: 'string', default: '' }] }],
  },
];

const whereProp: INodeProperties = {
  displayName: 'Select Rows',
  name: 'where',
  type: 'fixedCollection',
  typeOptions: { multipleValues: true },
  default: {},
  displayOptions: show(['select', 'deleteTable']),
  options: [
    {
      name: 'values',
      displayName: 'Condition',
      values: [
        { displayName: 'Column', name: 'column', type: 'string', default: '' },
        { displayName: 'Operator', name: 'condition', type: 'options', default: 'equal', options: [...Object.keys(CONDITIONS), 'IS NULL', 'IS NOT NULL'].map((c) => ({ name: c === 'equal' ? '=' : c, value: c })) },
        { displayName: 'Value', name: 'value', type: 'string', default: '' },
      ],
    },
  ],
};

export const Postgres: INodeType = {
  description: {
    name: '8n8.postgres',
    displayName: 'Postgres',
    description: 'Query and modify a PostgreSQL database',
    group: ['input'],
    version: [2, 2.1, 2.2, 2.3, 2.4, 2.5],
    defaults: { name: 'Postgres', color: '#336791' },
    icon: 'fa:database',
    subtitle: '={{$parameter["operation"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'postgres', required: true }],
    codex: { categories: ['Data & Storage'], alias: ['SQL', 'Database', 'Supabase', 'Neon'] },
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'executeQuery',
        options: [
          { name: 'Execute SQL', value: 'executeQuery' },
          { name: 'Insert', value: 'insert' },
          { name: 'Insert or Update', value: 'upsert' },
          { name: 'Update', value: 'update' },
          { name: 'Select', value: 'select' },
          { name: 'Delete', value: 'deleteTable' },
        ],
      },
      { displayName: 'Query', name: 'query', type: 'string', typeOptions: { editor: 'sqlEditor', editorLanguage: 'sql' }, default: 'SELECT * FROM users WHERE id = $1', displayOptions: show(['executeQuery']), hint: 'Use $1, $2… and fill them in "Query Parameters"' },
      { displayName: 'Schema', name: 'schema', type: 'string', default: 'public', displayOptions: show(['insert', 'upsert', 'update', 'select', 'deleteTable']) },
      { displayName: 'Table', name: 'table', type: 'string', default: '', required: true, displayOptions: show(['insert', 'upsert', 'update', 'select', 'deleteTable']) },
      { displayName: 'Command', name: 'deleteCommand', type: 'options', default: 'delete', displayOptions: show(['deleteTable']), options: [{ name: 'Delete Rows', value: 'delete' }, { name: 'Truncate', value: 'truncate' }, { name: 'Drop Table', value: 'drop' }] },
      ...columnsMapping,
      { displayName: 'Column to Match On', name: 'columnToMatchOn', type: 'string', default: 'id', displayOptions: show(['upsert', 'update']), description: 'Upsert needs a unique index on this column' },
      whereProp,
      { displayName: 'Combine Conditions', name: 'combineConditions', type: 'options', default: 'AND', displayOptions: show(['select', 'deleteTable']), options: [{ name: 'AND', value: 'AND' }, { name: 'OR', value: 'OR' }] },
      {
        displayName: 'Sort',
        name: 'sort',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        displayOptions: show(['select']),
        options: [{ name: 'values', displayName: 'Rule', values: [{ displayName: 'Column', name: 'column', type: 'string', default: '' }, { displayName: 'Direction', name: 'direction', type: 'options', default: 'ASC', options: [{ name: 'Ascending', value: 'ASC' }, { name: 'Descending', value: 'DESC' }] }] }],
      },
      { displayName: 'Return All', name: 'returnAll', type: 'boolean', default: false, displayOptions: show(['select']) },
      { displayName: 'Limit', name: 'limit', type: 'number', default: 50, displayOptions: { show: { operation: ['select'], returnAll: [false] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Query Parameters', name: 'queryReplacement', type: 'string', default: '', description: 'Values for $1, $2…: comma separated, or an expression returning an array', displayOptions: { show: { '/operation': ['executeQuery'] } } },
          { displayName: 'Query Batching', name: 'queryBatching', type: 'options', default: 'independently', options: [{ name: 'Each Item Independently', value: 'independently' }, { name: 'All Items in One Transaction', value: 'transaction' }] },
          { displayName: 'Output Columns (RETURNING)', name: 'outputColumns', type: 'string', default: '*', displayOptions: { show: { '/operation': ['insert', 'upsert', 'update'] } } },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const creds = await this.getCredentials<PgCreds>('postgres');
    const pool = new pg.Pool({
      host: creds.host,
      port: Number(creds.port ?? 5432),
      database: creds.database,
      user: creds.user,
      password: creds.password,
      ssl: creds.ssl === 'require' ? true : creds.ssl === 'allow' ? { rejectUnauthorized: false } : false,
      max: 4,
      connectionTimeoutMillis: 10_000,
    });
    const items = this.getInputData();
    const op = this.getNodeParameter('operation', 0) as string;
    const transaction = this.getNodeParameter('options.queryBatching', 0, 'independently') === 'transaction';
    const client = await pool.connect().catch((e: Error) => {
      throw new NodeOperationError(this.getNode(), `Could not connect to Postgres: ${e.message}`);
    });
    const out: INodeExecutionData[] = [];
    try {
      if (transaction) await client.query('BEGIN');
      for (let i = 0; i < items.length; i++) {
        try {
          const rows = await runOperation(this, client, op, i, items[i]);
          for (const json of rows) out.push({ json, pairedItem: { item: i } });
        } catch (e) {
          if (transaction) throw e;
          if (this.continueOnFail()) out.push(errorItem(e, i));
          else throw new NodeOperationError(this.getNode(), e as Error, { itemIndex: i });
        }
      }
      if (transaction) await client.query('COMMIT');
    } catch (e) {
      if (transaction) await client.query('ROLLBACK').catch(() => {});
      throw e instanceof NodeOperationError ? e : new NodeOperationError(this.getNode(), e as Error);
    } finally {
      client.release();
      await pool.end();
    }
    return [out];
  },
};

async function runOperation(ctx: IExecuteFunctions, client: pg.PoolClient, op: string, i: number, item: INodeExecutionData): Promise<IDataObject[]> {
  const p = <T = string>(name: string, fallback?: unknown) => ctx.getNodeParameter(name, i, fallback) as T;
  const q = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as IDataObject[];

  if (op === 'executeQuery') {
    const raw = p<unknown>('options.queryReplacement', '');
    const params = Array.isArray(raw) ? raw : String(raw ?? '').trim() ? String(raw).split(',').map((s) => s.trim()) : [];
    const result = await client.query(p('query'), params);
    // multiple statements return an array of results; keep the last one with rows
    const results = Array.isArray(result) ? result : [result];
    const last = results.filter((r) => r.rows?.length).at(-1) ?? results.at(-1);
    return last?.rows?.length ? (last.rows as IDataObject[]) : [{ success: true, command: last?.command, rowCount: last?.rowCount ?? 0 }];
  }

  const table = tableRef(p('schema', 'public'), p('table'));

  if (op === 'select') {
    const where = buildWhere((p<IDataObject>('where', {}).values as Where[]) ?? [], p('combineConditions', 'AND') as 'AND');
    const sort = ((p<IDataObject>('sort', {}).values as Array<{ column: string; direction: string }>) ?? []).filter((s) => s.column);
    const order = sort.length ? ` ORDER BY ${sort.map((s) => `${quoteIdent(s.column)} ${s.direction === 'DESC' ? 'DESC' : 'ASC'}`).join(', ')}` : '';
    const limit = p('returnAll', false) ? '' : ` LIMIT ${Math.max(1, Number(p('limit', 50)))}`;
    return q(`SELECT * FROM ${table}${where.sql}${order}${limit}`, where.params);
  }

  if (op === 'deleteTable') {
    const command = p('deleteCommand', 'delete');
    if (command === 'truncate') await q(`TRUNCATE TABLE ${table}`);
    else if (command === 'drop') await q(`DROP TABLE IF EXISTS ${table}`);
    else {
      const where = buildWhere((p<IDataObject>('where', {}).values as Where[]) ?? [], p('combineConditions', 'AND') as 'AND');
      const rows = await q(`DELETE FROM ${table}${where.sql} RETURNING *`, where.params);
      return rows.length ? rows : [{ success: true, deleted: 0 }];
    }
    return [{ success: true, command }];
  }

  // insert / upsert / update
  let values: IDataObject;
  if (p('dataMode', 'autoMapInputData') === 'defineBelow') {
    values = Object.fromEntries(((p<IDataObject>('valuesToSend', {}).values as Array<{ column: string; value: unknown }>) ?? []).filter((v) => v.column).map((v) => [v.column, v.value])) as IDataObject;
  } else values = item.json;
  const columns = Object.keys(values);
  if (!columns.length) throw new Error('No columns to write');
  const params = columns.map((c) => {
    const v = values[c];
    return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  const returning = p('options.outputColumns', '*');
  const ret = returning === '*' ? ' RETURNING *' : ` RETURNING ${returning.split(',').map((c) => quoteIdent(c.trim())).join(', ')}`;
  const placeholders = columns.map((_, n) => `$${n + 1}`).join(', ');
  const cols = columns.map(quoteIdent).join(', ');

  if (op === 'insert') return q(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})${ret}`, params);

  const match = p('columnToMatchOn');
  if (!(match in values)) throw new Error(`The item has no value for the match column "${match}"`);
  if (op === 'upsert') {
    const updates = columns.filter((c) => c !== match).map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`);
    const action = updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING';
    return q(`INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT (${quoteIdent(match)}) ${action}${ret}`, params);
  }
  const setCols = columns.filter((c) => c !== match);
  const set = setCols.map((c) => `${quoteIdent(c)} = $${columns.indexOf(c) + 1}`).join(', ');
  return q(`UPDATE ${table} SET ${set} WHERE ${quoteIdent(match)} = $${columns.indexOf(match) + 1}${ret}`, params);
}
