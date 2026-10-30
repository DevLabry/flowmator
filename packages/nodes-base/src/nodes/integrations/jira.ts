import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ICredentialType, IDataObject, IExecuteFunctions, IHookFunctions, ILoadOptionsFunctions, INodeProperties, INodeType, IWebhookFunctions, IWebhookResult } from '@8n8/workflow';
import { apiRequest, collectPages, forEachItem, forOp, jsonParam, listLimit, operationProp, returnAllProps } from '../../utils/api';

type Version = 'cloud' | 'server' | 'serverPat';
const CREDENTIAL: Record<Version, string> = { cloud: 'jiraSoftwareCloudApi', server: 'jiraSoftwareServerApi', serverPat: 'jiraSoftwareServerPatApi' };

/** Plain text → Atlassian Document Format (Cloud's v3 API wants ADF for descriptions and comments). */
export function textToAdf(text: string): IDataObject {
  const paragraphs = String(text ?? '').split(/\n{2,}/).filter((p) => p.length);
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((para) => ({
      type: 'paragraph',
      content: para.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]),
    })),
  };
}

/** ADF → plain text (for reading descriptions and comments back). */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  const n = node as IDataObject;
  if (n.type === 'text') return String(n.text ?? '');
  if (n.type === 'hardBreak') return '\n';
  const inner = ((n.content as unknown[]) ?? []).map(adfToText).join('');
  return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(String(n.type)) ? `${inner}\n` : inner;
}

type Ctx = { helpers: IExecuteFunctions['helpers']; getCredentials: IExecuteFunctions['getCredentials']; getNodeParameter: IExecuteFunctions['getNodeParameter'] };

async function jira(ctx: Ctx, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, qs?: IDataObject, i = 0, extra: { headers?: Record<string, string>; json?: boolean; encoding?: 'arraybuffer' } = {}) {
  const version = ctx.getNodeParameter('jiraVersion', i, 'cloud') as Version;
  const { domain } = await ctx.getCredentials<{ domain: string }>(CREDENTIAL[version]);
  const api = version === 'cloud' ? '/rest/api/3' : '/rest/api/2';
  const url = path.startsWith('http') ? path : `${String(domain).replace(/\/+$/, '')}${path.startsWith('/rest/') ? '' : api}${path}`;
  try {
    return await apiRequest(ctx, CREDENTIAL[version], { url, method, ...(body !== undefined ? { body } : {}), ...(qs ? { qs } : {}), ...extra }, i);
  } catch (e) {
    const b = (e as { body?: { errorMessages?: string[]; errors?: Record<string, string> } }).body;
    const messages = [...(b?.errorMessages ?? []), ...Object.entries(b?.errors ?? {}).map(([k, v]) => `${k}: ${v}`)];
    if (messages.length) throw new Error(`Jira error: ${messages.join('; ')}`);
    throw e;
  }
}

const isCloud = (ctx: Ctx, i: number) => ctx.getNodeParameter('jiraVersion', i, 'cloud') === 'cloud';
const richText = (ctx: Ctx, i: number, text: string) => (isCloud(ctx, i) ? textToAdf(text) : text);
const userRef = (ctx: Ctx, i: number, id: string) => (isCloud(ctx, i) ? { accountId: id } : { name: id });

const issueKey: INodeProperties = { displayName: 'Issue Key', name: 'issueKey', type: 'string', default: '', required: true, placeholder: 'PROJ-123' };

