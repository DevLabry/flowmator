import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ICredentialType, IDataObject, IExecuteFunctions, IHookFunctions, INodeProperties, INodeType, IWebhookFunctions, IWebhookResult } from '@8n8/workflow';
import { apiRequest, collectPages, forEachItem, forOp, listLimit, operationProp, returnAllProps } from '../../utils/api';

const API = 'https://api.stripe.com/v1';

/** Stripe takes form bodies with bracketed keys: metadata[plan]=pro, items[0][price]=… */
export function stripeForm(data: IDataObject): URLSearchParams {
  const params = new URLSearchParams();
  const add = (key: string, value: unknown) => {
    if (value === undefined) return;
    if (value === null) params.append(key, '');
    else if (Array.isArray(value)) value.forEach((v, i) => add(`${key}[${i}]`, v));
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    else params.append(key, String(value));
  };
  for (const [k, v] of Object.entries(data)) add(k, v);
  return params;
}

/** Checks a `Stripe-Signature` header (t=…,v1=…) against the raw body; rejects stale timestamps. */
export function verifyStripeSignature(secret: string, header: string, raw: Buffer, toleranceSec = 300, now = Date.now()) {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]).filter(([k]) => k === 't'));
  const signatures = header.split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  const t = Number(parts.t);
  if (!t || !signatures.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex'));
  return signatures.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), expected));
}

type Ctx = { helpers: IExecuteFunctions['helpers'] };

