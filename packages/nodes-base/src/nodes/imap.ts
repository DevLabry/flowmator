import { ImapFlow, type SearchObject } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { NodeOperationError, type IDataObject, type INodeExecutionData, type INodeType, type ITriggerFunctions } from '@8n8/workflow';

/* ---------------- Email Trigger (IMAP) ---------------- */

interface ImapCredentials {
  user: string;
  password: string;
  host: string;
  port?: number;
  secure?: boolean;
  allowUnauthorizedCerts?: boolean;
}

const FLAG_CRITERIA: Record<string, SearchObject> = {
  ALL: { all: true },
  ANSWERED: { answered: true },
  UNANSWERED: { answered: false },
  DELETED: { deleted: true },
  UNDELETED: { deleted: false },
  DRAFT: { draft: true },
  UNDRAFT: { draft: false },
  FLAGGED: { flagged: true },
  UNFLAGGED: { flagged: false },
  SEEN: { seen: true },
  UNSEEN: { seen: false },
  NEW: { new: true },
  OLD: { old: true },
  RECENT: { recent: true },
};

const VALUE_CRITERIA: Record<string, keyof SearchObject> = {
  SINCE: 'since',
  BEFORE: 'before',
  ON: 'on',
  SENTSINCE: 'sentSince',
  SENTBEFORE: 'sentBefore',
  SENTON: 'sentOn',
  FROM: 'from',
  TO: 'to',
  CC: 'cc',
  BCC: 'bcc',
  SUBJECT: 'subject',
  BODY: 'body',
  TEXT: 'text',
  UID: 'uid',
  LARGER: 'larger',
  SMALLER: 'smaller',
};

/**
 * Turns n8n's custom search rules (node-imap style, e.g. ["UNSEEN", ["SINCE", "May 20, 2024"]])
 * into an imapflow search query. All rules must match.
 */
export function imapSearchQuery(rules: unknown): SearchObject {
  const query: SearchObject = {};
  const add = (rule: unknown, into: SearchObject) => {
    const [key, ...args] = (Array.isArray(rule) ? rule : [rule]) as unknown[];
    const name = String(key).toUpperCase();
    if (FLAG_CRITERIA[name]) return Object.assign(into, FLAG_CRITERIA[name]);
    if (name === 'HEADER') return (into.header = { ...(into.header ?? {}), [String(args[0])]: String(args[1] ?? '') });
    const sub = (r: unknown) => {
      const q: SearchObject = {};
      add(r, q);
      return q;
    };
    if (name === 'OR') return (into.or = [...(into.or ?? []), ...args.map(sub)]);
    if (name === 'NOT') return (into.not = sub(args[0]));
    const field = VALUE_CRITERIA[name];
    if (!field) throw new Error(`Unsupported search rule "${key}"`);
    const value = args[0];
    if (field === 'larger' || field === 'smaller') (into as IDataObject)[field] = Number(value);
    else if (['since', 'before', 'on', 'sentSince', 'sentBefore', 'sentOn'].includes(field)) (into as IDataObject)[field] = new Date(String(value)) as never;
    else (into as IDataObject)[field] = String(value);
  };
  for (const rule of (rules as unknown[]) ?? []) add(rule, query);
  return Object.keys(query).length ? query : { all: true };
}

const addressText = (a?: AddressObject | AddressObject[]) => (a ? (Array.isArray(a) ? a.map((x) => x.text).join(', ') : a.text) : undefined);