const issueFields = (name: string, displayName: string): INodeProperties => ({
  displayName,
  name,
  type: 'collection',
  default: {},
  options: [
    { displayName: 'Assignee', name: 'assignee', type: 'options', default: '', typeOptions: { loadOptionsMethod: 'getUsers' } },
    { displayName: 'Description', name: 'description', type: 'string', typeOptions: { rows: 4 }, default: '' },
    { displayName: 'Due Date', name: 'duedate', type: 'dateTime', default: '' },
    { displayName: 'Labels', name: 'labels', type: 'string', default: '', description: 'Comma separated' },
    { displayName: 'Parent Issue Key', name: 'parentIssueKey', type: 'string', default: '' },
    { displayName: 'Priority', name: 'priority', type: 'options', default: '', typeOptions: { loadOptionsMethod: 'getPriorities' } },
    { displayName: 'Reporter', name: 'reporter', type: 'options', default: '', typeOptions: { loadOptionsMethod: 'getUsers' } },
    ...(name === 'updateFields'
      ? [
          { displayName: 'Status (Transition)', name: 'statusId', type: 'options' as const, default: '', typeOptions: { loadOptionsMethod: 'getTransitions' }, description: 'Moves the issue through the transition with this ID' },
          { displayName: 'Summary', name: 'summary', type: 'string' as const, default: '' },
          { displayName: 'Issue Type', name: 'issueType', type: 'string' as const, default: '' },
        ]
      : []),
    {
      displayName: 'Custom Fields',
      name: 'customFieldsUi',
      type: 'fixedCollection',
      typeOptions: { multipleValues: true },
      default: {},
      options: [{ name: 'customFieldsValues', displayName: 'Custom Field', values: [{ displayName: 'Field ID', name: 'fieldId', type: 'string', default: '', placeholder: 'customfield_10011' }, { displayName: 'Value', name: 'fieldValue', type: 'string', default: '', description: 'JSON values (objects, arrays, numbers) are parsed' }] }],
    },
  ],
});

