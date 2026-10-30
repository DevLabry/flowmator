import type { IDataObject, IExecuteFunctions, IHelpers, ILoadOptionsFunctions, INodeExecutionData, INodeType } from '@flowmator/workflow';
import { NodeOperationError } from '@flowmator/workflow';
import { apiRequest, forOp, operationProp } from '../../utils/api';
import { errorItem } from '../../utils/object';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
export const credTypeOf = (auth: unknown) => (auth === 'serviceAccount' ? 'googleApi' : 'googleSheetsOAuth2Api');

/** Accepts an ID or a docs.google.com URL. */
export function spreadsheetId(v: string) {
  return String(v).match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] ?? String(v).trim();
}

/** 0 → A, 25 → Z, 26 → AA */
export function columnLetter(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const quoteSheet = (name: string) => `'${name.replace(/'/g, "''")}'`;

class SheetsClient {
  constructor(
    private readonly ctx: { helpers: IHelpers },
    private readonly credType: string,
    readonly id: string,
  ) {}

  request(method: 'GET' | 'POST' | 'PUT', path: string, body?: IDataObject, qs?: IDataObject) {
    return apiRequest<IDataObject>(this.ctx, this.credType, { url: `${API}${path}`, method, ...(body ? { body } : {}), ...(qs ? { qs } : {}) });
  }

  async sheets() {
    const r = await this.request('GET', `/${this.id}`, undefined, { fields: 'sheets.properties' });
    return ((r.sheets as IDataObject[]) ?? []).map((s) => s.properties as { sheetId: number; title: string; index: number });
  }

  async values(range: string, render = 'UNFORMATTED_VALUE'): Promise<unknown[][]> {
    const r = await this.request('GET', `/${this.id}/values/${encodeURIComponent(range)}`, undefined, { valueRenderOption: render, dateTimeRenderOption: 'FORMATTED_STRING' });
    return (r.values as unknown[][]) ?? [];
  }
}

/* ---------------- a sheet as a table (evaluation datasets) ---------------- */

/** Rows below the header row as objects, with their sheet row number (row_number, like the Sheets node). */
export async function sheetRows(ctx: { helpers: IHelpers }, credType: string, documentId: string, sheet: string): Promise<IDataObject[]> {
  const [header = [], ...data] = await new SheetsClient(ctx, credType, spreadsheetId(documentId)).values(quoteSheet(sheet));
  const columns = header.map((h) => String(h ?? ''));
  const rows: IDataObject[] = [];
  data.forEach((values, i) => {
    if (!values.some((v) => v !== '' && v != null)) return;
    const row: IDataObject = { row_number: i + 2 };
    columns.forEach((c, j) => c && (row[c] = (values[j] ?? '') as IDataObject[string]));
    rows.push(row);
  });
  return rows;
}

/** Writes values into one row by column name, adding the columns the header row lacks. */
export async function writeSheetRow(ctx: { helpers: IHelpers }, credType: string, documentId: string, sheet: string, rowNumber: number, data: IDataObject) {
  const client = new SheetsClient(ctx, credType, spreadsheetId(documentId));
  const qs = quoteSheet(sheet);
  const header = ((await client.values(`${qs}!1:1`))[0] ?? []).map((h) => String(h ?? ''));
  const missing = Object.keys(data).filter((k) => !header.includes(k));
  if (missing.length) {
    await client.request('PUT', `/${client.id}/values/${encodeURIComponent(`${qs}!${columnLetter(header.length)}1`)}`, { values: [missing] }, { valueInputOption: 'RAW' });
    header.push(...missing);
  }
  const updates = Object.entries(data).map(([k, v]) => ({ range: `${qs}!${columnLetter(header.indexOf(k))}${rowNumber}`, values: [[cellValue(v)]] }));
  await client.request('POST', `/${client.id}/values:batchUpdate`, { valueInputOption: 'RAW', data: updates as unknown as IDataObject[] });
}

interface SheetOptions {
  headerRow?: number;
  firstDataRow?: number;
  valueInputMode?: 'USER_ENTERED' | 'RAW';
  valueRenderMode?: 'UNFORMATTED_VALUE' | 'FORMATTED_VALUE' | 'FORMULA';
  handlingExtraData?: 'ignoreIt' | 'insertInNewColumn' | 'error';
  returnFirstMatch?: boolean;
}

const cellValue = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v);

