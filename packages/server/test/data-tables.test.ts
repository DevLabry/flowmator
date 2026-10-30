import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src';
import type { IDataTableFilter } from '@flowmator/workflow';
import type { DataTableService } from '../src/data-tables';

let app: App;
let dir: string;
let tables: DataTableService;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flowmator-dt-'));
  app = await createApp({ userFolder: dir, port: 0, webhookUrl: 'http://localhost:5678/', encryptionKey: 'test-key' });
  await app.ctx.executions.start();
  tables = app.ctx.dataTables;
});

afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

const api = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.app.inject({ method: method as 'GET', url, payload: payload as never, headers });
  let body: any = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {}
  return { status: res.statusCode, body, headers: res.headers };
};

let n = 0;
const node = (name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id: `n${++n}`, name, type: `flowmator.${type}`, typeVersion: 1, position: [0, 0], parameters });
const chain = (...names: string[]) => {
  const c: Record<string, unknown> = {};
  for (let i = 0; i < names.length - 1; i++) c[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] };
  return c;
};
const code = (name: string, js: string) => node(name, 'code', { mode: 'runOnceForAllItems', jsCode: js });
const rl = (value: string) => ({ __rl: true, mode: 'list', value });

async function run(nodes: unknown[], connections: unknown) {
  const wf = (await api('POST', '/rest/workflows', { name: `DT ${++n}`, nodes, connections })).body.data;
  const res = await api('POST', `/rest/workflows/${wf.id}/run?wait=true`, {});
  return res.body.data as { status: string; data: { runData: Record<string, Array<{ data?: { main: Array<Array<{ json: Record<string, unknown> }>> }; error?: { message: string } }>> } };
}
const out = (r: Awaited<ReturnType<typeof run>>, name: string) => r.data.runData[name][0].data!.main[0].map((i) => i.json);

