import { randomBytes } from 'node:crypto';
import type { IBinaryData, IDataObject, IExecuteFunctions, IHelpers, INodeExecutionData, INodeProperties, INodeType, IPollFunctions } from '@8n8/workflow';
import { apiRequest, collectPages, forEachItem, forOp, listLimit, operationProp, pollTimesProp, returnAllProps } from '../../utils/api';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const credTypeOf = (auth: unknown) => (auth === 'serviceAccount' ? 'googleApi' : 'gmailOAuth2');

/* ---------------- MIME ---------------- */

export interface MailInput {
  from?: string;
  to: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{ fileName: string; mimeType: string; content: Buffer }>;
}

/** RFC 2047 encoded-word for non-ASCII header values. */
const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`);
const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const boundary = () => `8n8_${randomBytes(12).toString('hex')}`;

function bodyPart(contentType: string, content: string) {
  return `Content-Type: ${contentType}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(Buffer.from(content, 'utf8').toString('base64'))}`;
}

/** Builds an RFC 5322 message: text and/or HTML (multipart/alternative), plus attachments (multipart/mixed). */
export function buildMime(m: MailInput): string {
  const headers = [
    m.from && `From: ${encodeHeader(m.from)}`,
    `To: ${m.to}`,
    m.cc && `Cc: ${m.cc}`,
    m.bcc && `Bcc: ${m.bcc}`,
    m.replyTo && `Reply-To: ${m.replyTo}`,
    `Subject: ${encodeHeader(m.subject ?? '')}`,
    m.inReplyTo && `In-Reply-To: ${m.inReplyTo}`,
    m.references && `References: ${m.references}`,
    'MIME-Version: 1.0',
  ].filter(Boolean) as string[];

  let content: string;
  if (m.text !== undefined && m.html !== undefined) {
    const b = boundary();
    content = `Content-Type: multipart/alternative; boundary="${b}"\r\n\r\n--${b}\r\n${bodyPart('text/plain', m.text)}\r\n--${b}\r\n${bodyPart('text/html', m.html)}\r\n--${b}--`;
  } else {
    content = m.html !== undefined ? bodyPart('text/html', m.html) : bodyPart('text/plain', m.text ?? '');
  }

  if (m.attachments?.length) {
    const b = boundary();
    const parts = m.attachments.map(
      (a) =>
        `Content-Type: ${a.mimeType}; name="${encodeHeader(a.fileName)}"\r\nContent-Disposition: attachment; filename="${encodeHeader(a.fileName)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(a.content.toString('base64'))}`,
    );
    content = `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${content}\r\n${parts.map((p) => `--${b}\r\n${p}\r\n`).join('')}--${b}--`;
  }
  return `${headers.join('\r\n')}\r\n${content}`;
}

/* ---------------- message parsing ---------------- */

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

const decode = (data?: string) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

