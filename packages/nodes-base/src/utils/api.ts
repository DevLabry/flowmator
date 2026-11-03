import type { IDataObject, IExecuteFunctions, IHelpers, IHttpRequestOptions, INodeExecutionData, INodeProperties, NodeParameterValue } from '@flowmator/workflow';
import { NodeOperationError } from '@flowmator/workflow';
import { errorItem } from './object';

type Ctx = { helpers: IHelpers };

/** Authenticated JSON request using the credential type the node's "authentication" parameter selects. */
export function apiRequest<T = any>(ctx: Ctx, credentialType: string, options: IHttpRequestOptions, itemIndex = 0): Promise<T> {
  return ctx.helpers.httpRequestWithAuthentication(credentialType, { json: true, ...options, headers: { 'User-Agent': 'flowmator', ...(options.headers ?? {}) } }, itemIndex);
}

/** "Return All" / "Limit" parameters shared by every list operation. */
export const returnAllProps = (show: Record<string, NodeParameterValue[]>): INodeProperties[] => [
  { displayName: 'Return All', name: 'returnAll', type: 'boolean', default: false, displayOptions: { show } },
  { displayName: 'Limit', name: 'limit', type: 'number', default: 50, typeOptions: { minValue: 1 }, displayOptions: { show: { ...show, returnAll: [false] } } },
];

/** Collects pages from `fetchPage` until there is no next cursor or the limit is reached. */
export async function collectPages<T>(
  fetchPage: (cursor: string | undefined, pageSize: number) => Promise<{ items: T[]; next?: string | null }>,
  limit: number | undefined,
  pageSize = 100,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const size = limit ? Math.min(pageSize, limit - out.length) : pageSize;
    const page = await fetchPage(cursor, size);
    out.push(...page.items);
    cursor = page.next || undefined;
  } while (cursor && (!limit || out.length < limit));
  return limit ? out.slice(0, limit) : out;
}

export function listLimit(ctx: Pick<IExecuteFunctions, 'getNodeParameter'>, i: number): number | undefined {
  return ctx.getNodeParameter('returnAll', i, false) ? undefined : Number(ctx.getNodeParameter('limit', i, 50));
}

/** Runs `op` for each item with continue-on-fail; results that are arrays become several items. */
export async function forEachItem(ctx: IExecuteFunctions, op: (i: number, item: INodeExecutionData) => Promise<IDataObject | IDataObject[] | INodeExecutionData | INodeExecutionData[]>) {
  const out: INodeExecutionData[] = [];
  const items = ctx.getInputData();
  for (let i = 0; i < items.length; i++) {
    try {
      const r = await op(i, items[i]);
      for (const entry of Array.isArray(r) ? r : [r]) {
        const isItem = entry && typeof entry === 'object' && 'json' in entry && typeof (entry as INodeExecutionData).json === 'object';
        out.push(isItem ? { ...(entry as INodeExecutionData), pairedItem: { item: i } } : { json: entry as IDataObject, pairedItem: { item: i } });
      }
    } catch (e) {
      if (ctx.continueOnFail()) out.push(errorItem(e, i));
      else throw e instanceof NodeOperationError ? e : new NodeOperationError(ctx.getNode(), e as Error, { itemIndex: i });
    }
  }
  return out;
}

/** Parameters for a resource/operation pair, shown only for that operation. */
export const forOp = (resource: string, operation: string | string[], props: INodeProperties[]): INodeProperties[] =>
  props.map((p) => ({ ...p, displayOptions: { show: { resource: [resource], operation: Array.isArray(operation) ? operation : [operation], ...(p.displayOptions?.show ?? {}) }, ...(p.displayOptions?.hide ? { hide: p.displayOptions.hide } : {}) } }));

export const operationProp = (resource: string, options: Array<{ name: string; value: string; description?: string }>, def = options[0].value): INodeProperties => ({
  displayName: 'Operation',
  name: 'operation',
  type: 'options',
  noDataExpression: true,
  default: def,
  displayOptions: { show: { resource: [resource] } },
  options: options.map((o) => ({ ...o, action: o.name })),
});

/** JSON parameters may arrive as strings or already-parsed objects. */
export function jsonParam(value: unknown, what: string): IDataObject {
  if (value && typeof value === 'object') return value as IDataObject;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

/** "Poll Times" for polling triggers (turned into cron schedules by the server). */
export const pollTimesProp: INodeProperties = {
  displayName: 'Poll Times',
  name: 'pollTimes',
  type: 'fixedCollection',
  typeOptions: { multipleValues: true },
  default: { item: [{ mode: 'everyMinute' }] },
  options: [
    {
      name: 'item',
      displayName: 'Item',
      values: [
        { displayName: 'Mode', name: 'mode', type: 'options', default: 'everyMinute',
          options: [{ name: 'Every Minute', value: 'everyMinute' }, { name: 'Every Hour', value: 'everyHour' }, { name: 'Every X', value: 'everyX' }, { name: 'Custom (Cron)', value: 'custom' }] },
        { displayName: 'Value', name: 'value', type: 'number', default: 5, displayOptions: { show: { mode: ['everyX'] } } },
        { displayName: 'Unit', name: 'unit', type: 'options', default: 'minutes', displayOptions: { show: { mode: ['everyX'] } }, options: [{ name: 'Minutes', value: 'minutes' }, { name: 'Hours', value: 'hours' }] },
        { displayName: 'Cron Expression', name: 'cronExpression', type: 'string', default: '*/5 * * * *', displayOptions: { show: { mode: ['custom'] } } },
      ],
    },
  ],
};
