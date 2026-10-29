import type { IDataObject, IExecuteFunctions, INodeProperties, INodeType } from '@8n8/workflow';
import { apiRequest, collectPages, forEachItem, forOp, jsonParam, listLimit, operationProp, returnAllProps } from '../../utils/api';

const API = 'https://api.notion.com/v1';

/** Accepts a Notion id or any Notion URL and returns the dashed UUID. */
export function notionId(v: string): string {
  const hex = String(v).replace(/-/g, '').match(/[0-9a-f]{32}(?![0-9a-f])/i)?.[0];
  if (!hex) throw new Error(`"${v}" is not a Notion ID or URL`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
}

const PROPERTY_TYPES = ['title', 'rich_text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'email', 'phone_number', 'relation', 'people'];

type PropertyInput = { key: string; type: string; value: unknown; endDate?: string };

const text = (s: unknown) => [{ type: 'text', text: { content: String(s ?? '') } }];
const csv = (v: unknown) => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean));

/** Simple name/type/value rows → Notion property values. */
export function toNotionProperties(rows: PropertyInput[]): IDataObject {
  const out: IDataObject = {};
  for (const r of rows) {
    if (!r.key) continue;
    const v = r.value;
    switch (r.type) {
      case 'title':
      case 'rich_text':
        out[r.key] = { [r.type]: text(v) };
        break;
      case 'number':
        out[r.key] = { number: v === '' || v === null || v === undefined ? null : Number(v) };
        break;
      case 'select':
      case 'status':
        out[r.key] = { [r.type]: v ? { name: String(v) } : null };
        break;
      case 'multi_select':
        out[r.key] = { multi_select: csv(v).map((name) => ({ name })) };
        break;
      case 'date':
        out[r.key] = { date: v ? { start: String(v), ...(r.endDate ? { end: r.endDate } : {}) } : null };
        break;
      case 'checkbox':
        out[r.key] = { checkbox: v === true || String(v).toLowerCase() === 'true' };
        break;
      case 'relation':
      case 'people':
        out[r.key] = { [r.type]: csv(v).map((id) => ({ id: notionId(id) })) };
        break;
      default:
        out[r.key] = { [r.type]: v === '' ? null : v };
    }
  }
  return out;
}

const plainText = (rich: unknown) => ((rich as Array<{ plain_text?: string }>) ?? []).map((t) => t.plain_text ?? '').join('');

/** Notion property value → plain value (for "Simplify"). */
function simpleValue(p: IDataObject): unknown {
  const v = p[p.type as string] as unknown;
  switch (p.type) {
    case 'title':
    case 'rich_text':
      return plainText(v);
    case 'select':
    case 'status':
      return (v as IDataObject | null)?.name ?? null;
    case 'multi_select':
      return ((v as IDataObject[]) ?? []).map((o) => o.name);
    case 'date':
      return v ? ((v as IDataObject).end ? { start: (v as IDataObject).start, end: (v as IDataObject).end } : (v as IDataObject).start) : null;
    case 'relation':
    case 'people':
      return ((v as IDataObject[]) ?? []).map((o) => o.id);
    case 'formula':
      return (v as IDataObject)?.[(v as IDataObject)?.type as string] ?? null;
    case 'rollup':
      return (v as IDataObject)?.[(v as IDataObject)?.type as string] ?? null;
    case 'files':
      return ((v as IDataObject[]) ?? []).map((f) => ((f.file ?? f.external) as IDataObject)?.url);
    case 'created_by':
    case 'last_edited_by':
      return (v as IDataObject)?.id;
    default:
      return v ?? null;
  }
}

export function simplifyPage(page: IDataObject): IDataObject {
  const props = (page.properties ?? {}) as Record<string, IDataObject>;
  const out: IDataObject = { id: page.id, url: page.url, created_time: page.created_time, last_edited_time: page.last_edited_time };
  for (const [name, p] of Object.entries(props)) out[name] = simpleValue(p) as never;
  return out;
}

const propertiesUi: INodeProperties = {
  displayName: 'Properties',
  name: 'propertiesUi',
  type: 'fixedCollection',
  typeOptions: { multipleValues: true },
  default: {},
  options: [
    {
      name: 'propertyValues',
      displayName: 'Property',
      values: [
        { displayName: 'Property Name', name: 'key', type: 'string', default: '', description: 'Exactly as in the database' },
        { displayName: 'Type', name: 'type', type: 'options', default: 'rich_text', options: PROPERTY_TYPES.map((t) => ({ name: t, value: t })) },
        { displayName: 'Value', name: 'value', type: 'string', default: '', hint: 'Comma separated for multi_select, relation and people; ISO date for date' },
        { displayName: 'End Date', name: 'endDate', type: 'string', default: '', displayOptions: { show: { type: ['date'] } } },
      ],
    },
  ],
};

