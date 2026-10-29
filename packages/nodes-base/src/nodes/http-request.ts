import {
  NodeApiError,
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type IHttpFullResponse,
  type IHttpRequestOptions,
  type INodeExecutionData,
  type INodeProperties,
  type INodeType,
  type NodeParameterValue,
} from '@8n8/workflow';

type KeyValue = { name: string; value: unknown; parameterType?: string; inputDataFieldName?: string };

const kvToObject = (list: KeyValue[] | undefined): IDataObject => {
  const out: IDataObject = {};
  for (const { name, value } of list ?? []) {
    if (!name) continue;
    if (out[name] === undefined) out[name] = value as never;
    else out[name] = ([] as unknown[]).concat(out[name], value) as never;
  }
  return out;
};

const parseJsonParam = (raw: unknown, what: string): IDataObject => {
  if (raw && typeof raw === 'object') return raw as IDataObject;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`JSON parameter "${what}" needs to be valid JSON`);
  }
};

const keyValueCollection = (name: string, displayName: string, show: Record<string, NodeParameterValue[]>, extraValues: INodeProperties[] = []): INodeProperties => ({
  displayName,
  name,
  type: 'fixedCollection' as const,
  typeOptions: { multipleValues: true },
  default: { parameters: [{ name: '', value: '' }] },
  displayOptions: { show },
  options: [
    {
      name: 'parameters',
      displayName: 'Parameter',
      values: [
        ...extraValues,
        { displayName: 'Name', name: 'name', type: 'string' as const, default: '' },
        { displayName: 'Value', name: 'value', type: 'string' as const, default: '' },
      ],
    },
  ],
});

