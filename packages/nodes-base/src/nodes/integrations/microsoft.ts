import type { ICredentialType, IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, INodeType, IPollFunctions } from '@flowmator/workflow';
import { apiRequest, collectPages, forEachItem, forOp, listLimit, operationProp, pollTimesProp, returnAllProps } from '../../utils/api';

const GRAPH = 'https://graph.microsoft.com/v1.0';

type Ctx = { helpers: IExecuteFunctions['helpers'] };
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Microsoft Graph request; `path` may also be a full URL (an @odata.nextLink). */
async function graph(ctx: Ctx, credential: string, method: Method, path: string, body?: unknown, qs?: IDataObject, i = 0, extra: { headers?: Record<string, string>; json?: boolean; encoding?: 'arraybuffer' } = {}): Promise<any> {
  try {
    return await apiRequest(ctx, credential, { url: path.startsWith('https://') ? path : `${GRAPH}${path}`, method, ...(body !== undefined ? { body } : {}), ...(qs ? { qs } : {}), ...extra }, i);
  } catch (e) {
    const err = (e as { body?: { error?: { code?: string; message?: string } } }).body?.error;
    if (err?.message) throw new Error(`Microsoft error: ${err.message}${err.code ? ` (${err.code})` : ''}`);
    throw e;
  }
}

/** Follows @odata.nextLink until done or the limit is reached. */
async function graphList(ctx: Ctx, credential: string, path: string, qs: IDataObject, limit: number | undefined, i = 0, headers?: Record<string, string>) {
  return collectPages(async (next, size) => {
    const r = next ? await graph(ctx, credential, 'GET', next, undefined, undefined, i, { headers }) : await graph(ctx, credential, 'GET', path, undefined, { ...qs, $top: size }, i, { headers });
    return { items: (r.value as IDataObject[]) ?? [], next: r['@odata.nextLink'] as string | undefined };
  }, limit);
}

const csv = (s: unknown) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const recipients = (s: unknown) => csv(s).map((address) => ({ emailAddress: { address } }));
const collection = (name: string, displayName: string, options: INodeProperties[]): INodeProperties => ({ displayName, name, type: 'collection', default: {}, options });

/* ======================= Outlook ======================= */

const OUTLOOK = 'microsoftOutlookOAuth2Api';

/** Flat message with addresses as strings (the shape n8n's "simplify" gives). */
export function simplifyOutlookMessage(m: IDataObject): IDataObject {
  const addr = (r: unknown) => ((r as IDataObject)?.emailAddress as IDataObject)?.address as string | undefined;
  return {
    id: m.id,
    conversationId: m.conversationId,
    subject: m.subject,
    bodyPreview: m.bodyPreview,
    from: addr(m.from),
    to: ((m.toRecipients as IDataObject[]) ?? []).map(addr),
    cc: ((m.ccRecipients as IDataObject[]) ?? []).map(addr),
    receivedDateTime: m.receivedDateTime,
    isRead: m.isRead,
    hasAttachments: m.hasAttachments,
    categories: m.categories,
    webLink: m.webLink,
    ...(m.body ? { body: (m.body as IDataObject).content, bodyType: (m.body as IDataObject).contentType } : {}),
  };
}

/** OData $filter for the message filters of the node and the trigger. */
export function outlookFilter(f: IDataObject, since?: string): string | undefined {
  const parts: string[] = [];
  const q = (s: unknown) => `'${String(s).replace(/'/g, "''")}'`;
  if (since) parts.push(`receivedDateTime gt ${since}`);
  if (f.receivedAfter) parts.push(`receivedDateTime ge ${new Date(String(f.receivedAfter)).toISOString()}`);
  if (f.receivedBefore) parts.push(`receivedDateTime le ${new Date(String(f.receivedBefore)).toISOString()}`);
  if (f.sender) parts.push(`from/emailAddress/address eq ${q(f.sender)}`);
  if (f.readStatus === 'read') parts.push('isRead eq true');
  if (f.readStatus === 'unread') parts.push('isRead eq false');
  if (f.hasAttachments) parts.push('hasAttachments eq true');
  if (f.categories) parts.push(`(${csv(f.categories).map((c) => `categories/any(x:x eq ${q(c)})`).join(' or ')})`);
  if (f.custom) parts.push(`(${f.custom})`);
  return parts.length ? parts.join(' and ') : undefined;
}

const messageFilters: INodeProperties = collection('filters', 'Filters', [
  { displayName: 'Folder IDs', name: 'foldersToInclude', type: 'string', default: '', description: 'Comma separated; well-known names like inbox, sentitems, drafts work too' },
  { displayName: 'Received After', name: 'receivedAfter', type: 'dateTime', default: '' },
  { displayName: 'Received Before', name: 'receivedBefore', type: 'dateTime', default: '' },
  { displayName: 'Sender', name: 'sender', type: 'string', default: '' },
  { displayName: 'Read Status', name: 'readStatus', type: 'options', default: 'both', options: [{ name: 'Read and Unread', value: 'both' }, { name: 'Read', value: 'read' }, { name: 'Unread', value: 'unread' }] },
  { displayName: 'Has Attachments', name: 'hasAttachments', type: 'boolean', default: false },
  { displayName: 'Categories', name: 'categories', type: 'string', default: '' },
  { displayName: 'Search', name: 'search', type: 'string', default: '', description: 'KQL search ($search); cannot be combined with other filters' },
  { displayName: 'Custom Filter', name: 'custom', type: 'string', default: '', placeholder: "importance eq 'high'" },
]);

const messageContent = (name: string, displayName: string): INodeProperties => collection(name, displayName, [
  { displayName: 'BCC Recipients', name: 'bccRecipients', type: 'string', default: '' },
  { displayName: 'Body Content Type', name: 'bodyContentType', type: 'options', default: 'Text', options: [{ name: 'HTML', value: 'HTML' }, { name: 'Text', value: 'Text' }] },
  { displayName: 'Categories', name: 'categories', type: 'string', default: '' },
  { displayName: 'CC Recipients', name: 'ccRecipients', type: 'string', default: '' },
  { displayName: 'Importance', name: 'importance', type: 'options', default: 'normal', options: [{ name: 'Low', value: 'low' }, { name: 'Normal', value: 'normal' }, { name: 'High', value: 'high' }] },
  { displayName: 'Reply To', name: 'replyTo', type: 'string', default: '' },
  { displayName: 'Attachments (Binary Fields)', name: 'attachments', type: 'string', default: '', description: 'Comma separated input binary fields to attach' },
  { displayName: 'Save to Sent Items', name: 'saveToSentItems', type: 'boolean', default: true },
]);

