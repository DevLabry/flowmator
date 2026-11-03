import { createHash, createHmac, createSign, randomBytes, randomUUID } from 'node:crypto';
import { DateTime, type DateTimeUnit, type DurationLikeObject } from 'luxon';
import { NodeOperationError, type IDataObject, type IExecuteFunctions, type INodeExecutionData, type INodeProperties, type INodeType } from '@flowmator/workflow';
import { deepCopy, errorItem, getValue, setValue, unsetValue } from '../utils/object';

/* ---------------- Date & Time ---------------- */

const UNITS = ['years', 'quarters', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'];
const unitOptions = UNITS.map((u) => ({ name: u[0].toUpperCase() + u.slice(1), value: u }));
const show = (...operation: string[]) => ({ show: { operation } });
const outputField = (def: string, ...ops: string[]): INodeProperties => ({ displayName: 'Output Field Name', name: 'outputFieldName', type: 'string', default: def, displayOptions: show(...ops) });

/** Accepts ISO strings, JS dates, Luxon DateTimes, epoch ms/seconds and loose date strings. */
export function toDateTime(value: unknown, zone: string, fromFormat?: string): DateTime {
  if (DateTime.isDateTime(value)) return value.setZone(zone);
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone });
  if (typeof value === 'number') return value > 1e11 ? DateTime.fromMillis(value, { zone }) : DateTime.fromSeconds(value, { zone });
  const s = String(value ?? '').trim();
  if (fromFormat) {
    const dt = DateTime.fromFormat(s, fromFormat, { zone });
    if (dt.isValid) return dt;
  }
  if (/^\d+$/.test(s)) return toDateTime(Number(s), zone);
  for (const parse of [DateTime.fromISO, DateTime.fromRFC2822, DateTime.fromHTTP, DateTime.fromSQL]) {
    const dt = parse(s, { zone });
    if (dt.isValid) return dt;
  }
  const js = new Date(s);
  if (!Number.isNaN(js.getTime())) return DateTime.fromJSDate(js, { zone });
  throw new Error(`The value '${s}' is not a valid date`);
}

const FORMAT_PRESETS: Record<string, string> = {
  'MM/dd/yyyy': 'MM/dd/yyyy',
  'yyyy/MM/dd': 'yyyy/MM/dd',
  'MMMM dd yyyy': 'MMMM dd yyyy',
  'MM-dd-yyyy': 'MM-dd-yyyy',
  'yyyy-MM-dd': 'yyyy-MM-dd',
};

