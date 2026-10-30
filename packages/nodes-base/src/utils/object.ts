import type { IDataObject } from '@flowmator/workflow';

/** Splits "a.b[0].c" into ["a", "b", "0", "c"]. */
export function toPath(path: string): string[] {
  return path
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .filter((p) => p !== '');
}

export function getValue(obj: unknown, path: string, dotNotation = true): unknown {
  if (!dotNotation) return (obj as IDataObject)?.[path];
  return toPath(path).reduce<unknown>((acc, key) => (acc !== null && acc !== undefined ? (acc as IDataObject)[key] : undefined), obj);
}

export function setValue(obj: IDataObject, path: string, value: unknown, dotNotation = true): void {
  if (!dotNotation) {
    obj[path] = value as never;
    return;
  }
  const keys = toPath(path);
  let cur: IDataObject = obj;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) {
      cur[key] = value as never;
      return;
    }
    if (cur[key] === null || typeof cur[key] !== 'object') cur[key] = (/^\d+$/.test(keys[i + 1]) ? [] : {}) as never;
    cur = cur[key] as IDataObject;
  });
}

export function unsetValue(obj: IDataObject, path: string, dotNotation = true): void {
  if (!dotNotation) {
    delete obj[path];
    return;
  }
  const keys = toPath(path);
  const last = keys.pop()!;
  const parent = keys.length ? getValue(obj, keys.join('.')) : obj;
  if (parent && typeof parent === 'object') delete (parent as IDataObject)[last];
}

export const deepCopy = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

export const isEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Field list from a comma separated string or array param. */
export function fieldList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Item emitted for a failed input item when the node continues on fail. `error` lets the engine route it to the error output. */
export function errorItem(error: unknown, itemIndex: number, input?: { json: IDataObject }): { json: IDataObject; error: { message: string }; pairedItem: { item: number } } {
  // errors thrown inside the Code node's vm context are not `instanceof Error` here
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  return { json: { ...(input?.json ?? {}), error: message }, error: { message }, pairedItem: { item: itemIndex } };
}