const properties: INodeProperties[] = [
  { displayName: 'Jira Version', name: 'jiraVersion', type: 'options', default: 'cloud', options: [{ name: 'Cloud', value: 'cloud' }, { name: 'Server (Self Hosted)', value: 'server' }, { name: 'Server (Personal Access Token)', value: 'serverPat' }] },
  { displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true, default: 'issue', options: [{ name: 'Issue', value: 'issue' }, { name: 'Issue Attachment', value: 'issueAttachment' }, { name: 'Issue Comment', value: 'issueComment' }, { name: 'User', value: 'user' }] },
  operationProp('issue', [
    { name: 'Changelog', value: 'changelog', description: 'Get the history of an issue' },
    { name: 'Create', value: 'create' },
    { name: 'Delete', value: 'delete' },
    { name: 'Get', value: 'get' },
    { name: 'Get Many', value: 'getAll' },
    { name: 'Notify', value: 'notify', description: 'Send an email notification about an issue' },
    { name: 'Status', value: 'transitions', description: 'List the transitions available for an issue' },
    { name: 'Update', value: 'update' },
  ]),
  operationProp('issueAttachment', [{ name: 'Add', value: 'add' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }, { name: 'Remove', value: 'remove' }]),
  operationProp('issueComment', [{ name: 'Add', value: 'add' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }, { name: 'Remove', value: 'remove' }, { name: 'Update', value: 'update' }]),
  operationProp('user', [{ name: 'Get', value: 'get' }, { name: 'Search', value: 'search' }]),

  /* issue */
  ...forOp('issue', 'create', [
    { displayName: 'Project', name: 'project', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'getProjects' } },
    { displayName: 'Issue Type', name: 'issueType', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'getIssueTypes', loadOptionsDependsOn: ['project'] } },
    { displayName: 'Summary', name: 'summary', type: 'string', default: '', required: true },
    issueFields('additionalFields', 'Additional Fields'),
  ]),
  ...forOp('issue', ['update', 'get', 'delete', 'changelog', 'notify', 'transitions'], [issueKey]),
  ...forOp('issue', 'update', [issueFields('updateFields', 'Update Fields')]),
  ...forOp('issue', 'delete', [{ displayName: 'Delete Subtasks', name: 'deleteSubtasks', type: 'boolean', default: false }]),
  ...forOp('issue', 'get', [{
    displayName: 'Additional Fields',
    name: 'additionalFields',
    type: 'collection',
    default: {},
    options: [
      { displayName: 'Expand', name: 'expand', type: 'string', default: '', placeholder: 'renderedFields,changelog' },
      { displayName: 'Fields', name: 'fields', type: 'string', default: '', placeholder: 'summary,status,assignee', description: 'Comma separated; *all or *navigable work too' },
      { displayName: 'Simplify', name: 'simplify', type: 'boolean', default: false, description: 'Flatten the fields and turn the description into plain text' },
    ],
  }]),
  ...forOp('issue', ['getAll', 'changelog'], returnAllProps({ resource: ['issue'], operation: ['getAll', 'changelog'] })),
  ...forOp('issue', 'getAll', [{
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    options: [
      { displayName: 'JQL', name: 'jql', type: 'string', default: '', placeholder: 'project = PROJ AND status = "In Progress" ORDER BY created DESC' },
      { displayName: 'Fields', name: 'fields', type: 'string', default: '*navigable' },
      { displayName: 'Expand', name: 'expand', type: 'string', default: '' },
    ],
  }]),
  ...forOp('issue', 'notify', [
    { displayName: 'Subject', name: 'subject', type: 'string', default: '' },
    { displayName: 'Text Body', name: 'textBody', type: 'string', typeOptions: { rows: 3 }, default: '' },
    { displayName: 'HTML Body', name: 'htmlBody', type: 'string', typeOptions: { rows: 3 }, default: '' },
    {
      displayName: 'Recipients',
      name: 'notificationRecipients',
      type: 'collection',
      default: { reporter: true },
      options: [
        { displayName: 'Assignee', name: 'assignee', type: 'boolean', default: false },
        { displayName: 'Reporter', name: 'reporter', type: 'boolean', default: false },
        { displayName: 'Voters', name: 'voters', type: 'boolean', default: false },
        { displayName: 'Watchers', name: 'watchers', type: 'boolean', default: false },
        { displayName: 'User IDs', name: 'users', type: 'string', default: '', description: 'Comma separated account IDs (Cloud) or usernames (Server)' },
        { displayName: 'Group Names', name: 'groups', type: 'string', default: '' },
      ],
    },
  ]),

  /* attachments */
  ...forOp('issueAttachment', ['add', 'getAll'], [issueKey]),
  ...forOp('issueAttachment', 'add', [{ displayName: 'Input Binary Field', name: 'binaryPropertyName', type: 'string', default: 'data', required: true }]),
  ...forOp('issueAttachment', ['get', 'remove'], [{ displayName: 'Attachment ID', name: 'attachmentId', type: 'string', default: '', required: true }]),
  ...forOp('issueAttachment', ['get', 'getAll'], [
    { displayName: 'Download', name: 'download', type: 'boolean', default: false },
    { displayName: 'Put Output File in Field', name: 'binaryProperty', type: 'string', default: 'data', displayOptions: { show: { download: [true] } } },
  ]),
  ...forOp('issueAttachment', 'getAll', returnAllProps({ resource: ['issueAttachment'], operation: ['getAll'] })),

  /* comments */
  ...forOp('issueComment', ['add', 'get', 'getAll', 'remove', 'update'], [issueKey]),
  ...forOp('issueComment', ['get', 'remove', 'update'], [{ displayName: 'Comment ID', name: 'commentId', type: 'string', default: '', required: true }]),
  ...forOp('issueComment', ['add', 'update'], [
    { displayName: 'Comment', name: 'comment', type: 'string', typeOptions: { rows: 4 }, default: '', description: 'Plain text; sent as ADF on Cloud' },
    { displayName: 'Options', name: 'options', type: 'collection', default: {}, options: [{ displayName: 'Comment as ADF/JSON', name: 'commentJson', type: 'json', default: '', description: 'Raw comment body; overrides the text' }] },
  ]),
  ...forOp('issueComment', 'getAll', returnAllProps({ resource: ['issueComment'], operation: ['getAll'] })),

  /* users */
  ...forOp('user', 'get', [{ displayName: 'Account ID', name: 'accountId', type: 'string', default: '', required: true, description: 'Username on Server' }]),
  ...forOp('user', 'search', [{ displayName: 'Query', name: 'query', type: 'string', default: '', required: true, description: 'Name or email' }]),
];

