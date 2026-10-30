import mysql from 'mysql2/promise';
import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, INodeType } from '@flowmator/workflow';
import { NodeOperationError } from '@flowmator/workflow';
import { errorItem } from '../../utils/object';

interface MySqlCreds {
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  ssl?: boolean;
  sslVerify?: boolean;
}

/** The node only needs to run statements; tests swap in a recording fake. */
export interface MySqlSession {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export const mysqlConnector = {
  async connect(c: MySqlCreds): Promise<MySqlSession> {
    const conn = await mysql.createConnection({
      host: c.host,
      port: Number(c.port ?? 3306),
      database: c.database,
      user: c.user,
      password: c.password,
      ssl: c.ssl ? { rejectUnauthorized: c.sslVerify !== false } : undefined,
      connectTimeout: 10_000,
      multipleStatements: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    return { query: async (sql, params) => (await conn.query(sql, params))[0], end: () => conn.end() };
  },
};

export const quoteMySqlIdent = (name: string) => `\`${String(name).replace(/`/g, '``')}\``;
const tableRef = (table: string) => String(table).split('.').map(quoteMySqlIdent).join('.');

const CONDITIONS: Record<string, string> = { equal: '=', '!=': '<>', LIKE: 'LIKE', '>': '>', '<': '<', '>=': '>=', '<=': '<=' };
type Where = { column: string; condition: string; value?: unknown };

/** WHERE clause with ? placeholders. */
export function buildMySqlWhere(conditions: Where[], combine: 'AND' | 'OR') {
  const params: unknown[] = [];
  const parts = conditions
    .filter((c) => c.column)
    .map((c) => {
      if (c.condition === 'IS NULL' || c.condition === 'IS NOT NULL') return `${quoteMySqlIdent(c.column)} ${c.condition}`;
      params.push(c.value);
      return `${quoteMySqlIdent(c.column)} ${CONDITIONS[c.condition] ?? '='} ?`;
    });
  return { sql: parts.length ? ` WHERE ${parts.join(` ${combine} `)}` : '', params };
}

const show = (operation: string[]) => ({ show: { operation } });

const properties: INodeProperties[] = [
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
  { displayName: 'Query', name: 'query', type: 'string', typeOptions: { editor: 'sqlEditor', editorLanguage: 'sql' }, default: 'SELECT * FROM users WHERE id = ?', displayOptions: show(['executeQuery']), hint: 'Use ? placeholders and fill them in "Query Parameters"' },
  { displayName: 'Table', name: 'table', type: 'string', default: '', required: true, displayOptions: show(['insert', 'upsert', 'update', 'select', 'deleteTable']) },
  { displayName: 'Command', name: 'deleteCommand', type: 'options', default: 'delete', displayOptions: show(['deleteTable']), options: [{ name: 'Delete Rows', value: 'delete' }, { name: 'Truncate', value: 'truncate' }, { name: 'Drop Table', value: 'drop' }] },
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
  { displayName: 'Column to Match On', name: 'columnToMatchOn', type: 'string', default: 'id', displayOptions: show(['update']) },
  {
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
  },
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
      { displayName: 'Query Parameters', name: 'queryReplacement', type: 'string', default: '', description: 'Values for the ? placeholders: comma separated, or an expression returning an array', displayOptions: { show: { '/operation': ['executeQuery'] } } },
      { displayName: 'Query Batching', name: 'queryBatching', type: 'options', default: 'independently', options: [{ name: 'Each Item Independently', value: 'independently' }, { name: 'All Items in One Transaction', value: 'transaction' }] },
      { displayName: 'Ignore Duplicates (INSERT IGNORE)', name: 'skipOnConflict', type: 'boolean', default: false, displayOptions: { show: { '/operation': ['insert'] } } },
      { displayName: 'Detailed Output', name: 'detailedOutput', type: 'boolean', default: false, description: 'Output affectedRows/insertId instead of the written values', displayOptions: { show: { '/operation': ['insert', 'upsert', 'update', 'executeQuery'] } } },
    ],
  },
];

export const MySql: INodeType = {
  description: {
    name: 'flowmator.mySql',
    displayName: 'MySQL',
    description: 'Query and modify a MySQL or MariaDB database',
    group: ['input'],
    version: [2, 2.1, 2.2, 2.3, 2.4],
    defaults: { name: 'MySQL', color: '#00758f' },
    icon: 'fa:database',
    subtitle: '={{$parameter["operation"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'mySql', required: true }],
    codex: { categories: ['Data & Storage'], alias: ['SQL', 'Database', 'MariaDB', 'PlanetScale'] },
    properties,
  },
  async execute(this: IExecuteFunctions) {
    const creds = await this.getCredentials<MySqlCreds>('mySql');
    const db = await mysqlConnector.connect(creds).catch((e: Error) => {
      throw new NodeOperationError(this.getNode(), `Could not connect to MySQL: ${e.message}`);
    });
    const items = this.getInputData();
    const op = this.getNodeParameter('operation', 0) as string;
    const transaction = this.getNodeParameter('options.queryBatching', 0, 'independently') === 'transaction';
    const out: INodeExecutionData[] = [];
    try {
      if (transaction) await db.query('START TRANSACTION');
      for (let i = 0; i < items.length; i++) {
        try {
          const rows = await runMySqlOperation(this, db, op, i, items[i]);
          for (const json of rows) out.push({ json, pairedItem: { item: i } });
        } catch (e) {
          if (transaction) throw e;
          if (this.continueOnFail()) out.push(errorItem(e, i));
          else throw new NodeOperationError(this.getNode(), e as Error, { itemIndex: i });
        }
      }
      if (transaction) await db.query('COMMIT');
    } catch (e) {
      if (transaction) await db.query('ROLLBACK').catch(() => {});
      throw e instanceof NodeOperationError ? e : new NodeOperationError(this.getNode(), e as Error);
    } finally {
      await db.end().catch(() => {});
    }
    return [out];
  },
};