async function stripe(ctx: Ctx, method: 'GET' | 'POST' | 'DELETE', path: string, body?: IDataObject, qs?: IDataObject, i = 0): Promise<IDataObject> {
  try {
    return await apiRequest(ctx, 'stripeApi', {
      url: `${API}${path}`,
      method,
      ...(body ? { body: stripeForm(body), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {}),
      ...(qs ? { qs } : {}),
    }, i);
  } catch (e) {
    const err = (e as { body?: { error?: { message?: string; code?: string } } }).body?.error;
    if (err?.message) throw new Error(`Stripe error: ${err.message}${err.code ? ` (${err.code})` : ''}`);
    throw e;
  }
}

async function list(ctx: Ctx, path: string, qs: IDataObject, limit: number | undefined, i: number) {
  return collectPages(async (after, size) => {
    const r = await stripe(ctx, 'GET', path, undefined, { ...qs, limit: size, ...(after ? { starting_after: after } : {}) }, i);
    const data = r.data as IDataObject[];
    return { items: data, next: r.has_more && data.length ? String(data.at(-1)!.id) : undefined };
  }, limit);
}

const metadataProp: INodeProperties = {
  displayName: 'Metadata',
  name: 'metadata',
  type: 'fixedCollection',
  typeOptions: { multipleValues: true },
  default: {},
  options: [{ name: 'metadataProperties', displayName: 'Metadata', values: [{ displayName: 'Key', name: 'key', type: 'string', default: '' }, { displayName: 'Value', name: 'value', type: 'string', default: '' }] }],
};
const addressProp = (name: string, displayName: string): INodeProperties => ({
  displayName,
  name,
  type: 'collection',
  default: {},
  options: ['line1', 'line2', 'city', 'state', 'postal_code', 'country'].map((f) => ({ displayName: f.replace('_', ' ').replace(/^\w/, (c) => c.toUpperCase()), name: f, type: 'string' as const, default: '' })),
});
const shippingProp: INodeProperties = {
  displayName: 'Shipping',
  name: 'shipping',
  type: 'collection',
  default: {},
  options: [{ displayName: 'Name', name: 'name', type: 'string', default: '' }, { displayName: 'Phone', name: 'phone', type: 'string', default: '' }, ...addressProp('address', 'Address').options!.map((o) => ({ ...o, name: `address_${(o as INodeProperties).name}` }) as INodeProperties)],
};

/** Collections from the UI → Stripe objects (metadata pairs, shipping address). */
function stripeFields(fields: IDataObject): IDataObject {
  const out: IDataObject = { ...fields };
  const meta = (fields.metadata as IDataObject | undefined)?.metadataProperties as Array<{ key: string; value: string }> | undefined;
  if (meta) out.metadata = Object.fromEntries(meta.filter((m) => m.key).map((m) => [m.key, m.value]));
  if (fields.shipping) {
    const s = fields.shipping as IDataObject;
    const address = Object.fromEntries(Object.entries(s).filter(([k]) => k.startsWith('address_')).map(([k, v]) => [k.slice(8), v]));
    out.shipping = { name: s.name, ...(s.phone ? { phone: s.phone } : {}), address };
  }
  return out;
}

const customerId: INodeProperties = { displayName: 'Customer ID', name: 'customerId', type: 'string', default: '', required: true, placeholder: 'cus_…' };

const properties: INodeProperties[] = [
  {
    displayName: 'Resource',
    name: 'resource',
    type: 'options',
    noDataExpression: true,
    default: 'balance',
    options: ['balance', 'charge', 'coupon', 'customer', 'customerCard', 'paymentIntent', 'source', 'token'].map((v) => ({ name: v === 'customerCard' ? 'Customer Card' : v === 'paymentIntent' ? 'Payment Intent' : v[0].toUpperCase() + v.slice(1), value: v })),
  },
  operationProp('balance', [{ name: 'Get', value: 'get' }]),
  operationProp('charge', [{ name: 'Create', value: 'create' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }, { name: 'Update', value: 'update' }]),
  operationProp('coupon', [{ name: 'Create', value: 'create' }, { name: 'Get Many', value: 'getAll' }]),
  operationProp('customer', [{ name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }, { name: 'Update', value: 'update' }]),
  operationProp('customerCard', [{ name: 'Add', value: 'add' }, { name: 'Get', value: 'get' }, { name: 'Remove', value: 'remove' }]),
  operationProp('paymentIntent', [{ name: 'Create', value: 'create' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }, { name: 'Confirm', value: 'confirm' }, { name: 'Cancel', value: 'cancel' }]),
  operationProp('source', [{ name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Get', value: 'get' }]),
  operationProp('token', [{ name: 'Create', value: 'create' }]),

  /* charge */
  ...forOp('charge', 'create', [
    customerId,
    { displayName: 'Amount', name: 'amount', type: 'number', default: 0, required: true, description: 'In the smallest currency unit (cents)' },
    { displayName: 'Currency', name: 'currency', type: 'string', default: 'usd', required: true },
    { displayName: 'Source ID', name: 'source', type: 'string', default: '', required: true, placeholder: 'card_…' },
  ]),
  ...forOp('charge', ['get', 'update'], [{ displayName: 'Charge ID', name: 'chargeId', type: 'string', default: '', required: true }]),
  ...forOp('charge', ['create', 'update'], [{
    displayName: 'Additional Fields',
    name: 'additionalFields',
    type: 'collection',
    default: {},
    options: [{ displayName: 'Description', name: 'description', type: 'string', default: '' }, metadataProp, { displayName: 'Receipt Email', name: 'receipt_email', type: 'string', default: '' }, shippingProp],
  }]),
  ...forOp('charge', 'getAll', returnAllProps({ resource: ['charge'], operation: ['getAll'] })),

  /* coupon */
  ...forOp('coupon', 'create', [
    { displayName: 'Apply', name: 'duration', type: 'options', default: 'once', options: [{ name: 'Forever', value: 'forever' }, { name: 'Once', value: 'once' }, { name: 'Repeating', value: 'repeating' }] },
    { displayName: 'Duration in Months', name: 'durationInMonths', type: 'number', default: 3, displayOptions: { show: { duration: ['repeating'] } } },
    { displayName: 'Discount Type', name: 'type', type: 'options', default: 'percent', options: [{ name: 'Fixed Amount (in Cents)', value: 'fixedAmount' }, { name: 'Percent', value: 'percent' }] },
    { displayName: 'Amount Off', name: 'amountOff', type: 'number', default: 0, displayOptions: { show: { type: ['fixedAmount'] } } },
    { displayName: 'Currency', name: 'currency', type: 'string', default: 'usd', displayOptions: { show: { type: ['fixedAmount'] } } },
    { displayName: 'Percent Off', name: 'percentOff', type: 'number', default: 10, typeOptions: { minValue: 1, maxValue: 100 }, displayOptions: { show: { type: ['percent'] } } },
  ]),
  ...forOp('coupon', 'getAll', returnAllProps({ resource: ['coupon'], operation: ['getAll'] })),

  /* customer */
  ...forOp('customer', 'create', [{ displayName: 'Name', name: 'name', type: 'string', default: '', required: true }]),
  ...forOp('customer', ['get', 'update', 'delete'], [customerId]),
  ...forOp('customer', ['create', 'update'], [{
    displayName: 'Additional Fields',
    name: 'additionalFields',
    type: 'collection',
    default: {},
    options: [addressProp('address', 'Address'), { displayName: 'Description', name: 'description', type: 'string', default: '' }, { displayName: 'Email', name: 'email', type: 'string', default: '' }, metadataProp, { displayName: 'Name', name: 'name', type: 'string', default: '' }, { displayName: 'Phone', name: 'phone', type: 'string', default: '' }, shippingProp],
  }]),
  ...forOp('customer', 'getAll', [...returnAllProps({ resource: ['customer'], operation: ['getAll'] }), { displayName: 'Filters', name: 'filters', type: 'collection', default: {}, options: [{ displayName: 'Email', name: 'email', type: 'string', default: '' }] }]),

  /* customer card */
  ...forOp('customerCard', ['add', 'get', 'remove'], [customerId]),
  ...forOp('customerCard', 'add', [{ displayName: 'Card Token', name: 'token', type: 'string', default: '', required: true, placeholder: 'tok_…' }]),
  ...forOp('customerCard', ['get', 'remove'], [{ displayName: 'Card ID', name: 'cardId', type: 'string', default: '', required: true }]),

  /* payment intent */
  ...forOp('paymentIntent', 'create', [
    { displayName: 'Amount', name: 'amount', type: 'number', default: 0, required: true, description: 'In the smallest currency unit (cents)' },
    { displayName: 'Currency', name: 'currency', type: 'string', default: 'usd', required: true },
    {
      displayName: 'Additional Fields',
      name: 'additionalFields',
      type: 'collection',
      default: {},
      options: [
        { displayName: 'Automatic Payment Methods', name: 'automaticPaymentMethods', type: 'boolean', default: true },
        { displayName: 'Confirm', name: 'confirm', type: 'boolean', default: false },
        { displayName: 'Customer ID', name: 'customer', type: 'string', default: '' },
        { displayName: 'Description', name: 'description', type: 'string', default: '' },
        metadataProp,
        { displayName: 'Payment Method ID', name: 'payment_method', type: 'string', default: '' },
        { displayName: 'Receipt Email', name: 'receipt_email', type: 'string', default: '' },
      ],
    },
  ]),
  ...forOp('paymentIntent', ['get', 'confirm', 'cancel'], [{ displayName: 'Payment Intent ID', name: 'paymentIntentId', type: 'string', default: '', required: true, placeholder: 'pi_…' }]),
  ...forOp('paymentIntent', 'getAll', [...returnAllProps({ resource: ['paymentIntent'], operation: ['getAll'] }), { displayName: 'Filters', name: 'filters', type: 'collection', default: {}, options: [{ displayName: 'Customer ID', name: 'customer', type: 'string', default: '' }] }]),

  /* source */
  ...forOp('source', ['create', 'delete', 'get'], [customerId]),
  ...forOp('source', 'create', [
    { displayName: 'Type', name: 'type', type: 'options', default: 'wechat', options: [{ name: 'WeChat', value: 'wechat' }] },
    { displayName: 'Amount', name: 'amount', type: 'number', default: 0 },
    { displayName: 'Currency', name: 'currency', type: 'string', default: 'usd' },
    { displayName: 'Additional Fields', name: 'additionalFields', type: 'collection', default: {}, options: [metadataProp, { displayName: 'Statement Descriptor', name: 'statement_descriptor', type: 'string', default: '' }] },
  ]),
  ...forOp('source', ['delete', 'get'], [{ displayName: 'Source ID', name: 'sourceId', type: 'string', default: '', required: true }]),

  /* token */
  ...forOp('token', 'create', [
    { displayName: 'Type', name: 'type', type: 'options', default: 'cardToken', options: [{ name: 'Card Token', value: 'cardToken' }] },
    { displayName: 'Card Number', name: 'number', type: 'string', default: '', placeholder: '4242424242424242' },
    { displayName: 'CVC', name: 'cvc', type: 'string', default: '', typeOptions: { password: true } },
    { displayName: 'Expiration Month', name: 'expirationMonth', type: 'string', default: '' },
    { displayName: 'Expiration Year', name: 'expirationYear', type: 'string', default: '' },
  ]),
];

export const Stripe: INodeType = {
  description: {
    name: '8n8.stripe',
    displayName: 'Stripe',
    description: 'Customers, charges, payment intents, coupons and cards in Stripe',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Stripe', color: '#635BFF' },
    icon: 'fa:stripe',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'stripeApi', required: true }],
    codex: { categories: ['Finance & Accounting'], alias: ['Payments', 'Billing'] },
    properties,
  },
  async execute(this: IExecuteFunctions) {
    return [
      await forEachItem(this, async (i) => {
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: IDataObject, qs?: IDataObject) => stripe(this, method, path, body, qs, i);
        const resource = p('resource');
        const op = p('operation');
        const extra = () => stripeFields(p<IDataObject>('additionalFields', {}));

        if (resource === 'balance') return call('GET', '/balance');
        if (resource === 'charge') {
          if (op === 'create') return call('POST', '/charges', { customer: p('customerId'), amount: p<number>('amount'), currency: p('currency'), source: p('source'), ...extra() });
          if (op === 'get') return call('GET', `/charges/${p('chargeId')}`);
          if (op === 'update') return call('POST', `/charges/${p('chargeId')}`, extra());
          return list(this, '/charges', {}, listLimit(this, i), i);
        }
        if (resource === 'coupon') {
          if (op === 'getAll') return list(this, '/coupons', {}, listLimit(this, i), i);
          const body: IDataObject = { duration: p('duration') };
          if (body.duration === 'repeating') body.duration_in_months = p<number>('durationInMonths');
          if (p('type') === 'fixedAmount') Object.assign(body, { amount_off: p<number>('amountOff'), currency: p('currency') });
          else body.percent_off = p<number>('percentOff');
          return call('POST', '/coupons', body);
        }
        if (resource === 'customer') {
          if (op === 'create') return call('POST', '/customers', { name: p('name'), ...extra() });
          if (op === 'update') return call('POST', `/customers/${p('customerId')}`, extra());
          if (op === 'get') return call('GET', `/customers/${p('customerId')}`);
          if (op === 'delete') return call('DELETE', `/customers/${p('customerId')}`);
          const f = p<IDataObject>('filters', {});
          return list(this, '/customers', f.email ? { email: f.email } : {}, listLimit(this, i), i);
        }
        if (resource === 'customerCard') {
          const base = `/customers/${p('customerId')}/sources`;
          if (op === 'add') return call('POST', base, { source: p('token') });
          if (op === 'get') return call('GET', `${base}/${p('cardId')}`);
          return call('DELETE', `${base}/${p('cardId')}`);
        }
        if (resource === 'paymentIntent') {
          if (op === 'create') {
            const { automaticPaymentMethods, ...f } = extra();
            return call('POST', '/payment_intents', { amount: p<number>('amount'), currency: p('currency'), ...(automaticPaymentMethods !== false ? { automatic_payment_methods: { enabled: true } } : {}), ...f });
          }
          if (op === 'get') return call('GET', `/payment_intents/${p('paymentIntentId')}`);
          if (op === 'confirm') return call('POST', `/payment_intents/${p('paymentIntentId')}/confirm`, {});
          if (op === 'cancel') return call('POST', `/payment_intents/${p('paymentIntentId')}/cancel`, {});
          const f = p<IDataObject>('filters', {});
          return list(this, '/payment_intents', f.customer ? { customer: f.customer } : {}, listLimit(this, i), i);
        }
        if (resource === 'source') {
          if (op === 'create') {
            const source = await call('POST', '/sources', { type: p('type'), amount: p<number>('amount'), currency: p('currency'), ...extra() });
            await call('POST', `/customers/${p('customerId')}/sources`, { source: source.id });
            return source;
          }
          if (op === 'get') return call('GET', `/sources/${p('sourceId')}`);
          return call('DELETE', `/customers/${p('customerId')}/sources/${p('sourceId')}`);
        }
        return call('POST', '/tokens', { card: { number: p('number'), cvc: p('cvc'), exp_month: p('expirationMonth'), exp_year: p('expirationYear') } });
      }),
    ];
  },
};

const EVENTS = [
  '*',
  'charge.succeeded', 'charge.failed', 'charge.refunded', 'charge.dispute.created',
  'checkout.session.completed', 'checkout.session.expired',
  'customer.created', 'customer.updated', 'customer.deleted',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end',
  'invoice.created', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_succeeded', 'invoice.upcoming',
  'payment_intent.created', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled',
  'payment_method.attached', 'payout.paid', 'payout.failed', 'price.created', 'product.created', 'refund.created',
];

export const StripeTrigger: INodeType = {
  description: {
    name: '8n8.stripeTrigger',
    displayName: 'Stripe Trigger',
    description: 'Starts the workflow on Stripe events (creates a webhook endpoint; needs a public URL)',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Stripe Trigger', color: '#635BFF' },
    icon: 'fa:stripe',
    inputs: [],
    outputs: ['main'],
    credentials: [{ name: 'stripeApi', required: true }],
    webhooks: [{ name: 'default', httpMethod: 'POST', path: 'webhook', isFullPath: false }],
    properties: [
      { displayName: 'Events', name: 'events', type: 'multiOptions', default: [], required: true, options: EVENTS.map((e) => ({ name: e === '*' ? '* (all events)' : e, value: e })) },
      { displayName: 'Options', name: 'options', type: 'collection', default: {}, options: [{ displayName: 'API Version', name: 'apiVersion', type: 'string', default: '', placeholder: '2025-09-30.clover', description: 'Version of the event payloads; empty uses the account default' }] },
    ],
  },
  webhookMethods: {
    default: {
      async checkExists(this: IHookFunctions) {
        const data = this.getWorkflowStaticData('node');
        if (!data.webhookId) return false;
        try {
          const hook = await stripe(this, 'GET', `/webhook_endpoints/${data.webhookId}`);
          if (hook.url === this.getNodeWebhookUrl('default') && hook.status === 'enabled') return true;
        } catch {}
        delete data.webhookId;
        return false;
      },
      async create(this: IHookFunctions) {
        const data = this.getWorkflowStaticData('node');
        const apiVersion = (this.getNodeParameter('options', {}) as IDataObject).apiVersion;
        const hook = await stripe(this, 'POST', '/webhook_endpoints', {
          url: this.getNodeWebhookUrl('default'),
          enabled_events: this.getNodeParameter('events', []) as string[],
          description: `8n8 workflow ${this.getWorkflow().id ?? ''}`.trim(),
          ...(apiVersion ? { api_version: apiVersion } : {}),
        });
        data.webhookId = hook.id as string;
        data.webhookSecret = hook.secret as string;
        return true;
      },
      async delete(this: IHookFunctions) {
        const data = this.getWorkflowStaticData('node');
        if (data.webhookId) await stripe(this, 'DELETE', `/webhook_endpoints/${data.webhookId}`).catch(() => {});
        delete data.webhookId;
        delete data.webhookSecret;
        return true;
      },
    },
  },
  async webhook(this: IWebhookFunctions): Promise<IWebhookResult> {
    const req = this.getRequestObject();
    const secret = this.getWorkflowStaticData('node').webhookSecret as string | undefined;
    if (secret && !verifyStripeSignature(secret, String(this.getHeaderData()['stripe-signature'] ?? ''), req.rawBody ?? Buffer.from(''))) {
      return { webhookResponse: { statusCode: 400, body: { message: 'Invalid Stripe signature' } } };
    }
    const event = this.getBodyData() as IDataObject;
    const wanted = this.getNodeParameter('events', []) as string[];
    if (!wanted.includes('*') && !wanted.includes(String(event.type))) return { webhookResponse: { statusCode: 200, body: { received: true } } };
    return { workflowData: [[{ json: event }]], webhookResponse: { statusCode: 200, body: { received: true } } };
  },
};

export const stripeCredentials: ICredentialType[] = [
  {
    name: 'stripeApi',
    displayName: 'Stripe API',
    documentationUrl: 'https://dashboard.stripe.com/apikeys',
    properties: [{ displayName: 'Secret Key', name: 'secretKey', type: 'string', typeOptions: { password: true }, default: '', placeholder: 'sk_live_… or rk_live_…' }],
    authenticate: { type: 'generic', properties: { headers: { Authorization: '=Bearer {{$credentials.secretKey}}' } } },
    test: { request: { url: 'https://api.stripe.com/v1/balance' } },
  },
];