describe('data table service', () => {
  it('creates tables, converts values and filters rows', async () => {
    const t = await tables.createTable('people', [
      { name: 'name', type: 'string' },
      { name: 'age', type: 'number' },
      { name: 'active', type: 'boolean' },
      { name: 'born', type: 'date' },
    ]);
    expect(t.columns.map((c) => c.name)).toEqual(['name', 'age', 'active', 'born']);
    const rows = await tables.insertRows(t.id, [
      { name: 'Ada', age: '36', active: 'true', born: '1815-12-10' },
      { name: 'alan', age: 41, active: false, born: null },
      { name: 'Grace', age: 85, active: true },
    ]);
    expect(rows[0]).toMatchObject({ id: 1, name: 'Ada', age: 36, active: true, born: '1815-12-10T00:00:00.000Z' });
    expect(rows[1].born).toBeNull();

    const names = async (filter: IDataTableFilter) => (await tables.getRows(t.id, { filter })).data.map((r) => r.name);
    expect(await names({ type: 'and', filters: [{ columnName: 'age', condition: 'gt', value: '40' }] })).toEqual(['alan', 'Grace']);
    expect(await names({ type: 'and', filters: [{ columnName: 'name', condition: 'like', value: 'a%' }] })).toEqual(['alan']);
    expect(await names({ type: 'and', filters: [{ columnName: 'name', condition: 'ilike', value: 'a%' }] })).toEqual(['Ada', 'alan']);
    expect(await names({ type: 'and', filters: [{ columnName: 'born', condition: 'isEmpty' }] })).toEqual(['alan', 'Grace']);
    expect(await names({ type: 'and', filters: [{ columnName: 'active', condition: 'isTrue' }, { columnName: 'age', condition: 'lt', value: 50 }] })).toEqual(['Ada']);
    expect(await names({ type: 'or', filters: [{ columnName: 'id', condition: 'eq', value: '3' }, { columnName: 'name', condition: 'eq', value: 'Ada' }] })).toEqual(['Ada', 'Grace']);
    expect(await names({ type: 'and', filters: [{ columnName: 'born', condition: 'neq', value: '1815-12-10' }] })).toEqual(['alan', 'Grace']);

    const sorted = await tables.getRows(t.id, { sortBy: { column: 'age', direction: 'DESC' }, take: 2, skip: 1 });
    expect(sorted).toMatchObject({ count: 3, data: [{ name: 'alan' }, { name: 'Ada' }] });
  });

  it('rejects bad values, names and unknown columns', async () => {
    const t = (await tables.getTable('people'))!;
    await expect(tables.insertRows(t.id, [{ age: 'old' }])).rejects.toThrow('expects a number');
    await expect(tables.insertRows(t.id, [{ nope: 1 }])).rejects.toThrow('Unknown column "nope"');
    await expect(tables.addColumn(t.id, { name: '1bad', type: 'string' })).rejects.toThrow('Invalid column name');
    await expect(tables.addColumn(t.id, { name: 'id', type: 'string' })).rejects.toThrow('reserved');
    await expect(tables.createTable('people', [])).rejects.toThrow('already exists');
    await expect(tables.deleteRows(t.id, { type: 'and', filters: [] })).rejects.toThrow('At least one condition');
    // a failed batch inserts nothing
    await expect(tables.insertRows(t.id, [{ name: 'ok' }, { age: 'x' }])).rejects.toThrow();
    expect((await tables.getRows(t.id)).count).toBe(3);
  });

  it('updates with dry run, upserts and deletes', async () => {
    const t = (await tables.getTable('people'))!;
    const byName = (name: string) => ({ type: 'and' as const, filters: [{ columnName: 'name', condition: 'eq' as const, value: name }] });
    const dry = await tables.updateRows(t.id, byName('Ada'), { age: 37 }, { dryRun: true });
    expect(dry).toMatchObject([{ age: 36, dryRunState: 'before' }, { age: 37, dryRunState: 'after' }]);
    expect((await tables.getRows(t.id, { filter: byName('Ada') })).data[0].age).toBe(36);
    expect(await tables.updateRows(t.id, byName('Ada'), { age: 37 })).toMatchObject([{ name: 'Ada', age: 37 }]);

    expect(await tables.upsertRow(t.id, byName('Linus'), { name: 'Linus', age: 55 })).toMatchObject([{ id: 4, name: 'Linus' }]);
    expect(await tables.upsertRow(t.id, byName('Linus'), { age: 56 })).toMatchObject([{ id: 4, age: 56 }]);

    expect(await tables.deleteRows(t.id, byName('Linus'), { dryRun: true })).toHaveLength(1);
    expect(await tables.deleteRows(t.id, byName('Linus'))).toMatchObject([{ id: 4 }]);
    expect((await tables.getRows(t.id)).count).toBe(3);
  });

  it('renames, moves and drops columns without losing data', async () => {
    const t = (await tables.getTable('people'))!;
    const born = t.columns.find((c) => c.name === 'born')!;
    tables.renameColumn(t.id, born.id, 'birthday');
    tables.moveColumn(t.id, 'birthday', 0);
    tables.deleteColumn(t.id, 'active');
    const after = tables.findTable(t.id)!;
    expect(after.columns.map((c) => c.name)).toEqual(['birthday', 'name', 'age']);
    expect((await tables.getRows(t.id, { take: 1 })).data[0]).toMatchObject({ birthday: '1815-12-10T00:00:00.000Z', name: 'Ada' });
    expect(tables.toCsv(t.id).split('\n')[0]).toBe('id,birthday,name,age,createdAt,updatedAt');
  });
});

