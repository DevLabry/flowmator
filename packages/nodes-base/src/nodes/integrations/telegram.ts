import { createHash } from 'node:crypto';
import type { IDataObject, IExecuteFunctions, IHookFunctions, INodeType, IWebhookFunctions, IWebhookResult } from '@8n8/workflow';
import { forEachItem, forOp, jsonParam, operationProp } from '../../utils/api';

interface TelegramCreds {
  accessToken: string;
  baseUrl?: string;
}

type Helpers = IExecuteFunctions['helpers'];

/** Bot API call; `form` switches to multipart for file uploads. Telegram answers { ok, result | description }. */
async function telegram(helpers: Helpers, creds: TelegramCreds, method: string, body: IDataObject | FormData = {}) {
  const url = `${(creds.baseUrl || 'https://api.telegram.org').replace(/\/$/, '')}/bot${creds.accessToken}/${method}`;
  const res = (await helpers.httpRequest({ url, method: 'POST', body, json: true, ignoreHttpStatusErrors: true })) as { ok: boolean; result?: unknown; description?: string; error_code?: number };
  if (!res.ok) throw new Error(`Telegram error${res.error_code ? ` ${res.error_code}` : ''}: ${res.description ?? 'unknown error'}`);
  return res.result as IDataObject;
}

const FILE_OPS: Record<string, { method: string; field: string }> = {
  sendPhoto: { method: 'sendPhoto', field: 'photo' },
  sendDocument: { method: 'sendDocument', field: 'document' },
  sendAudio: { method: 'sendAudio', field: 'audio' },
  sendVideo: { method: 'sendVideo', field: 'video' },
};

const chatIdProp = { displayName: 'Chat ID', name: 'chatId', type: 'string' as const, default: '', required: true, description: 'Numeric chat id, or @channelusername' };