type Header = { affectedRows?: number; insertId?: number | string; changedRows?: number };
/** mysql2 answers writes with a ResultSetHeader and reads with an array of rows. */
const isHeader = (r: unknown): r is Header => !!r && typeof r === 'object' && !Array.isArray(r) && 'affectedRows' in r && 'fieldCount' in r;

async function runMySqlOperation(ctx: IExecuteFunctions, db: MySqlSession, op: string, i: number, item: INodeExecutionData): Promise<IDataObject[]> {
  const p = <T = string>(name: string, fallback?: unknown) => ctx.getNodeParameter(name, i, fallback) as T;
  const detailed = p<boolean>('options.detailedOutput', false);
  const summary = (r: unknown): IDataObject => {
    const h = r as Header;
    return { success: true, affectedRows: h.affectedRows ?? 0, ...(h.insertId ? { insertId: h.insertId } : {}), ...(h.changedRows !== undefined ? { changedRows: h.changedRows } : {}) };
  };

  if (op === 'executeQuery') {
    const raw = p<unknown>('options.queryReplacement', '');
    const params = Array.isArray(raw) ? raw : String(raw ?? '').trim() ? String(raw).split(',').map((s) => s.trim()) : [];
    const result = await db.query(p('query'), params);
    // several statements give one result per statement; keep the last that returned rows
    const results = Array.isArray(result) && result.some((r) => Array.isArray(r) || isHeader(r)) ? result : [result];
    const withRows = results.filter((r) => Array.isArray(r) && r.length).at(-1);
    if (withRows) return withRows as IDataObject[];
    const last = results.at(-1);
    return [isHeader(last) ? summary(last) : { success: true }];
  }

  const table = tableRef(p('table'));

  if (op === 'select') {
    const where = buildMySqlWhere((p<IDataObject>('where', {}).values as Where[]) ?? [], p('combineConditions', 'AND') as 'AND');
    const sort = ((p<IDataObject>('sort', {}).values as Array<{ column: string; direction: string }>) ?? []).filter((s) => s.column);
    const order = sort.length ? ` ORDER BY ${sort.map((s) => `${quoteMySqlIdent(s.column)} ${s.direction === 'DESC' ? 'DESC' : 'ASC'}`).join(', ')}` : '';
    const limit = p('returnAll', false) ? '' : ` LIMIT ${Math.max(1, Number(p('limit', 50)))}`;
    return (await db.query(`SELECT * FROM ${table}${where.sql}${order}${limit}`, where.params)) as IDataObject[];
  }

  if (op === 'deleteTable') {
    const command = p('deleteCommand', 'delete');
    if (command === 'truncate') await db.query(`TRUNCATE TABLE ${table}`);
    else if (command === 'drop') await db.query(`DROP TABLE IF EXISTS ${table}`);
    else {
      const where = buildMySqlWhere((p<IDataObject>('where', {}).values as Where[]) ?? [], p('combineConditions', 'AND') as 'AND');
      return [{ ...summary(await db.query(`DELETE FROM ${table}${where.sql}`, where.params)), command }];
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
  const cols = columns.map(quoteMySqlIdent).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  // MySQL has no RETURNING: output the written values (plus the generated id)
  const written = (r: unknown) => {
    if (detailed) return [summary(r)];
    const h = r as Header;
    return [{ ...values, ...(h.insertId ? { insertId: h.insertId } : {}) }];
  };

  if (op === 'insert') {
    const ignore = p<boolean>('options.skipOnConflict', false) ? ' IGNORE' : '';
    return written(await db.query(`INSERT${ignore} INTO ${table} (${cols}) VALUES (${placeholders})`, params));
  }
  if (op === 'upsert') {
    // ON DUPLICATE KEY uses the table's primary and unique keys
    const updates = columns.map((c) => `${quoteMySqlIdent(c)} = VALUES(${quoteMySqlIdent(c)})`).join(', ');
    return written(await db.query(`INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`, params));
  }
  const match = p('columnToMatchOn', 'id');
  if (!(match in values)) throw new Error(`The item has no value for the match column "${match}"`);
  const setCols = columns.filter((c) => c !== match);
  if (!setCols.length) throw new Error('No columns to update besides the match column');
  const set = setCols.map((c) => `${quoteMySqlIdent(c)} = ?`).join(', ');
  const result = await db.query(`UPDATE ${table} SET ${set} WHERE ${quoteMySqlIdent(match)} = ?`, [...setCols.map((c) => params[columns.indexOf(c)]), params[columns.indexOf(match)]]);
  return detailed ? [summary(result)] : [values];
}