const outlookProperties: INodeProperties[] = [
  {
    displayName: 'Resource',
    name: 'resource',
    type: 'options',
    noDataExpression: true,
    default: 'message',
    options: [
      { name: 'Calendar', value: 'calendar' },
      { name: 'Contact', value: 'contact' },
      { name: 'Draft', value: 'draft' },
      { name: 'Event', value: 'event' },
      { name: 'Folder', value: 'folder' },
      { name: 'Message', value: 'message' },
      { name: 'Message Attachment', value: 'messageAttachment' },
    ],
  },
  operationProp('message', [
    { name: 'Delete', value: 'delete' },
    { name: 'Get', value: 'get' },
    { name: 'Get Many', value: 'getAll' },
    { name: 'Move', value: 'move' },
    { name: 'Reply', value: 'reply' },
    { name: 'Send', value: 'send' },
    { name: 'Update', value: 'update' },
  ], 'send'),
  operationProp('draft', [{ name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Get', value: 'get' }, { name: 'Send', value: 'send' }]),
  operationProp('messageAttachment', [{ name: 'Add', value: 'add' }, { name: 'Download', value: 'download' }, { name: 'Get Many', value: 'getAll' }]),
  operationProp('folder', [{ name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Get Many', value: 'getAll' }]),
  operationProp('contact', [{ name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }, { name: 'Update', value: 'update' }]),
  operationProp('event', [{ name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }, { name: 'Update', value: 'update' }]),
  operationProp('calendar', [{ name: 'Create', value: 'create' }, { name: 'Get Many', value: 'getAll' }]),

  /* message */
  ...forOp('message', 'send', [
    { displayName: 'To', name: 'toRecipients', type: 'string', default: '', required: true, description: 'Comma separated' },
    { displayName: 'Subject', name: 'subject', type: 'string', default: '' },
    { displayName: 'Message', name: 'bodyContent', type: 'string', typeOptions: { rows: 5 }, default: '' },
    messageContent('additionalFields', 'Additional Fields'),
  ]),
  ...forOp('message', ['delete', 'get', 'move', 'reply', 'update'], [{ displayName: 'Message ID', name: 'messageId', type: 'string', default: '', required: true }]),
  ...forOp('message', 'reply', [
    { displayName: 'Message', name: 'message', type: 'string', typeOptions: { rows: 4 }, default: '' },
    { displayName: 'Reply to Sender Only', name: 'replyToSenderOnly', type: 'boolean', default: false },
    collection('options', 'Options', [{ displayName: 'Body Content Type', name: 'bodyContentType', type: 'options', default: 'Text', options: [{ name: 'HTML', value: 'HTML' }, { name: 'Text', value: 'Text' }] }]),
  ]),
  ...forOp('message', 'move', [{ displayName: 'Destination Folder', name: 'folderId', type: 'string', default: '', required: true, description: 'Folder ID or a well-known name (archive, deleteditems, junkemail…)' }]),
  ...forOp('message', 'update', [collection('updateFields', 'Update Fields', [
    { displayName: 'Is Read', name: 'isRead', type: 'boolean', default: true },
    { displayName: 'Categories', name: 'categories', type: 'string', default: '' },
    { displayName: 'Importance', name: 'importance', type: 'options', default: 'normal', options: [{ name: 'Low', value: 'low' }, { name: 'Normal', value: 'normal' }, { name: 'High', value: 'high' }] },
    { displayName: 'Flag', name: 'flag', type: 'options', default: 'notFlagged', options: [{ name: 'Not Flagged', value: 'notFlagged' }, { name: 'Flagged', value: 'flagged' }, { name: 'Complete', value: 'complete' }] },
  ])]),
  ...forOp('message', 'getAll', [...returnAllProps({ resource: ['message'], operation: ['getAll'] }), messageFilters]),
  ...forOp('message', ['get', 'getAll'], [{ displayName: 'Simplify', name: 'simplify', type: 'boolean', default: true }]),

  /* draft */
  ...forOp('draft', 'create', [
    { displayName: 'Subject', name: 'subject', type: 'string', default: '' },
    { displayName: 'Message', name: 'bodyContent', type: 'string', typeOptions: { rows: 5 }, default: '' },
    { displayName: 'To', name: 'toRecipients', type: 'string', default: '' },
    messageContent('additionalFields', 'Additional Fields'),
  ]),
  ...forOp('draft', ['delete', 'get', 'send'], [{ displayName: 'Draft ID', name: 'draftId', type: 'string', default: '', required: true }]),

  /* attachments */
  ...forOp('messageAttachment', ['add', 'download', 'getAll'], [{ displayName: 'Message ID', name: 'messageId', type: 'string', default: '', required: true }]),
  ...forOp('messageAttachment', 'add', [{ displayName: 'Input Binary Field', name: 'binaryPropertyName', type: 'string', default: 'data', required: true }, collection('options', 'Options', [{ displayName: 'File Name', name: 'fileName', type: 'string', default: '' }])]),
  ...forOp('messageAttachment', 'download', [{ displayName: 'Attachment ID', name: 'attachmentId', type: 'string', default: '', required: true }, { displayName: 'Put Output File in Field', name: 'binaryPropertyName', type: 'string', default: 'data' }]),
  ...forOp('messageAttachment', 'getAll', returnAllProps({ resource: ['messageAttachment'], operation: ['getAll'] })),

  /* folders */
  ...forOp('folder', 'create', [{ displayName: 'Name', name: 'displayName', type: 'string', default: '', required: true }, { displayName: 'Parent Folder ID', name: 'parentFolderId', type: 'string', default: '', description: 'Empty creates a top-level folder' }]),
  ...forOp('folder', 'delete', [{ displayName: 'Folder ID', name: 'folderId', type: 'string', default: '', required: true }]),
  ...forOp('folder', 'getAll', [...returnAllProps({ resource: ['folder'], operation: ['getAll'] }), collection('options', 'Options', [{ displayName: 'Parent Folder ID', name: 'parentFolderId', type: 'string', default: '' }])]),

  /* contacts */
  ...forOp('contact', 'create', [{ displayName: 'First Name', name: 'givenName', type: 'string', default: '' }, { displayName: 'Last Name', name: 'surname', type: 'string', default: '' }]),
  ...forOp('contact', ['delete', 'get', 'update'], [{ displayName: 'Contact ID', name: 'contactId', type: 'string', default: '', required: true }]),
  ...forOp('contact', ['create', 'update'], [collection('fields', 'Fields', [
    { displayName: 'Emails', name: 'emailAddresses', type: 'string', default: '', description: 'Comma separated' },
    { displayName: 'Mobile Phone', name: 'mobilePhone', type: 'string', default: '' },
    { displayName: 'Business Phones', name: 'businessPhones', type: 'string', default: '' },
    { displayName: 'Company', name: 'companyName', type: 'string', default: '' },
    { displayName: 'Job Title', name: 'jobTitle', type: 'string', default: '' },
    { displayName: 'First Name', name: 'givenName', type: 'string', default: '' },
    { displayName: 'Last Name', name: 'surname', type: 'string', default: '' },
    { displayName: 'Notes', name: 'personalNotes', type: 'string', default: '' },
  ])]),
  ...forOp('contact', 'getAll', [...returnAllProps({ resource: ['contact'], operation: ['getAll'] }), collection('filters', 'Filters', [{ displayName: 'Custom Filter', name: 'custom', type: 'string', default: '' }])]),

  /* events */
  ...forOp('event', ['create', 'getAll'], [{ displayName: 'Calendar ID', name: 'calendarId', type: 'string', default: '', description: 'Empty uses the default calendar' }]),
  ...forOp('event', 'create', [
    { displayName: 'Title', name: 'subject', type: 'string', default: '', required: true },
    { displayName: 'Start', name: 'start', type: 'dateTime', default: '', required: true },
    { displayName: 'End', name: 'end', type: 'dateTime', default: '', required: true },
  ]),
  ...forOp('event', ['delete', 'get', 'update'], [{ displayName: 'Event ID', name: 'eventId', type: 'string', default: '', required: true }]),
  ...forOp('event', ['create', 'update'], [collection('eventFields', 'Fields', [
    { displayName: 'Title', name: 'subject', type: 'string', default: '' },
    { displayName: 'Start', name: 'start', type: 'dateTime', default: '' },
    { displayName: 'End', name: 'end', type: 'dateTime', default: '' },
    { displayName: 'Time Zone', name: 'timeZone', type: 'string', default: 'UTC' },
    { displayName: 'All Day', name: 'isAllDay', type: 'boolean', default: false },
    { displayName: 'Body', name: 'body', type: 'string', default: '' },
    { displayName: 'Location', name: 'location', type: 'string', default: '' },
    { displayName: 'Attendees', name: 'attendees', type: 'string', default: '', description: 'Comma separated emails' },
    { displayName: 'Online Meeting (Teams)', name: 'isOnlineMeeting', type: 'boolean', default: false },
    { displayName: 'Show As', name: 'showAs', type: 'options', default: 'busy', options: ['free', 'tentative', 'busy', 'oof', 'workingElsewhere'].map((v) => ({ name: v, value: v })) },
    { displayName: 'Categories', name: 'categories', type: 'string', default: '' },
  ])]),
  ...forOp('event', 'getAll', [...returnAllProps({ resource: ['event'], operation: ['getAll'] }), collection('filters', 'Filters', [
    { displayName: 'From', name: 'startDateTime', type: 'dateTime', default: '', description: 'With "To", lists occurrences of recurring events in the range (calendarView)' },
    { displayName: 'To', name: 'endDateTime', type: 'dateTime', default: '' },
    { displayName: 'Custom Filter', name: 'custom', type: 'string', default: '' },
  ])]),

  /* calendars */
  ...forOp('calendar', 'create', [{ displayName: 'Name', name: 'name', type: 'string', default: '', required: true }, collection('additionalFields', 'Additional Fields', [{ displayName: 'Color', name: 'color', type: 'options', default: 'auto', options: ['auto', 'lightBlue', 'lightGreen', 'lightOrange', 'lightGray', 'lightYellow', 'lightTeal', 'lightPink', 'lightBrown', 'lightRed'].map((v) => ({ name: v, value: v })) }])]),
  ...forOp('calendar', 'getAll', returnAllProps({ resource: ['calendar'], operation: ['getAll'] })),
];

async function messageAttachments(ctx: IExecuteFunctions, i: number, fields: string): Promise<IDataObject[]> {
  const out: IDataObject[] = [];
  for (const prop of csv(fields)) {
    const bin = ctx.helpers.assertBinaryData(i, prop);
    out.push({ '@odata.type': '#microsoft.graph.fileAttachment', name: bin.fileName ?? prop, contentType: bin.mimeType, contentBytes: (await ctx.helpers.getBinaryDataBuffer(i, prop)).toString('base64') });
  }
  return out;
}

/** Message resource body from the node's fields. */
async function buildMessage(ctx: IExecuteFunctions, i: number, base: { subject?: string; body?: string; to?: string }, f: IDataObject): Promise<IDataObject> {
  const message: IDataObject = {
    subject: base.subject ?? '',
    body: { contentType: String(f.bodyContentType ?? 'Text'), content: base.body ?? '' },
  };
  if (base.to) message.toRecipients = recipients(base.to);
  if (f.ccRecipients) message.ccRecipients = recipients(f.ccRecipients);
  if (f.bccRecipients) message.bccRecipients = recipients(f.bccRecipients);
  if (f.replyTo) message.replyTo = recipients(f.replyTo);
  if (f.importance) message.importance = f.importance;
  if (f.categories) message.categories = csv(f.categories);
  if (f.attachments) message.attachments = await messageAttachments(ctx, i, String(f.attachments));
  return message;
}

function eventBody(f: IDataObject): IDataObject {
  const tz = String(f.timeZone || 'UTC');
  const when = (v: unknown) => ({ dateTime: f.isAllDay ? String(v).slice(0, 10) + 'T00:00:00' : new Date(String(v)).toISOString().replace('Z', ''), timeZone: tz });
  const e: IDataObject = {};
  if (f.subject) e.subject = f.subject;
  if (f.start) e.start = when(f.start);
  if (f.end) e.end = when(f.end);
  if (f.isAllDay !== undefined) e.isAllDay = f.isAllDay;
  if (f.body) e.body = { contentType: 'HTML', content: f.body };
  if (f.location) e.location = { displayName: f.location };
  if (f.attendees) e.attendees = csv(f.attendees).map((address) => ({ emailAddress: { address }, type: 'required' }));
  if (f.isOnlineMeeting) Object.assign(e, { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' });
  if (f.showAs) e.showAs = f.showAs;
  if (f.categories) e.categories = csv(f.categories);
  return e;
}

export const MicrosoftOutlook: INodeType = {
  description: {
    name: 'flowmator.microsoftOutlook',
    displayName: 'Microsoft Outlook',
    description: 'Mail, folders, contacts and calendar events in Outlook / Microsoft 365',
    group: ['transform'],
    version: [1, 2],
    defaults: { name: 'Microsoft Outlook', color: '#0078D4' },
    icon: 'fa:microsoft',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: OUTLOOK, required: true }],
    codex: { categories: ['Communication', 'Productivity'], alias: ['Email', 'Office 365', 'Exchange', 'Calendar'] },
    properties: outlookProperties,
  },
  async execute(this: IExecuteFunctions) {
    return [
      await forEachItem(this, async (i, item) => {
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (method: Method, path: string, body?: unknown, qs?: IDataObject, extra?: Parameters<typeof graph>[7]) => graph(this, OUTLOOK, method, path, body, qs, i, extra);
        const list = (path: string, qs: IDataObject = {}, headers?: Record<string, string>) => graphList(this, OUTLOOK, path, qs, listLimit(this, i), i, headers);
        const resource = p('resource');
        const op = p('operation');

        if (resource === 'message') {
          const simplify = p<boolean>('simplify', true);
          if (op === 'send') {
            const f = p<IDataObject>('additionalFields', {});
            await call('POST', '/me/sendMail', { message: await buildMessage(this, i, { subject: p('subject', ''), body: p('bodyContent', ''), to: p('toRecipients') }, f), saveToSentItems: f.saveToSentItems !== false });
            return { success: true };
          }
          if (op === 'get') {
            const m = await call('GET', `/me/messages/${p('messageId')}`);
            return simplify ? simplifyOutlookMessage(m) : m;
          }
          if (op === 'delete') {
            await call('DELETE', `/me/messages/${p('messageId')}`);
            return { success: true };
          }
          if (op === 'move') return call('POST', `/me/messages/${p('messageId')}/move`, { destinationId: p('folderId') });
          if (op === 'update') {
            const f = p<IDataObject>('updateFields', {});
            const body: IDataObject = { ...f };
            if (f.categories !== undefined) body.categories = csv(f.categories);
            if (f.flag) body.flag = { flagStatus: f.flag };
            return call('PATCH', `/me/messages/${p('messageId')}`, body);
          }
          if (op === 'reply') {
            const action = p<boolean>('replyToSenderOnly', false) ? 'reply' : 'replyAll';
            const html = p<IDataObject>('options', {}).bodyContentType === 'HTML';
            await call('POST', `/me/messages/${p('messageId')}/${action}`, html ? { message: { body: { contentType: 'HTML', content: p('message', '') } } } : { comment: p('message', '') });
            return { success: true };
          }
          // getAll
          const f = p<IDataObject>('filters', {});
          const folders = csv(f.foldersToInclude);
          const qs: IDataObject = {};
          if (f.search) qs.$search = `"${String(f.search).replace(/"/g, '')}"`;
          else {
            const filter = outlookFilter(f);
            if (filter) qs.$filter = filter;
            qs.$orderby = 'receivedDateTime desc';
          }
          const rows = folders.length
            ? (await Promise.all(folders.map((folder) => list(`/me/mailFolders/${folder}/messages`, qs)))).flat()
            : await list('/me/messages', qs);
          return simplify ? rows.map(simplifyOutlookMessage) : rows;
        }

        if (resource === 'draft') {
          if (op === 'create') return call('POST', '/me/messages', await buildMessage(this, i, { subject: p('subject', ''), body: p('bodyContent', ''), to: p('toRecipients', '') }, p<IDataObject>('additionalFields', {})));
          if (op === 'get') return call('GET', `/me/messages/${p('draftId')}`);
          if (op === 'delete') {
            await call('DELETE', `/me/messages/${p('draftId')}`);
            return { success: true };
          }
          await call('POST', `/me/messages/${p('draftId')}/send`);
          return { success: true };
        }

        if (resource === 'messageAttachment') {
          const base = `/me/messages/${p('messageId')}/attachments`;
          if (op === 'getAll') return (await list(base, { $select: 'id,name,contentType,size,isInline,lastModifiedDateTime' }));
          if (op === 'add') {
            const prop = p('binaryPropertyName', 'data');
            const bin = this.helpers.assertBinaryData(i, prop);
            const data = await this.helpers.getBinaryDataBuffer(i, prop);
            const name = String(p<IDataObject>('options', {}).fileName || bin.fileName || prop);
            if (data.length > 3 * 1024 * 1024) {
              // big files need an upload session
              const session = await call('POST', `${base}/createUploadSession`, { AttachmentItem: { attachmentType: 'file', name, size: data.length, contentType: bin.mimeType } });
              const chunk = 4 * 1024 * 1024;
              for (let start = 0; start < data.length; start += chunk) {
                const part = data.subarray(start, start + chunk);
                await fetch(String(session.uploadUrl), { method: 'PUT', headers: { 'Content-Length': String(part.length), 'Content-Range': `bytes ${start}-${start + part.length - 1}/${data.length}` }, body: new Uint8Array(part) });
              }
              return { success: true, name };
            }
            return call('POST', base, { '@odata.type': '#microsoft.graph.fileAttachment', name, contentType: bin.mimeType, contentBytes: data.toString('base64') });
          }
          const att = await call('GET', `${base}/${p('attachmentId')}`);
          const { contentBytes, ...meta } = att;
          return { json: { ...item.json, ...meta }, binary: { ...(item.binary ?? {}), [p('binaryPropertyName', 'data')]: await this.helpers.prepareBinaryData(Buffer.from(String(contentBytes ?? ''), 'base64'), String(att.name), String(att.contentType)) } };
        }

        if (resource === 'folder') {
          if (op === 'create') {
            const parent = p('parentFolderId', '');
            return call('POST', parent ? `/me/mailFolders/${parent}/childFolders` : '/me/mailFolders', { displayName: p('displayName') });
          }
          if (op === 'delete') {
            await call('DELETE', `/me/mailFolders/${p('folderId')}`);
            return { success: true };
          }
          const parent = String(p<IDataObject>('options', {}).parentFolderId ?? '');
          return list(parent ? `/me/mailFolders/${parent}/childFolders` : '/me/mailFolders');
        }

        if (resource === 'contact') {
          const fields = () => {
            const f = { ...p<IDataObject>('fields', {}) };
            if (f.emailAddresses !== undefined) f.emailAddresses = csv(f.emailAddresses).map((address) => ({ address })) as unknown as IDataObject[];
            if (f.businessPhones !== undefined) f.businessPhones = csv(f.businessPhones);
            return f;
          };
          if (op === 'create') return call('POST', '/me/contacts', { givenName: p('givenName', ''), surname: p('surname', ''), ...fields() });
          if (op === 'update') return call('PATCH', `/me/contacts/${p('contactId')}`, fields());
          if (op === 'get') return call('GET', `/me/contacts/${p('contactId')}`);
          if (op === 'delete') {
            await call('DELETE', `/me/contacts/${p('contactId')}`);
            return { success: true };
          }
          const custom = p<IDataObject>('filters', {}).custom;
          return list('/me/contacts', custom ? { $filter: custom } : {});
        }

        if (resource === 'event') {
          const calendar = p('calendarId', '');
          const base = calendar ? `/me/calendars/${calendar}` : '/me';
          if (op === 'create') return call('POST', `${base}/events`, eventBody({ ...p<IDataObject>('eventFields', {}), subject: p('subject'), start: p('start'), end: p('end') }));
          if (op === 'update') return call('PATCH', `/me/events/${p('eventId')}`, eventBody(p<IDataObject>('eventFields', {})));
          if (op === 'get') return call('GET', `/me/events/${p('eventId')}`);
          if (op === 'delete') {
            await call('DELETE', `/me/events/${p('eventId')}`);
            return { success: true };
          }
          const f = p<IDataObject>('filters', {});
          if (f.startDateTime && f.endDateTime) return list(`${base}/calendarView`, { startDateTime: new Date(String(f.startDateTime)).toISOString(), endDateTime: new Date(String(f.endDateTime)).toISOString() });
          return list(`${base}/events`, f.custom ? { $filter: f.custom } : {});
        }

        if (op === 'create') return call('POST', '/me/calendars', { name: p('name'), ...p<IDataObject>('additionalFields', {}) });
        return list('/me/calendars');
      }),
    ];
  },
};

export const MicrosoftOutlookTrigger: INodeType = {
  description: {
    name: 'flowmator.microsoftOutlookTrigger',
    displayName: 'Microsoft Outlook Trigger',
    description: 'Starts the workflow when new mail arrives in Outlook',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Microsoft Outlook Trigger', color: '#0078D4' },
    icon: 'fa:microsoft',
    polling: true,
    inputs: [],
    outputs: ['main'],
    credentials: [{ name: OUTLOOK, required: true }],
    properties: [
      pollTimesProp,
      { displayName: 'Trigger On', name: 'event', type: 'options', default: 'messageReceived', options: [{ name: 'Message Received', value: 'messageReceived' }] },
      { displayName: 'Simplify', name: 'simplify', type: 'boolean', default: true },
      { ...messageFilters, options: messageFilters.options!.filter((o) => !['receivedAfter', 'receivedBefore', 'search'].includes((o as INodeProperties).name)) },
    ],
  },
  async poll(this: IPollFunctions) {
    const state = this.getWorkflowStaticData('node');
    const manual = this.getMode() === 'manual';
    const now = new Date().toISOString();
    if (!manual && !state.lastTimeChecked) {
      state.lastTimeChecked = now;
      return null;
    }
    const f = this.getNodeParameter('filters', {}) as IDataObject;
    const qs: IDataObject = { $orderby: 'receivedDateTime asc' };
    const filter = outlookFilter(f, manual ? undefined : String(state.lastTimeChecked));
    if (filter) qs.$filter = filter;
    if (manual) qs.$orderby = 'receivedDateTime desc';
    const folders = csv(f.foldersToInclude);
    const limit = manual ? 1 : 200;
    const messages = folders.length
      ? (await Promise.all(folders.map((folder) => graphList(this, OUTLOOK, `/me/mailFolders/${folder}/messages`, qs, limit)))).flat()
      : await graphList(this, OUTLOOK, '/me/messages', qs, limit);
    if (!manual) {
      const newest = messages.map((m) => String(m.receivedDateTime)).sort().at(-1);
      state.lastTimeChecked = newest && newest > String(state.lastTimeChecked) ? newest : state.lastTimeChecked;
    }
    if (!messages.length) return null;
    const simplify = this.getNodeParameter('simplify', true) as boolean;
    const items: INodeExecutionData[] = messages.map((m) => ({ json: simplify ? simplifyOutlookMessage(m) : m }));
    return [items];
  },
};

/* ======================= Teams ======================= */

const TEAMS = 'microsoftTeamsOAuth2Api';

const teamsProperties: INodeProperties[] = [
  { displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true, default: 'channelMessage', options: [{ name: 'Channel', value: 'channel' }, { name: 'Channel Message', value: 'channelMessage' }, { name: 'Chat Message', value: 'chatMessage' }, { name: 'Task', value: 'task' }] },
  operationProp('channel', [{ name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }, { name: 'Update', value: 'update' }]),
  operationProp('channelMessage', [{ name: 'Create', value: 'create' }, { name: 'Get Many', value: 'getAll' }]),
  operationProp('chatMessage', [{ name: 'Create', value: 'create' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }]),
  operationProp('task', [{ name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }, { name: 'Update', value: 'update' }]),

  ...forOp('channel', ['create', 'delete', 'get', 'getAll', 'update'], [{ displayName: 'Team ID', name: 'teamId', type: 'string', default: '', required: true }]),
  ...forOp('channel', ['delete', 'get', 'update'], [{ displayName: 'Channel ID', name: 'channelId', type: 'string', default: '', required: true }]),
  ...forOp('channel', 'create', [
    { displayName: 'Name', name: 'name', type: 'string', default: '', required: true },
    collection('options', 'Options', [{ displayName: 'Description', name: 'description', type: 'string', default: '' }, { displayName: 'Type', name: 'type', type: 'options', default: 'standard', options: [{ name: 'Private', value: 'private' }, { name: 'Shared', value: 'shared' }, { name: 'Standard', value: 'standard' }] }]),
  ]),
  ...forOp('channel', 'update', [collection('updateFields', 'Update Fields', [{ displayName: 'Name', name: 'name', type: 'string', default: '' }, { displayName: 'Description', name: 'description', type: 'string', default: '' }])]),
  ...forOp('channel', 'getAll', returnAllProps({ resource: ['channel'], operation: ['getAll'] })),

  ...forOp('channelMessage', ['create', 'getAll'], [{ displayName: 'Team ID', name: 'teamId', type: 'string', default: '', required: true }, { displayName: 'Channel ID', name: 'channelId', type: 'string', default: '', required: true }]),
  ...forOp('chatMessage', ['create', 'get', 'getAll'], [{ displayName: 'Chat ID', name: 'chatId', type: 'string', default: '', required: true }]),
  ...forOp('chatMessage', 'get', [{ displayName: 'Message ID', name: 'messageId', type: 'string', default: '', required: true }]),
  {
    displayName: 'Content Type',
    name: 'contentType',
    type: 'options',
    default: 'text',
    options: [{ name: 'HTML', value: 'html' }, { name: 'Text', value: 'text' }],
    displayOptions: { show: { resource: ['channelMessage', 'chatMessage'], operation: ['create'] } },
  },
  { displayName: 'Message', name: 'message', type: 'string', typeOptions: { rows: 4 }, default: '', required: true, displayOptions: { show: { resource: ['channelMessage', 'chatMessage'], operation: ['create'] } } },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    displayOptions: { show: { resource: ['channelMessage', 'chatMessage'], operation: ['create'] } },
    options: [
      { displayName: 'Reply to Message ID', name: 'makeReply', type: 'string', default: '', description: 'Channel messages only: post as a reply in this thread' },
    ],
  },
  ...forOp('channelMessage', 'getAll', returnAllProps({ resource: ['channelMessage'], operation: ['getAll'] })),
  ...forOp('chatMessage', 'getAll', returnAllProps({ resource: ['chatMessage'], operation: ['getAll'] })),

  ...forOp('task', 'create', [
    { displayName: 'Plan ID', name: 'planId', type: 'string', default: '', required: true },
    { displayName: 'Bucket ID', name: 'bucketId', type: 'string', default: '', required: true },
    { displayName: 'Title', name: 'title', type: 'string', default: '', required: true },
  ]),
  ...forOp('task', ['delete', 'get', 'update'], [{ displayName: 'Task ID', name: 'taskId', type: 'string', default: '', required: true }]),
  ...forOp('task', ['create', 'update'], [collection('taskFields', 'Fields', [
    { displayName: 'Assigned To (User IDs)', name: 'assignedTo', type: 'string', default: '' },
    { displayName: 'Bucket ID', name: 'bucketId', type: 'string', default: '' },
    { displayName: 'Due Date', name: 'dueDateTime', type: 'dateTime', default: '' },
    { displayName: 'Percent Complete', name: 'percentComplete', type: 'number', default: 0, typeOptions: { minValue: 0, maxValue: 100 } },
    { displayName: 'Title', name: 'title', type: 'string', default: '' },
  ])]),
  ...forOp('task', 'getAll', [
    { displayName: 'Tasks For', name: 'tasksFor', type: 'options', default: 'member', options: [{ name: 'Me (Assigned)', value: 'member' }, { name: 'Plan', value: 'plan' }] },
    { displayName: 'Plan ID', name: 'planId', type: 'string', default: '', displayOptions: { show: { tasksFor: ['plan'] } } },
    ...returnAllProps({ resource: ['task'], operation: ['getAll'] }),
  ]),
];

function plannerTask(f: IDataObject): IDataObject {
  const t: IDataObject = {};
  if (f.title) t.title = f.title;
  if (f.bucketId) t.bucketId = f.bucketId;
  if (f.dueDateTime) t.dueDateTime = new Date(String(f.dueDateTime)).toISOString();
  if (f.percentComplete !== undefined) t.percentComplete = f.percentComplete;
  if (f.assignedTo) t.assignments = Object.fromEntries(csv(f.assignedTo).map((id) => [id, { '@odata.type': 'microsoft.graph.plannerAssignment', orderHint: ' !' }]));
  return t;
}

export const MicrosoftTeams: INodeType = {
  description: {
    name: 'flowmator.microsoftTeams',
    displayName: 'Microsoft Teams',
    description: 'Channels, channel and chat messages, and Planner tasks in Microsoft Teams',
    group: ['input'],
    version: [1, 1.1, 2],
    defaults: { name: 'Microsoft Teams', color: '#5059C9' },
    icon: 'fa:microsoft',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: TEAMS, required: true }],
    codex: { categories: ['Communication'], alias: ['Chat', 'Planner'] },
    properties: teamsProperties,
  },
  async execute(this: IExecuteFunctions) {
    return [
      await forEachItem(this, async (i) => {
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (method: Method, path: string, body?: unknown, qs?: IDataObject, extra?: Parameters<typeof graph>[7]) => graph(this, TEAMS, method, path, body, qs, i, extra);
        const list = (path: string, qs: IDataObject = {}) => graphList(this, TEAMS, path, qs, listLimit(this, i), i);
        const resource = p('resource');
        const op = p('operation');

        if (resource === 'channel') {
          const base = `/teams/${p('teamId')}/channels`;
          if (op === 'create') {
            const o = p<IDataObject>('options', {});
            return call('POST', base, { displayName: p('name'), ...(o.description ? { description: o.description } : {}), membershipType: o.type ?? 'standard' });
          }
          if (op === 'get') return call('GET', `${base}/${p('channelId')}`);
          if (op === 'getAll') return list(base);
          if (op === 'delete') {
            await call('DELETE', `${base}/${p('channelId')}`);
            return { success: true };
          }
          const f = p<IDataObject>('updateFields', {});
          await call('PATCH', `${base}/${p('channelId')}`, { ...(f.name ? { displayName: f.name } : {}), ...(f.description !== undefined ? { description: f.description } : {}) });
          return { success: true };
        }

        if (resource === 'channelMessage' || resource === 'chatMessage') {
          const base = resource === 'channelMessage' ? `/teams/${p('teamId')}/channels/${p('channelId')}/messages` : `/chats/${p('chatId')}/messages`;
          if (op === 'get') return call('GET', `${base}/${p('messageId')}`);
          if (op === 'getAll') return list(base);
          const o = p<IDataObject>('options', {});
          const target = resource === 'channelMessage' && o.makeReply ? `${base}/${o.makeReply}/replies` : base;
          return call('POST', target, { body: { contentType: p('contentType', 'text'), content: p('message') } });
        }

        // Planner tasks
        if (op === 'create') return call('POST', '/planner/tasks', { planId: p('planId'), ...plannerTask({ ...p<IDataObject>('taskFields', {}), bucketId: p('bucketId'), title: p('title') }) });
        if (op === 'get') return call('GET', `/planner/tasks/${p('taskId')}`);
        if (op === 'getAll') return p('tasksFor', 'member') === 'plan' ? list(`/planner/plans/${p('planId')}/tasks`) : list('/me/planner/tasks');
        // updates and deletes need the task's current ETag
        const current = await call('GET', `/planner/tasks/${p('taskId')}`);
        const etag = String(current['@odata.etag']);
        if (op === 'delete') {
          await call('DELETE', `/planner/tasks/${p('taskId')}`, undefined, undefined, { headers: { 'If-Match': etag } });
          return { success: true };
        }
        await call('PATCH', `/planner/tasks/${p('taskId')}`, plannerTask(p<IDataObject>('taskFields', {})), undefined, { headers: { 'If-Match': etag } });
        return { success: true };
      }),
    ];
  },
};

/* ======================= OneDrive ======================= */

const ONEDRIVE = 'microsoftOneDriveOAuth2Api';

/** Path-addressed drive item: /me/drive/root:/a/b.txt: */
export const driveItemPath = (p: string) => `/me/drive/root:/${p.replace(/^\/+|\/+$/g, '').split('/').map(encodeURIComponent).join('/')}:`;
/** IDs, or "/folder/file" paths. */
const itemRef = (idOrPath: string) => (idOrPath.startsWith('/') ? driveItemPath(idOrPath) : `/me/drive/items/${idOrPath}`);

const oneDriveProperties: INodeProperties[] = [
  { displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true, default: 'file', options: [{ name: 'File', value: 'file' }, { name: 'Folder', value: 'folder' }] },
  operationProp('file', [
    { name: 'Copy', value: 'copy' },
    { name: 'Delete', value: 'delete' },
    { name: 'Download', value: 'download' },
    { name: 'Get', value: 'get' },
    { name: 'Rename', value: 'rename' },
    { name: 'Search', value: 'search' },
    { name: 'Share', value: 'share' },
    { name: 'Upload', value: 'upload' },
  ], 'upload'),
  operationProp('folder', [
    { name: 'Create', value: 'create' },
    { name: 'Delete', value: 'delete' },
    { name: 'Get Items', value: 'getChildren' },
    { name: 'Rename', value: 'rename' },
    { name: 'Search', value: 'search' },
    { name: 'Share', value: 'share' },
  ]),
  ...forOp('file', ['copy', 'delete', 'download', 'get', 'rename', 'share'], [{ displayName: 'File ID', name: 'fileId', type: 'string', default: '', required: true, description: 'Item ID, or a path starting with "/"' }]),
  ...forOp('folder', ['delete', 'getChildren', 'rename', 'share'], [{ displayName: 'Folder ID', name: 'folderId', type: 'string', default: '', description: 'Item ID, or a path starting with "/"; empty is the root' }]),
  ...forOp('file', 'copy', [{ displayName: 'Parent Folder ID', name: 'parentReference', type: 'string', default: '', required: true }, collection('additionalFields', 'Additional Fields', [{ displayName: 'New Name', name: 'name', type: 'string', default: '' }])]),
  ...forOp('file', 'download', [{ displayName: 'Put Output File in Field', name: 'binaryPropertyName', type: 'string', default: 'data' }]),
  { displayName: 'New Name', name: 'newName', type: 'string', default: '', required: true, displayOptions: { show: { resource: ['file', 'folder'], operation: ['rename'] } } },
  { displayName: 'Query', name: 'query', type: 'string', default: '', required: true, displayOptions: { show: { resource: ['file', 'folder'], operation: ['search'] } } },
  { displayName: 'Type', name: 'type', type: 'options', default: 'view', options: [{ name: 'View', value: 'view' }, { name: 'Edit', value: 'edit' }, { name: 'Embed', value: 'embed' }], displayOptions: { show: { resource: ['file', 'folder'], operation: ['share'] } } },
  { displayName: 'Scope', name: 'scope', type: 'options', default: 'anonymous', options: [{ name: 'Anyone With the Link', value: 'anonymous' }, { name: 'People in My Organization', value: 'organization' }], displayOptions: { show: { resource: ['file', 'folder'], operation: ['share'] } } },
  ...forOp('file', 'upload', [
    { displayName: 'File Name', name: 'fileName', type: 'string', default: '', placeholder: 'report.pdf', description: 'Defaults to the binary file name' },
    { displayName: 'Parent Folder ID', name: 'parentId', type: 'string', default: '', description: 'Item ID, or a path starting with "/"; empty is the root' },
    { displayName: 'Binary File', name: 'binaryData', type: 'boolean', default: true },
    { displayName: 'Input Binary Field', name: 'binaryPropertyName', type: 'string', default: 'data', displayOptions: { show: { binaryData: [true] } } },
    { displayName: 'File Content', name: 'fileContent', type: 'string', default: '', displayOptions: { show: { binaryData: [false] } } },
    { displayName: 'If File Exists', name: 'conflict', type: 'options', default: 'replace', options: [{ name: 'Replace', value: 'replace' }, { name: 'Rename', value: 'rename' }, { name: 'Fail', value: 'fail' }] },
  ]),
  ...forOp('folder', 'create', [
    { displayName: 'Name', name: 'name', type: 'string', default: '', required: true, placeholder: 'invoices/2026', description: 'Slashes create nested folders' },
    collection('options', 'Options', [{ displayName: 'Parent Folder ID', name: 'parentFolderId', type: 'string', default: '' }]),
  ]),
];

const childrenOf = (folder: string) => (folder ? `${itemRef(folder)}/children` : '/me/drive/root/children');

export const MicrosoftOneDrive: INodeType = {
  description: {
    name: 'flowmator.microsoftOneDrive',
    displayName: 'Microsoft OneDrive',
    description: 'Upload, download, share and organise files in OneDrive',
    group: ['input'],
    version: 1,
    defaults: { name: 'Microsoft OneDrive', color: '#0078D4' },
    icon: 'fa:microsoft',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: ONEDRIVE, required: true }],
    codex: { categories: ['Data & Storage'], alias: ['Files', 'SharePoint', 'Cloud Storage'] },
    properties: oneDriveProperties,
  },
  async execute(this: IExecuteFunctions) {
    return [
      await forEachItem(this, async (i, item) => {
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (method: Method, path: string, body?: unknown, qs?: IDataObject, extra?: Parameters<typeof graph>[7]) => graph(this, ONEDRIVE, method, path, body, qs, i, extra);
        const resource = p('resource');
        const op = p('operation');
        const ref = () => itemRef(resource === 'file' ? p('fileId') : p('folderId', ''));

        if (op === 'delete') {
          await call('DELETE', ref());
          return { success: true };
        }
        if (op === 'rename') return call('PATCH', ref(), { name: p('newName') });
        if (op === 'share') return call('POST', `${ref()}/createLink`, { type: p('type', 'view'), scope: p('scope', 'anonymous') });
        if (op === 'search') {
          const r = await call('GET', `/me/drive/root/search(q='${encodeURIComponent(p('query').replace(/'/g, "''"))}')`);
          const all = (r.value as IDataObject[]) ?? [];
          return all.filter((x) => (resource === 'folder' ? x.folder : x.file));
        }

        if (resource === 'folder') {
          if (op === 'getChildren') return graphList(this, ONEDRIVE, childrenOf(p('folderId', '')), {}, undefined, i);
          // create, one level at a time so "a/b/c" works
          let parent = String(p<IDataObject>('options', {}).parentFolderId ?? '');
          let created: IDataObject = {};
          for (const name of p('name').split('/').filter(Boolean)) {
            created = await call('POST', childrenOf(parent), { name, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' });
            parent = String(created.id);
          }
          return created;
        }

        if (op === 'get') return call('GET', ref());
        if (op === 'copy') {
          const f = p<IDataObject>('additionalFields', {});
          const target = p('parentReference');
          const parentReference = target.startsWith('/') ? { driveId: (await call('GET', '/me/drive')).id, path: `/drive/root:${target}` } : { id: target };
          await call('POST', `${ref()}/copy`, { parentReference, ...(f.name ? { name: f.name } : {}) });
          return { success: true };
        }
        if (op === 'download') {
          const meta = await call('GET', ref());
          const data = (await call('GET', `${ref()}/content`, undefined, undefined, { json: false, encoding: 'arraybuffer' })) as ArrayBuffer;
          return { json: { ...item.json, ...meta }, binary: { ...(item.binary ?? {}), [p('binaryPropertyName', 'data')]: await this.helpers.prepareBinaryData(Buffer.from(data), String(meta.name), String((meta.file as IDataObject)?.mimeType ?? '')) } };
        }

        // upload
        let data: Buffer;
        let name = p('fileName', '');
        let mime = 'text/plain';
        if (p<boolean>('binaryData', true)) {
          const prop = p('binaryPropertyName', 'data');
          const bin = this.helpers.assertBinaryData(i, prop);
          data = await this.helpers.getBinaryDataBuffer(i, prop);
          name ||= bin.fileName ?? prop;
          mime = bin.mimeType;
        } else data = Buffer.from(String(p('fileContent', '')), 'utf8');
        if (!name) throw new Error('Set the file name');
        const parent = p('parentId', '');
        const target = parent.startsWith('/') ? driveItemPath(`${parent}/${name}`) : parent ? `/me/drive/items/${parent}:/${encodeURIComponent(name)}:` : driveItemPath(name);
        const conflict = p('conflict', 'replace');
        if (data.length <= 4 * 1024 * 1024) {
          return call('PUT', `${target}/content`, new Uint8Array(data), { '@microsoft.graph.conflictBehavior': conflict }, { headers: { 'Content-Type': mime } });
        }
        // larger files go through an upload session, in 10 MiB chunks (a multiple of 320 KiB)
        const session = await call('POST', `${target}/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': conflict } });
        const chunk = 32 * 320 * 1024;
        let result: IDataObject = {};
        for (let start = 0; start < data.length; start += chunk) {
          const part = data.subarray(start, start + chunk);
          const res = await fetch(String(session.uploadUrl), { method: 'PUT', headers: { 'Content-Length': String(part.length), 'Content-Range': `bytes ${start}-${start + part.length - 1}/${data.length}` }, body: new Uint8Array(part) });
          if (!res.ok) throw new Error(`OneDrive upload failed: ${res.status} ${await res.text()}`);
          if (res.status === 200 || res.status === 201) result = (await res.json()) as IDataObject;
        }
        return result;
      }),
    ];
  },
};

/* ======================= Credentials ======================= */

const microsoftOAuth2 = (name: string, displayName: string, scope: string): ICredentialType => ({
  name,
  displayName,
  extends: name === 'microsoftOAuth2Api' ? ['oAuth2Api'] : ['microsoftOAuth2Api', 'oAuth2Api'],
  documentationUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  properties: [
    { displayName: 'Client ID', name: 'clientId', type: 'string', default: '', description: 'Application (client) ID of your Entra app registration' },
    { displayName: 'Client Secret', name: 'clientSecret', type: 'string', typeOptions: { password: true }, default: '' },
    { displayName: 'Grant Type', name: 'grantType', type: 'hidden', default: 'authorizationCode' },
    { displayName: 'Authorization URL', name: 'authUrl', type: 'hidden', default: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' },
    { displayName: 'Access Token URL', name: 'accessTokenUrl', type: 'hidden', default: 'https://login.microsoftonline.com/common/oauth2/v2.0/token' },
    { displayName: 'Scope', name: 'scope', type: 'string', default: `openid offline_access ${scope}`, description: 'Space separated' },
    { displayName: 'Auth URI Query Parameters', name: 'authQueryParameters', type: 'hidden', default: 'response_mode=query' },
    { displayName: 'Authentication', name: 'authentication', type: 'hidden', default: 'body' },
    { displayName: 'Token Data', name: 'oauthTokenData', type: 'hidden', default: {} },
  ],
});

export const microsoftCredentials: ICredentialType[] = [
  microsoftOAuth2('microsoftOAuth2Api', 'Microsoft OAuth2 (any Graph API)', 'User.Read'),
  microsoftOAuth2('microsoftOutlookOAuth2Api', 'Microsoft Outlook OAuth2', 'Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite MailboxSettings.Read User.Read'),
  microsoftOAuth2('microsoftTeamsOAuth2Api', 'Microsoft Teams OAuth2', 'User.Read Team.ReadBasic.All Channel.ReadBasic.All Channel.Create Channel.Delete.All ChannelSettings.ReadWrite.All ChannelMessage.Send ChannelMessage.Read.All Chat.ReadWrite Group.ReadWrite.All Tasks.ReadWrite'),
  microsoftOAuth2('microsoftOneDriveOAuth2Api', 'Microsoft OneDrive OAuth2', 'Files.ReadWrite.All User.Read'),
];
