import { DateTime } from 'luxon';
import type { INodeProperties } from '@flowmator/workflow';

export type FilterOperatorType = 'string' | 'number' | 'boolean' | 'dateTime' | 'array' | 'object' | 'any';

export interface FilterCondition {
  id?: string;
  leftValue: unknown;
  rightValue?: unknown;
  operator: { type: FilterOperatorType; operation: string; singleValue?: boolean; rightType?: FilterOperatorType };
}

export interface FilterValue {
  options?: { caseSensitive?: boolean; leftValue?: string; typeValidation?: 'strict' | 'loose' };
  conditions: FilterCondition[];
  combinator: 'and' | 'or';
}

export class FilterTypeError extends Error {}

const typeOf = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (DateTime.isDateTime(v) || v instanceof Date) return 'dateTime';
  return typeof v;
};

function coerce(value: unknown, type: FilterOperatorType, loose: boolean, side: string): unknown {
  if (value === undefined || value === null || type === 'any') return value;
  if (value === '' && type !== 'string') return undefined;
  switch (type) {
    case 'string':
      if (typeof value === 'string') return value;
      if (loose) return typeof value === 'object' ? JSON.stringify(value) : String(value);
      break;
    case 'number': {
      if (typeof value === 'number') return value;
      if (loose) {
        const n = typeof value === 'boolean' ? Number(value) : Number(String(value).trim());
        if (!Number.isNaN(n)) return n;
      }
      break;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (loose) {
        const s = String(value).trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
        if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;
      }
      break;
    case 'dateTime': {
      if (DateTime.isDateTime(value)) return value;
      if (value instanceof Date) return DateTime.fromJSDate(value);
      if (typeof value === 'string') {
        const dt = DateTime.fromISO(value);
        if (dt.isValid) return dt;
        const js = DateTime.fromJSDate(new Date(value));
        if (js.isValid && loose) return js;
      }
      if (typeof value === 'number' && loose) return DateTime.fromMillis(value);
      break;
    }
    case 'array':
      if (Array.isArray(value)) return value;
      if (loose && typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        } catch {}
      }
      break;
    case 'object':
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      if (loose && typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === 'object') return parsed;
        } catch {}
      }
      break;
  }
  throw new FilterTypeError(
    `Wrong type: '${typeof value === 'object' ? JSON.stringify(value) : String(value)}' is a ${typeOf(value)} but was expecting a ${type}` +
      ` [condition ${side}]${loose ? '' : '. Try enabling "Convert types where required"'}`,
  );
}

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && !DateTime.isDateTime(v) && Object.keys(v as object).length === 0);

const deepEqual = (a: unknown, b: unknown) => {
  if (DateTime.isDateTime(a) && DateTime.isDateTime(b)) return a.toMillis() === b.toMillis();
  return JSON.stringify(a) === JSON.stringify(b);
};

export function evaluateCondition(condition: FilterCondition, options: FilterValue['options'] = {}): boolean {
  const { type, operation } = condition.operator;
  const loose = options.typeValidation === 'loose';
  const caseSensitive = options.caseSensitive ?? true;

  if (operation === 'exists') return condition.leftValue !== undefined && condition.leftValue !== null;
  if (operation === 'notExists') return condition.leftValue === undefined || condition.leftValue === null;
  if (operation === 'empty') return isEmpty(condition.leftValue);
  if (operation === 'notEmpty') return !isEmpty(condition.leftValue);

  let left = coerce(condition.leftValue, type, loose, 'left');
  const rightType = (['contains', 'notContains'].includes(operation) && type === 'array') ? 'any' : operation.startsWith('length') ? 'number' : type;
  let right = condition.operator.singleValue ? undefined : coerce(condition.rightValue, rightType as FilterOperatorType, loose, 'right');

  if (!caseSensitive) {
    if (typeof left === 'string') left = left.toLowerCase();
    if (typeof right === 'string') right = right.toLowerCase();
  }

  switch (type) {
    case 'string': {
      const l = (left ?? '') as string;
      const r = (right ?? '') as string;
      switch (operation) {
        case 'equals': return l === r;
        case 'notEquals': return l !== r;
        case 'contains': return l.includes(r);
        case 'notContains': return !l.includes(r);
        case 'startsWith': return l.startsWith(r);
        case 'notStartsWith': return !l.startsWith(r);
        case 'endsWith': return l.endsWith(r);
        case 'notEndsWith': return !l.endsWith(r);
        case 'regex': return toRegex(r, caseSensitive).test(l);
        case 'notRegex': return !toRegex(r, caseSensitive).test(l);
      }
      break;
    }
    case 'number':
    case 'dateTime': {
      const l = DateTime.isDateTime(left) ? left.toMillis() : (left as number);
      const r = DateTime.isDateTime(right) ? right.toMillis() : (right as number);
      switch (operation) {
        case 'equals': return l === r;
        case 'notEquals': return l !== r;
        case 'gt': case 'after': return l > r;
        case 'lt': case 'before': return l < r;
        case 'gte': case 'afterOrEquals': return l >= r;
        case 'lte': case 'beforeOrEquals': return l <= r;
      }
      break;
    }
    case 'boolean':
      switch (operation) {
        case 'true': return left === true;
        case 'false': return left === false;
        case 'equals': return left === right;
        case 'notEquals': return left !== right;
      }
      break;
    case 'array': {
      const l = (left ?? []) as unknown[];
      const ci = (v: unknown) => (!caseSensitive && typeof v === 'string' ? v.toLowerCase() : v);
      switch (operation) {
        case 'contains': return l.some((v) => deepEqual(ci(v), right));
        case 'notContains': return !l.some((v) => deepEqual(ci(v), right));
        case 'lengthEquals': return l.length === right;
        case 'lengthNotEquals': return l.length !== right;
        case 'lengthGt': return l.length > (right as number);
        case 'lengthLt': return l.length < (right as number);
        case 'lengthGte': return l.length >= (right as number);
        case 'lengthLte': return l.length <= (right as number);
      }
      break;
    }
    case 'any':
    case 'object':
      if (operation === 'equals') return deepEqual(left, right);
      if (operation === 'notEquals') return !deepEqual(left, right);
      break;
  }
  throw new Error(`Unknown operator ${type}:${operation}`);
}

function toRegex(pattern: string, caseSensitive: boolean): RegExp {
  const m = pattern.match(/^\/(.*)\/([gimsuy]*)$/s);
  if (m) return new RegExp(m[1], m[2] + (caseSensitive || m[2].includes('i') ? '' : 'i'));
  return new RegExp(pattern, caseSensitive ? '' : 'i');
}

export function evaluateFilter(filter: FilterValue, overrideOptions?: FilterValue['options']): boolean {
  const options = { ...filter.options, ...overrideOptions };
  const conditions = filter.conditions ?? [];
  if (conditions.length === 0) return true;
  return filter.combinator === 'or'
    ? conditions.some((c) => evaluateCondition(c, options))
    : conditions.every((c) => evaluateCondition(c, options));
}

export const filterProperty = (name = 'conditions', displayName = 'Conditions'): INodeProperties => ({
  displayName,
  name,
  type: 'filter',
  default: { options: { caseSensitive: true, typeValidation: 'strict' }, conditions: [], combinator: 'and' },
});

export const looseTypeValidationProperty: INodeProperties = {
  displayName: 'Convert types where required',
  name: 'looseTypeValidation',
  type: 'boolean',
  default: false,
  description: 'Compare values of different types by converting them (e.g. "10" equals 10)',
};
