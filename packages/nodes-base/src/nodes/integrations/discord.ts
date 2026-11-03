import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, ILoadOptionsFunctions, INodeProperties, INodeType } from '@flowmator/workflow';
import { apiRequest, collectPages, forEachItem, forOp, jsonParam, listLimit, operationProp, returnAllProps } from '../../utils/api';

const API = 'https://discord.com/api/v10';

/** Discord errors look like { message, code, errors }; the nested errors name the bad field. */
function discordError(e: unknown): Error {
  const body = (e as { body?: IDataObject }).body;
  if (body && typeof body === 'object' && body.message) return new Error(`Discord error: ${body.message}${body.errors ? ` ${JSON.stringify(body.errors)}` : ''}`);
  return e as Error;
}

async function discord(ctx: { helpers: IExecuteFunctions['helpers'] }, method: IHttpRequestOptions['method'], path: string, body?: IDataObject | FormData, qs?: IDataObject, i = 0) {
  try {
    return await apiRequest(ctx, 'discordBotApi', { url: `${API}${path}`, method, ...(body ? { body } : {}), ...(qs ? { qs } : {}) }, i);
  } catch (e) {
    throw discordError(e);
  }
}

const guildProp: INodeProperties = { displayName: 'Server', name: 'guildId', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'getGuilds' }, description: 'Server name or ID' };
const channelProp: INodeProperties = { displayName: 'Channel', name: 'channelId', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'getChannels', loadOptionsDependsOn: ['guildId'] }, description: 'Channel name or ID' };
const messageIdProp: INodeProperties = { displayName: 'Message ID', name: 'messageId', type: 'string', default: '', required: true };

/** Content, embeds and files shared by bot and webhook messages. */
const messageFields: INodeProperties[] = [
  { displayName: 'Message', name: 'content', type: 'string', typeOptions: { rows: 3 }, default: '', description: 'Up to 2000 characters' },
  {
    displayName: 'Embeds',
    name: 'embeds',
    type: 'fixedCollection',
    typeOptions: { multipleValues: true },
    default: {},
    options: [
      {
        name: 'values',
        displayName: 'Embed',
        values: [
          { displayName: 'Input Method', name: 'inputMethod', type: 'options', default: 'fields', options: [{ name: 'Fields', value: 'fields' }, { name: 'JSON', value: 'json' }] },
          { displayName: 'JSON', name: 'json', type: 'json', default: '{\n  "title": ""\n}', displayOptions: { show: { inputMethod: ['json'] } } },
          { displayName: 'Title', name: 'title', type: 'string', default: '', displayOptions: { show: { inputMethod: ['fields'] } } },
          { displayName: 'Description', name: 'description', type: 'string', typeOptions: { rows: 2 }, default: '', displayOptions: { show: { inputMethod: ['fields'] } } },
          { displayName: 'URL', name: 'url', type: 'string', default: '', displayOptions: { show: { inputMethod: ['fields'] } } },
          { displayName: 'Color', name: 'color', type: 'color', default: '', displayOptions: { show: { inputMethod: ['fields'] } } },
          { displayName: 'Image URL', name: 'image', type: 'string', default: '', displayOptions: { show: { inputMethod: ['fields'] } } },
          { displayName: 'Footer', name: 'footer', type: 'string', default: '', displayOptions: { show: { inputMethod: ['fields'] } } },
        ],
      },
    ],
  },
  { displayName: 'Files (Binary Properties)', name: 'files', type: 'string', default: '', placeholder: 'data, image', description: 'Comma separated binary properties to attach' },
];

/** Bot-token fields: resource and operation keep their values when the connection is switched to a webhook. */
const botOnly = (props: INodeProperties[]): INodeProperties[] =>
  props.map((p) => ({ ...p, displayOptions: { ...p.displayOptions, show: { ...(p.displayOptions?.show ?? {}), authentication: ['botToken'] } } }));

type EmbedInput = { inputMethod?: string; json?: unknown; title?: string; description?: string; url?: string; color?: string; image?: string; footer?: string };

