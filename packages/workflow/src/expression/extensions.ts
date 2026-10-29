import { DateTime, Duration } from 'luxon';

type Fn = (value: any, ...args: any[]) => unknown;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !DateTime.isDateTime(v);

const isEmptyValue = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (isPlainObject(v) && Object.keys(v).length === 0);

const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Hash implementation is injected by the runtime (node:crypto on the server, Web Crypto is async so the editor omits it). */
let hashImpl: ((value: string, algorithm: string) => string) | undefined;
export function setHashImplementation(fn: (value: string, algorithm: string) => string) {
  hashImpl = fn;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const URL_RE = /https?:\/\/[^\s"'<>]+/;

const stringExt: Record<string, Fn> = {
  isEmpty: (s: string) => s.length === 0,
  isNotEmpty: (s: string) => s.length > 0,
  length: (s: string) => s.length,
  toNumber: (s: string) => {
    const n = Number(s.trim());
    if (Number.isNaN(n)) throw new Error(`Cannot convert "${s}" to a number`);
    return n;
  },
  toInt: (s: string) => parseInt(s, 10),
  toFloat: (s: string) => parseFloat(s),
  toBoolean: (s: string) => !['false', '0', 'no', 'n', 'off', ''].includes(s.trim().toLowerCase()),
  toDateTime: (s: string, format?: string) => {
    const dt = format ? DateTime.fromFormat(s, format) : DateTime.fromISO(s);
    if (dt.isValid) return dt;
    const fallback = DateTime.fromJSDate(new Date(s));
    if (!fallback.isValid) throw new Error(`Cannot convert "${s}" to a date`);
    return fallback;
  },
  toJsonString: (s: string) => JSON.stringify(s),
  parseJson: (s: string) => JSON.parse(s),
  toTitleCase: (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()),
  toSentenceCase: (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
  toSnakeCase: (s: string) => words(s).map((w) => w.toLowerCase()).join('_'),
  toCamelCase: (s: string) =>
    words(s)
      .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
      .join(''),
  toKebabCase: (s: string) => words(s).map((w) => w.toLowerCase()).join('-'),
  capitalize: (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
  removeTags: (s: string) => s.replace(/<[^>]*>/g, ''),
  removeMarkdown: (s: string) =>
    s
      .replace(/```[\s\S]*?```/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_~`#>]+/g, '')
      .trim(),
  trim: (s: string) => s.trim(),
  quote: (s: string, mark = '"') => `${mark}${s.replaceAll(mark, `\\${mark}`)}${mark}`,
  urlEncode: (s: string, entireString = false) => (entireString ? encodeURIComponent(s) : encodeURI(s)),
  urlDecode: (s: string, entireString = false) => (entireString ? decodeURIComponent(s) : decodeURI(s)),
  base64Encode: (s: string) => Buffer.from(s, 'utf8').toString('base64'),
  base64Decode: (s: string) => Buffer.from(s, 'base64').toString('utf8'),
  hash: (s: string, algorithm = 'md5') => {
    if (!hashImpl) throw new Error('hash() is not available in this environment');
    return hashImpl(s, algorithm.toLowerCase());
  },
  isEmail: (s: string) => new RegExp(`^${EMAIL_RE.source}$`).test(s),
  isUrl: (s: string) => {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  },
  isDomain: (s: string) => /^(?!-)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(s),
  isNumeric: (s: string) => s.trim() !== '' && !Number.isNaN(Number(s)),
  extractEmail: (s: string) => s.match(EMAIL_RE)?.[0],
  extractUrl: (s: string) => s.match(URL_RE)?.[0],
  extractDomain: (s: string) => {
    const email = s.match(/@([\w.-]+)/);
    if (email && !s.includes('://')) return email[1];
    try {
      return new URL(s.includes('://') ? s : `http://${s}`).hostname;
    } catch {
      return undefined;
    }
  },
  extractUrlPath: (s: string) => {
    try {
      return new URL(s).pathname;
    } catch {
      return undefined;
    }
  },
  replaceSpecialChars: (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, ''),
};

const numberExt: Record<string, Fn> = {
  round: (n: number, decimals = 0) => Math.round(n * 10 ** decimals) / 10 ** decimals,
  floor: (n: number) => Math.floor(n),
  ceil: (n: number) => Math.ceil(n),
  abs: (n: number) => Math.abs(n),
  isEven: (n: number) => n % 2 === 0,
  isOdd: (n: number) => Math.abs(n % 2) === 1,
  isInteger: (n: number) => Number.isInteger(n),
  toBoolean: (n: number) => n !== 0,
  toInt: (n: number) => Math.trunc(n),
  toFloat: (n: number) => n,
  format: (n: number, locale?: string, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(n),
  toDateTime: (n: number, format: 'ms' | 's' | 'excel' = 'ms') => {
    if (format === 's') return DateTime.fromSeconds(n);
    if (format === 'excel') return DateTime.fromMillis((n - 25569) * 86400 * 1000, { zone: 'utc' });
    return DateTime.fromMillis(n);
  },
  isEmpty: () => false,
  isNotEmpty: () => true,
};

const sumOf = (a: unknown[]) => a.reduce<number>((s, v) => s + (typeof v === 'number' ? v : Number(v) || 0), 0);

const arrayExt: Record<string, Fn> = {
  isEmpty: (a: unknown[]) => a.length === 0,
  isNotEmpty: (a: unknown[]) => a.length > 0,
  first: (a: unknown[]) => a[0],
  last: (a: unknown[]) => a[a.length - 1],
  length: (a: unknown[]) => a.length,
  sum: sumOf,
  average: (a: unknown[]) => (a.length ? sumOf(a) / a.length : 0),
  min: (a: number[]) => Math.min(...a),
  max: (a: number[]) => Math.max(...a),
  pluck: (a: unknown[], ...fields: string[]) =>
    a.filter(isPlainObject).map((o) =>
      fields.length === 0 ? o : fields.length === 1 ? o[fields[0]] : Object.fromEntries(fields.map((f) => [f, o[f]])),
    ),
  unique: (a: unknown[], ...fields: string[]) => {
    const seen: unknown[] = [];
    return a.filter((v) => {
      const key = fields.length && isPlainObject(v) ? fields.map((f) => v[f]) : v;
      if (seen.some((s) => deepEqual(s, key))) return false;
      seen.push(key);
      return true;
    });
  },
  removeDuplicates: (a: unknown[], ...fields: string[]) => arrayExt.unique(a, ...fields),
  compact: (a: unknown[]) => a.filter((v) => !isEmptyValue(v)),
  chunk: (a: unknown[], size: number) => {
    const out: unknown[][] = [];
    for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size));
    return out;
  },
  randomItem: (a: unknown[]) => a[Math.floor(Math.random() * a.length)],
  difference: (a: unknown[], other: unknown[]) => a.filter((v) => !other.some((o) => deepEqual(o, v))),
  intersection: (a: unknown[], other: unknown[]) => a.filter((v) => other.some((o) => deepEqual(o, v))),
  union: (a: unknown[], other: unknown[]) => arrayExt.unique([...a, ...other]),
  merge: (a: unknown[], ...others: unknown[][]) => {
    const all = [...a, ...others.flat()].filter(isPlainObject);
    return Object.assign({}, ...all);
  },
  smartJoin: (a: unknown[], keyField: string, valueField: string) =>
    Object.fromEntries(a.filter(isPlainObject).map((o) => [String(o[keyField]), o[valueField]])),
  renameKeys: (a: unknown[], ...pairs: string[]) =>
    a.map((o) => (isPlainObject(o) ? objectExt.renameKeys(o, ...pairs) : o)),
  toJsonString: (a: unknown[]) => JSON.stringify(a),
};

const objectExt: Record<string, Fn> = {
  isEmpty: (o: object) => Object.keys(o).length === 0,
  isNotEmpty: (o: object) => Object.keys(o).length > 0,
  keys: (o: object) => Object.keys(o),
  values: (o: object) => Object.values(o),
  hasField: (o: object, field: string) => field in o,
  removeField: (o: Record<string, unknown>, field: string) => {
    const { [field]: _, ...rest } = o;
    return rest;
  },
  removeFieldsContaining: (o: Record<string, unknown>, text: string) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => !(typeof v === 'string' && v.includes(text)))),
  keepFieldsContaining: (o: Record<string, unknown>, text: string) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string' && v.includes(text))),
  compact: (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => !isEmptyValue(v))),
  merge: (o: object, ...others: object[]) => Object.assign({}, o, ...others),
  renameKeys: (o: Record<string, unknown>, ...pairs: string[]) => {
    const map = new Map<string, string>();
    for (let i = 0; i + 1 < pairs.length; i += 2) map.set(pairs[i], pairs[i + 1]);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [map.get(k) ?? k, v]));
  },
  urlEncode: (o: Record<string, unknown>) => new URLSearchParams(o as Record<string, string>).toString(),
  toJsonString: (o: object) => JSON.stringify(o),
};

