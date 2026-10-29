import type { IDataObject, IExecuteFunctions, ILoadOptionsFunctions, INodeType } from '@8n8/workflow';
import { apiRequest, collectPages, forEachItem, forOp, jsonParam, listLimit, operationProp, returnAllProps } from '../../utils/api';

const credType = (ctx: { getNodeParameter(n: string, i: number, f?: unknown): unknown }, i = 0) =>
  ctx.getNodeParameter('authentication', i, 'accessToken') === 'oAuth2' ? 'slackOAuth2Api' : 'slackApi';

/** Slack's Web API answers 200 with { ok: false, error } on failure. */
async function slack(ctx: IExecuteFunctions | ILoadOptionsFunctions, method: string, body: IDataObject = {}, i = 0, httpMethod: 'GET' | 'POST' = 'POST') {
  const cred = 'getInputData' in ctx ? credType(ctx as IExecuteFunctions, i) : ((ctx.getCurrentNodeParameters().authentication === 'oAuth2' ? 'slackOAuth2Api' : 'slackApi'));
  const res = await apiRequest<IDataObject>(ctx as IExecuteFunctions, cred, {
    url: `https://slack.com/api/${method}`,
    method: httpMethod,
    ...(httpMethod === 'GET' ? { qs: body } : { body, headers: { 'Content-Type': 'application/json; charset=utf-8' } }),
  }, i);
  if (!res.ok) {
    const needed = res.needed ? ` (missing scope: ${res.needed})` : '';
    throw new Error(`Slack error: ${res.error}${needed}`);
  }
  return res;
}

const channelProp = { displayName: 'Channel', name: 'channelId', type: 'options' as const, default: '', required: true, typeOptions: { loadOptionsMethod: 'getChannels' }, description: 'Channel name or ID (expressions allowed)' };

