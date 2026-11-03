import type { ICredentialType, IDataObject, IExecuteFunctions, ILoadOptionsFunctions, INodeProperties, INodeType } from '@flowmator/workflow';
import { apiRequest, collectPages, forEachItem, forOp, listLimit, operationProp, returnAllProps } from '../../utils/api';

const API = 'https://api.hubapi.com';

/** CRM v3 object type per resource. */
const OBJECTS: Record<string, string> = { contact: 'contacts', company: 'companies', deal: 'deals', ticket: 'tickets' };
/** Engagements are their own CRM objects (with a timestamp property each). */
const ENGAGEMENTS: Record<string, string> = { note: 'notes', task: 'tasks', call: 'calls', email: 'emails', meeting: 'meetings' };

type Ctx = { helpers: IExecuteFunctions['helpers']; getNodeParameter: IExecuteFunctions['getNodeParameter'] };

async function hubspot(ctx: Ctx, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: IDataObject, qs?: IDataObject, i = 0): Promise<IDataObject> {
  const auth = ctx.getNodeParameter('authentication', i, 'appToken') === 'oAuth2' ? 'hubspotOAuth2Api' : 'hubspotAppToken';
  try {
    return (await apiRequest(ctx, auth, { url: `${API}${path}`, method, ...(body ? { body } : {}), ...(qs ? { qs } : {}) }, i)) ?? {};
  } catch (e) {
    const b = (e as { body?: { message?: string; category?: string } }).body;
    if (b?.message) throw new Error(`HubSpot error: ${b.message}`);
    throw e;
  }
}

/** Flattens a CRM object: id, timestamps and its properties on one level. */
export const flattenHubspot = (o: IDataObject): IDataObject => ({ id: o.id, ...(o.properties as IDataObject), createdAt: o.createdAt, updatedAt: o.updatedAt, archived: o.archived, ...(o.associations ? { associations: o.associations } : {}) });

const FILTER_OPS = ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN'];

/** Filter groups from the UI → the search API's filterGroups (groups are OR'ed, filters inside AND'ed). */
export function hubspotFilterGroups(ui: IDataObject): IDataObject[] {
  const groups = ((ui.filterGroupsValues as IDataObject[]) ?? []).map((g) =>
    (((g.filtersUi as IDataObject)?.filterValues as IDataObject[]) ?? []).filter((f) => f.propertyName).map((f) => {
      const op = String(f.operator ?? 'EQ');
      if (op === 'HAS_PROPERTY' || op === 'NOT_HAS_PROPERTY') return { propertyName: f.propertyName, operator: op };
      if (op === 'BETWEEN') return { propertyName: f.propertyName, operator: op, value: f.value, highValue: f.highValue };
      if (op === 'IN' || op === 'NOT_IN') return { propertyName: f.propertyName, operator: op, values: String(f.value ?? '').split(',').map((v) => v.trim()) };
      return { propertyName: f.propertyName, operator: op, value: f.value };
    }),
  );
  return groups.filter((g) => g.length).map((filters) => ({ filters }));
}

const propertiesUi = (object: string): INodeProperties => ({
  displayName: 'Properties',
  name: 'propertiesUi',
  type: 'fixedCollection',
  typeOptions: { multipleValues: true },
  default: {},
  placeholder: 'Add Property',
  options: [{ name: 'propertyValues', displayName: 'Property', values: [
    { displayName: 'Property', name: 'property', type: 'options', default: '', typeOptions: { loadOptionsMethod: `get${object}Properties` } },
    { displayName: 'Value', name: 'value', type: 'string', default: '' },
  ] }],
});
const outputProperties = (object: string): INodeProperties => ({
  displayName: 'Options',
  name: 'options',
  type: 'collection',
  default: {},
  options: [
    { displayName: 'Properties to Return', name: 'properties', type: 'multiOptions', default: [], typeOptions: { loadOptionsMethod: `get${object}Properties` } },
    { displayName: 'Include Associations', name: 'associations', type: 'string', default: '', placeholder: 'companies,deals' },
  ],
});
const filterGroups: INodeProperties = {
  displayName: 'Filter Groups',
  name: 'filterGroupsUi',
  type: 'fixedCollection',
  typeOptions: { multipleValues: true },
  default: {},
  description: 'Groups match with OR; filters in a group must all match',
  options: [{
    name: 'filterGroupsValues',
    displayName: 'Filter Group',
    values: [{
      displayName: 'Filters',
      name: 'filtersUi',
      type: 'fixedCollection',
      typeOptions: { multipleValues: true },
      default: {},
      options: [{ name: 'filterValues', displayName: 'Filter', values: [
        { displayName: 'Property Name', name: 'propertyName', type: 'string', default: '' },
        { displayName: 'Operator', name: 'operator', type: 'options', default: 'EQ', options: FILTER_OPS.map((o) => ({ name: o, value: o })) },
        { displayName: 'Value', name: 'value', type: 'string', default: '' },
        { displayName: 'High Value', name: 'highValue', type: 'string', default: '', displayOptions: { show: { operator: ['BETWEEN'] } } },
      ] }],
    }],
  }],
};