export const DateTimeNode: INodeType = {
  description: {
    name: 'flowmator.dateTime',
    displayName: 'Date & Time',
    description: 'Manipulate date and time values',
    group: ['transform'],
    version: 2,
    defaults: { name: 'Date & Time', color: '#408000' },
    icon: 'fa:calendar',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'getCurrentDate',
        options: [
          { name: 'Add to a Date', value: 'addToDate' },
          { name: 'Extract Part of a Date', value: 'extractDate' },
          { name: 'Format a Date', value: 'formatDate' },
          { name: 'Get Current Date', value: 'getCurrentDate' },
          { name: 'Get Time Between Dates', value: 'getTimeBetweenDates' },
          { name: 'Round a Date', value: 'roundDate' },
          { name: 'Subtract From a Date', value: 'subtractFromDate' },
        ],
      },
      { displayName: 'Include Current Time', name: 'includeTime', type: 'boolean', default: true, displayOptions: show('getCurrentDate') },
      outputField('currentDate', 'getCurrentDate'),
      { displayName: 'Date', name: 'magnitude', type: 'string', default: '', required: true, displayOptions: show('addToDate', 'subtractFromDate') },
      { displayName: 'Time Unit', name: 'timeUnit', type: 'options', default: 'days', options: unitOptions, displayOptions: show('addToDate', 'subtractFromDate') },
      { displayName: 'Duration', name: 'duration', type: 'number', default: 0, displayOptions: show('addToDate', 'subtractFromDate') },
      outputField('newDate', 'addToDate', 'subtractFromDate'),
      { displayName: 'Date', name: 'date', type: 'string', default: '', required: true, displayOptions: show('formatDate', 'roundDate', 'extractDate') },
      {
        displayName: 'Format',
        name: 'format',
        type: 'options',
        default: 'MM/dd/yyyy',
        displayOptions: show('formatDate'),
        options: [
          { name: 'Custom Format', value: 'custom' },
          { name: 'MM/DD/YYYY', value: 'MM/dd/yyyy' },
          { name: 'YYYY/MM/DD', value: 'yyyy/MM/dd' },
          { name: 'MMMM DD YYYY', value: 'MMMM dd yyyy' },
          { name: 'MM-DD-YYYY', value: 'MM-dd-yyyy' },
          { name: 'YYYY-MM-DD', value: 'yyyy-MM-dd' },
          { name: 'Unix Timestamp', value: 'X' },
          { name: 'Unix Ms Timestamp', value: 'x' },
          { name: 'ISO', value: 'iso' },
        ],
      },
      { displayName: 'Custom Format', name: 'customFormat', type: 'string', default: '', placeholder: "yyyy-MM-dd 'at' HH:mm", hint: 'Luxon tokens', displayOptions: { show: { operation: ['formatDate'], format: ['custom'] } } },
      outputField('formattedDate', 'formatDate'),
      { displayName: 'Mode', name: 'mode', type: 'options', default: 'roundDown', displayOptions: show('roundDate'), options: [{ name: 'Round Down', value: 'roundDown' }, { name: 'Round Up', value: 'roundUp' }] },
      {
        displayName: 'To Nearest',
        name: 'toNearest',
        type: 'options',
        default: 'day',
        displayOptions: show('roundDate'),
        options: ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second'].map((u) => ({ name: u[0].toUpperCase() + u.slice(1), value: u })),
      },
      outputField('roundedDate', 'roundDate'),
      { displayName: 'Start Date', name: 'startDate', type: 'string', default: '', displayOptions: show('getTimeBetweenDates') },
      { displayName: 'End Date', name: 'endDate', type: 'string', default: '', displayOptions: show('getTimeBetweenDates') },
      { displayName: 'Units', name: 'units', type: 'multiOptions', default: ['days'], options: unitOptions, displayOptions: show('getTimeBetweenDates') },
      outputField('timeDifference', 'getTimeBetweenDates'),
      {
        displayName: 'Part',
        name: 'part',
        type: 'options',
        default: 'month',
        displayOptions: show('extractDate'),
        options: ['year', 'month', 'week', 'day', 'hour', 'minute', 'second'].map((u) => ({ name: u[0].toUpperCase() + u.slice(1), value: u })),
      },
      outputField('datePart', 'extractDate'),
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'From Date Format', name: 'fromFormat', type: 'string', default: '', description: 'Format of the input date when it is not ISO, e.g. dd/MM/yyyy' },
          { displayName: 'Timezone', name: 'timezone', type: 'string', default: '', placeholder: 'Europe/Madrid' },
          { displayName: 'Include Input Fields', name: 'includeInputFields', type: 'boolean', default: true },
          { displayName: 'Output as ISO String', name: 'isoString', type: 'boolean', default: false },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const op = this.getNodeParameter('operation', i) as string;
        const opts = this.getNodeParameter('options', i, {}) as IDataObject;
        const zone = String(opts.timezone || this.getTimezone());
        const fromFormat = (opts.fromFormat as string) || undefined;
        const field = this.getNodeParameter('outputFieldName', i, 'data') as string;
        const iso = (dt: DateTime) => dt.toISO();
        let value: unknown;

        switch (op) {
          case 'getCurrentDate': {
            const now = DateTime.now().setZone(zone);
            value = this.getNodeParameter('includeTime', i, true) ? iso(now) : now.toISODate();
            break;
          }
          case 'addToDate':
          case 'subtractFromDate': {
            const dt = toDateTime(this.getNodeParameter('magnitude', i), zone, fromFormat);
            const d: DurationLikeObject = { [this.getNodeParameter('timeUnit', i) as string]: Number(this.getNodeParameter('duration', i)) };
            value = iso(op === 'addToDate' ? dt.plus(d) : dt.minus(d));
            break;
          }
          case 'formatDate': {
            const dt = toDateTime(this.getNodeParameter('date', i), zone, fromFormat);
            const format = this.getNodeParameter('format', i) as string;
            if (format === 'X') value = Math.floor(dt.toSeconds());
            else if (format === 'x') value = dt.toMillis();
            else if (format === 'iso') value = iso(dt);
            else value = dt.toFormat(format === 'custom' ? (this.getNodeParameter('customFormat', i) as string) : FORMAT_PRESETS[format] ?? format);
            break;
          }
          case 'roundDate': {
            const dt = toDateTime(this.getNodeParameter('date', i), zone, fromFormat);
            const unit = this.getNodeParameter('toNearest', i) as DateTimeUnit;
            const down = dt.startOf(unit);
            value = iso(this.getNodeParameter('mode', i) === 'roundUp' && !down.equals(dt) ? down.plus({ [unit]: 1 }) : down);
            break;
          }
          case 'getTimeBetweenDates': {
            const start = toDateTime(this.getNodeParameter('startDate', i), zone, fromFormat);
            const end = toDateTime(this.getNodeParameter('endDate', i), zone, fromFormat);
            const units = this.getNodeParameter('units', i) as Array<keyof DurationLikeObject>;
            const diff = end.diff(start, units);
            value = opts.isoString ? diff.toISO() : diff.toObject();
            break;
          }
          case 'extractDate': {
            const dt = toDateTime(this.getNodeParameter('date', i), zone, fromFormat);
            const part = this.getNodeParameter('part', i) as string;
            value = part === 'week' ? dt.weekNumber : (dt as unknown as Record<string, number>)[part];
            break;
          }
          default:
            throw new NodeOperationError(this.getNode(), `Unknown operation ${op}`);
        }
        const json = opts.includeInputFields === false ? {} : deepCopy(items[i].json);
        setValue(json, field, value);
        out.push({ json, ...(items[i].binary ? { binary: items[i].binary } : {}), pairedItem: { item: i } });
      } catch (e) {
        if (this.continueOnFail()) out.push(errorItem(e, i));
        else throw new NodeOperationError(this.getNode(), e as Error, { itemIndex: i });
      }
    }
    return [out];
  },
};