export const Slack: INodeType = {
  description: {
    name: '8n8.slack',
    displayName: 'Slack',
    description: 'Send messages and work with channels and users in Slack',
    group: ['output'],
    version: [2, 2.1, 2.2],
    defaults: { name: 'Slack', color: '#611f69' },
    icon: 'fa:slack',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      { name: 'slackApi', required: true, displayOptions: { show: { authentication: ['accessToken'] } } },
      { name: 'slackOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
    ],
    codex: { categories: ['Communication'] },
    properties: [
      { displayName: 'Authentication', name: 'authentication', type: 'options', default: 'accessToken', options: [{ name: 'Access Token', value: 'accessToken' }, { name: 'OAuth2', value: 'oAuth2' }] },
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'message',
        options: ['channel', 'message', 'reaction', 'user'].map((r) => ({ name: r[0].toUpperCase() + r.slice(1), value: r })),
      },
      operationProp('message', [
        { name: 'Send', value: 'post' },
        { name: 'Update', value: 'update' },
        { name: 'Delete', value: 'delete' },
        { name: 'Get Permalink', value: 'getPermalink' },
        { name: 'Search', value: 'search' },
      ]),
      operationProp('channel', [
        { name: 'Get Many', value: 'getAll' },
        { name: 'Get', value: 'get' },
        { name: 'History', value: 'history' },
        { name: 'Create', value: 'create' },
        { name: 'Invite', value: 'invite' },
      ]),
      operationProp('user', [{ name: 'Get', value: 'info' }, { name: 'Get Many', value: 'getAll' }, { name: 'Find by Email', value: 'lookupByEmail' }]),
      operationProp('reaction', [{ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }]),

      ...forOp('message', ['post', 'update', 'delete', 'getPermalink'], [channelProp]),
      ...forOp('message', ['post', 'update'], [
        { displayName: 'Message Type', name: 'messageType', type: 'options', default: 'text', options: [{ name: 'Simple Text', value: 'text' }, { name: 'Blocks', value: 'block' }] },
        { displayName: 'Text', name: 'text', type: 'string', typeOptions: { rows: 3 }, default: '', description: 'Supports Slack mrkdwn. With blocks, this is the notification fallback.' },
        { displayName: 'Blocks', name: 'blocksUi', type: 'json', default: '{\n  "blocks": []\n}', displayOptions: { show: { messageType: ['block'] } }, hint: 'Paste from Slack Block Kit Builder' },
      ]),
      ...forOp('message', ['update', 'delete', 'getPermalink'], [{ displayName: 'Message Timestamp', name: 'ts', type: 'string', default: '', required: true, description: 'The "ts" of the message' }]),
      ...forOp('message', 'post', [
        {
          displayName: 'Options',
          name: 'otherOptions',
          type: 'collection',
          default: {},
          options: [
            { displayName: 'Reply in Thread (Message Timestamp)', name: 'thread_ts', type: 'string', default: '' },
            { displayName: 'Also Send to Channel', name: 'reply_broadcast', type: 'boolean', default: false },
            { displayName: 'Unfurl Links', name: 'unfurl_links', type: 'boolean', default: true },
            { displayName: 'Send as User (OAuth2 user token)', name: 'as_user', type: 'boolean', default: false },
            { displayName: 'Bot Username', name: 'username', type: 'string', default: '' },
            { displayName: 'Bot Icon Emoji', name: 'icon_emoji', type: 'string', default: '', placeholder: ':robot_face:' },
          ],
        },
      ]),
      ...forOp('message', 'search', [
        { displayName: 'Search Query', name: 'query', type: 'string', default: '', required: true, hint: 'Needs a user token with search:read' },
        ...returnAllProps({ resource: ['message'], operation: ['search'] }),
      ]),

      ...forOp('channel', ['get', 'history', 'invite'], [channelProp]),
      ...forOp('channel', 'history', [...returnAllProps({ resource: ['channel'], operation: ['history'] }), { displayName: 'Oldest (Timestamp or Date)', name: 'oldest', type: 'string', default: '' }]),
      ...forOp('channel', 'getAll', [
        ...returnAllProps({ resource: ['channel'], operation: ['getAll'] }),
        { displayName: 'Exclude Archived', name: 'excludeArchived', type: 'boolean', default: true },
        { displayName: 'Types', name: 'types', type: 'multiOptions', default: ['public_channel'], options: ['public_channel', 'private_channel', 'mpim', 'im'].map((t) => ({ name: t, value: t })) },
      ]),
      ...forOp('channel', 'create', [{ displayName: 'Name', name: 'channelName', type: 'string', default: '', required: true }, { displayName: 'Private', name: 'isPrivate', type: 'boolean', default: false }]),
      ...forOp('channel', 'invite', [{ displayName: 'User IDs', name: 'userIds', type: 'string', default: '', description: 'Comma separated' }]),

      ...forOp('user', 'info', [{ displayName: 'User ID', name: 'user', type: 'string', default: '', required: true }]),
      ...forOp('user', 'lookupByEmail', [{ displayName: 'Email', name: 'email', type: 'string', default: '', required: true }]),
      ...forOp('user', 'getAll', returnAllProps({ resource: ['user'], operation: ['getAll'] })),

      ...forOp('reaction', ['add', 'remove'], [channelProp, { displayName: 'Message Timestamp', name: 'ts', type: 'string', default: '', required: true }, { displayName: 'Emoji Name', name: 'name', type: 'string', default: '', placeholder: 'thumbsup' }]),
    ],
  },
  methods: {
    loadOptions: {
      async getChannels(this: ILoadOptionsFunctions) {
        const channels = await collectPages(async (cursor) => {
          const r = await slack(this, 'conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) }, 0, 'GET');
          return { items: r.channels as IDataObject[], next: (r.response_metadata as IDataObject)?.next_cursor as string };
        }, 1000, 200);
        return channels.map((c) => ({ name: `#${c.name}`, value: String(c.id) })).sort((a, b) => a.name.localeCompare(b.name));
      },
    },
  },
  async execute(this: IExecuteFunctions) {
    return [
      await forEachItem(this, async (i) => {
        const resource = this.getNodeParameter('resource', i) as string;
        const op = this.getNodeParameter('operation', i) as string;
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (method: string, body: IDataObject = {}, httpMethod: 'GET' | 'POST' = 'POST') => slack(this, method, body, i, httpMethod);
        const paged = (method: string, key: string, body: IDataObject = {}) =>
          collectPages(async (cursor, size) => {
            const r = await call(method, { ...body, limit: size, ...(cursor ? { cursor } : {}) }, 'GET');
            return { items: r[key] as IDataObject[], next: (r.response_metadata as IDataObject)?.next_cursor as string };
          }, listLimit(this, i), 200);

        if (resource === 'message') {
          const channel = p('channelId', '');
          if (op === 'post' || op === 'update') {
            const blocks = p('messageType') === 'block' ? jsonParam(p('blocksUi'), 'Blocks').blocks : undefined;
            const body: IDataObject = { channel, text: p('text'), ...(blocks ? { blocks } : {}) };
            if (op === 'update') return call('chat.update', { ...body, ts: p('ts') });
            return call('chat.postMessage', { ...body, ...p<IDataObject>('otherOptions', {}) });
          }
          if (op === 'delete') return call('chat.delete', { channel, ts: p('ts') });
          if (op === 'getPermalink') return call('chat.getPermalink', { channel, message_ts: p('ts') }, 'GET');
          const limit = listLimit(this, i);
          const matches = await collectPages(async (page, size) => {
            const r = await call('search.messages', { query: p('query'), count: size, page: page ? Number(page) : 1 }, 'GET');
            const m = r.messages as IDataObject;
            const paging = m.paging as IDataObject;
            return { items: m.matches as IDataObject[], next: Number(paging.page) < Number(paging.pages) ? String(Number(paging.page) + 1) : null };
          }, limit, 100);
          return matches;
        }

        if (resource === 'channel') {
          if (op === 'getAll') return paged('conversations.list', 'channels', { types: p<string[]>('types', ['public_channel']).join(','), exclude_archived: p('excludeArchived', true) });
          if (op === 'get') return (await call('conversations.info', { channel: p('channelId') }, 'GET')).channel as IDataObject;
          if (op === 'history') return paged('conversations.history', 'messages', { channel: p('channelId'), ...(p('oldest', '') ? { oldest: toSlackTs(p('oldest')) } : {}) });
          if (op === 'create') return (await call('conversations.create', { name: p('channelName'), is_private: p('isPrivate', false) })).channel as IDataObject;
          return (await call('conversations.invite', { channel: p('channelId'), users: p('userIds') })).channel as IDataObject;
        }

        if (resource === 'user') {
          if (op === 'info') return (await call('users.info', { user: p('user') }, 'GET')).user as IDataObject;
          if (op === 'lookupByEmail') return (await call('users.lookupByEmail', { email: p('email') }, 'GET')).user as IDataObject;
          return paged('users.list', 'members');
        }

        // reaction
        return call(op === 'add' ? 'reactions.add' : 'reactions.remove', { channel: p('channelId'), timestamp: p('ts'), name: p('name').replace(/:/g, '') });
      }),
    ];
  },
};

/** Accepts Slack timestamps or any date, returns Slack's "seconds.micro" format. */
function toSlackTs(v: string) {
  if (/^\d+(\.\d+)?$/.test(v)) return v;
  const ms = new Date(v).getTime();
  if (Number.isNaN(ms)) throw new Error(`Invalid date "${v}"`);
  return (ms / 1000).toFixed(6);
}