export const HttpRequest: INodeType = {
  description: {
    name: '8n8.httpRequest',
    displayName: 'HTTP Request',
    description: 'Makes an HTTP request and returns the response data',
    group: ['output'],
    version: [3, 4, 4.1, 4.2],
    defaults: { name: 'HTTP Request', color: '#0004F5' },
    icon: 'fa:globe',
    subtitle: '={{$parameter["method"] + ": " + $parameter["url"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      { name: 'httpBasicAuth', displayOptions: { show: { genericAuthType: ['httpBasicAuth'] } } },
      { name: 'httpHeaderAuth', displayOptions: { show: { genericAuthType: ['httpHeaderAuth'] } } },
      { name: 'httpQueryAuth', displayOptions: { show: { genericAuthType: ['httpQueryAuth'] } } },
      { name: 'httpBearerAuth', displayOptions: { show: { genericAuthType: ['httpBearerAuth'] } } },
      { name: 'httpCustomAuth', displayOptions: { show: { genericAuthType: ['httpCustomAuth'] } } },
      { name: 'oAuth2Api', displayOptions: { show: { genericAuthType: ['oAuth2Api'] } } },
    ],
    codex: { alias: ['API', 'Request', 'URL', 'Build', 'cURL'] },
    properties: [
      { displayName: 'Method', name: 'method', type: 'options', default: 'GET',
        options: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].map((m) => ({ name: m, value: m })) },
      { displayName: 'URL', name: 'url', type: 'string', default: '', required: true, placeholder: 'https://example.com/index.html' },
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'none',
        options: [
          { name: 'None', value: 'none' },
          { name: 'Predefined Credential Type', value: 'predefinedCredentialType' },
          { name: 'Generic Credential Type', value: 'genericCredentialType' },
        ],
      },
      { displayName: 'Credential Type', name: 'nodeCredentialType', type: 'credentialsSelect', default: '', displayOptions: { show: { authentication: ['predefinedCredentialType'] } } },
      {
        displayName: 'Generic Auth Type',
        name: 'genericAuthType',
        type: 'credentialsSelect',
        default: '',
        displayOptions: { show: { authentication: ['genericCredentialType'] } },
        options: [
          { name: 'Basic Auth', value: 'httpBasicAuth' },
          { name: 'Bearer Auth', value: 'httpBearerAuth' },
          { name: 'Custom Auth', value: 'httpCustomAuth' },
          { name: 'Header Auth', value: 'httpHeaderAuth' },
          { name: 'OAuth2 API', value: 'oAuth2Api' },
          { name: 'Query Auth', value: 'httpQueryAuth' },
        ],
      },
      { displayName: 'Send Query Parameters', name: 'sendQuery', type: 'boolean', default: false },
      { displayName: 'Specify Query Parameters', name: 'specifyQuery', type: 'options', default: 'keypair', displayOptions: { show: { sendQuery: [true] } },
        options: [{ name: 'Using Fields Below', value: 'keypair' }, { name: 'Using JSON', value: 'json' }] },
      keyValueCollection('queryParameters', 'Query Parameters', { sendQuery: [true], specifyQuery: ['keypair'] }),
      { displayName: 'JSON', name: 'jsonQuery', type: 'json', default: '', displayOptions: { show: { sendQuery: [true], specifyQuery: ['json'] } } },
      { displayName: 'Send Headers', name: 'sendHeaders', type: 'boolean', default: false },
      { displayName: 'Specify Headers', name: 'specifyHeaders', type: 'options', default: 'keypair', displayOptions: { show: { sendHeaders: [true] } },
        options: [{ name: 'Using Fields Below', value: 'keypair' }, { name: 'Using JSON', value: 'json' }] },
      keyValueCollection('headerParameters', 'Header Parameters', { sendHeaders: [true], specifyHeaders: ['keypair'] }),
      { displayName: 'JSON', name: 'jsonHeaders', type: 'json', default: '', displayOptions: { show: { sendHeaders: [true], specifyHeaders: ['json'] } } },
      { displayName: 'Send Body', name: 'sendBody', type: 'boolean', default: false },
      {
        displayName: 'Body Content Type',
        name: 'contentType',
        type: 'options',
        default: 'json',
        displayOptions: { show: { sendBody: [true] } },
        options: [
          { name: 'Form Urlencoded', value: 'form-urlencoded' },
          { name: 'Form-Data', value: 'multipart-form-data' },
          { name: 'JSON', value: 'json' },
          { name: 'n8n Binary File', value: 'binaryData' },
          { name: 'Raw', value: 'raw' },
        ],
      },
      { displayName: 'Specify Body', name: 'specifyBody', type: 'options', default: 'keypair', displayOptions: { show: { sendBody: [true], contentType: ['json', 'form-urlencoded'] } },
        options: [{ name: 'Using Fields Below', value: 'keypair' }, { name: 'Using JSON', value: 'json' }] },
      keyValueCollection('bodyParameters', 'Body Parameters', { sendBody: [true], specifyBody: ['keypair'] }, [
        { displayName: 'Parameter Type', name: 'parameterType', type: 'options', default: 'formData',
          options: [{ name: 'n8n Binary File', value: 'formBinaryData' }, { name: 'Form Data', value: 'formData' }] },
        { displayName: 'Input Data Field Name', name: 'inputDataFieldName', type: 'string', default: '', displayOptions: { show: { parameterType: ['formBinaryData'] } } },
      ]),
      { displayName: 'JSON', name: 'jsonBody', type: 'json', default: '', displayOptions: { show: { sendBody: [true], specifyBody: ['json'] } } },
      { displayName: 'Input Data Field Name', name: 'inputDataFieldName', type: 'string', default: 'data', displayOptions: { show: { sendBody: [true], contentType: ['binaryData'] } } },
      { displayName: 'Content Type', name: 'rawContentType', type: 'string', default: 'text/plain', displayOptions: { show: { sendBody: [true], contentType: ['raw'] } } },
      { displayName: 'Body', name: 'body', type: 'string', default: '', displayOptions: { show: { sendBody: [true], contentType: ['raw'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          {
            displayName: 'Batching',
            name: 'batching',
            type: 'fixedCollection',
            default: { batch: {} },
            options: [
              {
                name: 'batch',
                displayName: 'Batching',
                values: [
                  { displayName: 'Items per Batch', name: 'batchSize', type: 'number', default: 50 },
                  { displayName: 'Batch Interval (ms)', name: 'batchInterval', type: 'number', default: 1000 },
                ],
              },
            ],
          },
          { displayName: 'Ignore SSL Issues (Insecure)', name: 'allowUnauthorizedCerts', type: 'boolean', default: false },
          { displayName: 'Array Format in Query Parameters', name: 'queryParameterArrays', type: 'options', default: 'repeat',
            options: [{ name: 'No Brackets', value: 'repeat' }, { name: 'Brackets Only', value: 'brackets' }, { name: 'Brackets with Indices', value: 'indices' }] },
          {
            displayName: 'Pagination',
            name: 'pagination',
            type: 'fixedCollection',
            default: { pagination: {} },
            options: [
              {
                name: 'pagination',
                displayName: 'Pagination',
                values: [
                  { displayName: 'Pagination Mode', name: 'paginationMode', type: 'options', default: 'updateAParameterInEachRequest',
                    options: [
                      { name: 'Off', value: 'off' },
                      { name: 'Update a Parameter in Each Request', value: 'updateAParameterInEachRequest' },
                      { name: 'Response Contains Next URL', value: 'responseContainsNextURL' },
                    ] },
                  { displayName: 'Next URL', name: 'nextURL', type: 'string', default: '', displayOptions: { show: { paginationMode: ['responseContainsNextURL'] } } },
                  {
                    displayName: 'Parameters',
                    name: 'parameters',
                    type: 'fixedCollection',
                    typeOptions: { multipleValues: true },
                    default: { parameters: [{ type: 'qs', name: '', value: '' }] },
                    displayOptions: { show: { paginationMode: ['updateAParameterInEachRequest'] } },
                    options: [
                      {
                        name: 'parameters',
                        displayName: 'Parameter',
                        values: [
                          { displayName: 'Type', name: 'type', type: 'options', default: 'qs',
                            options: [{ name: 'Body', value: 'body' }, { name: 'Header', value: 'headers' }, { name: 'Query', value: 'qs' }] },
                          { displayName: 'Name', name: 'name', type: 'string', default: '' },
                          { displayName: 'Value', name: 'value', type: 'string', default: '', hint: 'Use $response, $pageCount, $request' },
                        ],
                      },
                    ],
                  },
                  { displayName: 'Pagination Complete When', name: 'paginationCompleteWhen', type: 'options', default: 'responseIsEmpty',
                    options: [
                      { name: 'Response Is Empty', value: 'responseIsEmpty' },
                      { name: 'Receive Specific Status Codes', value: 'receiveSpecificStatusCodes' },
                      { name: 'Other', value: 'other' },
                    ] },
                  { displayName: 'Status Code(s) when Complete', name: 'statusCodesWhenComplete', type: 'string', default: '', displayOptions: { show: { paginationCompleteWhen: ['receiveSpecificStatusCodes'] } } },
                  { displayName: 'Complete Expression', name: 'completeExpression', type: 'string', default: '', displayOptions: { show: { paginationCompleteWhen: ['other'] } } },
                  { displayName: 'Limit Pages Fetched', name: 'limitPagesFetched', type: 'boolean', default: false },
                  { displayName: 'Max Pages', name: 'maxRequests', type: 'number', default: 100, displayOptions: { show: { limitPagesFetched: [true] } } },
                  { displayName: 'Interval Between Requests (ms)', name: 'requestInterval', type: 'number', default: 0 },
                ],
              },
            ],
          },
          {
            displayName: 'Response',
            name: 'response',
            type: 'fixedCollection',
            default: { response: {} },
            options: [
              {
                name: 'response',
                displayName: 'Response',
                values: [
                  { displayName: 'Include Response Headers and Status', name: 'fullResponse', type: 'boolean', default: false },
                  { displayName: 'Never Error', name: 'neverError', type: 'boolean', default: false },
                  { displayName: 'Response Format', name: 'responseFormat', type: 'options', default: 'autodetect',
                    options: [{ name: 'Autodetect', value: 'autodetect' }, { name: 'File', value: 'file' }, { name: 'JSON', value: 'json' }, { name: 'Text', value: 'text' }] },
                  { displayName: 'Put Output in Field', name: 'outputPropertyName', type: 'string', default: 'data', displayOptions: { show: { responseFormat: ['file', 'text'] } } },
                ],
              },
            ],
          },
          { displayName: 'Timeout (ms)', name: 'timeout', type: 'number', default: 10000 },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    const node = this.getNode();
    const batch = this.getNodeParameter('options.batching.batch', 0, {}) as { batchSize?: number; batchInterval?: number };
    const batchSize = batch.batchSize && batch.batchSize > 0 ? batch.batchSize : 0;

    for (let i = 0; i < items.length; i++) {
      if (batchSize && i > 0 && i % batchSize === 0 && batch.batchInterval) {
        await new Promise((r) => setTimeout(r, batch.batchInterval));
      }
      try {
        const request = await buildRequest(this, i);
        const auth = this.getNodeParameter('authentication', i, 'none') as string;
        const credType =
          auth === 'genericCredentialType' ? (this.getNodeParameter('genericAuthType', i) as string)
          : auth === 'predefinedCredentialType' ? (this.getNodeParameter('nodeCredentialType', i) as string)
          : '';
        const send = (opts: IHttpRequestOptions) =>
          credType ? this.helpers.httpRequestWithAuthentication(credType, opts, i) : this.helpers.httpRequest(opts);

        const responseOpts = this.getNodeParameter('options.response.response', i, {}) as {
          fullResponse?: boolean; neverError?: boolean; responseFormat?: string; outputPropertyName?: string;
        };
        const format = responseOpts.responseFormat ?? 'autodetect';
        request.returnFullResponse = true;
        request.ignoreHttpStatusErrors = !!responseOpts.neverError;
        request.encoding = format === 'file' ? 'arraybuffer' : format === 'text' ? 'text' : undefined;
        request.json = format === 'json';

        // raw: its expressions reference $response, which only exists once a page has been fetched
        const pagination = this.getNodeParameter('options.pagination.pagination', i, {}, { rawExpressions: true }) as IDataObject;
        const responses: IHttpFullResponse[] =
          pagination.paginationMode && pagination.paginationMode !== 'off'
            ? await paginate(this, i, request, pagination, send)
            : [await send(request)];

        for (const res of responses) out.push(...(await toItems(this, res, responseOpts, format, i)));
      } catch (error) {
        if (this.continueOnFail()) {
          const message = (error as Error).message;
          out.push({ json: { error: message }, error: { message }, pairedItem: { item: i } });
          continue;
        }
        if (error instanceof NodeApiError || error instanceof NodeOperationError) throw error;
        throw new NodeOperationError(node, error as Error, { itemIndex: i });
      }
    }
    return [out];
  },
};

async function buildRequest(ctx: IExecuteFunctions, i: number): Promise<IHttpRequestOptions> {
  const method = ctx.getNodeParameter('method', i, 'GET') as IHttpRequestOptions['method'];
  let url = String(ctx.getNodeParameter('url', i)).trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const timeout = ctx.getNodeParameter('options.timeout', i, 0) as number;
  const request: IHttpRequestOptions = { method, url, headers: {}, ...(timeout ? { timeout } : {}) };

  if (ctx.getNodeParameter('sendQuery', i, false)) {
    request.qs = ctx.getNodeParameter('specifyQuery', i, 'keypair') === 'json'
      ? parseJsonParam(ctx.getNodeParameter('jsonQuery', i), 'Query Parameters')
      : kvToObject(ctx.getNodeParameter('queryParameters.parameters', i, []) as KeyValue[]);
  }
  if (ctx.getNodeParameter('sendHeaders', i, false)) {
    const headers = ctx.getNodeParameter('specifyHeaders', i, 'keypair') === 'json'
      ? parseJsonParam(ctx.getNodeParameter('jsonHeaders', i), 'Headers')
      : kvToObject(ctx.getNodeParameter('headerParameters.parameters', i, []) as KeyValue[]);
    request.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]));
  }
  if (ctx.getNodeParameter('sendBody', i, false)) {
    const contentType = ctx.getNodeParameter('contentType', i, 'json') as string;
    const specify = ctx.getNodeParameter('specifyBody', i, 'keypair') as string;
    const params = () => (ctx.getNodeParameter('bodyParameters.parameters', i, []) as KeyValue[]) ?? [];
    switch (contentType) {
      case 'json':
        request.body = specify === 'json' ? parseJsonParam(ctx.getNodeParameter('jsonBody', i), 'Body') : kvToObject(params());
        break;
      case 'form-urlencoded':
        request.headers!['Content-Type'] = 'application/x-www-form-urlencoded';
        request.body = specify === 'json' ? parseJsonParam(ctx.getNodeParameter('jsonBody', i), 'Body') : kvToObject(params());
        break;
      case 'multipart-form-data': {
        const form = new FormData();
        for (const p of params()) {
          if (p.parameterType === 'formBinaryData') {
            const field = p.inputDataFieldName || 'data';
            const bin = ctx.helpers.assertBinaryData(i, field);
            const buffer = await ctx.helpers.getBinaryDataBuffer(i, field);
            form.append(p.name, new Blob([new Uint8Array(buffer)], { type: bin.mimeType }), bin.fileName ?? 'file');
          } else form.append(p.name, String(p.value ?? ''));
        }
        request.body = form;
        break;
      }
      case 'binaryData': {
        const field = ctx.getNodeParameter('inputDataFieldName', i, 'data') as string;
        const bin = ctx.helpers.assertBinaryData(i, field);
        request.body = await ctx.helpers.getBinaryDataBuffer(i, field);
        request.headers!['Content-Type'] ??= bin.mimeType;
        break;
      }
      case 'raw':
        request.body = String(ctx.getNodeParameter('body', i, ''));
        request.headers!['Content-Type'] = ctx.getNodeParameter('rawContentType', i, 'text/plain') as string;
        break;
    }
  }
  return request;
}