export const GoogleSheets: INodeType = {
  description: {
    name: 'flowmator.googleSheets',
    displayName: 'Google Sheets',
    description: 'Read, append and update rows in Google Sheets',
    group: ['input', 'output'],
    version: [4, 4.1, 4.2, 4.3, 4.4, 4.5],
    defaults: { name: 'Google Sheets', color: '#0aa55c' },
    icon: 'fa:google-sheets',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      { name: 'googleSheetsOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
      { name: 'googleApi', required: true, displayOptions: { show: { authentication: ['serviceAccount'] } } },
    ],
    codex: { categories: ['Data & Storage'], alias: ['Spreadsheet', 'CSV', 'Excel'] },
    properties: [
      { displayName: 'Authentication', name: 'authentication', type: 'options', default: 'oAuth2', options: [{ name: 'OAuth2 (recommended)', value: 'oAuth2' }, { name: 'Service Account', value: 'serviceAccount' }] },
      { displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true, default: 'sheet', options: [{ name: 'Sheet Within Document', value: 'sheet' }, { name: 'Document', value: 'spreadsheet' }] },
      operationProp('sheet', [
        { name: 'Append Row', value: 'append' },
        { name: 'Append or Update Row', value: 'appendOrUpdate' },
        { name: 'Update Row', value: 'update' },
        { name: 'Get Row(s)', value: 'read' },
        { name: 'Delete Rows or Columns', value: 'delete' },
        { name: 'Clear', value: 'clear' },
      ]),
      operationProp('spreadsheet', [{ name: 'Create', value: 'create' }]),
      ...forOp('sheet', ['append', 'appendOrUpdate', 'update', 'read', 'delete', 'clear'], [
        { displayName: 'Document (ID or URL)', name: 'documentId', type: 'string', default: '', required: true },
        { displayName: 'Sheet', name: 'sheetName', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'getSheets' }, description: 'Tab name (expressions allowed)' },
      ]),
      ...forOp('sheet', ['append', 'appendOrUpdate', 'update'], [
        { displayName: 'Mapping Column Mode', name: 'dataMode', type: 'options', default: 'autoMapInputData', options: [{ name: 'Map Automatically (field name = column name)', value: 'autoMapInputData' }, { name: 'Map Each Column Manually', value: 'defineBelow' }] },
        {
          displayName: 'Values to Send',
          name: 'fieldsUi',
          type: 'fixedCollection',
          typeOptions: { multipleValues: true },
          default: {},
          displayOptions: { show: { dataMode: ['defineBelow'] } },
          options: [{ name: 'fieldValues', displayName: 'Field', values: [{ displayName: 'Column', name: 'column', type: 'string', default: '' }, { displayName: 'Value', name: 'fieldValue', type: 'string', default: '' }] }],
        },
      ]),
      ...forOp('sheet', ['appendOrUpdate', 'update'], [{ displayName: 'Column to Match On', name: 'columnToMatchOn', type: 'string', default: '', required: true, description: 'Rows whose value in this column equals the item\'s value are updated' }]),
      ...forOp('sheet', 'read', [
        {
          displayName: 'Filters',
          name: 'filtersUI',
          type: 'fixedCollection',
          typeOptions: { multipleValues: true },
          default: {},
          options: [{ name: 'values', displayName: 'Filter', values: [{ displayName: 'Column', name: 'lookupColumn', type: 'string', default: '' }, { displayName: 'Value', name: 'lookupValue', type: 'string', default: '' }] }],
        },
      ]),
      ...forOp('sheet', 'delete', [
        { displayName: 'To Delete', name: 'toDelete', type: 'options', default: 'rows', options: [{ name: 'Rows', value: 'rows' }, { name: 'Columns', value: 'columns' }] },
        { displayName: 'Start Row Number', name: 'startIndex', type: 'number', default: 2, typeOptions: { minValue: 1 }, displayOptions: { show: { toDelete: ['rows'] } } },
        { displayName: 'Start Column', name: 'startColumn', type: 'string', default: 'A', displayOptions: { show: { toDelete: ['columns'] } } },
        { displayName: 'Number to Delete', name: 'numberToDelete', type: 'number', default: 1, typeOptions: { minValue: 1 } },
      ]),
      ...forOp('sheet', 'clear', [
        { displayName: 'Clear', name: 'clear', type: 'options', default: 'wholeSheet', options: [{ name: 'Whole Sheet', value: 'wholeSheet' }, { name: 'Keep Header Row', value: 'keepHeader' }, { name: 'Specific Range', value: 'range' }] },
        { displayName: 'Range', name: 'range', type: 'string', default: 'A1:F', displayOptions: { show: { clear: ['range'] } } },
      ]),
      ...forOp('spreadsheet', 'create', [
        { displayName: 'Title', name: 'title', type: 'string', default: '', required: true },
        { displayName: 'Sheet Names', name: 'sheetNames', type: 'string', default: 'Sheet1', description: 'Comma separated' },
      ]),
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        displayOptions: { show: { resource: ['sheet'], operation: ['append', 'appendOrUpdate', 'update', 'read'] } },
        options: [
          { displayName: 'Header Row', name: 'headerRow', type: 'number', default: 1 },
          { displayName: 'First Data Row', name: 'firstDataRow', type: 'number', default: 2 },
          { displayName: 'Cell Format', name: 'valueInputMode', type: 'options', default: 'USER_ENTERED', options: [{ name: 'Let Google Sheets Format (formulas, dates…)', value: 'USER_ENTERED'}, { name: 'Raw (as is)', value: 'RAW' }] , displayOptions: { show: { '/operation': ['append', 'appendOrUpdate', 'update'] } } },
          { displayName: 'Output Formatting', name: 'valueRenderMode', type: 'options', default: 'UNFORMATTED_VALUE', options: [{ name: 'Values (unformatted)', value: 'UNFORMATTED_VALUE'}, { name: 'Values (formatted)', value: 'FORMATTED_VALUE' }, { name: 'Formulas', value: 'FORMULA' }] , displayOptions: { show: { '/operation': ['read'] } } },
          { displayName: 'When Item Has Extra Fields', name: 'handlingExtraData', type: 'options', default: 'insertInNewColumn', options: [{ name: 'Insert in New Column(s)', value: 'insertInNewColumn'}, { name: 'Ignore Them', value: 'ignoreIt' }, { name: 'Error', value: 'error' }] , displayOptions: { show: { '/operation': ['append', 'appendOrUpdate', 'update'] } } },
          { displayName: 'Return Only First Match', name: 'returnFirstMatch', type: 'boolean', default: false , displayOptions: { show: { '/operation': ['read'] } } },
        ],
      },
    ],
  },
  methods: {
    loadOptions: {
      async getSheets(this: ILoadOptionsFunctions) {
        const doc = this.getNodeParameter('documentId', '') as string;
        if (!doc) return [];
        const client = new SheetsClient(this, credTypeOf(this.getNodeParameter('authentication', 'oAuth2')), spreadsheetId(doc));
        return (await client.sheets()).map((s) => ({ name: s.title, value: s.title }));
      },
    },
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const resource = this.getNodeParameter('resource', 0) as string;
    const op = this.getNodeParameter('operation', 0) as string;
    const auth = this.getNodeParameter('authentication', 0, 'oAuth2');
    const credType = credTypeOf(auth);

    if (resource === 'spreadsheet') {
      const out: INodeExecutionData[] = [];
      for (let i = 0; i < items.length; i++) {
        const names = String(this.getNodeParameter('sheetNames', i, 'Sheet1')).split(',').map((s) => s.trim()).filter(Boolean);
        const r = await apiRequest<IDataObject>(this, credType, { url: API, method: 'POST', body: { properties: { title: this.getNodeParameter('title', i) }, sheets: names.map((title) => ({ properties: { title } })) } }, i);
        out.push({ json: { spreadsheetId: r.spreadsheetId, url: r.spreadsheetUrl, title: (r.properties as IDataObject).title, sheets: names }, pairedItem: { item: i } });
      }
      return [out];
    }

    const client = new SheetsClient(this, credType, spreadsheetId(this.getNodeParameter('documentId', 0) as string));
    const sheet = this.getNodeParameter('sheetName', 0) as string;
    const qs = quoteSheet(sheet);
    const o = this.getNodeParameter('options', 0, {}) as SheetOptions;
    const headerRow = o.headerRow ?? 1;
    const firstDataRow = o.firstDataRow ?? headerRow + 1;

    if (op === 'read') {
      const out: INodeExecutionData[] = [];
      const rows = await client.values(qs, o.valueRenderMode ?? 'UNFORMATTED_VALUE');
      const header = (rows[headerRow - 1] ?? []).map(String);
      const data = rows.slice(firstDataRow - 1).map((r, n) => {
        const json: IDataObject = { row_number: firstDataRow + n };
        header.forEach((h, c) => h && (json[h] = (r[c] ?? '') as never));
        return json;
      });
      for (let i = 0; i < items.length; i++) {
        const filters = ((this.getNodeParameter('filtersUI.values', i, []) as Array<{ lookupColumn: string; lookupValue: unknown }>) ?? []).filter((f) => f.lookupColumn);
        let matches = data.filter((row) => filters.every((f) => String(row[f.lookupColumn] ?? '') === String(f.lookupValue ?? '')));
        if (o.returnFirstMatch) matches = matches.slice(0, 1);
        for (const json of matches) out.push({ json, pairedItem: { item: i } });
      }
      return [out];
    }

    if (op === 'clear') {
      const mode = this.getNodeParameter('clear', 0) as string;
      const range = mode === 'range' ? `${qs}!${this.getNodeParameter('range', 0)}` : mode === 'keepHeader' ? `${qs}!A${headerRow + 1}:ZZZ` : qs;
      await client.request('POST', `/${client.id}/values/${encodeURIComponent(range)}:clear`, {});
      return [items.map((item, i) => ({ json: { cleared: range }, pairedItem: { item: i } }))];
    }

    if (op === 'delete') {
      const target = (await client.sheets()).find((s) => s.title === sheet);
      if (!target) throw new NodeOperationError(this.getNode(), `Sheet "${sheet}" not found`);
      const rows = this.getNodeParameter('toDelete', 0) === 'rows';
      const count = Number(this.getNodeParameter('numberToDelete', 0, 1));
      const start = rows ? Number(this.getNodeParameter('startIndex', 0)) - 1 : columnIndex(String(this.getNodeParameter('startColumn', 0)));
      await client.request('POST', `/${client.id}:batchUpdate`, { requests: [{ deleteDimension: { range: { sheetId: target.sheetId, dimension: rows ? 'ROWS' : 'COLUMNS', startIndex: start, endIndex: start + count } } }] });
      return [items.map((_, i) => ({ json: { deleted: count, dimension: rows ? 'rows' : 'columns' }, pairedItem: { item: i } }))];
    }

    // append / update / appendOrUpdate: one header read, then batched writes
    const valueInput = o.valueInputMode ?? 'USER_ENTERED';
    const all = await client.values(qs, 'UNFORMATTED_VALUE');
    const header = (all[headerRow - 1] ?? []).map(String);
    const rowsData: IDataObject[] = [];
    const errors: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        if (this.getNodeParameter('dataMode', i, 'autoMapInputData') === 'defineBelow') {
          const fields = (this.getNodeParameter('fieldsUi.fieldValues', i, []) as Array<{ column: string; fieldValue: unknown }>) ?? [];
          rowsData.push(Object.fromEntries(fields.filter((f) => f.column).map((f) => [f.column, f.fieldValue])) as IDataObject);
        } else rowsData.push(items[i].json);
      } catch (e) {
        if (!this.continueOnFail()) throw e;
        errors.push(errorItem(e, i));
        rowsData.push({});
      }
    }

    // new columns for unknown fields
    const extra = [...new Set(rowsData.flatMap((r) => Object.keys(r)))].filter((k) => !header.includes(k));
    if (extra.length) {
      const mode = o.handlingExtraData ?? 'insertInNewColumn';
      if (mode === 'error') throw new NodeOperationError(this.getNode(), `Columns not in the sheet: ${extra.join(', ')}`);
      if (mode === 'insertInNewColumn') {
        const startCol = header.length;
        header.push(...extra);
        await client.request('PUT', `/${client.id}/values/${encodeURIComponent(`${qs}!${columnLetter(startCol)}${headerRow}`)}`, { values: [extra] }, { valueInputOption: 'RAW' });
      }
    }
    const toRow = (r: IDataObject, existing: unknown[] = []) => header.map((h, c) => (h in r ? cellValue(r[h]) : (existing[c] ?? '')));

    const matchColumn = op === 'append' ? '' : (this.getNodeParameter('columnToMatchOn', 0) as string);
    const matchIndex = header.indexOf(matchColumn);
    if (matchColumn && matchIndex === -1) throw new NodeOperationError(this.getNode(), `Column "${matchColumn}" not found in the header row`);

    const updates: Array<{ range: string; values: unknown[][] }> = [];
    const appends: unknown[][] = [];
    const resultRows: Array<{ json: IDataObject; row?: number }> = [];
    const dataRows = all.slice(firstDataRow - 1);
    rowsData.forEach((r, i) => {
      if (errors.some((e) => (e.pairedItem as { item: number }).item === i)) return;
      if (matchColumn) {
        const key = String(r[matchColumn] ?? '');
        const found = dataRows.findIndex((row) => String(row[matchIndex] ?? '') === key);
        if (found >= 0) {
          const rowNumber = firstDataRow + found;
          const values = toRow(r, dataRows[found]);
          dataRows[found] = values;
          updates.push({ range: `${qs}!A${rowNumber}:${columnLetter(header.length - 1)}${rowNumber}`, values: [values] });
          resultRows[i] = { json: { ...r, row_number: rowNumber } };
          return;
        }
        if (op === 'update') {
          resultRows[i] = { json: { ...r, _updated: false } };
          return;
        }
      }
      appends.push(toRow(r));
      resultRows[i] = { json: { ...r } };
    });

    if (updates.length) await client.request('POST', `/${client.id}/values:batchUpdate`, { valueInputOption: valueInput, data: updates });
    if (appends.length) {
      await client.request('POST', `/${client.id}/values/${encodeURIComponent(`${qs}!A${headerRow}`)}:append`, { values: appends }, { valueInputOption: valueInput, insertDataOption: 'INSERT_ROWS' });
    }

    const out: INodeExecutionData[] = [];
    resultRows.forEach((r, i) => r && out.push({ json: r.json, pairedItem: { item: i } }));
    return [[...out, ...errors]];
  },
};

function columnIndex(letters: string) {
  return letters.toUpperCase().split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}