const objectResource = (resource: string, idName: string): INodeProperties[] => {
  const Obj = resource[0].toUpperCase() + resource.slice(1);
  return [
    operationProp(resource, [
      ...(resource === 'contact' ? [{ name: 'Create or Update', value: 'upsert', description: 'Matched on email' }] : [{ name: 'Create', value: 'create' }]),
      { name: 'Delete', value: 'delete' },
      { name: 'Get', value: 'get' },
      { name: 'Get Many', value: 'getAll' },
      { name: 'Search', value: 'search' },
      ...(resource === 'contact' ? [] : [{ name: 'Update', value: 'update' }]),
    ]),
    ...forOp(resource, 'upsert', [{ displayName: 'Email', name: 'email', type: 'string', default: '', required: true, placeholder: 'name@email.com' }]),
    ...forOp(resource, ['get', 'update', 'delete'], [{ displayName: `${Obj} ID`, name: idName, type: 'string', default: '', required: true }]),
    ...forOp(resource, ['create', 'upsert', 'update'], [propertiesUi(Obj)]),
    ...(resource === 'deal' ? forOp(resource, 'create', [
      { displayName: 'Deal Name', name: 'dealname', type: 'string', default: '', required: true },
      { displayName: 'Deal Stage', name: 'dealstage', type: 'string', default: 'appointmentscheduled', required: true },
    ]) : []),
    ...(resource === 'company' ? forOp(resource, 'create', [{ displayName: 'Name', name: 'name', type: 'string', default: '', required: true }]) : []),
    ...(resource === 'ticket' ? forOp(resource, 'create', [
      { displayName: 'Ticket Name', name: 'subject', type: 'string', default: '', required: true },
      { displayName: 'Pipeline Stage ID', name: 'hs_pipeline_stage', type: 'string', default: '1', required: true },
    ]) : []),
    ...forOp(resource, ['create', 'upsert', 'update'], [{
      displayName: 'Associate With',
      name: 'associateWith',
      type: 'fixedCollection',
      typeOptions: { multipleValues: true },
      default: {},
      options: [{ name: 'values', displayName: 'Association', values: [
        { displayName: 'Object Type', name: 'objectType', type: 'options', default: 'companies', options: ['contacts', 'companies', 'deals', 'tickets'].map((o) => ({ name: o, value: o })) },
        { displayName: 'Object ID', name: 'objectId', type: 'string', default: '' },
      ] }],
    }]),
    ...forOp(resource, ['get', 'getAll', 'search'], [outputProperties(Obj)]),
    ...forOp(resource, ['getAll', 'search'], returnAllProps({ resource: [resource], operation: ['getAll', 'search'] })),
    ...forOp(resource, 'search', [
      filterGroups,
      { displayName: 'Query', name: 'query', type: 'string', default: '', description: 'Free text searched across the default searchable properties' },
      { displayName: 'Sort By', name: 'sortBy', type: 'string', default: '', placeholder: 'createdate' },
      { displayName: 'Direction', name: 'direction', type: 'options', default: 'DESCENDING', options: [{ name: 'Ascending', value: 'ASCENDING' }, { name: 'Descending', value: 'DESCENDING' }] },
    ]),
  ];
};