describe('data table REST API', () => {
  it('creates a table with rows, edits, searches and exports it', async () => {
    const created = await api('POST', '/rest/data-tables', { name: 'orders', columns: [{ name: 'sku', type: 'string' }, { name: 'qty', type: 'number' }], rows: [{ sku: 'A-1', qty: 2 }, { sku: 'B-2', qty: 5 }, { sku: 'a-3', qty: 1 }] });
    expect(created.status).toBe(200);
    const id = created.body.data.id;
    expect((await api('GET', '/rest/data-tables')).body.data.find((t: { id: string }) => t.id === id).rowCount).toBe(3);

    const sorted = await api('GET', `/rest/data-tables/${id}/rows?sortBy=qty:desc&take=2`);
    expect(sorted.body.data).toMatchObject({ count: 3, data: [{ sku: 'B-2' }, { sku: 'A-1' }] });
    const searched = await api('GET', `/rest/data-tables/${id}/rows?search=a-`);
    expect(searched.body.data.data.map((r: { sku: string }) => r.sku)).toEqual(['A-1', 'a-3']);
    const filter = encodeURIComponent(JSON.stringify({ type: 'and', filters: [{ columnName: 'qty', condition: 'gte', value: 2 }] }));
    expect((await api('GET', `/rest/data-tables/${id}/rows?filter=${filter}`)).body.data.count).toBe(2);

    expect((await api('PATCH', `/rest/data-tables/${id}/rows/1`, { qty: 9 })).body.data.qty).toBe(9);
    expect((await api('PATCH', `/rest/data-tables/${id}/rows/1`, { qty: 'x' })).status).toBe(400);
    expect((await api('POST', `/rest/data-tables/${id}/columns`, { name: 'note', type: 'string' })).status).toBe(200);
    expect((await api('DELETE', `/rest/data-tables/${id}/rows?ids=3`)).body.data).toHaveLength(1);

    const csv = await api('GET', `/rest/data-tables/${id}/download-csv`);
    expect(csv.headers['content-disposition']).toContain('orders.csv');
    expect(String(csv.body).split('\n')[1]).toMatch(/^1,A-1,9,,/);

    expect((await api('POST', '/rest/data-tables', { name: 'orders' })).status).toBe(409);
    expect((await api('GET', '/rest/data-tables/missing')).status).toBe(404);
    // a bad row rolls the whole creation back
    expect((await api('POST', '/rest/data-tables', { name: 'broken', columns: [{ name: 'n', type: 'number' }], rows: [{ n: 'x' }] })).status).toBe(400);
    expect(tables.findTable('broken')).toBeNull();
  });

  it('serves rows on the public API with an API key', async () => {
    const key = (await api('POST', '/rest/api-keys', { label: 'dt' })).body.data.apiKey;
    expect((await api('GET', '/api/v1/data-tables')).status).toBe(401);
    const list = await api('GET', '/api/v1/data-tables', undefined, { 'x-n8n-api-key': key });
    const orders = list.body.data.find((t: { name: string }) => t.name === 'orders');
    const inserted = await api('POST', `/api/v1/data-tables/${orders.id}/rows`, { data: [{ sku: 'C-9', qty: 3 }] }, { 'x-n8n-api-key': key });
    expect(inserted.body.data[0]).toMatchObject({ sku: 'C-9', qty: 3 });
  });
});