/** Builds the message payload, as multipart when files are attached. */
async function messagePayload(ctx: IExecuteFunctions, i: number, extra: IDataObject): Promise<IDataObject | FormData> {
  const content = ctx.getNodeParameter('content', i, '') as string;
  const embeds = (((ctx.getNodeParameter('embeds', i, {}) as IDataObject).values as EmbedInput[]) ?? []).map((e) => {
    if (e.inputMethod === 'json') return jsonParam(e.json, 'Embed');
    const embed: IDataObject = {};
    if (e.title) embed.title = e.title;
    if (e.description) embed.description = e.description;
    if (e.url) embed.url = e.url;
    if (e.color) embed.color = parseInt(String(e.color).replace('#', ''), 16);
    if (e.image) embed.image = { url: e.image };
    if (e.footer) embed.footer = { text: e.footer };
    return embed;
  });
  if (!content && !embeds.length && !String(ctx.getNodeParameter('files', i, '')).trim()) throw new Error('Add a message, an embed or a file');
  const payload: IDataObject = { ...(content ? { content } : {}), ...(embeds.length ? { embeds } : {}), ...extra };

  const props = String(ctx.getNodeParameter('files', i, '')).split(',').map((p) => p.trim()).filter(Boolean);
  if (!props.length) return payload;
  const form = new FormData();
  payload.attachments = [];
  for (const [n, prop] of props.entries()) {
    const bin = ctx.helpers.assertBinaryData(i, prop);
    const buffer = await ctx.helpers.getBinaryDataBuffer(i, prop);
    const name = bin.fileName ?? `${prop}.${bin.fileExtension ?? 'bin'}`;
    form.append(`files[${n}]`, new Blob([new Uint8Array(buffer)], { type: bin.mimeType }), name);
    (payload.attachments as IDataObject[]).push({ id: n, filename: name });
  }
  form.append('payload_json', JSON.stringify(payload));
  return form;
}

