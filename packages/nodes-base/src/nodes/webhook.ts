import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeType, IWebhookFunctions, IWebhookResult } from '@flowmator/workflow';

const HTTP_METHODS = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'].map((m) => ({ name: m, value: m }));

const BOT_RE = /bot|crawler|spider|slurp|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|preview/i;

function ipAllowed(ip: string | undefined, whitelist: string): boolean {
  const allowed = whitelist.split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.length || !ip) return true;
  const clean = ip.replace(/^::ffff:/, '');
  return allowed.some((a) => a === clean || (a.endsWith('*') && clean.startsWith(a.slice(0, -1))));
}

export const Webhook: INodeType = {
  description: {
    name: 'flowmator.webhook',
    displayName: 'Webhook',
    description: 'Starts the workflow when a webhook is called',
    group: ['trigger'],
    version: [1, 1.1, 2, 2.1],
    defaults: { name: 'Webhook', color: '#885577' },
    icon: 'fa:bolt',
    inputs: [],
    outputs: ['main'],
    credentials: [
      { name: 'httpBasicAuth', required: true, displayOptions: { show: { authentication: ['basicAuth'] } } },
      { name: 'httpHeaderAuth', required: true, displayOptions: { show: { authentication: ['headerAuth'] } } },
    ],
    webhooks: [
      { name: 'default', httpMethod: '={{$parameter["httpMethod"] || "GET"}}', path: '={{$parameter["path"]}}', responseMode: '={{$parameter["responseMode"]}}', isFullPath: true },
    ],
    properties: [
      { displayName: 'HTTP Method', name: 'httpMethod', type: 'options', default: 'GET', options: HTTP_METHODS },
      { displayName: 'Path', name: 'path', type: 'string', default: '', placeholder: 'webhook or users/:id', required: true },
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'none',
        options: [
          { name: 'None', value: 'none' },
          { name: 'Basic Auth', value: 'basicAuth' },
          { name: 'Header Auth', value: 'headerAuth' },
        ],
      },
      {
        displayName: 'Respond',
        name: 'responseMode',
        type: 'options',
        default: 'onReceived',
        options: [
          { name: 'Immediately', value: 'onReceived', description: 'As soon as this node executes' },
          { name: 'When Last Node Finishes', value: 'lastNode', description: 'Returns data of the last-executed node' },
          { name: "Using 'Respond to Webhook' Node", value: 'responseNode', description: 'Response defined in that node' },
        ],
      },
      { displayName: 'Response Code', name: 'responseCode', type: 'number', default: 200, displayOptions: { hide: { responseMode: ['responseNode'] } } },
      {
        displayName: 'Response Data',
        name: 'responseData',
        type: 'options',
        default: 'firstEntryJson',
        displayOptions: { show: { responseMode: ['lastNode'] } },
        options: [
          { name: 'All Entries', value: 'allEntries' },
          { name: 'First Entry JSON', value: 'firstEntryJson' },
          { name: 'First Entry Binary', value: 'firstEntryBinary' },
          { name: 'No Response Body', value: 'noData' },
        ],
      },
      { displayName: 'Property Name', name: 'responseBinaryPropertyName', type: 'string', default: 'data', displayOptions: { show: { responseData: ['firstEntryBinary'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Allowed Origins (CORS)', name: 'allowedOrigins', type: 'string', default: '*' },
          { displayName: 'Binary Property', name: 'binaryPropertyName', type: 'string', default: 'data' },
          { displayName: 'Ignore Bots', name: 'ignoreBots', type: 'boolean', default: false },
          { displayName: 'IP(s) Whitelist', name: 'ipWhitelist', type: 'string', default: '' },
          { displayName: 'No Response Body', name: 'noResponseBody', type: 'boolean', default: false },
          { displayName: 'Raw Body', name: 'rawBody', type: 'boolean', default: false },
          { displayName: 'Response Data', name: 'responseData', type: 'string', default: '', description: 'Custom body sent when responding immediately' },
          { displayName: 'Response Content-Type', name: 'responseContentType', type: 'string', default: '' },
          {
            displayName: 'Response Headers',
            name: 'responseHeaders',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: {},
            options: [
              {
                name: 'entries',
                displayName: 'Entries',
                values: [
                  { displayName: 'Name', name: 'name', type: 'string', default: '' },
                  { displayName: 'Value', name: 'value', type: 'string', default: '' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  async webhook(this: IWebhookFunctions): Promise<IWebhookResult> {
    const req = this.getRequestObject();
    const options = this.getNodeParameter('options', {}) as IDataObject;

    if (!ipAllowed(req.ip, String(options.ipWhitelist ?? ''))) {
      return { webhookResponse: { statusCode: 403, body: { message: 'IP is not whitelisted to access the webhook!' } } };
    }
    if (options.ignoreBots && BOT_RE.test(String(req.headers['user-agent'] ?? ''))) {
      return { webhookResponse: { statusCode: 403, body: { message: 'Bots are not allowed' } } };
    }

    const authentication = this.getNodeParameter('authentication', 'none') as string;
    if (authentication === 'basicAuth') {
      const creds = await this.getCredentials<{ user: string; password: string }>('httpBasicAuth');
      const header = String(req.headers.authorization ?? '');
      const [user, pass] = Buffer.from(header.replace(/^Basic /i, ''), 'base64').toString().split(':');
      if (!header.startsWith('Basic ') || user !== creds.user || pass !== creds.password) {
        return { webhookResponse: { statusCode: 401, headers: { 'WWW-Authenticate': 'Basic realm="Webhook"' }, body: { message: 'Authorization data is wrong!' } } };
      }
    } else if (authentication === 'headerAuth') {
      const creds = await this.getCredentials<{ name: string; value: string }>('httpHeaderAuth');
      if (req.headers[creds.name.toLowerCase()] !== creds.value) {
        return { webhookResponse: { statusCode: 403, body: { message: 'Authorization data is wrong!' } } };
      }
    }

    const item: INodeExecutionData = {
      json: {
        headers: req.headers as IDataObject,
        params: req.params,
        query: req.query,
        body: (req.body ?? {}) as IDataObject,
        webhookUrl: this.getNodeWebhookUrl('default'),
        executionMode: this.getMode() === 'manual' ? 'test' : 'production',
      },
    };

    const binaryProp = String(options.binaryPropertyName || 'data');
    if (req.files?.length) {
      item.binary = {};
      let n = 0;
      for (const f of req.files) {
        const key = req.files.length === 1 ? binaryProp : `${binaryProp}${n++}`;
        item.binary[key] = await this.helpers.prepareBinaryData(f.data, f.fileName, f.mimeType);
      }
    } else if (options.rawBody && req.rawBody) {
      const contentType = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0];
      item.binary = { [binaryProp]: await this.helpers.prepareBinaryData(req.rawBody, undefined, contentType) };
    }

    return { workflowData: [[item]] };
  },
};

export const RespondToWebhook: INodeType = {
  description: {
    name: 'flowmator.respondToWebhook',
    displayName: 'Respond to Webhook',
    description: 'Returns data for the webhook that started the workflow',
    group: ['transform'],
    version: [1, 1.1],
    defaults: { name: 'Respond to Webhook', color: '#885577' },
    icon: 'fa:reply',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Respond With',
        name: 'respondWith',
        type: 'options',
        default: 'firstIncomingItem',
        options: [
          { name: 'All Incoming Items', value: 'allIncomingItems' },
          { name: 'Binary File', value: 'binary' },
          { name: 'First Incoming Item', value: 'firstIncomingItem' },
          { name: 'JSON', value: 'json' },
          { name: 'No Data', value: 'noData' },
          { name: 'Redirect', value: 'redirect' },
          { name: 'Text', value: 'text' },
        ],
      },
      { displayName: 'Redirect URL', name: 'redirectURL', type: 'string', default: '', displayOptions: { show: { respondWith: ['redirect'] } } },
      { displayName: 'Response Body', name: 'responseBody', type: 'json', default: '{\n  "myField": "value"\n}', displayOptions: { show: { respondWith: ['json'] } } },
      { displayName: 'Response Body', name: 'responseBody', type: 'string', default: '', displayOptions: { show: { respondWith: ['text'] } } },
      { displayName: 'Response Data Source', name: 'responseDataSource', type: 'options', default: 'automatically', displayOptions: { show: { respondWith: ['binary'] } },
        options: [{ name: 'Choose Automatically From Input', value: 'automatically' }, { name: 'Specify Myself', value: 'set' }] },
      { displayName: 'Input Field Name', name: 'inputFieldName', type: 'string', default: 'data', displayOptions: { show: { respondWith: ['binary'], responseDataSource: ['set'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Response Code', name: 'responseCode', type: 'number', default: 200 },
          {
            displayName: 'Response Headers',
            name: 'responseHeaders',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: {},
            options: [
              {
                name: 'entries',
                displayName: 'Entries',
                values: [
                  { displayName: 'Name', name: 'name', type: 'string', default: '' },
                  { displayName: 'Value', name: 'value', type: 'string', default: '' },
                ],
              },
            ],
          },
          { displayName: 'Put Response in Field', name: 'responseKey', type: 'string', default: '' },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const respondWith = this.getNodeParameter('respondWith', 0) as string;
    const options = this.getNodeParameter('options', 0, {}) as IDataObject;
    const headers: Record<string, string> = {};
    for (const h of ((options.responseHeaders as IDataObject)?.entries as Array<{ name: string; value: string }>) ?? []) {
      if (h.name) headers[h.name.toLowerCase()] = String(h.value);
    }
    let statusCode = Number(options.responseCode ?? 200);
    let body: unknown;
    const wrap = (v: unknown) => (options.responseKey ? { [String(options.responseKey)]: v } : v);

    switch (respondWith) {
      case 'allIncomingItems':
        body = wrap(items.map((i) => i.json));
        break;
      case 'firstIncomingItem':
        body = wrap(items[0]?.json ?? {});
        break;
      case 'json': {
        const raw = this.getNodeParameter('responseBody', 0);
        body = wrap(typeof raw === 'string' ? (raw.trim() ? JSON.parse(raw) : {}) : raw);
        break;
      }
      case 'text':
        body = String(this.getNodeParameter('responseBody', 0) ?? '');
        headers['content-type'] ??= 'text/html; charset=utf-8';
        break;
      case 'binary': {
        const source = this.getNodeParameter('responseDataSource', 0, 'automatically') as string;
        const binaries = items[0]?.binary ?? {};
        const key = source === 'set' ? (this.getNodeParameter('inputFieldName', 0) as string) : Object.keys(binaries)[0];
        const bin = key ? binaries[key] : undefined;
        if (!bin) throw new Error('No binary data found to respond with');
        body = await this.helpers.getBinaryDataBuffer(0, key);
        headers['content-type'] ??= bin.mimeType;
        if (bin.fileName) headers['content-disposition'] ??= `inline; filename="${bin.fileName}"`;
        break;
      }
      case 'redirect':
        statusCode = options.responseCode ? statusCode : 307;
        headers.location = this.getNodeParameter('redirectURL', 0) as string;
        break;
      case 'noData':
        body = undefined;
        break;
    }

    this.sendResponse({ statusCode, headers, body });
    return [items];
  },
};
