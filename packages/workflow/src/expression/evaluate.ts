import { DateTime } from 'luxon';
import { ExpressionError } from '../errors';
import { extend } from './extensions';
import { splitTemplate } from './template';
import { transformExtensions } from './transform';

export const isExpression = (value: unknown): value is string => typeof value === 'string' && value.startsWith('=');

/**
 * Globals hidden from expressions. This is not a security sandbox (Flowmator is single-user),
 * it just keeps expressions from accidentally touching the host process.
 */
const SHADOWED_GLOBALS = ['process', 'require', 'module', 'exports', 'global', 'globalThis', 'window', 'document', 'eval', 'Function', 'setTimeout', 'setInterval', 'fetch'];

type Compiled = (ctx: Record<string, unknown>, ext: typeof extend) => unknown;
const cache = new Map<string, Compiled>();

function compile(code: string): Compiled {
  let fn = cache.get(code);
  if (fn) return fn;
  const transformed = transformExtensions(code);
  try {
    // Sloppy-mode function so `with` can expose the context variables as plain identifiers.
    fn = new Function('__ctx', '__ext', `with (__ctx) { return (${transformed}\n); }`) as Compiled;
  } catch (error) {
    throw new ExpressionError(`Invalid syntax: ${(error as Error).message}`, { description: code.trim(), cause: error });
  }
  if (cache.size > 5000) cache.clear();
  cache.set(code, fn);
  return fn;
}

export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (DateTime.isDateTime(value)) return value.toISO() ?? '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function runCode(code: string, context: Record<string, unknown>): unknown {
  const fn = compile(code);
  const scope: Record<string, unknown> = Object.create(null);
  for (const g of SHADOWED_GLOBALS) scope[g] = undefined;
  Object.assign(scope, context);
  try {
    return fn(scope, extend);
  } catch (error) {
    if (error instanceof ExpressionError) throw error;
    throw new ExpressionError((error as Error).message ?? String(error), { cause: error });
  }
}

/**
 * Evaluates a parameter value that starts with "=".
 * A value that is exactly one `{{ }}` block returns the raw result (object, number...),
 * anything mixed with text is rendered as a string.
 */
export function evaluateExpression(expression: string, context: Record<string, unknown>): unknown {
  const template = expression.startsWith('=') ? expression.slice(1) : expression;
  const chunks = splitTemplate(template);
  if (!chunks.some((c) => c.kind === 'code')) return template;
  if (chunks.length === 1) {
    const value = runCode(chunks[0].value, context);
    return normalizeResult(value);
  }
  return chunks.map((c) => (c.kind === 'text' ? c.value : stringifyValue(runCode(c.value, context)))).join('');
}

function normalizeResult(value: unknown): unknown {
  if (DateTime.isDateTime(value)) return value.toISO();
  if (typeof value === 'function') throw new ExpressionError('Expression resolved to a function, call it with ()');
  if (typeof value === 'number' && Number.isNaN(value)) return NaN;
  return value;
}

/** Resolves expressions anywhere inside a (possibly nested) parameter value. */
export function resolveParameterValue(value: unknown, evaluate: (expression: string) => unknown): unknown {
  if (isExpression(value)) return evaluate(value);
  if (Array.isArray(value)) return value.map((v) => resolveParameterValue(v, evaluate));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveParameterValue(v, evaluate);
    return out;
  }
  return value;
}