/* ---------------- Crypto ---------------- */

const HASHES = ['MD5', 'SHA1', 'SHA256', 'SHA384', 'SHA512', 'SHA3-256', 'SHA3-384', 'SHA3-512'];
const nodeAlgo = (t: string) => t.toLowerCase();

export const CryptoNode: INodeType = {
  description: {
    name: 'flowmator.crypto',
    displayName: 'Crypto',
    description: 'Hash, sign and generate random values',
    group: ['transform'],
    version: 2,
    defaults: { name: 'Crypto', color: '#408000' },
    icon: 'fa:key',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Action',
        name: 'action',
        type: 'options',
        default: 'hash',
        options: [
          { name: 'Generate', value: 'generate', description: 'Generate random data' },
          { name: 'Hash', value: 'hash' },
          { name: 'Hmac', value: 'hmac' },
          { name: 'Sign', value: 'sign', description: 'Sign a string with a private key' },
        ],
      },
      { displayName: 'Type', name: 'type', type: 'options', default: 'SHA256', options: HASHES.map((h) => ({ name: h, value: h })), displayOptions: { show: { action: ['hash', 'hmac'] } } },
      { displayName: 'Binary File', name: 'binaryData', type: 'boolean', default: false, displayOptions: { show: { action: ['hash', 'hmac'] } } },
      { displayName: 'Binary Property Name', name: 'binaryPropertyName', type: 'string', default: 'data', displayOptions: { show: { action: ['hash', 'hmac'], binaryData: [true] } } },
      { displayName: 'Value', name: 'value', type: 'string', default: '', displayOptions: { show: { action: ['hash', 'hmac', 'sign'], binaryData: [false] } } },
      { displayName: 'Secret', name: 'secret', type: 'string', typeOptions: { password: true }, default: '', displayOptions: { show: { action: ['hmac'] } } },
      { displayName: 'Algorithm', name: 'algorithm', type: 'options', default: 'RSA-SHA256', options: ['RSA-SHA256', 'RSA-SHA384', 'RSA-SHA512', 'RSA-SHA1'].map((a) => ({ name: a, value: a })), displayOptions: { show: { action: ['sign'] } } },
      { displayName: 'Private Key', name: 'privateKey', type: 'string', typeOptions: { rows: 4, password: true }, default: '', displayOptions: { show: { action: ['sign'] } } },
      { displayName: 'Encoding', name: 'encoding', type: 'options', default: 'hex', options: [{ name: 'BASE64', value: 'base64' }, { name: 'HEX', value: 'hex' }], displayOptions: { show: { action: ['hash', 'hmac', 'sign'] } } },
      {
        displayName: 'Type',
        name: 'encodingType',
        type: 'options',
        default: 'uuid',
        displayOptions: { show: { action: ['generate'] } },
        options: [
          { name: 'ASCII', value: 'ascii' },
          { name: 'BASE64', value: 'base64' },
          { name: 'HEX', value: 'hex' },
          { name: 'UUID', value: 'uuid' },
        ],
      },
      { displayName: 'Length', name: 'stringLength', type: 'number', default: 32, displayOptions: { show: { action: ['generate'], encodingType: ['ascii', 'base64', 'hex'] } } },
      { displayName: 'Property Name', name: 'dataPropertyName', type: 'string', default: 'data' },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const action = this.getNodeParameter('action', i) as string;
        const prop = this.getNodeParameter('dataPropertyName', i) as string;
        let input: string | Buffer = '';
        if ((action === 'hash' || action === 'hmac') && this.getNodeParameter('binaryData', i, false)) {
          input = await this.helpers.getBinaryDataBuffer(i, this.getNodeParameter('binaryPropertyName', i) as string);
        } else if (action !== 'generate') input = String(this.getNodeParameter('value', i, '') ?? '');
        const encoding = this.getNodeParameter('encoding', i, 'hex') as 'hex' | 'base64';
        let value: string;
        switch (action) {
          case 'hash':
            value = createHash(nodeAlgo(this.getNodeParameter('type', i) as string)).update(input).digest(encoding);
            break;
          case 'hmac':
            value = createHmac(nodeAlgo(this.getNodeParameter('type', i) as string), this.getNodeParameter('secret', i) as string).update(input).digest(encoding);
            break;
          case 'sign': {
            const signer = createSign(this.getNodeParameter('algorithm', i) as string);
            signer.update(input);
            value = signer.sign(this.getNodeParameter('privateKey', i) as string, encoding);
            break;
          }
          default: {
            const type = this.getNodeParameter('encodingType', i) as string;
            const length = Number(this.getNodeParameter('stringLength', i, 32));
            if (type === 'uuid') value = randomUUID();
            else if (type === 'ascii') {
              const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
              value = Array.from(randomBytes(length), (b) => chars[b % chars.length]).join('');
            } else value = randomBytes(length).toString(type as BufferEncoding).slice(0, length);
          }
        }
        const json = deepCopy(items[i].json);
        setValue(json, prop, value);
        out.push({ json, ...(items[i].binary ? { binary: items[i].binary } : {}), pairedItem: { item: i } });
      } catch (e) {
        if (this.continueOnFail()) out.push(errorItem(e, i));
        else throw new NodeOperationError(this.getNode(), e as Error, { itemIndex: i });
      }
    }
    return [out];
  },
};