export const Telegram: INodeType = {
  description: {
    name: '8n8.telegram',
    displayName: 'Telegram',
    description: 'Send and manage messages with a Telegram bot',
    group: ['output'],
    version: [1, 1.1, 1.2],
    defaults: { name: 'Telegram', color: '#0088cc' },
    icon: 'fa:telegram',
    subtitle: '={{$parameter["operation"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'telegramApi', required: true }],
    codex: { categories: ['Communication'] },
    properties: [
      { displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true, default: 'message', options: [{ name: 'Message', value: 'message' }, { name: 'Chat', value: 'chat' }, { name: 'Callback', value: 'callback' }] },
      operationProp('message', [
        { name: 'Send Message', value: 'sendMessage' },
        { name: 'Send Photo', value: 'sendPhoto' },
        { name: 'Send Document', value: 'sendDocument' },
        { name: 'Send Audio', value: 'sendAudio' },
        { name: 'Send Video', value: 'sendVideo' },
        { name: 'Edit Message Text', value: 'editMessageText' },
        { name: 'Delete Message', value: 'deleteMessage' },
        { name: 'Pin Message', value: 'pinChatMessage' },
      ]),
      operationProp('chat', [{ name: 'Get', value: 'getChat' }, { name: 'Get Administrators', value: 'getChatAdministrators' }, { name: 'Leave', value: 'leaveChat' }]),
      operationProp('callback', [{ name: 'Answer Query', value: 'answerCallbackQuery' }]),

      ...forOp('message', ['sendMessage', 'sendPhoto', 'sendDocument', 'sendAudio', 'sendVideo', 'editMessageText', 'deleteMessage', 'pinChatMessage'], [chatIdProp]),
      ...forOp('chat', ['getChat', 'getChatAdministrators', 'leaveChat'], [chatIdProp]),
      ...forOp('message', ['editMessageText', 'deleteMessage', 'pinChatMessage'], [{ displayName: 'Message ID', name: 'messageId', type: 'string', default: '', required: true }]),
      ...forOp('message', ['sendMessage', 'editMessageText'], [{ displayName: 'Text', name: 'text', type: 'string', typeOptions: { rows: 3 }, default: '', required: true }]),
      ...forOp('message', ['sendPhoto', 'sendDocument', 'sendAudio', 'sendVideo'], [
        { displayName: 'Binary File', name: 'binaryData', type: 'boolean', default: false, description: 'Upload a file from the input instead of sending a URL or file_id' },
        { displayName: 'Input Binary Field', name: 'binaryPropertyName', type: 'string', default: 'data', displayOptions: { show: { binaryData: [true] } } },
        { displayName: 'File URL or file_id', name: 'file', type: 'string', default: '', displayOptions: { show: { binaryData: [false] } } },
        { displayName: 'Caption', name: 'caption', type: 'string', default: '' },
      ]),
      ...forOp('message', ['sendMessage', 'editMessageText', 'sendPhoto', 'sendDocument', 'sendAudio', 'sendVideo'], [
        {
          displayName: 'Additional Fields',
          name: 'additionalFields',
          type: 'collection',
          default: {},
          options: [
            { displayName: 'Parse Mode', name: 'parse_mode', type: 'options', default: 'HTML', options: [{ name: 'HTML', value: 'HTML' }, { name: 'MarkdownV2', value: 'MarkdownV2' }, { name: 'Markdown (legacy)', value: 'Markdown' }] },
            { displayName: 'Disable Link Preview', name: 'disable_web_page_preview', type: 'boolean', default: false },
            { displayName: 'Disable Notification', name: 'disable_notification', type: 'boolean', default: false },
            { displayName: 'Reply To Message ID', name: 'reply_to_message_id', type: 'number', default: 0 },
            { displayName: 'Message Thread ID (topics)', name: 'message_thread_id', type: 'number', default: 0 },
            { displayName: 'Reply Markup (JSON)', name: 'reply_markup', type: 'json', default: '{\n  "inline_keyboard": [[{ "text": "Open", "url": "https://example.com" }]]\n}' },
          ],
        },
      ]),
      ...forOp('message', 'pinChatMessage', [{ displayName: 'Disable Notification', name: 'disableNotification', type: 'boolean', default: false }]),
      ...forOp('callback', 'answerCallbackQuery', [
        { displayName: 'Query ID', name: 'queryId', type: 'string', default: '={{ $json.callback_query.id }}', required: true },
        { displayName: 'Text', name: 'text', type: 'string', default: '' },
        { displayName: 'Show Alert', name: 'showAlert', type: 'boolean', default: false },
      ]),
    ],
  },
  async execute(this: IExecuteFunctions) {
    const creds = await this.getCredentials<TelegramCreds>('telegramApi');
    return [
      await forEachItem(this, async (i) => {
        const op = this.getNodeParameter('operation', i) as string;
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (method: string, body: IDataObject | FormData) => telegram(this.helpers, creds, method, body);
        const chat_id = p('chatId', '');
        const extra = () => {
          const a = { ...p<IDataObject>('additionalFields', {}) };
          if (a.reply_markup) a.reply_markup = jsonParam(a.reply_markup, 'Reply Markup') as never;
          for (const k of ['reply_to_message_id', 'message_thread_id']) if (!a[k]) delete a[k];
          return a;
        };

        switch (op) {
          case 'sendMessage':
            return call('sendMessage', { chat_id, text: p('text'), ...extra() });
          case 'editMessageText':
            return call('editMessageText', { chat_id, message_id: Number(p('messageId')), text: p('text'), ...extra() });
          case 'deleteMessage':
            return { deleted: await call('deleteMessage', { chat_id, message_id: Number(p('messageId')) }) } as IDataObject;
          case 'pinChatMessage':
            return { pinned: await call('pinChatMessage', { chat_id, message_id: Number(p('messageId')), disable_notification: p('disableNotification', false) }) } as IDataObject;
          case 'getChat':
          case 'getChatAdministrators':
          case 'leaveChat': {
            const r = await call(op, { chat_id });
            return Array.isArray(r) ? (r as IDataObject[]) : typeof r === 'object' ? r : ({ result: r } as IDataObject);
          }
          case 'answerCallbackQuery':
            return { answered: await call('answerCallbackQuery', { callback_query_id: p('queryId'), text: p('text', ''), show_alert: p('showAlert', false) }) } as IDataObject;
        }

        const { method, field } = FILE_OPS[op];
        const fields: IDataObject = { chat_id, ...(p('caption', '') ? { caption: p('caption') } : {}), ...extra() };
        if (!p('binaryData', false)) return call(method, { ...fields, [field]: p('file') });
        const prop = p('binaryPropertyName', 'data');
        const bin = this.helpers.assertBinaryData(i, prop);
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        const buffer = await this.helpers.getBinaryDataBuffer(i, prop);
        form.append(field, new Blob([new Uint8Array(buffer)], { type: bin.mimeType }), bin.fileName ?? field);
        return call(method, form);
      }),
    ];
  },
};

const UPDATE_TYPES = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query', 'inline_query', 'my_chat_member', 'chat_member', 'poll', 'poll_answer', 'pre_checkout_query', 'shipping_query'];

/** Telegram secret tokens allow [A-Za-z0-9_-]; derive one per workflow+node. */
const secretFor = (ctx: IHookFunctions | IWebhookFunctions) => createHash('sha256').update(`${ctx.getWorkflow().id}:${ctx.getNode().id}:${ctx.getNode().webhookId ?? ''}`).digest('hex').slice(0, 48);