/** Collection values → Jira issue `fields`. */
function buildIssueFields(ctx: Ctx, i: number, f: IDataObject): IDataObject {
  const fields: IDataObject = {};
  if (f.summary) fields.summary = f.summary;
  if (f.description !== undefined && f.description !== '') fields.description = richText(ctx, i, String(f.description));
  if (f.assignee) fields.assignee = userRef(ctx, i, String(f.assignee));
  if (f.reporter) fields.reporter = userRef(ctx, i, String(f.reporter));
  if (f.priority) fields.priority = { id: String(f.priority) };
  if (f.labels) fields.labels = String(f.labels).split(',').map((l) => l.trim()).filter(Boolean);
  if (f.duedate) fields.duedate = String(f.duedate).slice(0, 10);
  if (f.parentIssueKey) fields.parent = { key: f.parentIssueKey };
  if (f.issueType) fields.issuetype = /^\d+$/.test(String(f.issueType)) ? { id: String(f.issueType) } : { name: f.issueType };
  for (const c of ((f.customFieldsUi as IDataObject)?.customFieldsValues as Array<{ fieldId: string; fieldValue: string }>) ?? []) {
    if (!c.fieldId) continue;
    let v: unknown = c.fieldValue;
    try {
      v = JSON.parse(String(c.fieldValue));
    } catch {}
    fields[c.fieldId] = v as IDataObject;
  }
  return fields;
}

/** Issue with its fields flattened, the description as text and common objects reduced to names. */
export function simplifyIssue(issue: IDataObject): IDataObject {
  const f = (issue.fields as IDataObject) ?? {};
  const name = (v: unknown) => (v && typeof v === 'object' ? ((v as IDataObject).displayName ?? (v as IDataObject).name ?? (v as IDataObject).value ?? v) : v);
  const out: IDataObject = { id: issue.id, key: issue.key };
  for (const [k, v] of Object.entries(f)) out[k] = (k === 'description' ? (typeof v === 'string' ? v : adfToText(v).trim()) : Array.isArray(v) ? v.map(name) : name(v)) as IDataObject;
  return out;
}

const loadUsers = async function (this: ILoadOptionsFunctions) {
  const users = (await jira(this as unknown as Ctx, 'GET', isCloud(this as unknown as Ctx, 0) ? '/users/search' : '/user/search', undefined, isCloud(this as unknown as Ctx, 0) ? { maxResults: 1000 } : { username: '.', maxResults: 1000 })) as IDataObject[];
  return users.filter((u) => u.accountType !== 'app' && u.active !== false).map((u) => ({ name: String(u.displayName), value: String(u.accountId ?? u.name) }));
};