/* ---------------- Rename Keys ---------------- */

function renameByRegex(obj: IDataObject, re: RegExp, replacement: string, depth: number, level = 0): IDataObject {
  const out: IDataObject = {};
  for (const [k, v] of Object.entries(obj)) {
    const nk = k.replace(re, replacement);
    out[nk] = v && typeof v === 'object' && !Array.isArray(v) && (depth === -1 || level < depth) ? renameByRegex(v as IDataObject, re, replacement, depth, level + 1) : v;
  }
  return out;
}

export const RenameKeys: INodeType = {
  description: {
    name: 'flowmator.renameKeys',
    displayName: 'Rename Keys',
    description: 'Renames fields of items',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Rename Keys', color: '#772244' },
    icon: 'fa:edit',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Keys',
        name: 'keys',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true, sortable: true },
        default: {},
        placeholder: 'Add new key',
        options: [
          {
            name: 'key',
            displayName: 'Key',
            values: [
              { displayName: 'Current Key Name', name: 'currentKey', type: 'string', default: '', hint: 'Supports dot notation, e.g. a.b' },
              { displayName: 'New Key Name', name: 'newKey', type: 'string', default: '' },
            ],
          },
        ],
      },
      {
        displayName: 'Additional Options',
        name: 'additionalOptions',
        type: 'collection',
        default: {},
        options: [
          {
            displayName: 'Regex',
            name: 'regexReplacement',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: {},
            options: [
              {
                name: 'replacements',
                displayName: 'Replacement',
                values: [
                  { displayName: 'Regular Expression', name: 'searchRegex', type: 'string', default: '' },
                  { displayName: 'Replace With', name: 'replaceRegex', type: 'string', default: '' },
                  { displayName: 'Case Insensitive', name: 'caseInsensitive', type: 'boolean', default: false },
                  { displayName: 'Max Depth (-1 = all)', name: 'depth', type: 'number', default: -1 },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    return [
      this.getInputData().map((item, i) => {
        let json = deepCopy(item.json);
        const keys = (this.getNodeParameter('keys.key', i, []) as Array<{ currentKey: string; newKey: string }>) ?? [];
        for (const { currentKey, newKey } of keys) {
          if (!currentKey || !newKey || currentKey === newKey) continue;
          const v = getValue(json, currentKey);
          if (v === undefined) continue;
          setValue(json, newKey, v);
          unsetValue(json, currentKey);
        }
        const regexes = (this.getNodeParameter('additionalOptions.regexReplacement.replacements', i, []) as Array<{ searchRegex: string; replaceRegex: string; caseInsensitive?: boolean; depth?: number }>) ?? [];
        for (const r of regexes) {
          if (!r.searchRegex) continue;
          json = renameByRegex(json, new RegExp(r.searchRegex, `g${r.caseInsensitive ? 'i' : ''}`), r.replaceRegex ?? '', r.depth ?? -1);
        }
        return { json, ...(item.binary ? { binary: item.binary } : {}), pairedItem: { item: i } };
      }),
    ];
  },
};