/** Flattens a Gmail message: headers, text/html bodies and attachment references. */
export function simplifyMessage(msg: IDataObject) {
  const payload = (msg.payload ?? {}) as GmailPart;
  const headers: Record<string, string> = {};
  for (const h of payload.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  let text = '';
  let html = '';
  const attachments: Array<{ filename: string; mimeType: string; attachmentId: string; size: number }> = [];
  const walk = (p: GmailPart) => {
    if (p.filename && p.body?.attachmentId) attachments.push({ filename: p.filename, mimeType: p.mimeType ?? 'application/octet-stream', attachmentId: p.body.attachmentId, size: p.body.size ?? 0 });
    else if (p.mimeType === 'text/plain' && !text) text = decode(p.body?.data);
    else if (p.mimeType === 'text/html' && !html) html = decode(p.body?.data);
    p.parts?.forEach(walk);
  };
  walk(payload);
  return {
    json: {
      id: msg.id,
      threadId: msg.threadId,
      labelIds: msg.labelIds,
      snippet: msg.snippet,
      from: headers.from,
      to: headers.to,
      cc: headers.cc,
      subject: headers.subject,
      date: headers.date,
      messageId: headers['message-id'],
      text,
      html,
      attachments: attachments.map(({ filename, mimeType, size }) => ({ filename, mimeType, size })),
    } as IDataObject,
    attachments,
  };
}

async function gmail(ctx: { helpers: IHelpers }, auth: unknown, method: 'GET' | 'POST' | 'DELETE' | 'PUT', path: string, body?: IDataObject, qs?: IDataObject, i = 0) {
  return apiRequest<IDataObject>(ctx, credTypeOf(auth), { url: `${API}${path}`, method, ...(body ? { body } : {}), ...(qs ? { qs } : {}) }, i);
}

/** Message as an item; attachments optionally downloaded into binary fields. */
async function messageItem(ctx: { helpers: IHelpers }, auth: unknown, raw: IDataObject, simple: boolean, download: boolean, i = 0): Promise<INodeExecutionData> {
  const { json, attachments } = simplifyMessage(raw);
  const item: INodeExecutionData = { json: simple ? json : raw };
  if (download && attachments.length) {
    item.binary = {};
    for (const [n, a] of attachments.entries()) {
      const r = await gmail(ctx, auth, 'GET', `/messages/${raw.id}/attachments/${a.attachmentId}`, undefined, undefined, i);
      item.binary[`attachment_${n}`] = (await ctx.helpers.prepareBinaryData(Buffer.from(String(r.data), 'base64url'), a.filename, a.mimeType)) as IBinaryData;
    }
  }
  return item;
}

const authProp: INodeProperties = {
  displayName: 'Authentication',
  name: 'authentication',
  type: 'options',
  default: 'oAuth2',
  options: [{ name: 'OAuth2 (recommended)', value: 'oAuth2' }, { name: 'Service Account', value: 'serviceAccount' }],
};
const credentials = [
  { name: 'gmailOAuth2', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
  { name: 'googleApi', required: true, displayOptions: { show: { authentication: ['serviceAccount'] } } },
];

const filterProps: INodeProperties = {
  displayName: 'Filters',
  name: 'filters',
  type: 'collection',
  default: {},
  options: [
    { displayName: 'Search', name: 'q', type: 'string', default: '', placeholder: 'has:attachment from:boss@example.com', description: 'Gmail search syntax' },
    { displayName: 'Label IDs', name: 'labelIds', type: 'string', default: '', description: 'Comma separated, e.g. INBOX, UNREAD' },
    { displayName: 'Read Status', name: 'readStatus', type: 'options', default: 'both', options: [{ name: 'Unread and Read', value: 'both' }, { name: 'Unread Only', value: 'unread' }, { name: 'Read Only', value: 'read' }] },
    { displayName: 'Sender', name: 'sender', type: 'string', default: '' },
    { displayName: 'Include Spam and Trash', name: 'includeSpamTrash', type: 'boolean', default: false },
    { displayName: 'Received After', name: 'receivedAfter', type: 'dateTime', default: '' },
    { displayName: 'Received Before', name: 'receivedBefore', type: 'dateTime', default: '' },
  ],
};

/** Gmail search query from the filter collection. */
export function buildQuery(f: IDataObject, afterSeconds?: number): IDataObject {
  const q = [String(f.q ?? '')];
  if (f.readStatus === 'unread') q.push('is:unread');
  if (f.readStatus === 'read') q.push('is:read');
  if (f.sender) q.push(`from:${f.sender}`);
  if (f.receivedAfter) q.push(`after:${Math.floor(new Date(String(f.receivedAfter)).getTime() / 1000)}`);
  if (f.receivedBefore) q.push(`before:${Math.floor(new Date(String(f.receivedBefore)).getTime() / 1000)}`);
  if (afterSeconds) q.push(`after:${afterSeconds}`);
  const labels = String(f.labelIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { q: q.filter(Boolean).join(' '), ...(labels.length ? { labelIds: labels } : {}), ...(f.includeSpamTrash ? { includeSpamTrash: true } : {}) };
}

const composeProps = (ops: string[]): INodeProperties[] =>
  forOp('message', ops, [
    { displayName: 'Subject', name: 'subject', type: 'string', default: '', displayOptions: { show: { operation: ops.filter((o) => o !== 'reply') } } },
    { displayName: 'Email Type', name: 'emailType', type: 'options', default: 'html', options: [{ name: 'HTML', value: 'html' }, { name: 'Text', value: 'text' }] },
    { displayName: 'Message', name: 'message', type: 'string', typeOptions: { rows: 5 }, default: '' },
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      options: [
        { displayName: 'Attachments (binary fields)', name: 'attachments', type: 'string', default: '', description: 'Comma separated binary field names' },
        { displayName: 'CC', name: 'ccList', type: 'string', default: '' },
        { displayName: 'BCC', name: 'bccList', type: 'string', default: '' },
        { displayName: 'Reply To', name: 'replyTo', type: 'string', default: '' },
        { displayName: 'Sender Name', name: 'senderName', type: 'string', default: '' },
        { displayName: 'Reply to Sender Only', name: 'replyToSenderOnly', type: 'boolean', default: false },
      ],
    },
  ]);

export const Gmail: INodeType = {
  description: {
    name: '8n8.gmail',
    displayName: 'Gmail',
    description: 'Send, read and organize Gmail messages',
    group: ['transform'],
    version: [2, 2.1],
    defaults: { name: 'Gmail', color: '#ea4335' },
    icon: 'fa:gmail',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials,
    codex: { categories: ['Communication'] },
    properties: [
      authProp,
      { displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true, default: 'message', options: [{ name: 'Message', value: 'message' }, { name: 'Label', value: 'label' }, { name: 'Draft', value: 'draft' }] },
      operationProp('message', [
        { name: 'Send', value: 'send' },
        { name: 'Reply', value: 'reply' },
        { name: 'Get', value: 'get' },
        { name: 'Get Many', value: 'getAll' },
        { name: 'Mark as Read', value: 'markAsRead' },
        { name: 'Mark as Unread', value: 'markAsUnread' },
        { name: 'Add Labels', value: 'addLabels' },
        { name: 'Remove Labels', value: 'removeLabels' },
        { name: 'Delete', value: 'delete' },
      ]),
      operationProp('label', [{ name: 'Get Many', value: 'getAll' }, { name: 'Create', value: 'create' }]),
      operationProp('draft', [{ name: 'Create', value: 'create' }]),

      ...forOp('message', ['send'], [{ displayName: 'To', name: 'sendTo', type: 'string', default: '', required: true, placeholder: 'a@example.com, b@example.com' }]),
      ...forOp('draft', ['create'], [
        { displayName: 'To', name: 'sendTo', type: 'string', default: '' },
        { displayName: 'Subject', name: 'subject', type: 'string', default: '' },
        { displayName: 'Email Type', name: 'emailType', type: 'options', default: 'html', options: [{ name: 'HTML', value: 'html' }, { name: 'Text', value: 'text' }] },
        { displayName: 'Message', name: 'message', type: 'string', typeOptions: { rows: 5 }, default: '' },
      ]),
      ...forOp('message', ['reply', 'get', 'markAsRead', 'markAsUnread', 'addLabels', 'removeLabels', 'delete'], [{ displayName: 'Message ID', name: 'messageId', type: 'string', default: '', required: true }]),
      ...composeProps(['send', 'reply']),
      ...forOp('message', ['addLabels', 'removeLabels'], [{ displayName: 'Label IDs', name: 'labelIds', type: 'string', default: '', required: true, description: 'Comma separated' }]),
      ...forOp('message', ['get', 'getAll'], [
        { displayName: 'Simplify', name: 'simple', type: 'boolean', default: true },
        { displayName: 'Download Attachments', name: 'downloadAttachments', type: 'boolean', default: false },
      ]),
      ...forOp('message', 'getAll', [...returnAllProps({ resource: ['message'], operation: ['getAll'] }), filterProps]),
      ...forOp('label', 'create', [{ displayName: 'Name', name: 'name', type: 'string', default: '', required: true }]),
    ],
  },
  async execute(this: IExecuteFunctions) {
    return [
      await forEachItem(this, async (i, item) => {
        const resource = this.getNodeParameter('resource', i) as string;
        const op = this.getNodeParameter('operation', i) as string;
        const auth = this.getNodeParameter('authentication', i, 'oAuth2');
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (method: 'GET' | 'POST' | 'DELETE' | 'PUT', path: string, body?: IDataObject, qs?: IDataObject) => gmail(this, auth, method, path, body, qs, i);
        const csv = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

        const compose = async (extra: Partial<MailInput>): Promise<string> => {
          const o = p<IDataObject>('options', {});
          const body = p('message', '');
          const attachments: NonNullable<MailInput['attachments']> = [];
          for (const field of csv(String(o.attachments ?? ''))) {
            const bin = item.binary?.[field];
            if (!bin) throw new Error(`No binary field "${field}" on the input item`);
            attachments.push({ fileName: bin.fileName ?? field, mimeType: bin.mimeType, content: await this.helpers.getBinaryDataBuffer(i, field) });
          }
          const mime = buildMime({
            to: p('sendTo', ''),
            subject: p('subject', ''),
            ...(p('emailType', 'html') === 'html' ? { html: body } : { text: body }),
            ...(o.ccList ? { cc: String(o.ccList) } : {}),
            ...(o.bccList ? { bcc: String(o.bccList) } : {}),
            ...(o.replyTo ? { replyTo: String(o.replyTo) } : {}),
            // a display name needs the mailbox address to form a valid From header
            ...(o.senderName ? { from: `${String(o.senderName)} <${String((await call('GET', '/profile')).emailAddress)}>` } : {}),
            attachments,
            ...extra,
          });
          return Buffer.from(mime, 'utf8').toString('base64url');
        };

        if (resource === 'label') {
          if (op === 'create') return call('POST', '/labels', { name: p('name'), labelListVisibility: 'labelShow', messageListVisibility: 'show' });
          return ((await call('GET', '/labels')).labels as IDataObject[]) ?? [];
        }
        if (resource === 'draft') {
          return call('POST', '/drafts', { message: { raw: await compose({}) } });
        }

        const id = p('messageId', '');
        switch (op) {
          case 'send':
            return call('POST', '/messages/send', { raw: await compose({}) });
          case 'reply': {
            const original = simplifyMessage(await call('GET', `/messages/${id}`, undefined, { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'] })).json;
            const o = p<IDataObject>('options', {});
            const subject = String(original.subject ?? '');
            const raw = await compose({
              to: String(original.from ?? ''),
              ...(o.replyToSenderOnly ? {} : original.cc ? { cc: String(original.cc) } : {}),
              subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
              inReplyTo: original.messageId as string,
              references: original.messageId as string,
            });
            return call('POST', '/messages/send', { raw, threadId: original.threadId });
          }
          case 'get':
            return messageItem(this, auth, await call('GET', `/messages/${id}`, undefined, { format: 'full' }), p('simple', true), p('downloadAttachments', false), i);
          case 'getAll': {
            const qs = buildQuery(p<IDataObject>('filters', {}));
            const refs = await collectPages(async (cursor, size) => {
              const r = await call('GET', '/messages', undefined, { ...qs, maxResults: size, ...(cursor ? { pageToken: cursor } : {}) });
              return { items: (r.messages as IDataObject[]) ?? [], next: r.nextPageToken as string };
            }, listLimit(this, i), 100);
            const out: INodeExecutionData[] = [];
            for (const ref of refs) out.push(await messageItem(this, auth, await call('GET', `/messages/${ref.id}`, undefined, { format: 'full' }), p('simple', true), p('downloadAttachments', false), i));
            return out;
          }
          case 'markAsRead':
          case 'markAsUnread':
            return call('POST', `/messages/${id}/modify`, op === 'markAsRead' ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] });
          case 'addLabels':
          case 'removeLabels':
            return call('POST', `/messages/${id}/modify`, { [op === 'addLabels' ? 'addLabelIds' : 'removeLabelIds']: csv(p('labelIds')) });
          default:
            await call('DELETE', `/messages/${id}`);
            return { deleted: true, id };
        }
      }),
    ];
  },
};

export const GmailTrigger: INodeType = {
  description: {
    name: '8n8.gmailTrigger',
    displayName: 'Gmail Trigger',
    description: 'Starts the workflow when new emails arrive (checks on a schedule)',
    group: ['trigger'],
    version: [1, 1.1, 1.2],
    defaults: { name: 'Gmail Trigger', color: '#ea4335' },
    icon: 'fa:gmail',
    inputs: [],
    outputs: ['main'],
    credentials,
    polling: true,
    properties: [
      authProp,
      pollTimesProp,
      { displayName: 'Simplify', name: 'simple', type: 'boolean', default: true },
      { displayName: 'Download Attachments', name: 'downloadAttachments', type: 'boolean', default: false },
      filterProps,
    ],
  },
  async poll(this: IPollFunctions) {
    const auth = this.getNodeParameter('authentication', 'oAuth2');
    const state = this.getWorkflowStaticData('node');
    const now = Math.floor(Date.now() / 1000);
    const manual = this.getMode() === 'manual';
    // first activation: start from now instead of importing the whole mailbox
    if (!manual && state.lastTimeChecked === undefined) {
      state.lastTimeChecked = now;
      return null;
    }
    const since = manual ? undefined : (state.lastTimeChecked as number);
    const qs = buildQuery(this.getNodeParameter('filters', {}) as IDataObject, since);
    const list = await gmail(this, auth, 'GET', '/messages', undefined, { ...qs, maxResults: manual ? 1 : 50 });
    const refs = ((list.messages as IDataObject[]) ?? []).slice(0, manual ? 1 : 50);
    const seen = new Set((state.seenIds as string[]) ?? []);
    const items: INodeExecutionData[] = [];
    let newest = since ?? 0;
    for (const ref of refs.reverse()) {
      if (!manual && seen.has(String(ref.id))) continue;
      const raw = await gmail(this, auth, 'GET', `/messages/${ref.id}`, undefined, { format: 'full' });
      const received = Math.floor(Number(raw.internalDate) / 1000);
      // defensive: skip anything older than the last check even if the search returned it
      if (since && received < since) continue;
      newest = Math.max(newest, received);
      seen.add(String(ref.id));
      items.push(await messageItem(this, auth, raw, this.getNodeParameter('simple', true) as boolean, this.getNodeParameter('downloadAttachments', false) as boolean));
    }
    if (!manual) {
      state.lastTimeChecked = Math.max(newest, state.lastTimeChecked as number);
      state.seenIds = [...seen].slice(-500);
    }
    return items.length ? [items] : null;
  },
};