export const Jira: INodeType = {
  description: {
    name: '8n8.jira',
    displayName: 'Jira Software',
    description: 'Create, update, search and comment on Jira issues',
    group: ['output'],
    version: 1,
    defaults: { name: 'Jira Software', color: '#2684FF' },
    icon: 'fa:jira',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      { name: 'jiraSoftwareCloudApi', required: true, displayOptions: { show: { jiraVersion: ['cloud'] } } },
      { name: 'jiraSoftwareServerApi', required: true, displayOptions: { show: { jiraVersion: ['server'] } } },
      { name: 'jiraSoftwareServerPatApi', required: true, displayOptions: { show: { jiraVersion: ['serverPat'] } } },
    ],
    codex: { categories: ['Productivity', 'Development'], alias: ['Atlassian', 'Tickets', 'Issues'] },
    properties,
  },
  methods: {
    loadOptions: {
      async getProjects(this: ILoadOptionsFunctions) {
        const ctx = this as unknown as Ctx;
        const projects = isCloud(ctx, 0) ? (((await jira(ctx, 'GET', '/project/search', undefined, { maxResults: 100 })) as IDataObject).values as IDataObject[]) : ((await jira(ctx, 'GET', '/project')) as IDataObject[]);
        return projects.map((p) => ({ name: `${p.name} (${p.key})`, value: String(p.id) }));
      },
      async getIssueTypes(this: ILoadOptionsFunctions) {
        const project = String(this.getCurrentNodeParameters().project ?? '');
        const p = (await jira(this as unknown as Ctx, 'GET', `/project/${project}`)) as IDataObject;
        return ((p.issueTypes as IDataObject[]) ?? []).map((t) => ({ name: String(t.name), value: String(t.id) }));
      },
      async getPriorities(this: ILoadOptionsFunctions) {
        return ((await jira(this as unknown as Ctx, 'GET', '/priority')) as IDataObject[]).map((p) => ({ name: String(p.name), value: String(p.id) }));
      },
      async getTransitions(this: ILoadOptionsFunctions) {
        const key = String(this.getCurrentNodeParameters().issueKey ?? '');
        if (!key) return [];
        const r = (await jira(this as unknown as Ctx, 'GET', `/issue/${key}/transitions`)) as IDataObject;
        return ((r.transitions as IDataObject[]) ?? []).map((t) => ({ name: `${t.name} → ${(t.to as IDataObject)?.name ?? ''}`, value: String(t.id) }));
      },
      getUsers: loadUsers,
    },
  },
  async execute(this: IExecuteFunctions) {
    return [
      await forEachItem(this, async (i, item) => {
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, qs?: IDataObject, extra?: Parameters<typeof jira>[6]) => jira(this, method, path, body, qs, i, extra);
        const resource = p('resource');
        const op = p('operation');
        const cloud = isCloud(this, i);

        if (resource === 'issue') {
          const key = () => p('issueKey');
          if (op === 'create') {
            const fields = { project: { id: p('project') }, issuetype: { id: p('issueType') }, summary: p('summary'), ...buildIssueFields(this, i, p<IDataObject>('additionalFields', {})) };
            return call('POST', '/issue', { fields });
          }
          if (op === 'update') {
            const f = p<IDataObject>('updateFields', {});
            const fields = buildIssueFields(this, i, f);
            if (Object.keys(fields).length) await call('PUT', `/issue/${key()}`, { fields });
            if (f.statusId) await call('POST', `/issue/${key()}/transitions`, { transition: { id: String(f.statusId) } });
            return { success: true, key: key() };
          }
          if (op === 'get') {
            const f = p<IDataObject>('additionalFields', {});
            const issue = (await call('GET', `/issue/${key()}`, undefined, { ...(f.fields ? { fields: f.fields } : {}), ...(f.expand ? { expand: f.expand } : {}) })) as IDataObject;
            return f.simplify ? simplifyIssue(issue) : issue;
          }
          if (op === 'delete') {
            await call('DELETE', `/issue/${key()}`, undefined, { deleteSubtasks: p<boolean>('deleteSubtasks', false) });
            return { success: true };
          }
          if (op === 'transitions') return ((await call('GET', `/issue/${key()}/transitions`)) as IDataObject).transitions as IDataObject[];
          if (op === 'changelog') {
            if (!cloud) {
              const issue = (await call('GET', `/issue/${key()}`, undefined, { expand: 'changelog', fields: 'summary' })) as IDataObject;
              const histories = ((issue.changelog as IDataObject)?.histories as IDataObject[]) ?? [];
              const limit = listLimit(this, i);
              return limit ? histories.slice(0, limit) : histories;
            }
            return collectPages(async (startAt, size) => {
              const at = Number(startAt ?? 0);
              const r = (await call('GET', `/issue/${key()}/changelog`, undefined, { startAt: at, maxResults: size })) as IDataObject;
              const values = r.values as IDataObject[];
              return { items: values, next: r.isLast || !values.length ? undefined : String(at + values.length) };
            }, listLimit(this, i));
          }
          if (op === 'notify') {
            const r = p<IDataObject>('notificationRecipients', {});
            const to: IDataObject = { reporter: !!r.reporter, assignee: !!r.assignee, watchers: !!r.watchers, voters: !!r.voters };
            const users = String(r.users ?? '').split(',').map((u) => u.trim()).filter(Boolean);
            if (users.length) to.users = users.map((u) => (cloud ? { accountId: u } : { name: u }));
            const groups = String(r.groups ?? '').split(',').map((g) => g.trim()).filter(Boolean);
            if (groups.length) to.groups = groups.map((name) => ({ name }));
            await call('POST', `/issue/${key()}/notify`, { subject: p('subject', ''), textBody: p('textBody', ''), htmlBody: p('htmlBody', ''), to });
            return { success: true };
          }
          // getAll
          const o = p<IDataObject>('options', {});
          const jql = String(o.jql ?? '');
          const fields = String(o.fields || '*navigable');
          if (cloud) {
            // the enhanced search API pages with tokens
            return collectPages(async (token, size) => {
              const r = (await call('POST', '/search/jql', { jql, fields: fields.split(',').map((f) => f.trim()), maxResults: size, ...(o.expand ? { expand: String(o.expand) } : {}), ...(token ? { nextPageToken: token } : {}) })) as IDataObject;
              return { items: r.issues as IDataObject[], next: r.isLast ? undefined : (r.nextPageToken as string) };
            }, listLimit(this, i));
          }
          return collectPages(async (startAt, size) => {
            const at = Number(startAt ?? 0);
            const r = (await call('POST', '/search', { jql, fields: fields.split(','), startAt: at, maxResults: size, ...(o.expand ? { expand: String(o.expand).split(',') } : {}) })) as IDataObject;
            const issues = r.issues as IDataObject[];
            return { items: issues, next: at + issues.length < Number(r.total) && issues.length ? String(at + issues.length) : undefined };
          }, listLimit(this, i));
        }

        if (resource === 'issueAttachment') {
          const download = async (a: IDataObject) => {
            if (!p<boolean>('download', false)) return a;
            const data = (await call('GET', String(a.content), undefined, undefined, { json: false, encoding: 'arraybuffer' })) as ArrayBuffer;
            return { json: a, binary: { [p('binaryProperty', 'data')]: await this.helpers.prepareBinaryData(Buffer.from(data), String(a.filename), String(a.mimeType)) } };
          };
          if (op === 'add') {
            const prop = p('binaryPropertyName', 'data');
            const bin = this.helpers.assertBinaryData(i, prop);
            const form = new FormData();
            form.append('file', new Blob([new Uint8Array(await this.helpers.getBinaryDataBuffer(i, prop))], { type: bin.mimeType }), bin.fileName ?? 'file');
            return (await call('POST', `/issue/${p('issueKey')}/attachments`, form, undefined, { headers: { 'X-Atlassian-Token': 'no-check' } })) as IDataObject[];
          }
          if (op === 'get') return download((await call('GET', `/attachment/${p('attachmentId')}`)) as IDataObject);
          if (op === 'remove') {
            await call('DELETE', `/attachment/${p('attachmentId')}`);
            return { success: true };
          }
          const issue = (await call('GET', `/issue/${p('issueKey')}`, undefined, { fields: 'attachment' })) as IDataObject;
          const attachments = ((issue.fields as IDataObject)?.attachment as IDataObject[]) ?? [];
          const limit = listLimit(this, i);
          return Promise.all((limit ? attachments.slice(0, limit) : attachments).map(download));
        }

        if (resource === 'issueComment') {
          const base = `/issue/${p('issueKey')}/comment`;
          const body = () => {
            const raw = p<IDataObject>('options', {}).commentJson;
            if (raw) return { body: jsonParam(raw, 'Comment JSON') };
            return { body: richText(this, i, p('comment', '')) };
          };
          if (op === 'add') return call('POST', base, body());
          if (op === 'update') return call('PUT', `${base}/${p('commentId')}`, body());
          if (op === 'get') return call('GET', `${base}/${p('commentId')}`);
          if (op === 'remove') {
            await call('DELETE', `${base}/${p('commentId')}`);
            return { success: true };
          }
          return collectPages(async (startAt, size) => {
            const at = Number(startAt ?? 0);
            const r = (await call('GET', base, undefined, { startAt: at, maxResults: size, orderBy: '+created' })) as IDataObject;
            const comments = r.comments as IDataObject[];
            return { items: comments, next: at + comments.length < Number(r.total) && comments.length ? String(at + comments.length) : undefined };
          }, listLimit(this, i));
        }

        if (op === 'search') return (await call('GET', '/user/search', undefined, cloud ? { query: p('query') } : { username: p('query') })) as IDataObject[];
        return call('GET', '/user', undefined, cloud ? { accountId: p('accountId') } : { username: p('accountId') });
      }),
    ];
  },
};