const properties: INodeProperties[] = [
  { displayName: 'Authentication', name: 'authentication', type: 'options', default: 'appToken', options: [{ name: 'APP Token', value: 'appToken' }, { name: 'OAuth2', value: 'oAuth2' }] },
  {
    displayName: 'Resource',
    name: 'resource',
    type: 'options',
    noDataExpression: true,
    default: 'contact',
    options: [
      { name: 'Contact', value: 'contact' },
      { name: 'Contact List', value: 'contactList' },
      { name: 'Company', value: 'company' },
      { name: 'Deal', value: 'deal' },
      { name: 'Engagement', value: 'engagement' },
      { name: 'Ticket', value: 'ticket' },
    ],
  },
  ...objectResource('contact', 'contactId'),
  ...objectResource('company', 'companyId'),
  ...objectResource('deal', 'dealId'),
  ...objectResource('ticket', 'ticketId'),

  operationProp('contactList', [{ name: 'Add', value: 'add', description: 'Add contacts to a list' }, { name: 'Remove', value: 'remove', description: 'Remove contacts from a list' }]),
  ...forOp('contactList', ['add', 'remove'], [
    { displayName: 'List ID', name: 'listId', type: 'string', default: '', required: true, description: 'ILS list ID of a manual (static) list' },
    { displayName: 'Contact IDs', name: 'contactIds', type: 'string', default: '', required: true, description: 'Comma separated' },
  ]),

  operationProp('engagement', [{ name: 'Create', value: 'create' }, { name: 'Delete', value: 'delete' }, { name: 'Get', value: 'get' }, { name: 'Get Many', value: 'getAll' }]),
  ...forOp('engagement', ['create', 'delete', 'get', 'getAll'], [{ displayName: 'Type', name: 'type', type: 'options', default: 'note', options: Object.keys(ENGAGEMENTS).map((t) => ({ name: t[0].toUpperCase() + t.slice(1), value: t })) }]),
  ...forOp('engagement', ['delete', 'get'], [{ displayName: 'Engagement ID', name: 'engagementId', type: 'string', default: '', required: true }]),
  ...forOp('engagement', 'create', [
    { displayName: 'Body', name: 'body', type: 'string', typeOptions: { rows: 4 }, default: '', description: 'Note text, task/call/meeting notes or email body' },
    { displayName: 'Subject / Title', name: 'subject', type: 'string', default: '', displayOptions: { show: { type: ['task', 'call', 'email', 'meeting'] } } },
    { displayName: 'Timestamp', name: 'timestamp', type: 'dateTime', default: '', description: 'Defaults to now (due date for tasks, start for meetings)' },
    {
      displayName: 'Associations',
      name: 'associations',
      type: 'collection',
      default: {},
      options: [
        { displayName: 'Contact IDs', name: 'contacts', type: 'string', default: '' },
        { displayName: 'Company IDs', name: 'companies', type: 'string', default: '' },
        { displayName: 'Deal IDs', name: 'deals', type: 'string', default: '' },
        { displayName: 'Ticket IDs', name: 'tickets', type: 'string', default: '' },
      ],
    },
    { displayName: 'Additional Properties (JSON)', name: 'extraProperties', type: 'json', default: '{}', placeholder: '{ "hs_task_priority": "HIGH" }' },
  ]),
  ...forOp('engagement', 'getAll', returnAllProps({ resource: ['engagement'], operation: ['getAll'] })),
];

const REQUIRED_ON_CREATE: Record<string, string[]> = { deal: ['dealname', 'dealstage'], company: ['name'], ticket: ['subject', 'hs_pipeline_stage'] };
const csv = (s: unknown) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Default association type ids (HUBSPOT_DEFINED) between CRM objects. */
const ASSOCIATION_TYPES: Record<string, number> = {
  'contacts-companies': 279, 'contacts-deals': 4, 'contacts-tickets': 15,
  'companies-contacts': 280, 'companies-deals': 342, 'companies-tickets': 340,
  'deals-contacts': 3, 'deals-companies': 341, 'deals-tickets': 27,
  'tickets-contacts': 16, 'tickets-companies': 339, 'tickets-deals': 28,
  'notes-contacts': 202, 'notes-companies': 190, 'notes-deals': 214, 'notes-tickets': 228,
  'tasks-contacts': 204, 'tasks-companies': 192, 'tasks-deals': 216, 'tasks-tickets': 230,
  'calls-contacts': 194, 'calls-companies': 182, 'calls-deals': 206, 'calls-tickets': 220,
  'emails-contacts': 198, 'emails-companies': 186, 'emails-deals': 210, 'emails-tickets': 224,
  'meetings-contacts': 200, 'meetings-companies': 188, 'meetings-deals': 212, 'meetings-tickets': 226,
};
const association = (from: string, to: string, id: string) => ({ to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_TYPES[`${from}-${to}`] }] });

const loadProperties = (object: string) =>
  async function (this: ILoadOptionsFunctions) {
    const r = await hubspot(this as unknown as Ctx, 'GET', `/crm/v3/properties/${object}`);
    return ((r.results as IDataObject[]) ?? []).filter((p) => !(p.modificationMetadata as IDataObject)?.readOnlyValue).map((p) => ({ name: String(p.label), value: String(p.name), description: String(p.type) })).sort((a, b) => a.name.localeCompare(b.name));
  };

