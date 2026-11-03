import type {
  DataTableColumnType,
  DataTableRow,
  IDataTable,
  IDataTableColumn,
  IDataTableFilter,
  IDataTableRowsQuery,
  IDataTableService,
} from '@flowmator/workflow';
import { newId, type Database } from './db';

export const DATA_TABLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS data_tables (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS data_table_columns (
  id TEXT PRIMARY KEY,
  dataTableId TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  idx INTEGER NOT NULL,
  UNIQUE (dataTableId, name)
);
`;

const COLUMN_TYPES: DataTableColumnType[] = ['string', 'number', 'boolean', 'date'];
const SQL_TYPES: Record<DataTableColumnType, string> = { string: 'TEXT', number: 'REAL', boolean: 'INTEGER', date: 'TEXT' };
/** Every row has these; they can be filtered and sorted on but not written. */
const SYSTEM_COLUMNS: Record<string, DataTableColumnType> = { id: 'number', createdAt: 'date', updatedAt: 'date' };

export class DataTableError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

const now = () => new Date().toISOString();
const rowsTable = (id: string) => `"data_table_rows_${id}"`;
/** User columns are stored under their id, so renaming a column never touches the rows table. */
const physical = (column: IDataTableColumn) => `"c_${column.id}"`;

function validateColumnName(name: string) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(name)) {
    throw new DataTableError(`Invalid column name "${name}": use letters, numbers and underscores, starting with a letter`);
  }
  if (name in SYSTEM_COLUMNS) throw new DataTableError(`"${name}" is a reserved column name`);
}

function validateType(type: string): DataTableColumnType {
  if (!COLUMN_TYPES.includes(type as DataTableColumnType)) throw new DataTableError(`Unknown column type "${type}" (use ${COLUMN_TYPES.join(', ')})`);
  return type as DataTableColumnType;
}

/** Converts a value from a workflow or the editor to what the column stores. */
function toSql(value: unknown, type: DataTableColumnType, column: string): SqlValue {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'string':
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    case 'number': {
      if (value === '') return null;
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(n) || typeof value === 'boolean') throw new DataTableError(`Column "${column}" expects a number, got ${JSON.stringify(value)}`);
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (value === 1 || value === 0) return value;
      const s = String(value).trim().toLowerCase();
      if (s === 'true' || s === '1') return 1;
      if (s === 'false' || s === '0') return 0;
      if (s === '') return null;
      throw new DataTableError(`Column "${column}" expects true or false, got ${JSON.stringify(value)}`);
    }
    case 'date': {
      if (value === '') return null;
      const d = value instanceof Date ? value : typeof value === 'object' && 'toISO' in (value as object) ? new Date(String((value as { toISO(): string }).toISO())) : new Date(value as string | number);
      if (Number.isNaN(d.getTime())) throw new DataTableError(`Column "${column}" expects a date, got ${JSON.stringify(value)}`);
      return d.toISOString();
    }
  }
}

function fromSql(value: unknown, type: DataTableColumnType): unknown {
  if (value === null || value === undefined) return null;
  if (type === 'boolean') return value === 1 || value === 1n;
  if (type === 'number' && typeof value === 'bigint') return Number(value);
  return value;
}

/** Turns a LIKE pattern (% and _) into a case-sensitive GLOB pattern. */
function likeToGlob(pattern: string) {
  return pattern.replace(/[[\]*?]/g, (c) => `[${c}]`).replace(/%/g, '*').replace(/_/g, '?');
}

export class DataTableService implements IDataTableService {
  constructor(private readonly database: Database) {
    database.db.exec(DATA_TABLE_SCHEMA);
  }

  private get db() {
    return this.database.db;
  }

  /* ---------------- tables ---------------- */

  private columns(tableId: string): IDataTableColumn[] {
    return (this.db.prepare('SELECT id, name, type, idx FROM data_table_columns WHERE dataTableId = ? ORDER BY idx').all(tableId) as Row[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      type: r.type as DataTableColumnType,
      index: Number(r.idx),
    }));
  }

  private toTable(r: Row): IDataTable {
    return { id: r.id as string, name: r.name as string, columns: this.columns(r.id as string), createdAt: r.createdAt as string, updatedAt: r.updatedAt as string };
  }

  async listTables(filter: { name?: string } = {}): Promise<IDataTable[]> {
    return this.listTablesSync(filter);
  }

  listTablesSync(filter: { name?: string } = {}): IDataTable[] {
    const rows = filter.name
      ? (this.db.prepare('SELECT * FROM data_tables WHERE name LIKE ? ORDER BY updatedAt DESC').all(`%${filter.name}%`) as Row[])
      : (this.db.prepare('SELECT * FROM data_tables ORDER BY updatedAt DESC').all() as Row[]);
    return rows.map((r) => this.toTable(r));
  }

  /** Tables with their row counts and approximate size, for the editor list. */
  listWithStats(filter: { name?: string } = {}) {
    return this.listTablesSync(filter).map((t) => ({ ...t, rowCount: this.count(t.id) }));
  }

  async getTable(idOrName: string): Promise<IDataTable | null> {
    return this.findTable(idOrName);
  }

  findTable(idOrName: string): IDataTable | null {
    const r = (this.db.prepare('SELECT * FROM data_tables WHERE id = ?').get(idOrName) ?? this.db.prepare('SELECT * FROM data_tables WHERE name = ?').get(idOrName)) as Row | undefined;
    return r ? this.toTable(r) : null;
  }

  requireTable(idOrName: string): IDataTable {
    const t = this.findTable(idOrName);
    if (!t) throw new DataTableError(`Data table "${idOrName}" not found`, 404);
    return t;
  }

  async createTable(name: string, columns: Array<{ name: string; type: DataTableColumnType }> = []): Promise<IDataTable> {
    return this.createTableSync(name, columns);
  }

  createTableSync(name: string, columns: Array<{ name: string; type: DataTableColumnType }> = []): IDataTable {
    name = name?.trim();
    if (!name) throw new DataTableError('A data table needs a name');
    if (this.db.prepare('SELECT 1 FROM data_tables WHERE name = ?').get(name)) throw new DataTableError(`A data table named "${name}" already exists`, 409);
    const seen = new Set<string>();
    for (const c of columns) {
      validateColumnName(c.name);
      validateType(c.type);
      if (seen.has(c.name)) throw new DataTableError(`Duplicate column "${c.name}"`);
      seen.add(c.name);
    }
    const id = newId();
    const ts = now();
    this.database.transaction(() => {
      this.db.prepare('INSERT INTO data_tables (id, name, createdAt, updatedAt) VALUES (?,?,?,?)').run(id, name, ts, ts);
      this.db.exec(`CREATE TABLE ${rowsTable(id)} (id INTEGER PRIMARY KEY AUTOINCREMENT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`);
      columns.forEach((c, i) => this.insertColumn(id, c, i));
    });
    return this.findTable(id)!;
  }

  async renameTable(id: string, name: string): Promise<IDataTable> {
    const table = this.requireTable(id);
    name = name?.trim();
    if (!name) throw new DataTableError('A data table needs a name');
    const other = this.db.prepare('SELECT id FROM data_tables WHERE name = ?').get(name) as Row | undefined;
    if (other && other.id !== table.id) throw new DataTableError(`A data table named "${name}" already exists`, 409);
    this.db.prepare('UPDATE data_tables SET name = ?, updatedAt = ? WHERE id = ?').run(name, now(), table.id);
    return this.findTable(table.id)!;
  }

  async deleteTable(id: string): Promise<void> {
    const table = this.requireTable(id);
    this.database.transaction(() => {
      this.db.exec(`DROP TABLE IF EXISTS ${rowsTable(table.id)}`);
      this.db.prepare('DELETE FROM data_table_columns WHERE dataTableId = ?').run(table.id);
      this.db.prepare('DELETE FROM data_tables WHERE id = ?').run(table.id);
    });
  }

  private touch(tableId: string) {
    this.db.prepare('UPDATE data_tables SET updatedAt = ? WHERE id = ?').run(now(), tableId);
  }

  /* ---------------- columns ---------------- */

  private insertColumn(tableId: string, c: { name: string; type: DataTableColumnType }, index: number): IDataTableColumn {
    const column: IDataTableColumn = { id: newId(), name: c.name, type: c.type, index };
    this.db.prepare('INSERT INTO data_table_columns (id, dataTableId, name, type, idx) VALUES (?,?,?,?,?)').run(column.id, tableId, c.name, c.type, index);
    this.db.exec(`ALTER TABLE ${rowsTable(tableId)} ADD COLUMN ${physical(column)} ${SQL_TYPES[c.type]}`);
    return column;
  }

  async addColumn(tableId: string, column: { name: string; type: DataTableColumnType }): Promise<IDataTableColumn> {
    const table = this.requireTable(tableId);
    validateColumnName(column.name);
    const type = validateType(column.type);
    if (table.columns.some((c) => c.name === column.name)) throw new DataTableError(`Column "${column.name}" already exists`, 409);
    const created = this.database.transaction(() => this.insertColumn(table.id, { name: column.name, type }, table.columns.length));
    this.touch(table.id);
    return created;
  }

  renameColumn(tableId: string, columnId: string, name: string): IDataTableColumn {
    const table = this.requireTable(tableId);
    const column = table.columns.find((c) => c.id === columnId || c.name === columnId);
    if (!column) throw new DataTableError(`Column "${columnId}" not found`, 404);
    validateColumnName(name);
    if (table.columns.some((c) => c.name === name && c.id !== column.id)) throw new DataTableError(`Column "${name}" already exists`, 409);
    this.db.prepare('UPDATE data_table_columns SET name = ? WHERE id = ?').run(name, column.id);
    this.touch(table.id);
    return { ...column, name };
  }

  moveColumn(tableId: string, columnId: string, targetIndex: number) {
    const table = this.requireTable(tableId);
    const from = table.columns.findIndex((c) => c.id === columnId || c.name === columnId);
    if (from < 0) throw new DataTableError(`Column "${columnId}" not found`, 404);
    const order = [...table.columns];
    const [moved] = order.splice(from, 1);
    order.splice(Math.max(0, Math.min(targetIndex, order.length)), 0, moved);
    this.database.transaction(() => order.forEach((c, i) => this.db.prepare('UPDATE data_table_columns SET idx = ? WHERE id = ?').run(i, c.id)));
    this.touch(table.id);
  }

  deleteColumn(tableId: string, columnId: string) {
    const table = this.requireTable(tableId);
    const column = table.columns.find((c) => c.id === columnId || c.name === columnId);
    if (!column) throw new DataTableError(`Column "${columnId}" not found`, 404);
    this.database.transaction(() => {
      this.db.exec(`ALTER TABLE ${rowsTable(table.id)} DROP COLUMN ${physical(column)}`);
      this.db.prepare('DELETE FROM data_table_columns WHERE id = ?').run(column.id);
      table.columns.filter((c) => c.id !== column.id).forEach((c, i) => this.db.prepare('UPDATE data_table_columns SET idx = ? WHERE id = ?').run(i, c.id));
    });
    this.touch(table.id);
  }

  /* ---------------- rows ---------------- */

  private columnRef(table: IDataTable, name: string): { sql: string; type: DataTableColumnType } {
    if (name in SYSTEM_COLUMNS) return { sql: `"${name}"`, type: SYSTEM_COLUMNS[name] };
    const column = table.columns.find((c) => c.name === name);
    if (!column) throw new DataTableError(`Unknown column "${name}" in data table "${table.name}"`);
    return { sql: physical(column), type: column.type };
  }

  private select(table: IDataTable) {
    return ['id', 'createdAt', 'updatedAt', ...table.columns.map((c) => `${physical(c)} AS "${c.name}"`)].join(', ');
  }

  private toRow(table: IDataTable, r: Row): DataTableRow {
    const row: DataTableRow = { id: Number(r.id) };
    for (const c of table.columns) row[c.name] = fromSql(r[c.name], c.type);
    row.createdAt = r.createdAt;
    row.updatedAt = r.updatedAt;
    return row;
  }

  private where(table: IDataTable, filter?: IDataTableFilter): { sql: string; args: SqlValue[] } {
    if (!filter?.filters?.length) return { sql: '', args: [] };
    const parts: string[] = [];
    const args: SqlValue[] = [];
    for (const f of filter.filters) {
      const col = this.columnRef(table, f.columnName);
      const value = () => toSql(col.type === 'number' && f.columnName === 'id' ? Number(f.value) : f.value, col.type, f.columnName);
      switch (f.condition) {
        case 'eq': {
          const v = value();
          if (v === null) parts.push(`${col.sql} IS NULL`);
          else {
            parts.push(`${col.sql} = ?`);
            args.push(v);
          }
          break;
        }
        case 'neq': {
          const v = value();
          if (v === null) parts.push(`${col.sql} IS NOT NULL`);
          else {
            parts.push(`(${col.sql} != ? OR ${col.sql} IS NULL)`);
            args.push(v);
          }
          break;
        }
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
          const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.condition];
          parts.push(`${col.sql} ${op} ?`);
          args.push(value());
          break;
        }
        case 'like':
          parts.push(`${col.sql} GLOB ?`);
          args.push(likeToGlob(String(f.value ?? '')));
          break;
        case 'ilike':
          parts.push(`LOWER(${col.sql}) LIKE LOWER(?)`);
          args.push(String(f.value ?? ''));
          break;
        case 'isEmpty':
          parts.push(`(${col.sql} IS NULL OR ${col.sql} = '')`);
          break;
        case 'isNotEmpty':
          parts.push(`(${col.sql} IS NOT NULL AND ${col.sql} != '')`);
          break;
        case 'isTrue':
          parts.push(`${col.sql} = 1`);
          break;
        case 'isFalse':
          parts.push(`${col.sql} = 0`);
          break;
        default:
          throw new DataTableError(`Unknown condition "${(f as { condition: string }).condition}"`);
      }
    }
    return { sql: `WHERE ${parts.join(filter.type === 'or' ? ' OR ' : ' AND ')}`, args };
  }

  private requireFilter(filter: IDataTableFilter | undefined, action: string) {
    if (!filter?.filters?.length) throw new DataTableError(`At least one condition is needed to ${action} rows`);
  }

  private values(table: IDataTable, data: DataTableRow): Array<{ sql: string; value: SqlValue }> {
    const out: Array<{ sql: string; value: SqlValue }> = [];
    for (const [name, v] of Object.entries(data)) {
      if (name in SYSTEM_COLUMNS) continue;
      const column = table.columns.find((c) => c.name === name);
      if (!column) throw new DataTableError(`Unknown column "${name}" in data table "${table.name}"`);
      out.push({ sql: physical(column), value: toSql(v, column.type, name) });
    }
    return out;
  }

  private count(tableId: string, where = { sql: '', args: [] as SqlValue[] }): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS c FROM ${rowsTable(tableId)} ${where.sql}`).get(...where.args) as Row).c);
  }

  async getRows(tableId: string, query: IDataTableRowsQuery = {}) {
    return this.getRowsSync(tableId, query);
  }

  getRowsSync(tableId: string, query: IDataTableRowsQuery & { search?: string } = {}): { count: number; data: DataTableRow[] } {
    const table = this.requireTable(tableId);
    const where = this.where(table, query.filter);
    if (query.search) {
      const cols = ['CAST(id AS TEXT)', ...table.columns.map((c) => `CAST(${physical(c)} AS TEXT)`)];
      const clause = `(${cols.map((c) => `LOWER(${c}) LIKE ?`).join(' OR ')})`;
      where.sql = where.sql ? `${where.sql.replace(/^WHERE /, 'WHERE (')}) AND ${clause}` : `WHERE ${clause}`;
      where.args.push(...cols.map(() => `%${query.search!.toLowerCase()}%`));
    }
    const sort = query.sortBy ? `${this.columnRef(table, query.sortBy.column).sql} ${query.sortBy.direction === 'DESC' ? 'DESC' : 'ASC'}, id ASC` : 'id ASC';
    const limit = query.take !== undefined ? `LIMIT ${Math.max(0, Math.floor(query.take))} OFFSET ${Math.max(0, Math.floor(query.skip ?? 0))}` : query.skip ? `LIMIT -1 OFFSET ${Math.floor(query.skip)}` : '';
    const rows = this.db.prepare(`SELECT ${this.select(table)} FROM ${rowsTable(table.id)} ${where.sql} ORDER BY ${sort} ${limit}`).all(...where.args) as Row[];
    return { count: this.count(table.id, where), data: rows.map((r) => this.toRow(table, r)) };
  }

  private byIds(table: IDataTable, ids: number[]): DataTableRow[] {
    if (!ids.length) return [];
    const rows = this.db.prepare(`SELECT ${this.select(table)} FROM ${rowsTable(table.id)} WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as Row[];
    return rows.map((r) => this.toRow(table, r));
  }

  async insertRows(tableId: string, rows: DataTableRow[]): Promise<DataTableRow[]> {
    return this.insertRowsSync(tableId, rows);
  }

  insertRowsSync(tableId: string, rows: DataTableRow[]): DataTableRow[] {
    const table = this.requireTable(tableId);
    const ids = this.database.transaction(() =>
      rows.map((data) => {
        const values = this.values(table, data);
        const ts = now();
        const cols = ['createdAt', 'updatedAt', ...values.map((v) => v.sql)];
        const res = this.db.prepare(`INSERT INTO ${rowsTable(table.id)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(ts, ts, ...values.map((v) => v.value));
        return Number(res.lastInsertRowid);
      }),
    );
    if (ids.length) this.touch(table.id);
    return this.byIds(table, ids);
  }

  private matchingIds(table: IDataTable, filter: IDataTableFilter): number[] {
    const where = this.where(table, filter);
    return (this.db.prepare(`SELECT id FROM ${rowsTable(table.id)} ${where.sql} ORDER BY id`).all(...where.args) as Row[]).map((r) => Number(r.id));
  }

  private applyUpdate(table: IDataTable, ids: number[], values: Array<{ sql: string; value: SqlValue }>) {
    if (!ids.length) return;
    const sets = [...values.map((v) => `${v.sql} = ?`), 'updatedAt = ?'];
    this.db.prepare(`UPDATE ${rowsTable(table.id)} SET ${sets.join(', ')} WHERE id IN (${ids.map(() => '?').join(',')})`).run(...values.map((v) => v.value), now(), ...ids);
    this.touch(table.id);
  }

  async updateRows(tableId: string, filter: IDataTableFilter, data: DataTableRow, options: { dryRun?: boolean } = {}): Promise<DataTableRow[]> {
    const table = this.requireTable(tableId);
    this.requireFilter(filter, 'update');
    const values = this.values(table, data);
    const ids = this.matchingIds(table, filter);
    if (options.dryRun) {
      const before = this.byIds(table, ids);
      const changed = Object.fromEntries(values.map((v) => [table.columns.find((c) => physical(c) === v.sql)!.name, fromSql(v.value, table.columns.find((c) => physical(c) === v.sql)!.type)]));
      return before.flatMap((row) => [
        { ...row, dryRunState: 'before' },
        { ...row, ...changed, dryRunState: 'after' },
      ]);
    }
    this.database.transaction(() => this.applyUpdate(table, ids, values));
    return this.byIds(table, ids);
  }

  /** Bulk update by row id (the editor grid). */
  updateRowById(tableId: string, id: number, data: DataTableRow): DataTableRow {
    const table = this.requireTable(tableId);
    this.applyUpdate(table, [id], this.values(table, data));
    const [row] = this.byIds(table, [id]);
    if (!row) throw new DataTableError(`Row ${id} not found`, 404);
    return row;
  }

  async upsertRow(tableId: string, filter: IDataTableFilter, data: DataTableRow): Promise<DataTableRow[]> {
    const table = this.requireTable(tableId);
    this.requireFilter(filter, 'upsert');
    const ids = this.matchingIds(table, filter);
    if (!ids.length) return this.insertRowsSync(table.id, [data]);
    const values = this.values(table, data);
    this.database.transaction(() => this.applyUpdate(table, ids, values));
    return this.byIds(table, ids);
  }

  async deleteRows(tableId: string, filter: IDataTableFilter, options: { dryRun?: boolean } = {}): Promise<DataTableRow[]> {
    const table = this.requireTable(tableId);
    this.requireFilter(filter, 'delete');
    return this.deleteByIds(table.id, this.matchingIds(table, filter), options.dryRun);
  }

  deleteByIds(tableId: string, ids: number[], dryRun = false): DataTableRow[] {
    const table = this.requireTable(tableId);
    const rows = this.byIds(table, ids);
    if (dryRun || !rows.length) return rows;
    this.db.prepare(`DELETE FROM ${rowsTable(table.id)} WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    this.touch(table.id);
    return rows;
  }

  /** CSV with a header row; values are quoted when needed. */
  toCsv(tableId: string): string {
    const table = this.requireTable(tableId);
    const headers = ['id', ...table.columns.map((c) => c.name), 'createdAt', 'updatedAt'];
    const cell = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = this.getRowsSync(table.id).data;
    return [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n');
  }
}