const dateExt: Record<string, Fn> = {
  beginningOf: (d: DateTime, unit: 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' = 'week') => d.startOf(unit),
  endOfMonth: (d: DateTime) => d.endOf('month'),
  isWeekend: (d: DateTime) => d.weekday >= 6,
  isInLast: (d: DateTime, n = 0, unit = 'minutes') => d >= DateTime.now().minus({ [unit]: n }) && d <= DateTime.now(),
  isBetween: (d: DateTime, a: DateTime | string, b: DateTime | string) => {
    const toDt = (v: DateTime | string) => (typeof v === 'string' ? DateTime.fromISO(v) : v);
    return d > toDt(a) && d < toDt(b);
  },
  extract: (d: DateTime, unit = 'week') =>
    unit === 'week' ? d.weekNumber : unit === 'yearDayNumber' ? d.ordinal : (d as unknown as Record<string, number>)[unit],
  format: (d: DateTime, fmt: string) => d.toFormat(fmt),
  toDateTime: (d: DateTime) => d,
  diffTo: (d: DateTime, other: DateTime | string, unit: string = 'days') => {
    const o = typeof other === 'string' ? DateTime.fromISO(other) : other;
    return d.diff(o, unit as any).as(unit as any);
  },
  diffToNow: (d: DateTime, unit: string = 'days') => DateTime.now().diff(d, unit as any).as(unit as any),
  isEmpty: () => false,
  isNotEmpty: () => true,
};

const booleanExt: Record<string, Fn> = {
  toNumber: (b: boolean) => (b ? 1 : 0),
  toInt: (b: boolean) => (b ? 1 : 0),
  isEmpty: () => false,
  isNotEmpty: () => true,
};

export const EXTENSION_METHOD_NAMES = [
  ...new Set([
    ...Object.keys(stringExt),
    ...Object.keys(numberExt),
    ...Object.keys(arrayExt),
    ...Object.keys(objectExt),
    ...Object.keys(dateExt),
    ...Object.keys(booleanExt),
  ]),
];

/** Runtime dispatcher for transformed expressions. Native methods always win. */
export function extend(value: any, method: string, args: unknown[]): unknown {
  if (value !== null && value !== undefined) {
    const native = value[method];
    if (typeof native === 'function') return native.apply(value, args);
  }
  let table: Record<string, Fn> | undefined;
  if (typeof value === 'string') table = stringExt;
  else if (typeof value === 'number') table = numberExt;
  else if (typeof value === 'boolean') table = booleanExt;
  else if (Array.isArray(value)) table = arrayExt;
  else if (value instanceof Date) return extend(DateTime.fromJSDate(value), method, args);
  else if (DateTime.isDateTime(value)) table = dateExt;
  else if (Duration.isDuration(value)) table = undefined;
  else if (value && typeof value === 'object') table = objectExt;
  else if (value === null || value === undefined) {
    if (method === 'isEmpty') return true;
    if (method === 'isNotEmpty') return false;
  }
  const fn = table?.[method];
  if (!fn) {
    const typeName = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    throw new TypeError(`${method}() is not a function on ${typeName}`);
  }
  return fn(value, ...args);
}