async function paginate(
  ctx: IExecuteFunctions,
  i: number,
  base: IHttpRequestOptions,
  config: IDataObject,
  send: (o: IHttpRequestOptions) => Promise<IHttpFullResponse>,
): Promise<IHttpFullResponse[]> {
  const raw = ctx.getNode().parameters.options as IDataObject;
  const rawPagination = ((raw?.pagination as IDataObject)?.pagination ?? {}) as IDataObject;
  const maxPages = config.limitPagesFetched ? Number(config.maxRequests ?? 100) : 1000;
  const interval = Number(config.requestInterval ?? 0);
  const responses: IHttpFullResponse[] = [];
  let request = structuredClone({ ...base, body: base.body instanceof FormData ? undefined : base.body });

  for (let page = 0; page < maxPages; page++) {
    const res = await send(request);
    responses.push(res);
    const keys = { $response: res, $pageCount: page + 1, $request: request };

    const done = (() => {
      switch (config.paginationCompleteWhen) {
        case 'receiveSpecificStatusCodes':
          return String(config.statusCodesWhenComplete ?? '').split(',').map((s) => Number(s.trim())).includes(res.statusCode);
        case 'other':
          return !!ctx.evaluateExpression(String(rawPagination.completeExpression ?? 'false'), i, keys);
        default: {
          const b = res.body;
          return b === undefined || b === null || b === '' || (Array.isArray(b) && b.length === 0) || (typeof b === 'object' && !Array.isArray(b) && Object.keys(b as object).length === 0);
        }
      }
    })();
    if (done) break;

    request = structuredClone(request);
    if (config.paginationMode === 'responseContainsNextURL') {
      const next = ctx.evaluateExpression(String(rawPagination.nextURL ?? ''), i, keys);
      if (!next) break;
      request.url = String(next);
      request.qs = undefined;
    } else {
      const rawParams = ((rawPagination.parameters as IDataObject)?.parameters as KeyValue[] & Array<{ type: string }>) ?? [];
      for (const p of rawParams as Array<KeyValue & { type: string }>) {
        const value = typeof p.value === 'string' && p.value.startsWith('=') ? ctx.evaluateExpression(p.value, i, keys) : p.value;
        if (p.type === 'qs') request.qs = { ...(request.qs ?? {}), [p.name]: value as never };
        else if (p.type === 'headers') request.headers = { ...(request.headers ?? {}), [p.name]: String(value) };
        else request.body = { ...((request.body as IDataObject) ?? {}), [p.name]: value as never };
      }
    }
    if (interval) await new Promise((r) => setTimeout(r, interval));
  }
  return responses;
}