export const Hubspot: INodeType = {
  description: {
    name: 'flowmator.hubspot',
    displayName: 'HubSpot',
    description: 'Contacts, companies, deals, tickets and engagements in HubSpot CRM',
    group: ['output'],
    version: [2, 2.1, 2.2],
    defaults: { name: 'HubSpot', color: '#FF7A59' },
    icon: 'fa:hubspot',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      { name: 'hubspotAppToken', required: true, displayOptions: { show: { authentication: ['appToken'] } } },
      { name: 'hubspotOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
    ],
    codex: { categories: ['Sales', 'Marketing'], alias: ['CRM'] },
    properties,
  },
  methods: {
    loadOptions: {
      getContactProperties: loadProperties('contacts'),
      getCompanyProperties: loadProperties('companies'),
      getDealProperties: loadProperties('deals'),
      getTicketProperties: loadProperties('tickets'),
    },
  },
  async execute(this: IExecuteFunctions) {
    return [
      await forEachItem(this, async (i) => {
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: IDataObject, qs?: IDataObject) => hubspot(this, method, path, body, qs, i);
        const resource = p('resource');
        const op = p('operation');

        if (resource === 'contactList') {
          const ids = csv(p('contactIds'));
          const r = await call('PUT', `/crm/v3/lists/${p('listId')}/memberships/${op === 'add' ? 'add' : 'remove'}`, ids as unknown as IDataObject);
          return { listId: p('listId'), ...r };
        }

        if (resource === 'engagement') {
          const object = ENGAGEMENTS[p('type')];
          if (op === 'get') return flattenHubspot(await call('GET', `/crm/v3/objects/${object}/${p('engagementId')}`));
          if (op === 'delete') {
            await call('DELETE', `/crm/v3/objects/${object}/${p('engagementId')}`);
            return { deleted: true, id: p('engagementId') };
          }
          if (op === 'getAll') {
            const rows = await collectPages(async (after, size) => {
              const r = await call('GET', `/crm/v3/objects/${object}`, undefined, { limit: size, ...(after ? { after } : {}) });
              return { items: r.results as IDataObject[], next: ((r.paging as IDataObject)?.next as IDataObject)?.after as string };
            }, listLimit(this, i));
            return rows.map(flattenHubspot);
          }
          const type = p('type');
          const ts = p('timestamp', '') ? new Date(p('timestamp')).toISOString() : new Date().toISOString();
          const text = p('body', '');
          const props: IDataObject = { hs_timestamp: ts };
          if (type === 'note') props.hs_note_body = text;
          if (type === 'task') Object.assign(props, { hs_task_subject: p('subject', ''), hs_task_body: text, hs_task_status: 'NOT_STARTED' });
          if (type === 'call') Object.assign(props, { hs_call_title: p('subject', ''), hs_call_body: text });
          if (type === 'email') Object.assign(props, { hs_email_subject: p('subject', ''), hs_email_text: text, hs_email_direction: 'EMAIL' });
          if (type === 'meeting') Object.assign(props, { hs_meeting_title: p('subject', ''), hs_meeting_body: text, hs_meeting_start_time: ts });
          const extra = p<unknown>('extraProperties', '{}');
          Object.assign(props, typeof extra === 'string' ? JSON.parse(extra || '{}') : extra);
          const assoc = p<IDataObject>('associations', {});
          const associations = Object.entries(assoc).flatMap(([to, ids]) => csv(ids).map((id) => association(object, to, id)));
          return flattenHubspot(await call('POST', `/crm/v3/objects/${object}`, { properties: props, ...(associations.length ? { associations } : {}) }));
        }

        const object = OBJECTS[resource];
        const id = () => p(`${resource}Id`);
        const o = p<IDataObject>('options', {});
        const readQs = () => ({
          ...((o.properties as string[])?.length ? { properties: (o.properties as string[]).join(',') } : {}),
          ...(o.associations ? { associations: String(o.associations) } : {}),
        });

        if (op === 'get') return flattenHubspot(await call('GET', `/crm/v3/objects/${object}/${id()}`, undefined, readQs()));
        if (op === 'delete') {
          await call('DELETE', `/crm/v3/objects/${object}/${id()}`);
          return { deleted: true, id: id() };
        }
        if (op === 'getAll') {
          const rows = await collectPages(async (after, size) => {
            const r = await call('GET', `/crm/v3/objects/${object}`, undefined, { ...readQs(), limit: size, ...(after ? { after } : {}) });
            return { items: r.results as IDataObject[], next: ((r.paging as IDataObject)?.next as IDataObject)?.after as string };
          }, listLimit(this, i));
          return rows.map(flattenHubspot);
        }
        if (op === 'search') {
          const body: IDataObject = { filterGroups: hubspotFilterGroups(p<IDataObject>('filterGroupsUi', {})) };
          if (p('query', '')) body.query = p('query');
          if (p('sortBy', '')) body.sorts = [{ propertyName: p('sortBy'), direction: p('direction', 'DESCENDING') }];
          if ((o.properties as string[])?.length) body.properties = o.properties;
          const rows = await collectPages(async (after, size) => {
            const r = await call('POST', `/crm/v3/objects/${object}/search`, { ...body, limit: Math.min(size, 200), ...(after ? { after } : {}) });
            return { items: r.results as IDataObject[], next: ((r.paging as IDataObject)?.next as IDataObject)?.after as string };
          }, listLimit(this, i), 200);
          return rows.map(flattenHubspot);
        }

        // create / upsert / update
        const props: IDataObject = Object.fromEntries((((p<IDataObject>('propertiesUi', {}).propertyValues as Array<{ property: string; value: string }>) ?? []).filter((v) => v.property)).map((v) => [v.property, v.value]));
        if (op === 'create') for (const field of REQUIRED_ON_CREATE[resource] ?? []) props[field] = p(field);
        if (resource === 'ticket' && op === 'create' && !props.hs_pipeline) props.hs_pipeline = '0';
        const associations = (((p<IDataObject>('associateWith', {}).values as Array<{ objectType: string; objectId: string }>) ?? []).filter((a) => a.objectId)).map((a) => [a.objectType, a.objectId] as const);

        let result: IDataObject;
        if (op === 'upsert') {
          props.email = p('email');
          const r = await call('POST', `/crm/v3/objects/${object}/batch/upsert`, { inputs: [{ idProperty: 'email', id: p('email'), properties: props }] });
          result = (r.results as IDataObject[])[0];
        } else if (op === 'create') {
          result = await call('POST', `/crm/v3/objects/${object}`, { properties: props, ...(associations.length ? { associations: associations.map(([to, aid]) => association(object, to, aid)) } : {}) });
          return flattenHubspot(result);
        } else result = await call('PATCH', `/crm/v3/objects/${object}/${id()}`, { properties: props });
        // updates associate one by one (default association label)
        for (const [to, aid] of associations) await call('PUT', `/crm/v4/objects/${object}/${result.id}/associations/default/${to}/${aid}`);
        return flattenHubspot(result);
      }),
    ];
  },
};