export const Discord: INodeType = {
  description: {
    name: 'flowmator.discord',
    displayName: 'Discord',
    description: 'Send messages and manage channels and members in Discord',
    group: ['output'],
    version: [2],
    defaults: { name: 'Discord', color: '#5865F2' },
    icon: 'fa:discord',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      { name: 'discordBotApi', required: true, displayOptions: { show: { authentication: ['botToken'] } } },
      { name: 'discordWebhookApi', required: true, displayOptions: { show: { authentication: ['webhook'] } } },
    ],
    codex: { categories: ['Communication'] },
    properties: [
      { displayName: 'Connection Type', name: 'authentication', type: 'options', default: 'botToken', options: [{ name: 'Bot Token', value: 'botToken', description: 'Everything a bot can do' }, { name: 'Webhook', value: 'webhook', description: 'Only posts messages to one channel' }] },
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'message',
        displayOptions: { show: { authentication: ['botToken'] } },
        options: [{ name: 'Message', value: 'message' }, { name: 'Channel', value: 'channel' }, { name: 'Member', value: 'member' }],
      },
      {
        ...operationProp('message', [
          { name: 'Send', value: 'send' },
          { name: 'Get', value: 'get' },
          { name: 'Get Many', value: 'getAll' },
          { name: 'React with Emoji', value: 'react' },
          { name: 'Delete', value: 'deleteMessage' },
        ]),
        displayOptions: { show: { resource: ['message'], authentication: ['botToken'] } },
      },
      ...botOnly([
      operationProp('channel', [{ name: 'Create', value: 'create' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }, { name: 'Update', value: 'update' }, { name: 'Delete', value: 'deleteChannel' }]),
      operationProp('member', [{ name: 'Get Many', value: 'getAll' }, { name: 'Add Role', value: 'roleAdd' }, { name: 'Remove Role', value: 'roleRemove' }]),

      // bot: message
      ...forOp('message', ['send', 'get', 'getAll', 'react', 'deleteMessage'], [guildProp, channelProp]),
      ...forOp('message', ['get', 'react', 'deleteMessage'], [messageIdProp]),
      ...forOp('message', 'send', [
        ...messageFields,
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          options: [
            { displayName: 'Reply to Message ID', name: 'replyTo', type: 'string', default: '' },
            { displayName: 'Text-to-Speech', name: 'tts', type: 'boolean', default: false },
            { displayName: 'Suppress Embeds', name: 'suppressEmbeds', type: 'boolean', default: false },
          ],
        },
      ]),
      ...forOp('message', 'getAll', returnAllProps({ resource: ['message'], operation: ['getAll'] })),
      ...forOp('message', 'react', [{ displayName: 'Emoji', name: 'emoji', type: 'string', default: '', required: true, placeholder: '👍 or name:id for custom emoji' }]),

      // bot: channel
      ...forOp('channel', ['create', 'get', 'getAll', 'update', 'deleteChannel'], [guildProp]),
      ...forOp('channel', ['get', 'update', 'deleteChannel'], [channelProp]),
      ...forOp('channel', ['create', 'update'], [
        { displayName: 'Name', name: 'name', type: 'string', default: '', required: true },
        {
          displayName: 'Options',
          name: 'channelOptions',
          type: 'collection',
          default: {},
          options: [
            { displayName: 'Type', name: 'type', type: 'options', default: 0, options: [{ name: 'Text', value: 0 }, { name: 'Voice', value: 2 }, { name: 'Category', value: 4 }, { name: 'Announcement', value: 5 }, { name: 'Forum', value: 15 }] },
            { displayName: 'Topic', name: 'topic', type: 'string', default: '' },
            { displayName: 'Parent Category ID', name: 'parent_id', type: 'string', default: '' },
            { displayName: 'Age-Restricted (NSFW)', name: 'nsfw', type: 'boolean', default: false },
            { displayName: 'Slowmode (Seconds)', name: 'rate_limit_per_user', type: 'number', default: 0 },
            { displayName: 'Position', name: 'position', type: 'number', default: 0 },
          ],
        },
      ]),
      ...forOp('channel', 'getAll', [{ displayName: 'Text Channels Only', name: 'textOnly', type: 'boolean', default: false }]),

      // bot: member
      ...forOp('member', ['getAll', 'roleAdd', 'roleRemove'], [guildProp]),
      ...forOp('member', 'getAll', returnAllProps({ resource: ['member'], operation: ['getAll'] })),
      ...forOp('member', ['roleAdd', 'roleRemove'], [
        { displayName: 'User ID', name: 'userId', type: 'string', default: '', required: true },
        { displayName: 'Roles', name: 'roles', type: 'multiOptions', default: [], typeOptions: { loadOptionsMethod: 'getRoles', loadOptionsDependsOn: ['guildId'] } },
      ]),
      ]),

      // webhook
      ...messageFields.map((f) => ({ ...f, displayOptions: { show: { authentication: ['webhook'] } } })),
      {
        displayName: 'Options',
        name: 'webhookOptions',
        type: 'collection',
        default: {},
        displayOptions: { show: { authentication: ['webhook'] } },
        options: [
          { displayName: 'Username', name: 'username', type: 'string', default: '' },
          { displayName: 'Avatar URL', name: 'avatar_url', type: 'string', default: '' },
          { displayName: 'Text-to-Speech', name: 'tts', type: 'boolean', default: false },
          { displayName: 'Thread ID', name: 'thread_id', type: 'string', default: '', description: 'Post into a thread or forum post' },
        ],
      },
    ],
  },
  methods: {
    loadOptions: {
      async getGuilds(this: ILoadOptionsFunctions) {
        const guilds = (await discord(this, 'GET', '/users/@me/guilds')) as IDataObject[];
        return guilds.map((g) => ({ name: String(g.name), value: String(g.id) }));
      },
      async getChannels(this: ILoadOptionsFunctions) {
        const guild = this.getCurrentNodeParameters().guildId as string;
        if (!guild) return [];
        const channels = (await discord(this, 'GET', `/guilds/${guild}/channels`)) as IDataObject[];
        // text, announcement, forum
        return channels.filter((c) => [0, 5, 15].includes(Number(c.type))).map((c) => ({ name: `#${c.name}`, value: String(c.id) }));
      },
      async getRoles(this: ILoadOptionsFunctions) {
        const guild = this.getCurrentNodeParameters().guildId as string;
        if (!guild) return [];
        const roles = (await discord(this, 'GET', `/guilds/${guild}/roles`)) as IDataObject[];
        return roles.filter((r) => r.name !== '@everyone').map((r) => ({ name: String(r.name), value: String(r.id) }));
      },
    },
  },
  async execute(this: IExecuteFunctions) {
    const auth = this.getNodeParameter('authentication', 0, 'botToken') as string;
    return [
      await forEachItem(this, async (i) => {
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;

        if (auth === 'webhook') {
          const { webhookUri } = await this.getCredentials<{ webhookUri: string }>('discordWebhookApi');
          const { thread_id, ...opts } = p<IDataObject>('webhookOptions', {});
          const body = await messagePayload(this, i, opts);
          try {
            // wait=true makes Discord return the created message
            return await this.helpers.httpRequest({ url: webhookUri, method: 'POST', body, qs: { wait: true, ...(thread_id ? { thread_id } : {}) }, json: true });
          } catch (e) {
            throw discordError(e);
          }
        }

        const resource = p('resource');
        const op = p('operation');
        const call = (method: IHttpRequestOptions['method'], path: string, body?: IDataObject | FormData, qs?: IDataObject) => discord(this, method, path, body, qs, i);

        if (resource === 'message') {
          const channel = p('channelId');
          if (op === 'send') {
            const o = p<{ replyTo?: string; tts?: boolean; suppressEmbeds?: boolean }>('options', {});
            const extra: IDataObject = {};
            if (o.tts) extra.tts = true;
            if (o.suppressEmbeds) extra.flags = 1 << 2;
            if (o.replyTo) extra.message_reference = { message_id: o.replyTo, fail_if_not_exists: false };
            return call('POST', `/channels/${channel}/messages`, await messagePayload(this, i, extra));
          }
          if (op === 'get') return call('GET', `/channels/${channel}/messages/${p('messageId')}`);
          if (op === 'react') {
            await call('PUT', `/channels/${channel}/messages/${p('messageId')}/reactions/${encodeURIComponent(p('emoji').replace(/^<a?:|>$/g, ''))}/@me`);
            return { success: true };
          }
          if (op === 'deleteMessage') {
            await call('DELETE', `/channels/${channel}/messages/${p('messageId')}`);
            return { success: true };
          }
          // newest first, paging backwards with "before"
          return collectPages(async (before, size) => {
            const page = (await call('GET', `/channels/${channel}/messages`, undefined, { limit: size, ...(before ? { before } : {}) })) as IDataObject[];
            return { items: page, next: page.length === size ? String(page.at(-1)!.id) : null };
          }, listLimit(this, i), 100);
        }

        const guild = p('guildId');
        if (resource === 'channel') {
          if (op === 'getAll') {
            const channels = (await call('GET', `/guilds/${guild}/channels`)) as IDataObject[];
            return p('textOnly', false) ? channels.filter((c) => Number(c.type) === 0) : channels;
          }
          if (op === 'get') return call('GET', `/channels/${p('channelId')}`);
          if (op === 'deleteChannel') return call('DELETE', `/channels/${p('channelId')}`);
          const body: IDataObject = { name: p('name'), ...p<IDataObject>('channelOptions', {}) };
          if (op === 'create') return call('POST', `/guilds/${guild}/channels`, body);
          const { type: _type, ...changes } = body; // a channel's type can't change
          return call('PATCH', `/channels/${p('channelId')}`, changes);
        }

        // member
        if (op === 'getAll') {
          return collectPages(async (after, size) => {
            const page = (await call('GET', `/guilds/${guild}/members`, undefined, { limit: size, ...(after ? { after } : {}) })) as IDataObject[];
            return { items: page, next: page.length === size ? String((page.at(-1)!.user as IDataObject).id) : null };
          }, listLimit(this, i), 1000);
        }
        const roles = p<string[]>('roles', []);
        for (const role of roles) await call(op === 'roleAdd' ? 'PUT' : 'DELETE', `/guilds/${guild}/members/${p('userId')}/roles/${role}`);
        return { success: true, roles };
      }),
    ];
  },
};