export const TelegramTrigger: INodeType = {
  description: {
    name: '8n8.telegramTrigger',
    displayName: 'Telegram Trigger',
    description: 'Starts the workflow when your bot receives an update (needs a public HTTPS URL)',
    group: ['trigger'],
    version: [1, 1.1, 1.2],
    defaults: { name: 'Telegram Trigger', color: '#0088cc' },
    icon: 'fa:telegram',
    inputs: [],
    outputs: ['main'],
    credentials: [{ name: 'telegramApi', required: true }],
    webhooks: [{ name: 'default', httpMethod: 'POST', path: 'webhook', isFullPath: false }],
    properties: [
      { displayName: 'Telegram only delivers to public HTTPS URLs. Set WEBHOOK_URL to your public address (for example a tunnel) before activating.', name: 'notice', type: 'notice', default: '' },
      { displayName: 'Trigger On', name: 'updates', type: 'multiOptions', default: ['message'], options: [{ name: '* (all updates)', value: '*' }, ...UPDATE_TYPES.map((u) => ({ name: u, value: u }))] },
      {
        displayName: 'Additional Fields',
        name: 'additionalFields',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Restrict to Chat IDs', name: 'chatIds', type: 'string', default: '', description: 'Comma separated; other chats are ignored' },
          { displayName: 'Restrict to User IDs', name: 'userIds', type: 'string', default: '' },
          { displayName: 'Download Images/Files', name: 'download', type: 'boolean', default: false, description: 'Attach the largest photo or the document as binary data' },
        ],
      },
    ],
  },
  webhookMethods: {
    default: {
      async checkExists(this: IHookFunctions) {
        const creds = await this.getCredentials<TelegramCreds>('telegramApi');
        const info = await telegram(this.helpers, creds, 'getWebhookInfo');
        return info.url === this.getNodeWebhookUrl('default');
      },
      async create(this: IHookFunctions) {
        const creds = await this.getCredentials<TelegramCreds>('telegramApi');
        const updates = this.getNodeParameter('updates', ['message']) as string[];
        await telegram(this.helpers, creds, 'setWebhook', {
          url: this.getNodeWebhookUrl('default'),
          allowed_updates: updates.includes('*') ? [] : updates,
          secret_token: secretFor(this),
          drop_pending_updates: false,
        });
        return true;
      },
      async delete(this: IHookFunctions) {
        const creds = await this.getCredentials<TelegramCreds>('telegramApi');
        await telegram(this.helpers, creds, 'deleteWebhook');
        return true;
      },
    },
  },
  async webhook(this: IWebhookFunctions): Promise<IWebhookResult> {
    if (this.getHeaderData()['x-telegram-bot-api-secret-token'] !== secretFor(this)) {
      return { webhookResponse: { statusCode: 403, body: { message: 'Invalid secret token' } } };
    }
    const update = this.getBodyData();
    const updates = this.getNodeParameter('updates', ['message']) as string[];
    const kind = UPDATE_TYPES.find((u) => u in update);
    const extra = this.getNodeParameter('additionalFields', {}) as IDataObject;
    const msg = (update[kind ?? ''] ?? {}) as IDataObject;
    const chatId = String(((msg.chat ?? (msg.message as IDataObject)?.chat) as IDataObject)?.id ?? '');
    const userId = String((msg.from as IDataObject)?.id ?? '');
    const list = (v: unknown) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const ignored =
      (!updates.includes('*') && (!kind || !updates.includes(kind))) ||
      (list(extra.chatIds).length && !list(extra.chatIds).includes(chatId)) ||
      (list(extra.userIds).length && !list(extra.userIds).includes(userId));
    // always answer 200 so Telegram doesn't retry updates we chose to ignore
    if (ignored) return { webhookResponse: { statusCode: 200, body: { ignored: true } } };

    const item: { json: IDataObject; binary?: Record<string, never> } = { json: update };
    if (extra.download) {
      const photo = (msg.photo as IDataObject[] | undefined)?.at(-1);
      const fileId = (photo?.file_id ?? (msg.document as IDataObject)?.file_id ?? (msg.video as IDataObject)?.file_id ?? (msg.voice as IDataObject)?.file_id) as string | undefined;
      if (fileId) {
        const creds = await this.getCredentials<TelegramCreds>('telegramApi');
        const file = await telegram(this.helpers, creds, 'getFile', { file_id: fileId });
        const base = (creds.baseUrl || 'https://api.telegram.org').replace(/\/$/, '');
        const data = (await this.helpers.httpRequest({ url: `${base}/file/bot${creds.accessToken}/${file.file_path}`, encoding: 'arraybuffer' })) as Buffer;
        const name = String((msg.document as IDataObject)?.file_name ?? String(file.file_path).split('/').pop());
        item.binary = { data: (await this.helpers.prepareBinaryData(data, name)) as never };
      }
    }
    return { workflowData: [[item]], webhookResponse: { statusCode: 200, body: { ok: true } } };
  },
};