export const EmailReadImap: INodeType = {
  description: {
    name: '8n8.emailReadImap',
    displayName: 'Email Trigger (IMAP)',
    description: 'Starts the workflow when an email arrives in an IMAP mailbox',
    group: ['trigger'],
    version: [2, 2.1],
    defaults: { name: 'Email Trigger (IMAP)', color: '#44AA22' },
    icon: 'fa:inbox',
    inputs: [],
    outputs: ['main'],
    credentials: [{ name: 'imap', required: true }],
    codex: { alias: ['Email', 'IMAP', 'Inbox', 'Mail'] },
    properties: [
      { displayName: 'Mailbox Name', name: 'mailbox', type: 'string', default: 'INBOX' },
      {
        displayName: 'Action',
        name: 'postProcessAction',
        type: 'options',
        default: 'read',
        description: 'What to do with an email once it has been received',
        options: [
          { name: 'Mark as Read', value: 'read' },
          { name: 'Nothing', value: 'nothing' },
        ],
      },
      {
        displayName: 'Format',
        name: 'format',
        type: 'options',
        default: 'simple',
        options: [
          { name: 'RAW', value: 'raw', description: 'The whole message as a base64url string' },
          { name: 'Resolved', value: 'resolved', description: 'Parsed message with attachments as binary data' },
          { name: 'Simple', value: 'simple', description: 'Headers and text; attachments only when downloaded' },
        ],
      },
      { displayName: 'Download Attachments', name: 'downloadAttachments', type: 'boolean', default: false, displayOptions: { show: { format: ['simple'] } } },
      {
        displayName: 'Property Prefix Name',
        name: 'dataPropertyAttachmentsPrefixName',
        type: 'string',
        default: 'attachment_',
        description: 'Attachments are stored in binary fields named prefix + index',
        displayOptions: { show: { format: ['resolved', 'simple'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          {
            displayName: 'Custom Email Rules',
            name: 'customEmailConfig',
            type: 'string',
            default: '["UNSEEN"]',
            description: 'Search rules as JSON, e.g. ["UNSEEN", ["SINCE", "May 20, 2024"], ["FROM", "boss@example.com"]]',
          },
          { displayName: 'Ignore SSL Issues (Insecure)', name: 'allowUnauthorizedCerts', type: 'boolean', default: false },
          { displayName: 'Force Reconnect Every Minutes', name: 'forceReconnect', type: 'number', default: 60, description: 'Reconnect periodically; 0 disables' },
          { displayName: 'Track Last Message', name: 'trackLastMessageId', type: 'boolean', default: true, description: 'Only return emails newer than the last one received, even if they match the rules again' },
        ],
      },
    ],
  },
  async trigger(this: ITriggerFunctions) {
    const creds = await this.getCredentials<ImapCredentials>('imap');
    const mailbox = (this.getNodeParameter('mailbox', 'INBOX') as string) || 'INBOX';
    const postProcess = this.getNodeParameter('postProcessAction', 'read') as string;
    const format = this.getNodeParameter('format', 'simple') as string;
    const downloadAttachments = format === 'resolved' || !!this.getNodeParameter('downloadAttachments', false);
    const prefix = (this.getNodeParameter('dataPropertyAttachmentsPrefixName', 'attachment_') as string) || 'attachment_';
    const options = this.getNodeParameter('options', {}) as IDataObject;
    let rules: unknown;
    try {
      rules = JSON.parse(String(options.customEmailConfig || '["UNSEEN"]'));
    } catch {
      throw new NodeOperationError(this.getNode(), 'Custom email rules must be valid JSON');
    }
    const criteria = imapSearchQuery(rules);
    const trackLast = options.trackLastMessageId !== false;
    const staticData = this.getWorkflowStaticData('node');

    const toItem = async (parsed: ParsedMail, raw: Buffer, uid: number): Promise<INodeExecutionData> => {
      if (format === 'raw') return { json: { raw: raw.toString('base64url'), uid } };
      const binary: NonNullable<INodeExecutionData['binary']> = {};
      if (downloadAttachments) {
        for (const [i, a] of parsed.attachments.entries()) binary[`${prefix}${i}`] = await this.helpers.prepareBinaryData(a.content, a.filename ?? `${prefix}${i}`, a.contentType);
      }
      let json: IDataObject;
      if (format === 'resolved') {
        const { attachments, headers, headerLines, ...rest } = parsed;
        json = { ...(JSON.parse(JSON.stringify(rest)) as IDataObject), headers: Object.fromEntries([...headers].map(([k, v]) => [k, typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v])), attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })) as never, uid };
      } else {
        json = {
          from: addressText(parsed.from),
          to: addressText(parsed.to),
          cc: addressText(parsed.cc),
          subject: parsed.subject,
          date: parsed.date?.toISOString(),
          messageId: parsed.messageId,
          textPlain: parsed.text,
          textHtml: parsed.html || undefined,
          metadata: Object.fromEntries(parsed.headerLines.map((h) => [h.key, h.line.slice(h.key.length + 1).trim()])),
          uid,
        };
      }
      return { json: JSON.parse(JSON.stringify(json)), ...(Object.keys(binary).length ? { binary } : {}) };
    };

    let client: ImapFlow | undefined;
    let closing = false;
    let reconnectTimer: NodeJS.Timeout | undefined;
    let chain = Promise.resolve();

    const fetchNew = async () => {
      if (!client?.usable) return;
      const lock = await client.getMailboxLock(mailbox);
      try {
        const last = Number(staticData.lastMessageUid ?? 0);
        const query: SearchObject = trackLast && last ? { ...criteria, uid: `${last + 1}:*` } : criteria;
        // "N:*" always matches the newest message even when its UID is below N
        const uids = ((await client.search(query, { uid: true })) || []).filter((u) => !trackLast || u > last).sort((a, b) => a - b);
        if (!uids.length) return;
        const items: INodeExecutionData[] = [];
        for (const uid of uids) {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          items.push(await toItem(await simpleParser(msg.source), msg.source, uid));
        }
        if (postProcess === 'read') await client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true });
        if (trackLast) staticData.lastMessageUid = uids[uids.length - 1];
        if (items.length) this.emit([items]);
      } finally {
        lock.release();
      }
    };
    const schedule = () => {
      chain = chain.then(fetchNew).catch((e) => this.emitError(e as Error));
      return chain;
    };

    const connect = async () => {
      const c = new ImapFlow({
        host: creds.host,
        port: Number(creds.port ?? 993),
        secure: creds.secure ?? true,
        auth: { user: creds.user, pass: creds.password },
        tls: { rejectUnauthorized: !(creds.allowUnauthorizedCerts || options.allowUnauthorizedCerts) },
        logger: false,
        // start IDLE soon after each fetch so new emails are announced right away
        autoIdleDelay: 1_000,
      });
      c.on('error', () => {});
      c.on('exists', () => void schedule());
      c.on('close', () => {
        if (closing || client !== c) return;
        reconnectTimer = setTimeout(() => void reconnect(), 5_000);
      });
      await c.connect();
      await c.mailboxOpen(mailbox);
      client = c;
    };
    const reconnect = async () => {
      if (closing) return;
      const old = client;
      client = undefined;
      await old?.logout().catch(() => {});
      try {
        await connect();
        await schedule();
      } catch (e) {
        this.emitError(e as Error);
        reconnectTimer = setTimeout(() => void reconnect(), 30_000);
      }
    };

    await connect();
    const minutes = Number(options.forceReconnect ?? 60);
    const forceTimer = minutes > 0 && this.getMode() !== 'manual' ? setInterval(() => void reconnect(), minutes * 60_000) : undefined;
    // emails that already match are picked up right away
    void schedule();

    return {
      closeFunction: async () => {
        closing = true;
        clearTimeout(reconnectTimer);
        if (forceTimer) clearInterval(forceTimer);
        await chain.catch(() => {});
        await client?.logout().catch(() => {});
      },
    };
  },
};
