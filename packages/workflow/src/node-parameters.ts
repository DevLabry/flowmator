import type { INodeParameters, INodeProperties, NodeParameterValue } from './types';

const getPath = (params: INodeParameters, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as INodeParameters)[key] : undefined), params);

/**
 * Evaluates `displayOptions` for a property. Keys may start with "/" to reference root parameters
 * from inside a collection; `@version` checks the node type version.
 */
export function getParameterDisplayed(
  property: INodeProperties,
  nodeValues: INodeParameters,
  rootValues: INodeParameters = nodeValues,
  typeVersion?: number,
): boolean {
  const opts = property.displayOptions;
  if (!opts) return true;
  const valueOf = (key: string): unknown => {
    if (key === '@version') return typeVersion;
    return key.startsWith('/') ? getPath(rootValues, key.slice(1)) : getPath(nodeValues, key);
  };
  const matches = (key: string, allowed: NodeParameterValue[]) => {
    const v = valueOf(key);
    const values = Array.isArray(v) ? v : [v];
    return allowed.some((a) => {
      if (a && typeof a === 'object' && '_cnd' in (a as object)) return checkCondition((a as any)._cnd, v);
      return values.includes(a as never);
    });
  };
  if (opts.show) for (const [k, allowed] of Object.entries(opts.show)) if (!matches(k, allowed)) return false;
  if (opts.hide) for (const [k, allowed] of Object.entries(opts.hide)) if (matches(k, allowed)) return false;
  return true;
}

function checkCondition(cnd: Record<string, unknown>, value: unknown): boolean {
  const [op, expected] = Object.entries(cnd)[0] ?? [];
  const n = Number(value);
  switch (op) {
    case 'eq':
      return value === expected;
    case 'not':
      return value !== expected;
    case 'gte':
      return n >= Number(expected);
    case 'lte':
      return n <= Number(expected);
    case 'gt':
      return n > Number(expected);
    case 'lt':
      return n < Number(expected);
    case 'startsWith':
      return String(value).startsWith(String(expected));
    case 'includes':
      return String(value).includes(String(expected));
    case 'exists':
      return value !== undefined;
    default:
      return false;
  }
}

/**
 * Returns the node parameters with defaults filled in for every displayed top-level property.
 * Values the user set are kept as-is; hidden properties are dropped.
 */
export function getNodeParametersWithDefaults(
  properties: INodeProperties[],
  values: INodeParameters,
  typeVersion?: number,
): INodeParameters {
  const result: INodeParameters = {};
  // Two passes so that displayOptions depending on defaults of earlier params resolve correctly
  const merged: INodeParameters = { ...values };
  for (const prop of properties) {
    if (merged[prop.name] === undefined && prop.type !== 'notice') merged[prop.name] = structuredClone(prop.default) as never;
  }
  for (const prop of properties) {
    if (prop.type === 'notice' || prop.type === 'button') continue;
    if (!getParameterDisplayed(prop, merged, merged, typeVersion)) continue;
    if (result[prop.name] !== undefined) continue; // same name defined twice with different displayOptions
    result[prop.name] = merged[prop.name];
  }
  return result;
}
