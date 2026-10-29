import { glob, readFile, stat, writeFile, appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { NodeOperationError, type IDataObject, type IExecuteFunctions, type INodeExecutionData, type INodeType } from '@8n8/workflow';
import { deepCopy, getValue, setValue } from '../utils/object';
import { perItem } from './markup';

/* ---------------- file access rules ---------------- */

/**
 * N8N_RESTRICT_FILE_ACCESS_TO (";"-separated dirs) limits where file nodes may read/write.
 * The 8n8 data folder (database, encryption key) is always off limits unless
 * N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES=false.
 */
export function assertFileAccess(filePath: string) {
  const resolved = path.resolve(filePath.replace(/^~(?=$|\/)/, os.homedir()));
  const allowed = (process.env.N8N_RESTRICT_FILE_ACCESS_TO ?? '').split(';').map((s) => s.trim()).filter(Boolean).map((d) => path.resolve(d));
  if (allowed.length && !allowed.some((d) => resolved === d || resolved.startsWith(d + path.sep))) {
    throw new Error(`Access to "${resolved}" is not allowed. Allowed folders: ${allowed.join(', ')}`);
  }
  if (process.env.N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES !== 'false') {
    const dataDir = path.resolve(process.env.N8N_USER_FOLDER ?? path.join(os.homedir(), '.8n8'));
    if (resolved === dataDir || resolved.startsWith(dataDir + path.sep)) throw new Error(`Access to the 8n8 data folder is not allowed: ${resolved}`);
  }
  return resolved;
}

/* ---------------- Read/Write Files from Disk ---------------- */

export const ReadWriteFile: INodeType = {
  description: {
    name: '8n8.readWriteFile',
    displayName: 'Read/Write Files from Disk',
    description: 'Reads files from or writes files to the computer running 8n8',
    group: ['input'],
    version: 1,
    defaults: { name: 'Read/Write Files from Disk', color: '#2244FF' },
    icon: 'fa:file',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      { displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true, default: 'read',
        options: [{ name: 'Read File(s) From Disk', value: 'read' }, { name: 'Write File to Disk', value: 'write' }] },
      { displayName: 'File(s) Selector', name: 'fileSelector', type: 'string', default: '', required: true, placeholder: '/home/me/reports/*.csv', hint: 'A path or glob pattern', displayOptions: { show: { operation: ['read'] } } },
      { displayName: 'File Path and Name', name: 'fileName', type: 'string', default: '', required: true, placeholder: '/home/me/out/report.txt', displayOptions: { show: { operation: ['write'] } } },
      { displayName: 'Input Binary Field', name: 'dataPropertyName', type: 'string', default: 'data', displayOptions: { show: { operation: ['write'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Put Output File in Field', name: 'dataPropertyName', type: 'string', default: 'data', displayOptions: { show: { '/operation': ['read'] } } },
          { displayName: 'File Name', name: 'fileName', type: 'string', default: '', description: 'Override the name stored with the file', displayOptions: { show: { '/operation': ['read'] } } },
          { displayName: 'MIME Type', name: 'mimeType', type: 'string', default: '', displayOptions: { show: { '/operation': ['read'] } } },
          { displayName: 'Append', name: 'append', type: 'boolean', default: false, displayOptions: { show: { '/operation': ['write'] } } },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    return [
      await perItem(this, async (item, i) => {
        const op = this.getNodeParameter('operation', i) as string;
        const o = this.getNodeParameter('options', i, {}) as IDataObject;
        if (op === 'read') {
          const pattern = String(this.getNodeParameter('fileSelector', i)).replace(/^~(?=$|\/)/, os.homedir());
          const files: string[] = [];
          for await (const f of glob(pattern)) files.push(path.resolve(f));
          if (!files.length) {
            try {
              if ((await stat(pattern)).isFile()) files.push(path.resolve(pattern));
            } catch {
              /* not found */
            }
          }
          const out: INodeExecutionData[] = [];
          for (const file of files.sort()) {
            assertFileAccess(file);
            if (!(await stat(file)).isFile()) continue;
            const binary = await this.helpers.prepareBinaryData(await readFile(file), (o.fileName as string) || path.basename(file), (o.mimeType as string) || undefined);
            out.push({ json: { fileName: path.basename(file), filePath: file, directory: path.dirname(file), fileExtension: binary.fileExtension, fileSize: binary.fileSize }, binary: { [String(o.dataPropertyName || 'data')]: binary } });
          }
          return out;
        }
        const file = assertFileAccess(String(this.getNodeParameter('fileName', i)));
        const prop = this.getNodeParameter('dataPropertyName', i) as string;
        const buffer = await this.helpers.getBinaryDataBuffer(i, prop);
        await mkdir(path.dirname(file), { recursive: true });
        if (o.append) await appendFile(file, buffer);
        else await writeFile(file, buffer);
        return { json: { ...deepCopy(item.json), fileName: file }, ...(item.binary ? { binary: item.binary } : {}) };
      }),
    ];
  },
};

/* ---------------- Extract from File ---------------- */

const EXTRACT_OPS = [
  { name: 'Extract From CSV', value: 'csv' },
  { name: 'Extract From HTML Table', value: 'html' },
  { name: 'Extract From JSON', value: 'fromJson' },
  { name: 'Extract From PDF', value: 'pdf' },
  { name: 'Extract From Text File', value: 'text' },
  { name: 'Extract From XLSX', value: 'xlsx' },
  { name: 'Move File to Base64 String', value: 'binaryToPropery' },
];

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue);
    if ('text' in v) return (v as { text: string }).text;
    if ('richText' in v) return (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join('');
    if ('error' in v) return (v as { error: string }).error;
  }
  return v;
}

function rowsToObjects(rows: unknown[][], headerRow: boolean, includeEmpty: boolean): IDataObject[] {
  if (!headerRow) return rows.map((r) => Object.fromEntries(r.map((v, i) => [`column_${i}`, v])) as IDataObject);
  const [header = [], ...data] = rows;
  const keys = header.map((h, i) => String(h ?? `column_${i}`));
  return data.map((r) => {
    const o: IDataObject = {};
    keys.forEach((k, i) => {
      const v = r[i];
      if (includeEmpty || (v !== null && v !== undefined && v !== '')) o[k] = (v ?? null) as never;
    });
    return o;
  });
}

export const ExtractFromFile: INodeType = {
  description: {
    name: '8n8.extractFromFile',
    displayName: 'Extract from File',
    description: 'Turns a binary file (CSV, XLSX, PDF, JSON, HTML, text) into item data',
    group: ['input'],
    version: [1, 1.1],
    defaults: { name: 'Extract from File', color: '#2244FF' },
    icon: 'fa:file-export',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      { displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true, default: 'csv', options: EXTRACT_OPS },
      { displayName: 'Input Binary Field', name: 'binaryPropertyName', type: 'string', default: 'data', required: true },
      { displayName: 'Destination Output Field', name: 'destinationKey', type: 'string', default: 'data', displayOptions: { show: { operation: ['fromJson', 'text', 'binaryToPropery'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Delimiter', name: 'delimiter', type: 'string', default: ',', displayOptions: { show: { '/operation': ['csv'] } } },
          { displayName: 'Header Row', name: 'headerRow', type: 'boolean', default: true, displayOptions: { show: { '/operation': ['csv', 'xlsx', 'html'] } } },
          { displayName: 'Include Empty Cells', name: 'includeEmptyCells', type: 'boolean', default: false, displayOptions: { show: { '/operation': ['csv', 'xlsx', 'html'] } } },
          { displayName: 'Starting Line', name: 'fromLine', type: 'number', default: 0, displayOptions: { show: { '/operation': ['csv'] } } },
          { displayName: 'Max Number of Rows to Load', name: 'maxRowCount', type: 'number', default: -1, displayOptions: { show: { '/operation': ['csv', 'xlsx'] } } },
          { displayName: 'Sheet Name', name: 'sheetName', type: 'string', default: '', description: 'Defaults to the first sheet', displayOptions: { show: { '/operation': ['xlsx'] } } },
          { displayName: 'Encoding', name: 'encoding', type: 'options', default: 'utf8', options: ['utf8', 'latin1', 'utf16le', 'ascii'].map((e) => ({ name: e, value: e })), displayOptions: { show: { '/operation': ['csv', 'text', 'fromJson', 'html'] } } },
          { displayName: 'Keep Source', name: 'keepSource', type: 'options', default: 'json', options: [{ name: 'JSON', value: 'json' }, { name: 'Binary', value: 'binary' }, { name: 'Both', value: 'both' }], displayOptions: { show: { '/operation': ['fromJson', 'text', 'binaryToPropery', 'pdf'] } } },
          { displayName: 'Join Pages', name: 'joinPages', type: 'boolean', default: true, displayOptions: { show: { '/operation': ['pdf'] } } },
          { displayName: 'Password', name: 'password', type: 'string', typeOptions: { password: true }, default: '', displayOptions: { show: { '/operation': ['pdf'] } } },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    return [
      await perItem(this, async (item, i) => {
        const op = this.getNodeParameter('operation', i) as string;
        const prop = this.getNodeParameter('binaryPropertyName', i) as string;
        const o = this.getNodeParameter('options', i, {}) as IDataObject;
        this.helpers.assertBinaryData(i, prop);
        const buffer = await this.helpers.getBinaryDataBuffer(i, prop);
        const encoding = (o.encoding as BufferEncoding) ?? 'utf8';
        const headerRow = o.headerRow !== false;
        const includeEmpty = !!o.includeEmptyCells;
        const max = Number(o.maxRowCount ?? -1);
        const limit = <T>(rows: T[]) => (max >= 0 ? rows.slice(0, max) : rows);
        // Keep Source: "json" keeps the input fields, "binary" keeps the file, "both" keeps both
        const keep = (json: IDataObject): INodeExecutionData => {
          const k = o.keepSource ?? 'json';
          const withInput = k === 'json' || k === 'both' ? { ...deepCopy(item.json), ...json } : json;
          return { json: withInput, ...(k === 'binary' || k === 'both' ? { binary: item.binary } : {}) };
        };

        switch (op) {
          case 'csv': {
            let text = buffer.toString(encoding).replace(/^﻿/, '');
            if (Number(o.fromLine)) text = text.split(/\r?\n/).slice(Number(o.fromLine)).join('\n');
            const parsed = Papa.parse<unknown[]>(text, { delimiter: String(o.delimiter || ','), skipEmptyLines: true });
            const rows = rowsToObjects(parsed.data, headerRow, includeEmpty);
            return limit(rows).map((json) => ({ json }));
          }
          case 'html': {
            const $ = load(buffer.toString(encoding));
            const rows = $('table').first().find('tr').toArray().map((tr) => $(tr).find('th,td').toArray().map((c) => $(c).text().trim()));
            return rowsToObjects(rows, headerRow, includeEmpty).map((json) => ({ json }));
          }
          case 'xlsx': {
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(buffer as unknown as ArrayBuffer);
            const sheet = o.sheetName ? wb.getWorksheet(String(o.sheetName)) : wb.worksheets[0];
            if (!sheet) throw new Error(`Sheet "${o.sheetName}" not found. Sheets: ${wb.worksheets.map((s) => s.name).join(', ')}`);
            const rows: unknown[][] = [];
            sheet.eachRow({ includeEmpty: false }, (row) => {
              const values = (row.values as ExcelJS.CellValue[]).slice(1);
              rows.push(values.map(cellValue));
            });
            return limit(rowsToObjects(rows, headerRow, includeEmpty)).map((json) => ({ json }));
          }
          case 'pdf': {
            const { extractText, getDocumentProxy, getMeta } = await import('unpdf');
            const pdf = await getDocumentProxy(new Uint8Array(buffer), o.password ? { password: String(o.password) } : undefined);
            const { totalPages, text } = await extractText(pdf, { mergePages: o.joinPages !== false });
            const meta = await getMeta(pdf).catch(() => ({ info: {}, metadata: {} }));
            return keep({ numpages: totalPages, text: text as never, info: (meta.info ?? {}) as IDataObject });
          }
          case 'fromJson': {
            const dest = this.getNodeParameter('destinationKey', i) as string;
            const json: IDataObject = {};
            setValue(json, dest, JSON.parse(buffer.toString(encoding).replace(/^﻿/, '')));
            return keep(json);
          }
          case 'text': {
            const json: IDataObject = {};
            setValue(json, this.getNodeParameter('destinationKey', i) as string, buffer.toString(encoding));
            return keep(json);
          }
          case 'binaryToPropery': {
            const json: IDataObject = {};
            setValue(json, this.getNodeParameter('destinationKey', i) as string, buffer.toString('base64'));
            return keep(json);
          }
        }
        throw new NodeOperationError(this.getNode(), `Unsupported operation ${op}`);
      }),
    ];
  },
};

/* ---------------- Convert to File ---------------- */

export const ConvertToFile: INodeType = {
  description: {
    name: '8n8.convertToFile',
    displayName: 'Convert to File',
    description: 'Turns item data into a binary file (CSV, XLSX, JSON, HTML, text)',
    group: ['input'],
    version: [1, 1.1],
    defaults: { name: 'Convert to File', color: '#2244FF' },
    icon: 'fa:file-import',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'csv',
        options: [
          { name: 'Convert to CSV', value: 'csv' },
          { name: 'Convert to HTML', value: 'html' },
          { name: 'Convert to JSON', value: 'toJson' },
          { name: 'Convert to Text File', value: 'toText' },
          { name: 'Convert to XLSX', value: 'xlsx' },
          { name: 'Move Base64 String to File', value: 'toBinary' },
        ],
      },
      { displayName: 'Mode', name: 'mode', type: 'options', default: 'once', displayOptions: { show: { operation: ['toJson'] } },
        options: [{ name: 'All Items to One File', value: 'once' }, { name: 'Each Item to Separate File', value: 'each' }] },
      { displayName: 'Text Input Field', name: 'sourceProperty', type: 'string', default: '', required: true, displayOptions: { show: { operation: ['toText', 'toBinary'] } } },
      { displayName: 'Put Output File in Field', name: 'binaryPropertyName', type: 'string', default: 'data' },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'File Name', name: 'fileName', type: 'string', default: '' },
          { displayName: 'Delimiter', name: 'delimiter', type: 'string', default: ',', displayOptions: { show: { '/operation': ['csv'] } } },
          { displayName: 'Header Row', name: 'headerRow', type: 'boolean', default: true, displayOptions: { show: { '/operation': ['csv', 'xlsx', 'html'] } } },
          { displayName: 'Sheet Name', name: 'sheetName', type: 'string', default: 'Sheet', displayOptions: { show: { '/operation': ['xlsx'] } } },
          { displayName: 'Format', name: 'format', type: 'boolean', default: false, description: 'Pretty-print the JSON', displayOptions: { show: { '/operation': ['toJson'] } } },
          { displayName: 'MIME Type', name: 'mimeType', type: 'string', default: '', displayOptions: { show: { '/operation': ['toBinary', 'toText'] } } },
          { displayName: 'Encoding', name: 'encoding', type: 'options', default: 'utf8', options: ['utf8', 'latin1', 'utf16le', 'ascii'].map((e) => ({ name: e, value: e })), displayOptions: { show: { '/operation': ['toText', 'toJson', 'csv'] } } },
          { displayName: 'Add Byte Order Mark (BOM)', name: 'addBOM', type: 'boolean', default: false, displayOptions: { show: { '/operation': ['csv', 'toText', 'toJson'] } } },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const op = this.getNodeParameter('operation', 0) as string;
    const prop = this.getNodeParameter('binaryPropertyName', 0) as string;
    const o = this.getNodeParameter('options', 0, {}) as IDataObject;
    const encoding = (o.encoding as BufferEncoding) ?? 'utf8';
    const bom = (s: string) => (o.addBOM ? `﻿${s}` : s);
    const allPaired = items.map((_, i) => ({ item: i }));
    const file = async (data: Buffer, defaultName: string, mime?: string, json: IDataObject = {}, pairedItem: INodeExecutionData['pairedItem'] = allPaired): Promise<INodeExecutionData> => ({
      json,
      binary: { [prop]: await this.helpers.prepareBinaryData(data, (o.fileName as string) || defaultName, (o.mimeType as string) || mime) },
      pairedItem,
    });
    const columns = () => [...new Set(items.flatMap((i) => Object.keys(i.json)))];
    const flat = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

    switch (op) {
      case 'csv': {
        const cols = columns();
        const rows = items.map((i) => cols.map((c) => flat(i.json[c])));
        const csv = Papa.unparse(o.headerRow === false ? rows : [cols, ...rows], { delimiter: String(o.delimiter || ',') });
        return [[await file(Buffer.from(bom(csv), encoding), 'data.csv', 'text/csv')]];
      }
      case 'html': {
        const cols = columns();
        const esc = (v: unknown) => String(flat(v) ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
        const head = o.headerRow === false ? '' : `<thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
        const body = items.map((i) => `<tr>${cols.map((c) => `<td>${esc(i.json[c])}</td>`).join('')}</tr>`).join('\n');
        return [[await file(Buffer.from(`<table>${head}<tbody>\n${body}\n</tbody></table>`), 'data.html', 'text/html')]];
      }
      case 'xlsx': {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet(String(o.sheetName || 'Sheet'));
        const cols = columns();
        if (o.headerRow !== false) ws.addRow(cols);
        for (const i of items) ws.addRow(cols.map((c) => flat(i.json[c]) as ExcelJS.CellValue));
        const buf = Buffer.from(await wb.xlsx.writeBuffer());
        return [[await file(buf, 'data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')]];
      }
      case 'toJson': {
        const fmt = (v: unknown) => bom(JSON.stringify(v, null, o.format ? 2 : undefined));
        if (this.getNodeParameter('mode', 0, 'once') === 'each') {
          return [await Promise.all(items.map((it, i) => file(Buffer.from(fmt(it.json), encoding), 'data.json', 'application/json', {}, { item: i })))];
        }
        return [[await file(Buffer.from(fmt(items.map((i) => i.json)), encoding), 'data.json', 'application/json')]];
      }
      case 'toText':
      case 'toBinary':
        return [
          await Promise.all(
            items.map(async (it, i) => {
              const src = this.getNodeParameter('sourceProperty', i) as string;
              const value = getValue(it.json, src);
              if (value === undefined) throw new NodeOperationError(this.getNode(), `The field "${src}" does not exist on item ${i}`, { itemIndex: i });
              const data = op === 'toBinary' ? Buffer.from(String(value), 'base64') : Buffer.from(bom(typeof value === 'string' ? value : JSON.stringify(value)), encoding);
              return file(data, op === 'toText' ? 'file.txt' : 'file', op === 'toText' ? 'text/plain' : undefined, {}, { item: i });
            }),
          ),
        ];
    }
    throw new NodeOperationError(this.getNode(), `Unsupported operation ${op}`);
  },
};