const simplifyProp: INodeProperties = { displayName: 'Simplify', name: 'simple', type: 'boolean', default: true, description: 'Return property values as plain fields' };

export const Notion: INodeType = {
  description: {
    name: '8n8.notion',
    displayName: 'Notion',
    description: 'Read and write Notion databases, pages and blocks',
    group: ['output'],
    version: [2, 2.1, 2.2],
    defaults: { name: 'Notion', color: '#000000' },
    icon: 'fa:notion',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'notionApi', required: true }],
    codex: { categories: ['Productivity'] },
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'databasePage',
        options: [
          { name: 'Database Page', value: 'databasePage' },
          { name: 'Page', value: 'page' },
          { name: 'Database', value: 'database' },
          { name: 'Block', value: 'block' },
        ],
      },
      operationProp('databasePage', [{ name: 'Create', value: 'create' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }, { name: 'Update', value: 'update' }]),
      operationProp('page', [{ name: 'Create', value: 'create' }, { name: 'Get', value: 'get' }, { name: 'Archive', value: 'archive' }, { name: 'Search', value: 'search' }]),
      operationProp('database', [{ name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }]),
      operationProp('block', [{ name: 'Append', value: 'append' }, { name: 'Get Child Blocks', value: 'getAll' }]),

      ...forOp('databasePage', ['create', 'getAll'], [{ displayName: 'Database (ID or URL)', name: 'databaseId', type: 'string', default: '', required: true }]),
      ...forOp('database', 'get', [{ displayName: 'Database (ID or URL)', name: 'databaseId', type: 'string', default: '', required: true }]),
      ...forOp('databasePage', ['get', 'update'], [{ displayName: 'Page (ID or URL)', name: 'pageId', type: 'string', default: '', required: true }]),
      ...forOp('page', ['get', 'archive'], [{ displayName: 'Page (ID or URL)', name: 'pageId', type: 'string', default: '', required: true }]),
      ...forOp('databasePage', ['create', 'update'], [propertiesUi]),
      ...forOp('databasePage', ['create', 'get', 'getAll', 'update'], [simplifyProp]),
      ...forOp('databasePage', 'getAll', [
        { displayName: 'Filter (JSON)', name: 'filterJson', type: 'json', default: '', hint: 'Notion filter object, e.g. {"property": "Status", "status": {"equals": "Done"}}' },
        { displayName: 'Sorts (JSON)', name: 'sortsJson', type: 'json', default: '', hint: 'e.g. [{"property": "Created", "direction": "descending"}]' },
        ...returnAllProps({ resource: ['databasePage'], operation: ['getAll'] }),
      ]),
      ...forOp('page', 'create', [
        { displayName: 'Parent Page (ID or URL)', name: 'pageId', type: 'string', default: '', required: true },
        { displayName: 'Title', name: 'title', type: 'string', default: '', required: true },
      ]),
      ...forOp('page', 'search', [
        { displayName: 'Search Text', name: 'text', type: 'string', default: '' },
        ...returnAllProps({ resource: ['page'], operation: ['search'] }),
      ]),
      ...forOp('page', ['get', 'search'], [simplifyProp]),
      ...forOp('database', 'getAll', returnAllProps({ resource: ['database'], operation: ['getAll'] })),
      ...forOp('block', ['append', 'getAll'], [{ displayName: 'Block or Page (ID or URL)', name: 'blockId', type: 'string', default: '', required: true }]),
      ...forOp('block', 'getAll', returnAllProps({ resource: ['block'], operation: ['getAll'] })),
      ...forOp('databasePage', 'create', [{ displayName: 'Content (one paragraph per line)', name: 'content', type: 'string', typeOptions: { rows: 3 }, default: '' }]),
      ...forOp('page', 'create', [{ displayName: 'Content (one paragraph per line)', name: 'content', type: 'string', typeOptions: { rows: 3 }, default: '' }]),
      ...forOp('block', 'append', [
        {
          displayName: 'Blocks',
          name: 'blockUi',
          type: 'fixedCollection',
          typeOptions: { multipleValues: true },
          default: {},
          options: [
            {
              name: 'blockValues',
              displayName: 'Block',
              values: [
                { displayName: 'Type', name: 'type', type: 'options', default: 'paragraph', options: ['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'code', 'divider'].map((t) => ({ name: t, value: t })) },
                { displayName: 'Text', name: 'text', type: 'string', default: '' },
                { displayName: 'Checked', name: 'checked', type: 'boolean', default: false, displayOptions: { show: { type: ['to_do'] } } },
              ],
            },
          ],
        },
      ]),
    ],
  },
  async execute(this: IExecuteFunctions) {
    return [
      await forEachItem(this, async (i) => {
        const resource = this.getNodeParameter('resource', i) as string;
        const op = this.getNodeParameter('operation', i) as string;
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: IDataObject, qs?: IDataObject) =>
          apiRequest<IDataObject>(this, 'notionApi', { url: `${API}${path}`, method, ...(body ? { body } : {}), ...(qs ? { qs } : {}) }, i);
        const paged = (fetch: (cursor: string | undefined, size: number) => Promise<IDataObject>) =>
          collectPages(async (cursor, size) => {
            const r = await fetch(cursor, size);
            return { items: r.results as IDataObject[], next: r.has_more ? (r.next_cursor as string) : null };
          }, listLimit(this, i), 100);
        const props = () => toNotionProperties((p<IDataObject>('propertiesUi', {}).propertyValues as PropertyInput[]) ?? []);
        const paragraphs = (content: string) =>
          content.split('\n').filter((l) => l.trim()).map((l) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: text(l) } }));
        const shape = (page: IDataObject) => (p('simple', true) ? simplifyPage(page) : page);

        if (resource === 'databasePage') {
          if (op === 'create') {
            const children = paragraphs(p('content', ''));
            return shape(await call('POST', '/pages', { parent: { database_id: notionId(p('databaseId')) }, properties: props(), ...(children.length ? { children } : {}) }));
          }
          if (op === 'get') return shape(await call('GET', `/pages/${notionId(p('pageId'))}`));
          if (op === 'update') return shape(await call('PATCH', `/pages/${notionId(p('pageId'))}`, { properties: props() }));
          const filter = jsonParam(p('filterJson', ''), 'Filter');
          const sortsRaw = p<unknown>('sortsJson', '');
          const sorts = typeof sortsRaw === 'string' ? (sortsRaw.trim() ? JSON.parse(sortsRaw) : undefined) : sortsRaw;
          const pages = await paged((cursor, size) =>
            call('POST', `/databases/${notionId(p('databaseId'))}/query`, { page_size: size, ...(cursor ? { start_cursor: cursor } : {}), ...(Object.keys(filter).length ? { filter } : {}), ...(sorts ? { sorts } : {}) }),
          );
          return pages.map(shape);
        }

        if (resource === 'page') {
          if (op === 'create') {
            const children = paragraphs(p('content', ''));
            return call('POST', '/pages', { parent: { page_id: notionId(p('pageId')) }, properties: { title: { title: text(p('title')) } }, ...(children.length ? { children } : {}) });
          }
          if (op === 'get') return shape(await call('GET', `/pages/${notionId(p('pageId'))}`));
          if (op === 'archive') return call('PATCH', `/pages/${notionId(p('pageId'))}`, { archived: true });
          const found = await paged((cursor, size) => call('POST', '/search', { query: p('text', ''), filter: { property: 'object', value: 'page' }, page_size: size, ...(cursor ? { start_cursor: cursor } : {}) }));
          return found.map(shape);
        }

        if (resource === 'database') {
          if (op === 'get') return call('GET', `/databases/${notionId(p('databaseId'))}`);
          const dbs = await paged((cursor, size) => call('POST', '/search', { filter: { property: 'object', value: 'database' }, page_size: size, ...(cursor ? { start_cursor: cursor } : {}) }));
          return dbs.map((d) => ({ id: d.id, title: plainText(d.title), url: d.url, properties: Object.keys((d.properties as object) ?? {}) }) as IDataObject);
        }

        // block
        const blockId = notionId(p('blockId'));
        if (op === 'getAll') return paged((cursor, size) => call('GET', `/blocks/${blockId}/children`, undefined, { page_size: size, ...(cursor ? { start_cursor: cursor } : {}) }));
        const blocks = ((p<IDataObject>('blockUi', {}).blockValues as Array<{ type: string; text: string; checked?: boolean }>) ?? []).map((b) =>
          b.type === 'divider'
            ? { object: 'block', type: 'divider', divider: {} }
            : { object: 'block', type: b.type, [b.type]: { rich_text: text(b.text), ...(b.type === 'to_do' ? { checked: !!b.checked } : {}), ...(b.type === 'code' ? { language: 'plain text' } : {}) } },
        );
        return call('PATCH', `/blocks/${blockId}/children`, { children: blocks });
      }),
    ];
  },
};