async function toItems(
  ctx: IExecuteFunctions,
  res: IHttpFullResponse,
  opts: { fullResponse?: boolean; outputPropertyName?: string },
  format: string,
  i: number,
): Promise<INodeExecutionData[]> {
  const pairedItem = { item: i };
  const outField = opts.outputPropertyName || 'data';
  const contentType = String(res.headers['content-type'] ?? '');

  if (format === 'file' || (format === 'autodetect' && Buffer.isBuffer(res.body))) {
    const disposition = res.headers['content-disposition'];
    const fileName = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
    const binary = await ctx.helpers.prepareBinaryData(res.body as Buffer, fileName, contentType.split(';')[0] || undefined);
    const json = opts.fullResponse ? { headers: res.headers, statusCode: res.statusCode, statusMessage: res.statusMessage } : {};
    return [{ json, binary: { [outField]: binary }, pairedItem }];
  }

  const body = res.body;
  if (opts.fullResponse) {
    return [{ json: { body: body as never, headers: res.headers, statusCode: res.statusCode, statusMessage: res.statusMessage }, pairedItem }];
  }
  if (format === 'text' || typeof body === 'string' || body === undefined) {
    return [{ json: { [outField]: (body ?? '') as string }, pairedItem }];
  }
  if (Array.isArray(body)) {
    return body.map((entry) => ({ json: entry && typeof entry === 'object' ? entry : { data: entry }, pairedItem }));
  }
  return [{ json: body as IDataObject, pairedItem }];
}
