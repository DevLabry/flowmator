import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { evaluateExpression, splitTemplate } from '../src';

const ctx = (json: object = {}) => ({ $json: json, DateTime, $now: DateTime.now() });

describe('template parsing', () => {
  it('splits text and code, respecting braces and strings inside code', () => {
    expect(splitTemplate('a {{ {x: 1}.x }} b {{ "}}" }}')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'code', value: ' {x: 1}.x ' },
      { kind: 'text', value: ' b ' },
      { kind: 'code', value: ' "}}" ' },
    ]);
  });

  it('handles template literals with nested ${}', () => {
    expect(splitTemplate('{{ `a${ {b: 1}.b }c` }}')).toEqual([{ kind: 'code', value: ' `a${ {b: 1}.b }c` ' }]);
  });
});

describe('evaluateExpression', () => {
  it('returns raw values for a single block and strings when mixed', () => {
    expect(evaluateExpression('={{ $json.list }}', ctx({ list: [1, 2] }))).toEqual([1, 2]);
    expect(evaluateExpression('=n: {{ $json.n + 1 }}', ctx({ n: 1 }))).toBe('n: 2');
    expect(evaluateExpression('=obj: {{ $json }}', ctx({ a: 1 }))).toBe('obj: {"a":1}');
    expect(evaluateExpression('=plain text', ctx())).toBe('plain text');
  });

  it('supports data transformation helpers', () => {
    expect(evaluateExpression('={{ "Hello World".toSnakeCase() }}', ctx())).toBe('hello_world');
    expect(evaluateExpression('={{ $json.a.sum() }}', ctx({ a: [1, 2, 3] }))).toBe(6);
    expect(evaluateExpression('={{ $json.a.includes(2) }}', ctx({ a: [1, 2, 3] }))).toBe(true);
    expect(evaluateExpression('={{ $json.e.extractDomain() }}', ctx({ e: 'me@example.com' }))).toBe('example.com');
    expect(evaluateExpression('={{ $json.o.isEmpty() }}', ctx({ o: {} }))).toBe(true);
    expect(evaluateExpression('={{ "2024-01-15".toDateTime().plus({ days: 1 }).toFormat("yyyy-MM-dd") }}', ctx())).toBe('2024-01-16');
    expect(evaluateExpression('={{ (1.256).round(2) }}', ctx())).toBe(1.26);
    expect(evaluateExpression('={{ $json.x?.isEmpty() }}', ctx({}))).toBeUndefined();
  });

  it('hides host globals', () => {
    expect(evaluateExpression('={{ typeof process }}', ctx())).toBe('undefined');
    expect(evaluateExpression('={{ typeof require }}', ctx())).toBe('undefined');
  });

  it('reports syntax errors as ExpressionError', () => {
    expect(() => evaluateExpression('={{ $json. }}', ctx())).toThrow(/Invalid syntax/);
  });
});
