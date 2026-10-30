import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ICredentialType, IDataObject, IExecuteFunctions, IHookFunctions, INodeProperties, INodeType, IWebhookFunctions, IWebhookResult } from '@flowmator/workflow';
import { apiRequest, forEachItem, forOp, operationProp } from '../../utils/api';

const API = 'https://api.trello.com/1';

type Ctx = { helpers: IExecuteFunctions['helpers'] };

async function trello(ctx: Ctx, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, qs: IDataObject = {}, i = 0, body?: unknown): Promise<any> {
  try {
    return await apiRequest(ctx, 'trelloApi', { url: `${API}${path}`, method, qs, ...(body !== undefined ? { body } : {}) }, i);
  } catch (e) {
    const b = (e as { body?: unknown }).body;
    if (typeof b === 'string' && b) throw new Error(`Trello error: ${b}`);
    if (b && typeof b === 'object' && (b as IDataObject).message) throw new Error(`Trello error: ${(b as IDataObject).message}`);
    throw e;
  }
}

/** Trello signs webhooks with HMAC-SHA1 (base64) of the raw body followed by the callback URL. */
export function verifyTrelloSignature(secret: string, raw: Buffer, callbackUrl: string, signature: string) {
  const expected = Buffer.from(createHmac('sha1', secret).update(Buffer.concat([raw, Buffer.from(callbackUrl)])).digest('base64'));
  const got = Buffer.from(signature);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Every key of the "Additional/Update Fields" collection goes to Trello as a query parameter. */
const fieldsQs = (f: IDataObject): IDataObject => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]));

const id = (displayName: string, name = 'id'): INodeProperties => ({ displayName, name, type: 'string', default: '', required: true });
const collection = (name: string, displayName: string, options: INodeProperties[]): INodeProperties => ({ displayName, name, type: 'collection', default: {}, options });
const fieldsOpt: INodeProperties = { displayName: 'Fields', name: 'fields', type: 'string', default: 'all', description: 'Comma separated fields to return' };

const cardFields: INodeProperties[] = [
  { displayName: 'Due Date', name: 'due', type: 'dateTime', default: '' },
  { displayName: 'Due Complete', name: 'dueComplete', type: 'boolean', default: false },
  { displayName: 'Label IDs', name: 'idLabels', type: 'string', default: '', description: 'Comma separated' },
  { displayName: 'Member IDs', name: 'idMembers', type: 'string', default: '', description: 'Comma separated' },
  { displayName: 'Position', name: 'pos', type: 'string', default: 'bottom', description: 'top, bottom or a number' },
  { displayName: 'Start', name: 'start', type: 'dateTime', default: '' },
  { displayName: 'URL Source', name: 'urlSource', type: 'string', default: '', description: 'A URL to attach' },
];