const TRIGGER_EVENTS = [
  '*',
  'jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted',
  'comment_created', 'comment_updated', 'comment_deleted',
  'attachment_created', 'attachment_deleted',
  'issuelink_created', 'issuelink_deleted',
  'worklog_created', 'worklog_updated', 'worklog_deleted',
  'sprint_created', 'sprint_started', 'sprint_closed', 'sprint_updated', 'sprint_deleted',
  'project_created', 'project_updated', 'project_deleted',
  'jira:version_released', 'jira:version_created',
  'user_created', 'user_updated', 'user_deleted',
];

export const JiraTrigger: INodeType = {
  description: {
    name: '8n8.jiraTrigger',
    displayName: 'Jira Trigger',
    description: 'Starts the workflow on Jira events (registers a webhook; needs admin rights and a public URL)',
    group: ['trigger'],
    version: [1, 1.1],
    defaults: { name: 'Jira Trigger', color: '#2684FF' },
    icon: 'fa:jira',
    inputs: [],
    outputs: ['main'],
    credentials: [
      { name: 'jiraSoftwareCloudApi', required: true, displayOptions: { show: { jiraVersion: ['cloud'] } } },
      { name: 'jiraSoftwareServerApi', required: true, displayOptions: { show: { jiraVersion: ['server'] } } },
      { name: 'jiraSoftwareServerPatApi', required: true, displayOptions: { show: { jiraVersion: ['serverPat'] } } },
    ],
    webhooks: [{ name: 'default', httpMethod: 'POST', path: 'webhook', isFullPath: false }],
    properties: [
      properties[0],
      { displayName: 'Events', name: 'events', type: 'multiOptions', default: [], required: true, options: TRIGGER_EVENTS.map((e) => ({ name: e === '*' ? '* (all events)' : e, value: e })) },
      { displayName: 'Additional Fields', name: 'additionalFields', type: 'collection', default: {}, options: [{ displayName: 'Filter (JQL)', name: 'filter', type: 'string', default: '', placeholder: 'project = PROJ', description: 'Only issue events matching this JQL' }, { displayName: 'Exclude Body', name: 'excludeBody', type: 'boolean', default: false }] },
    ],
  },
  webhookMethods: {
    default: {
      async checkExists(this: IHookFunctions) {
        const data = this.getWorkflowStaticData('node');
        if (!data.webhookId) return false;
        try {
          const hook = (await jira(this as unknown as Ctx, 'GET', `/rest/webhooks/1.0/webhook/${data.webhookId}`)) as IDataObject;
          if (hook.url === this.getNodeWebhookUrl('default')) return true;
        } catch {}
        delete data.webhookId;
        return false;
      },
      async create(this: IHookFunctions) {
        const data = this.getWorkflowStaticData('node');
        let events = this.getNodeParameter('events', []) as string[];
        if (events.includes('*')) events = TRIGGER_EVENTS.slice(1);
        const f = this.getNodeParameter('additionalFields', {}) as IDataObject;
        data.secret = randomBytes(24).toString('hex');
        const hook = (await jira(this as unknown as Ctx, 'POST', '/rest/webhooks/1.0/webhook', {
          name: `8n8 webhook (workflow ${this.getWorkflow().id ?? ''})`,
          url: this.getNodeWebhookUrl('default'),
          events,
          filters: { 'issue-related-events-section': String(f.filter ?? '') },
          excludeBody: !!f.excludeBody,
          secret: data.secret,
        })) as IDataObject;
        data.webhookId = String(hook.self ?? '').split('/').pop();
        return true;
      },
      async delete(this: IHookFunctions) {
        const data = this.getWorkflowStaticData('node');
        if (data.webhookId) await jira(this as unknown as Ctx, 'DELETE', `/rest/webhooks/1.0/webhook/${data.webhookId}`).catch(() => {});
        delete data.webhookId;
        delete data.secret;
        return true;
      },
    },
  },
  async webhook(this: IWebhookFunctions): Promise<IWebhookResult> {
    const secret = this.getWorkflowStaticData('node').secret as string | undefined;
    const signature = String(this.getHeaderData()['x-hub-signature'] ?? '');
    // Jira Cloud signs deliveries of webhooks registered with a secret; Server does not
    if (secret && signature) {
      const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(this.getRequestObject().rawBody ?? Buffer.from('')).digest('hex')}`);
      if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), expected)) return { webhookResponse: { statusCode: 401, body: { message: 'Invalid signature' } } };
    }
    return { workflowData: [[{ json: this.getBodyData() as IDataObject }]] };
  },
};

const domain: INodeProperties = { displayName: 'Domain', name: 'domain', type: 'string', default: '', placeholder: 'https://example.atlassian.net' };

export const jiraCredentials: ICredentialType[] = [
  {
    name: 'jiraSoftwareCloudApi',
    displayName: 'Jira SW Cloud API',
    documentationUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    properties: [
      { displayName: 'Email', name: 'email', type: 'string', default: '' },
      { displayName: 'API Token', name: 'apiToken', type: 'string', typeOptions: { password: true }, default: '' },
      domain,
    ],
    authenticate: { type: 'generic', properties: { auth: { username: '={{$credentials.email}}', password: '={{$credentials.apiToken}}' } } },
    test: { request: { url: '={{$credentials.domain}}/rest/api/3/myself' } },
  },
  {
    name: 'jiraSoftwareServerApi',
    displayName: 'Jira SW Server API',
    properties: [
      { displayName: 'Username', name: 'email', type: 'string', default: '' },
      { displayName: 'Password', name: 'password', type: 'string', typeOptions: { password: true }, default: '' },
      { ...domain, placeholder: 'https://jira.example.com' },
    ],
    authenticate: { type: 'generic', properties: { auth: { username: '={{$credentials.email}}', password: '={{$credentials.password}}' } } },
    test: { request: { url: '={{$credentials.domain}}/rest/api/2/myself' } },
  },
  {
    name: 'jiraSoftwareServerPatApi',
    displayName: 'Jira SW Server (PAT) API',
    properties: [
      { displayName: 'Personal Access Token', name: 'personalAccessToken', type: 'string', typeOptions: { password: true }, default: '' },
      { ...domain, placeholder: 'https://jira.example.com' },
    ],
    authenticate: { type: 'generic', properties: { headers: { Authorization: '=Bearer {{$credentials.personalAccessToken}}' } } },
    test: { request: { url: '={{$credentials.domain}}/rest/api/2/myself' } },
  },
];