export const hubspotCredentials: ICredentialType[] = [
  {
    name: 'hubspotAppToken',
    displayName: 'HubSpot App Token',
    documentationUrl: 'https://developers.hubspot.com/docs/api/private-apps',
    properties: [{ displayName: 'APP Token', name: 'appToken', type: 'string', typeOptions: { password: true }, default: '', description: 'Access token of a private app' }],
    authenticate: { type: 'generic', properties: { headers: { Authorization: '=Bearer {{$credentials.appToken}}' } } },
    test: { request: { url: 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1' } },
  },
  {
    name: 'hubspotOAuth2Api',
    displayName: 'HubSpot OAuth2',
    extends: ['oAuth2Api'],
    properties: [
      { displayName: 'Client ID', name: 'clientId', type: 'string', default: '' },
      { displayName: 'Client Secret', name: 'clientSecret', type: 'string', typeOptions: { password: true }, default: '' },
      { displayName: 'Grant Type', name: 'grantType', type: 'hidden', default: 'authorizationCode' },
      { displayName: 'Authorization URL', name: 'authUrl', type: 'hidden', default: 'https://app.hubspot.com/oauth/authorize' },
      { displayName: 'Access Token URL', name: 'accessTokenUrl', type: 'hidden', default: 'https://api.hubapi.com/oauth/v1/token' },
      {
        displayName: 'Scope',
        name: 'scope',
        type: 'string',
        default: 'crm.objects.contacts.read crm.objects.contacts.write crm.objects.companies.read crm.objects.companies.write crm.objects.deals.read crm.objects.deals.write crm.lists.read crm.lists.write crm.schemas.contacts.read tickets',
      },
      { displayName: 'Auth URI Query Parameters', name: 'authQueryParameters', type: 'hidden', default: '' },
      { displayName: 'Authentication', name: 'authentication', type: 'hidden', default: 'body' },
      { displayName: 'Token Data', name: 'oauthTokenData', type: 'hidden', default: {} },
    ],
  },
];