const properties: INodeProperties[] = [
  {
    displayName: 'Resource',
    name: 'resource',
    type: 'options',
    noDataExpression: true,
    default: 'card',
    options: [
      { name: 'Attachment', value: 'attachment' },
      { name: 'Board', value: 'board' },
      { name: 'Board Member', value: 'boardMember' },
      { name: 'Card', value: 'card' },
      { name: 'Card Comment', value: 'cardComment' },
      { name: 'Checklist', value: 'checklist' },
      { name: 'Label', value: 'label' },
      { name: 'List', value: 'list' },
    ],
  },
  operationProp('board', [{ name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Get', value: 'get' }, { name: 'Update', value: 'update' }]),
  operationProp('boardMember', [{ name: 'Add', value: 'add' }, { name: 'Get Many', value: 'getAll' }, { name: 'Invite', value: 'invite' }, { name: 'Remove', value: 'remove' }]),
  operationProp('card', [{ name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Get', value: 'get' }, { name: 'Update', value: 'update' }]),
  operationProp('cardComment', [{ name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Update', value: 'update' }]),
  operationProp('list', [{ name: 'Archive', value: 'archive' }, { name: 'Create', value: 'create' }, { name: 'Get', value: 'get' }, { name: 'Get Cards', value: 'getCards' }, { name: 'Get Many', value: 'getAll', description: 'Lists on a board' }, { name: 'Update', value: 'update' }]),
  operationProp('attachment', [{ name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }]),
  operationProp('checklist', [
    { name: 'Create', value: 'create' },
    { name: 'Create Checklist Item', value: 'createCheckItem' },
    { name: 'Delete', value: 'delete' },
    { name: 'Delete Checklist Item', value: 'deleteCheckItem' },
    { name: 'Get', value: 'get' },
    { name: 'Get Checklist Items', value: 'getCheckItem' },
    { name: 'Get Completed Checklist Items', value: 'completedCheckItems' },
    { name: 'Get Many', value: 'getAll', description: 'Checklists on a card' },
    { name: 'Update Checklist Item', value: 'updateCheckItem' },
  ]),
  operationProp('label', [{ name: 'Add to Card', value: 'addLabel' }, { name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }, { name: 'Remove From Card', value: 'removeLabel' }, { name: 'Update', value: 'update' }]),

  /* board */
  ...forOp('board', 'create', [
    { displayName: 'Name', name: 'name', type: 'string', default: '', required: true },
    { displayName: 'Description', name: 'description', type: 'string', default: '' },
    collection('additionalFields', 'Additional Fields', [
      { displayName: 'Default Labels', name: 'defaultLabels', type: 'boolean', default: true },
      { displayName: 'Default Lists', name: 'defaultLists', type: 'boolean', default: true },
      { displayName: 'Organization ID', name: 'idOrganization', type: 'string', default: '' },
      { displayName: 'Source Board ID', name: 'idBoardSource', type: 'string', default: '', description: 'Copy this board' },
      { displayName: 'Permission Level', name: 'prefs_permissionLevel', type: 'options', default: 'private', options: [{ name: 'Org', value: 'org' }, { name: 'Private', value: 'private' }, { name: 'Public', value: 'public' }] },
      { displayName: 'Background', name: 'prefs_background', type: 'string', default: 'blue' },
    ]),
  ]),
  ...forOp('board', ['delete', 'get', 'update'], [id('Board ID')]),
  ...forOp('board', 'get', [collection('additionalFields', 'Additional Fields', [fieldsOpt, { displayName: 'Plugin Data', name: 'pluginData', type: 'boolean', default: false }])]),
  ...forOp('board', 'update', [collection('updateFields', 'Update Fields', [
    { displayName: 'Name', name: 'name', type: 'string', default: '' },
    { displayName: 'Description', name: 'desc', type: 'string', default: '' },
    { displayName: 'Closed', name: 'closed', type: 'boolean', default: false },
    { displayName: 'Subscribed', name: 'subscribed', type: 'boolean', default: false },
    { displayName: 'Organization ID', name: 'idOrganization', type: 'string', default: '' },
  ])]),

  /* board members */
  ...forOp('boardMember', ['add', 'getAll', 'invite', 'remove'], [id('Board ID')]),
  ...forOp('boardMember', ['add', 'remove'], [id('Member ID', 'idMember')]),
  ...forOp('boardMember', 'add', [{ displayName: 'Type', name: 'type', type: 'options', default: 'normal', options: [{ name: 'Admin', value: 'admin' }, { name: 'Normal', value: 'normal' }, { name: 'Observer', value: 'observer' }] }]),
  ...forOp('boardMember', 'invite', [id('Email', 'email'), { displayName: 'Type', name: 'type', type: 'options', default: 'normal', options: [{ name: 'Admin', value: 'admin' }, { name: 'Normal', value: 'normal' }, { name: 'Observer', value: 'observer' }] }, { displayName: 'Full Name', name: 'fullName', type: 'string', default: '' }]),

  /* card */
  ...forOp('card', 'create', [
    id('List ID', 'listId'),
    { displayName: 'Name', name: 'name', type: 'string', default: '', required: true },
    { displayName: 'Description', name: 'description', type: 'string', typeOptions: { rows: 3 }, default: '' },
    collection('additionalFields', 'Additional Fields', cardFields),
  ]),
  ...forOp('card', ['delete', 'get', 'update'], [id('Card ID')]),
  ...forOp('card', 'get', [collection('additionalFields', 'Additional Fields', [fieldsOpt, { displayName: 'Include Checklists', name: 'checklists', type: 'options', default: 'none', options: [{ name: 'All', value: 'all' }, { name: 'None', value: 'none' }] }, { displayName: 'Include Attachments', name: 'attachments', type: 'boolean', default: false }])]),
  ...forOp('card', 'update', [collection('updateFields', 'Update Fields', [
    { displayName: 'Name', name: 'name', type: 'string', default: '' },
    { displayName: 'Description', name: 'desc', type: 'string', default: '' },
    { displayName: 'Closed', name: 'closed', type: 'boolean', default: false },
    { displayName: 'List ID', name: 'idList', type: 'string', default: '', description: 'Move the card to this list' },
    { displayName: 'Board ID', name: 'idBoard', type: 'string', default: '' },
    { displayName: 'Subscribed', name: 'subscribed', type: 'boolean', default: false },
    ...cardFields.filter((f) => f.name !== 'urlSource'),
  ])]),

  /* card comments */
  ...forOp('cardComment', ['create', 'delete', 'update'], [id('Card ID', 'cardId')]),
  ...forOp('cardComment', ['create', 'update'], [{ displayName: 'Text', name: 'text', type: 'string', typeOptions: { rows: 3 }, default: '', required: true }]),
  ...forOp('cardComment', ['delete', 'update'], [id('Comment ID', 'commentId')]),

  /* list */
  ...forOp('list', 'create', [id('Board ID', 'idBoard'), { displayName: 'Name', name: 'name', type: 'string', default: '', required: true }, collection('additionalFields', 'Additional Fields', [{ displayName: 'List Source ID', name: 'idListSource', type: 'string', default: '', description: 'Copy this list' }, { displayName: 'Position', name: 'pos', type: 'string', default: 'bottom' }])]),
  ...forOp('list', ['archive', 'get', 'getCards', 'update'], [id('List ID')]),
  ...forOp('list', 'archive', [{ displayName: 'Archive', name: 'archive', type: 'boolean', default: false, description: 'Off unarchives the list' }]),
  ...forOp('list', 'getAll', [id('Board ID')]),
  ...forOp('list', ['get', 'getAll', 'getCards'], [collection('additionalFields', 'Additional Fields', [fieldsOpt, { displayName: 'Filter', name: 'filter', type: 'options', default: 'open', options: [{ name: 'All', value: 'all' }, { name: 'Closed', value: 'closed' }, { name: 'Open', value: 'open' }] }])]),
  ...forOp('list', 'update', [collection('updateFields', 'Update Fields', [{ displayName: 'Name', name: 'name', type: 'string', default: '' }, { displayName: 'Board ID', name: 'idBoard', type: 'string', default: '' }, { displayName: 'Position', name: 'pos', type: 'string', default: '' }, { displayName: 'Closed', name: 'closed', type: 'boolean', default: false }, { displayName: 'Subscribed', name: 'subscribed', type: 'boolean', default: false }])]),

  /* attachments */
  ...forOp('attachment', ['create', 'delete', 'get', 'getAll'], [id('Card ID', 'cardId')]),
  ...forOp('attachment', 'create', [
    { displayName: 'Binary File', name: 'binaryData', type: 'boolean', default: false },
    { displayName: 'Input Binary Field', name: 'binaryPropertyName', type: 'string', default: 'data', displayOptions: { show: { binaryData: [true] } } },
    { displayName: 'Source URL', name: 'url', type: 'string', default: '', displayOptions: { show: { binaryData: [false] } } },
    collection('additionalFields', 'Additional Fields', [{ displayName: 'Name', name: 'name', type: 'string', default: '' }, { displayName: 'MIME Type', name: 'mimeType', type: 'string', default: '' }, { displayName: 'Set as Cover', name: 'setCover', type: 'boolean', default: false }]),
  ]),
  ...forOp('attachment', ['delete', 'get'], [id('Attachment ID')]),

  /* checklists */
  ...forOp('checklist', ['create', 'getAll'], [id('Card ID', 'cardId')]),
  ...forOp('checklist', 'create', [{ displayName: 'Name', name: 'name', type: 'string', default: '', required: true }, collection('additionalFields', 'Additional Fields', [{ displayName: 'Copy Source Checklist ID', name: 'idChecklistSource', type: 'string', default: '' }, { displayName: 'Position', name: 'pos', type: 'string', default: 'bottom' }])]),
  ...forOp('checklist', ['delete', 'get', 'createCheckItem', 'getCheckItem'], [id('Checklist ID')]),
  ...forOp('checklist', 'createCheckItem', [{ displayName: 'Name', name: 'name', type: 'string', default: '', required: true }, collection('additionalFields', 'Additional Fields', [{ displayName: 'Checked', name: 'checked', type: 'boolean', default: false }, { displayName: 'Position', name: 'pos', type: 'string', default: 'bottom' }])]),
  ...forOp('checklist', ['deleteCheckItem', 'updateCheckItem', 'completedCheckItems'], [id('Card ID', 'cardId')]),
  ...forOp('checklist', ['deleteCheckItem', 'updateCheckItem'], [id('Checklist Item ID', 'checkItemId')]),
  ...forOp('checklist', 'updateCheckItem', [collection('additionalFields', 'Additional Fields', [{ displayName: 'Name', name: 'name', type: 'string', default: '' }, { displayName: 'State', name: 'state', type: 'options', default: 'complete', options: [{ name: 'Complete', value: 'complete' }, { name: 'Incomplete', value: 'incomplete' }] }, { displayName: 'Position', name: 'pos', type: 'string', default: '' }, { displayName: 'Checklist ID', name: 'idChecklist', type: 'string', default: '' }])]),

  /* labels */
  ...forOp('label', ['create', 'getAll'], [id('Board ID', 'boardId')]),
  ...forOp('label', 'create', [{ displayName: 'Name', name: 'name', type: 'string', default: '', required: true }, { displayName: 'Color', name: 'color', type: 'options', default: 'null', options: ['black', 'blue', 'green', 'lime', 'orange', 'pink', 'purple', 'red', 'sky', 'yellow', 'null'].map((c) => ({ name: c, value: c })) }]),
  ...forOp('label', ['delete', 'get', 'update'], [id('Label ID')]),
  ...forOp('label', ['addLabel', 'removeLabel'], [id('Card ID', 'cardId'), id('Label ID')]),
  ...forOp('label', 'update', [collection('updateFields', 'Update Fields', [{ displayName: 'Name', name: 'name', type: 'string', default: '' }, { displayName: 'Color', name: 'color', type: 'string', default: '' }])]),
];

export const Trello: INodeType = {
  description: {
    name: 'flowmator.trello',
    displayName: 'Trello',
    description: 'Boards, lists, cards, checklists and labels in Trello',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Trello', color: '#0079BF' },
    icon: 'fa:trello',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'trelloApi', required: true }],
    codex: { categories: ['Productivity'], alias: ['Kanban', 'Atlassian'] },
    properties,
  },
  async execute(this: IExecuteFunctions) {
    return [
      await forEachItem(this, async (i) => {
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, qs: IDataObject = {}, body?: unknown) => trello(this, method, path, qs, i, body);
        const resource = p('resource');
        const op = p('operation');
        const add = () => fieldsQs(p<IDataObject>('additionalFields', {}));
        const upd = () => fieldsQs(p<IDataObject>('updateFields', {}));

        if (resource === 'board') {
          if (op === 'create') return call('POST', '/boards', { name: p('name'), desc: p('description', ''), ...add() });
          if (op === 'delete') return call('DELETE', `/boards/${p('id')}`);
          if (op === 'get') return call('GET', `/boards/${p('id')}`, add());
          return call('PUT', `/boards/${p('id')}`, upd());
        }
        if (resource === 'boardMember') {
          if (op === 'getAll') return call('GET', `/boards/${p('id')}/members`);
          if (op === 'add') return call('PUT', `/boards/${p('id')}/members/${p('idMember')}`, { type: p('type', 'normal') });
          if (op === 'invite') return call('PUT', `/boards/${p('id')}/members`, { email: p('email'), type: p('type', 'normal'), ...(p('fullName', '') ? { fullName: p('fullName') } : {}) });
          return call('DELETE', `/boards/${p('id')}/members/${p('idMember')}`);
        }
        if (resource === 'card') {
          if (op === 'create') return call('POST', '/cards', { idList: p('listId'), name: p('name'), desc: p('description', ''), ...add() });
          if (op === 'delete') return call('DELETE', `/cards/${p('id')}`);
          if (op === 'get') return call('GET', `/cards/${p('id')}`, add());
          return call('PUT', `/cards/${p('id')}`, upd());
        }
        if (resource === 'cardComment') {
          if (op === 'create') return call('POST', `/cards/${p('cardId')}/actions/comments`, { text: p('text') });
          if (op === 'update') return call('PUT', `/cards/${p('cardId')}/actions/${p('commentId')}/comments`, { text: p('text') });
          return call('DELETE', `/cards/${p('cardId')}/actions/${p('commentId')}/comments`);
        }
        if (resource === 'list') {
          if (op === 'create') return call('POST', '/lists', { idBoard: p('idBoard'), name: p('name'), ...add() });
          if (op === 'archive') return call('PUT', `/lists/${p('id')}/closed`, { value: p<boolean>('archive', false) });
          if (op === 'get') return call('GET', `/lists/${p('id')}`, add());
          if (op === 'getCards') return call('GET', `/lists/${p('id')}/cards`, add());
          if (op === 'getAll') return call('GET', `/boards/${p('id')}/lists`, add());
          return call('PUT', `/lists/${p('id')}`, upd());
        }
        if (resource === 'attachment') {
          const base = `/cards/${p('cardId')}/attachments`;
          if (op === 'get') return call('GET', `${base}/${p('id')}`);
          if (op === 'getAll') return call('GET', base);
          if (op === 'delete') return call('DELETE', `${base}/${p('id')}`);
          if (p<boolean>('binaryData', false)) {
            const prop = p('binaryPropertyName', 'data');
            const bin = this.helpers.assertBinaryData(i, prop);
            const form = new FormData();
            form.append('file', new Blob([new Uint8Array(await this.helpers.getBinaryDataBuffer(i, prop))], { type: bin.mimeType }), bin.fileName ?? 'file');
            return call('POST', base, add(), form);
          }
          return call('POST', base, { url: p('url'), ...add() });
        }
        if (resource === 'checklist') {
          if (op === 'create') return call('POST', `/cards/${p('cardId')}/checklists`, { name: p('name'), ...add() });
          if (op === 'getAll') return call('GET', `/cards/${p('cardId')}/checklists`);
          if (op === 'get') return call('GET', `/checklists/${p('id')}`);
          if (op === 'delete') return call('DELETE', `/checklists/${p('id')}`);
          if (op === 'createCheckItem') return call('POST', `/checklists/${p('id')}/checkItems`, { name: p('name'), ...add() });
          if (op === 'getCheckItem') return call('GET', `/checklists/${p('id')}/checkItems`);
          if (op === 'completedCheckItems') return call('GET', `/cards/${p('cardId')}/checkItemStates`);
          if (op === 'deleteCheckItem') return call('DELETE', `/cards/${p('cardId')}/checkItem/${p('checkItemId')}`);
          return call('PUT', `/cards/${p('cardId')}/checkItem/${p('checkItemId')}`, add());
        }
        // labels
        if (op === 'create') return call('POST', '/labels', { idBoard: p('boardId'), name: p('name'), color: p('color', 'null') });
        if (op === 'getAll') return call('GET', `/boards/${p('boardId')}/labels`);
        if (op === 'get') return call('GET', `/labels/${p('id')}`);
        if (op === 'delete') return call('DELETE', `/labels/${p('id')}`);
        if (op === 'update') return call('PUT', `/labels/${p('id')}`, upd());
        if (op === 'addLabel') return call('POST', `/cards/${p('cardId')}/idLabels`, { value: p('id') });
        return call('DELETE', `/cards/${p('cardId')}/idLabels/${p('id')}`);
      }),
    ];
  },
};

export const TrelloTrigger: INodeType = {
  description: {
    name: 'flowmator.trelloTrigger',
    displayName: 'Trello Trigger',
    description: 'Starts the workflow when a board, list or card changes (creates a Trello webhook; needs a public URL)',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Trello Trigger', color: '#0079BF' },
    icon: 'fa:trello',
    inputs: [],
    outputs: ['main'],
    credentials: [{ name: 'trelloApi', required: true }],
    webhooks: [
      // Trello checks the callback with a HEAD request before creating the webhook
      { name: 'setup', httpMethod: 'HEAD', path: 'webhook', isFullPath: false },
      { name: 'default', httpMethod: 'POST', path: 'webhook', isFullPath: false },
    ],
    properties: [{ displayName: 'Model ID', name: 'id', type: 'string', default: '', required: true, placeholder: '4d5ea62fd76aa1136000000c', description: 'ID of the board, list, card or member to watch' }],
  },
  webhookMethods: {
    default: {
      async checkExists(this: IHookFunctions) {
        const data = this.getWorkflowStaticData('node');
        if (!data.webhookId) return false;
        try {
          const hook = await trello(this, 'GET', `/webhooks/${data.webhookId}`);
          if (hook.callbackURL === this.getNodeWebhookUrl('default') && hook.active !== false) return true;
        } catch {}
        delete data.webhookId;
        return false;
      },
      async create(this: IHookFunctions) {
        const data = this.getWorkflowStaticData('node');
        const hook = await trello(this, 'POST', '/webhooks', { callbackURL: this.getNodeWebhookUrl('default'), idModel: this.getNodeParameter('id') as string, description: 'flowmator webhook' });
        data.webhookId = hook.id as string;
        return true;
      },
      async delete(this: IHookFunctions) {
        const data = this.getWorkflowStaticData('node');
        if (data.webhookId) await trello(this, 'DELETE', `/webhooks/${data.webhookId}`).catch(() => {});
        delete data.webhookId;
        return true;
      },
    },
  },
  async webhook(this: IWebhookFunctions): Promise<IWebhookResult> {
    if (this.getWebhookName() === 'setup') return { webhookResponse: { statusCode: 200, body: '' } };
    const { oauthSecret } = await this.getCredentials<{ oauthSecret?: string }>('trelloApi');
    if (oauthSecret) {
      const ok = verifyTrelloSignature(oauthSecret, this.getRequestObject().rawBody ?? Buffer.from(''), this.getNodeWebhookUrl('default') ?? '', String(this.getHeaderData()['x-trello-webhook'] ?? ''));
      if (!ok) return { webhookResponse: { statusCode: 401, body: { message: 'Invalid signature' } } };
    }
    return { workflowData: [[{ json: this.getBodyData() as IDataObject }]] };
  },
};

export const trelloCredentials: ICredentialType[] = [
  {
    name: 'trelloApi',
    displayName: 'Trello API',
    documentationUrl: 'https://trello.com/power-ups/admin',
    properties: [
      { displayName: 'API Key', name: 'apiKey', type: 'string', default: '' },
      { displayName: 'API Token', name: 'apiToken', type: 'string', typeOptions: { password: true }, default: '' },
      { displayName: 'OAuth Secret', name: 'oauthSecret', type: 'string', typeOptions: { password: true }, default: '', description: 'Optional: the Trello Trigger uses it to verify webhook signatures' },
    ],
    authenticate: { type: 'generic', properties: { qs: { key: '={{$credentials.apiKey}}', token: '={{$credentials.apiToken}}' } } },
    test: { request: { url: 'https://api.trello.com/1/members/me' } },
  },
];