describe('Data Table node', () => {
  it('inserts input items, then reads them back with conditions and order', async () => {
    const t = await tables.createTable('contacts', [{ name: 'email', type: 'string' }, { name: 'score', type: 'number' }, { name: 'vip', type: 'boolean' }]);
    const r = await run(
      [
        node('Start', 'manualTrigger'),
        code('Items', "return [{ json: { email: 'a@x.io', score: 10, extra: 'ignored' } }, { json: { email: 'b@x.io', score: 30, vip: true } }]"),
        node('Insert', 'dataTable', { operation: 'insert', dataTableId: rl(t.id), columns: { mappingMode: 'autoMapInputData', value: null } }),
      ],
      chain('Start', 'Items', 'Insert'),
    );
    expect(r.status).toBe('success');
    expect(out(r, 'Insert')).toMatchObject([{ id: 1, email: 'a@x.io', score: 10, vip: null }, { id: 2, email: 'b@x.io', vip: true }]);
    expect(out(r, 'Insert')[0]).not.toHaveProperty('extra');

    const get = await run(
      [
        node('Start', 'manualTrigger'),
        node('Get', 'dataTable', {
          operation: 'get',
          dataTableId: { __rl: true, mode: 'id', value: 'contacts' },
          filters: { conditions: [{ keyName: 'score', condition: 'gte', keyValue: '10' }] },
          returnAll: true,
          orderBy: true,
          orderByColumn: 'score',
          orderByDirection: 'DESC',
        }),
      ],
      chain('Start', 'Get'),
    );
    expect(out(get, 'Get').map((x) => x.email)).toEqual(['b@x.io', 'a@x.io']);
  });

  it('maps columns with expressions, upserts and filters items by existence', async () => {
    const r = await run(
      [
        node('Start', 'manualTrigger'),
        code('Items', "return [{ json: { mail: 'a@x.io', points: 99 } }, { json: { mail: 'new@x.io', points: 1 } }]"),
        node('Upsert', 'dataTable', {
          operation: 'upsert',
          dataTableId: rl('contacts'),
          filters: { conditions: [{ keyName: 'email', condition: 'eq', keyValue: '={{ $json.mail }}' }] },
          columns: { mappingMode: 'defineBelow', value: { email: '={{ $json.mail }}', score: '={{ $json.points }}' }, matchingColumns: [], schema: [] },
        }),
      ],
      chain('Start', 'Items', 'Upsert'),
    );
    expect(r.status).toBe('success');
    expect(out(r, 'Upsert')).toMatchObject([{ id: 1, score: 99 }, { id: 3, email: 'new@x.io', score: 1 }]);

    const exists = await run(
      [
        node('Start', 'manualTrigger'),
        code('Items', "return [{ json: { mail: 'a@x.io' } }, { json: { mail: 'nobody@x.io' } }]"),
        node('Known', 'dataTable', { operation: 'rowExists', dataTableId: rl('contacts'), filters: { conditions: [{ keyName: 'email', condition: 'eq', keyValue: '={{ $json.mail }}' }] } }),
      ],
      chain('Start', 'Items', 'Known'),
    );
    expect(out(exists, 'Known')).toEqual([{ mail: 'a@x.io' }]);
  });

  it('manages tables and reports missing ones', async () => {
    const r = await run(
      [
        node('Start', 'manualTrigger'),
        node('Create', 'dataTable', { resource: 'table', operation: 'create', tableName: 'made-by-node', columnsUi: { column: [{ name: 'title', type: 'string' }] } }),
        node('List', 'dataTable', { resource: 'table', operation: 'list', nameFilter: 'made-by' }),
      ],
      chain('Start', 'Create', 'List'),
    );
    expect(out(r, 'Create')[0]).toMatchObject({ name: 'made-by-node', columns: [{ name: 'title', type: 'string' }] });
    expect(out(r, 'List').map((t) => t.name)).toEqual(['made-by-node']);

    const missing = await run([node('Start', 'manualTrigger'), node('Get', 'dataTable', { operation: 'get', dataTableId: rl('nope') })], chain('Start', 'Get'));
    expect(missing.status).toBe('error');
    expect(missing.data.runData.Get[0].error?.message).toContain('Data table "nope" not found');
  });

  it('offers tables and columns to the editor', async () => {
    const t = tables.findTable('contacts')!;
    const params = { operation: 'insert', dataTableId: rl(t.id) };
    const list = await api('POST', '/rest/dynamic-node-parameters/options', { nodeTypeAndVersion: { name: 'flowmator.dataTable' }, methodName: 'tableSearch', currentNodeParameters: params, filter: 'cont' });
    expect(list.body.data.results).toEqual([{ name: 'contacts', value: t.id }]);
    const fields = await api('POST', '/rest/dynamic-node-parameters/resource-mapper-fields', { nodeTypeAndVersion: { name: 'flowmator.dataTable' }, methodName: 'getColumns', currentNodeParameters: params });
    expect(fields.body.data.fields.map((f: { id: string; type: string }) => `${f.id}:${f.type}`)).toEqual(['email:string', 'score:number', 'vip:boolean']);
    const cols = await api('POST', '/rest/dynamic-node-parameters/options', { nodeTypeAndVersion: { name: 'flowmator.dataTable' }, methodName: 'getDataTableColumns', currentNodeParameters: params });
    expect(cols.body.data.map((c: { value: string }) => c.value)).toEqual(['id', 'email', 'score', 'vip', 'createdAt', 'updatedAt']);
  });
});
