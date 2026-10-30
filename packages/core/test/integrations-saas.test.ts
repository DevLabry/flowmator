import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adfToText, driveItemPath, hubspotFilterGroups, outlookFilter, simplifyIssue, stripeForm, textToAdf, verifyStripeSignature, verifyTrelloSignature } from '@8n8/nodes-base';
import type { IDataObject, IWebhookRequest } from '@8n8/workflow';
import { HookContext, PollContext, WebhookContext } from '../src';
import { additionalData, makeWorkflow, node } from './helpers';
import { calls, creds, credentialsHelper, route, runNode, withCred } from './integration-harness';

Object.assign(creds, {
  stripeApi: { secretKey: 'sk_test_1', accessToken: 'sk_test_1' },
  hubspotAppToken: { appToken: 'pat-na1', accessToken: 'pat-na1' },
  jiraSoftwareCloudApi: { email: 'me@x.io', apiToken: 't', domain: 'https://acme.atlassian.net/', accessToken: 'jira' },
  jiraSoftwareServerApi: { email: 'me', password: 'p', domain: 'https://jira.acme.io', accessToken: 'jira' },
  trelloApi: { apiKey: 'k', apiToken: 't', oauthSecret: 'trello-secret', accessToken: 'trello' },
  microsoftOutlookOAuth2Api: { oauthTokenData: { access_token: 'ms-outlook' } },
  microsoftTeamsOAuth2Api: { oauthTokenData: { access_token: 'ms-teams' } },
  microsoftOneDriveOAuth2Api: { oauthTokenData: { access_token: 'ms-drive' } },
});

/** A webhook trigger: runs its hook methods (with static data) and receives deliveries. */
function webhookTrigger(type: string, params: Record<string, unknown>, cred: string, url = 'https://8n8.example/webhook/abc/webhook') {
  const wf = makeWorkflow([node('T', type, params, withCred(cred))], {});
  const nodeType = wf.nodeTypes.getByNameAndVersion(`8n8.${type}`);
  const p = () => ({ workflow: wf, node: wf.getNode('T')!, additionalData: additionalData({ mode: 'trigger', credentialsHelper }) });
  return {
    hook: (method: 'create' | 'delete' | 'checkExists') => nodeType.webhookMethods!.default[method].call(new HookContext(p(), 'default', () => url)),
    deliver: (body: unknown, headers: Record<string, string> = {}, name = 'default', method = 'POST') => {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      const request: IWebhookRequest = { method, path: 'webhook', headers, query: {}, params: {}, body: typeof body === 'string' ? {} : (body as IDataObject), rawBody: Buffer.from(raw) };
      return nodeType.webhook!.call(new WebhookContext(p(), request, name, () => url));
    },
    state: () => wf.staticData['node:T'] as IDataObject,
  };
}

/* ---------- Stripe ---------- */

describe('Stripe', () => {
  it('encodes nested form bodies the way Stripe expects', () => {
    expect(stripeForm({ amount: 500, metadata: { plan: 'pro' }, expand: ['customer'], shipping: { address: { city: 'Madrid' } }, x: undefined }).toString()).toBe(
      'amount=500&metadata%5Bplan%5D=pro&expand%5B0%5D=customer&shipping%5Baddress%5D%5Bcity%5D=Madrid',
    );
  });

  it('creates customers with metadata and pages through lists', async () => {
    route(/POST https:\/\/api\.stripe\.com\/v1\/customers$/, () => ({ id: 'cus_1', object: 'customer' }));
    const [c] = await runNode('stripe', { resource: 'customer', operation: 'create', name: 'Ada', additionalFields: { email: 'ada@x.io', metadata: { metadataProperties: [{ key: 'source', value: '8n8' }] } } }, 'stripeApi');
    expect(c).toEqual({ id: 'cus_1', object: 'customer' });
    expect(calls[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0].body).toEqual({ name: 'Ada', email: 'ada@x.io', 'metadata[source]': '8n8' });

    route(/GET https:\/\/api\.stripe\.com\/v1\/charges$/, (call) =>
      call.url.searchParams.get('starting_after') ? { data: [{ id: 'ch_3' }], has_more: false } : { data: [{ id: 'ch_1' }, { id: 'ch_2' }], has_more: true },
    );
    const charges = await runNode('stripe', { resource: 'charge', operation: 'getAll', returnAll: true }, 'stripeApi');
    expect(charges.map((x) => x.id)).toEqual(['ch_1', 'ch_2', 'ch_3']);
    expect(calls.at(-1)!.url.searchParams.get('starting_after')).toBe('ch_2');
  });

  it('creates payment intents with automatic payment methods and reports Stripe errors', async () => {
    route(/POST https:\/\/api\.stripe\.com\/v1\/payment_intents$/, () => ({ id: 'pi_1', status: 'requires_payment_method' }));
    await runNode('stripe', { resource: 'paymentIntent', operation: 'create', amount: 1999, currency: 'eur', additionalFields: { customer: 'cus_1' } }, 'stripeApi');
    expect(calls[0].body).toEqual({ amount: '1999', currency: 'eur', 'automatic_payment_methods[enabled]': 'true', customer: 'cus_1' });

    route(/GET https:\/\/api\.stripe\.com\/v1\/customers\/cus_x/, () => new Response(JSON.stringify({ error: { message: 'No such customer', code: 'resource_missing' } }), { status: 404, headers: { 'content-type': 'application/json' } }));
    await expect(runNode('stripe', { resource: 'customer', operation: 'get', customerId: 'cus_x' }, 'stripeApi')).rejects.toThrow('Stripe error: No such customer (resource_missing)');
  });

  it('registers the webhook endpoint and verifies Stripe-Signature', async () => {
    route(/POST https:\/\/api\.stripe\.com\/v1\/webhook_endpoints$/, () => ({ id: 'we_1', secret: 'whsec_abc' }));
    route(/DELETE https:\/\/api\.stripe\.com\/v1\/webhook_endpoints\/we_1/, () => ({ deleted: true }));
    const t = webhookTrigger('stripeTrigger', { events: ['invoice.paid'] }, 'stripeApi');
    await t.hook('create');
    expect(calls[0].body).toMatchObject({ url: 'https://8n8.example/webhook/abc/webhook', 'enabled_events[0]': 'invoice.paid' });
    expect(t.state()).toMatchObject({ webhookId: 'we_1', webhookSecret: 'whsec_abc' });

    const event = { id: 'evt_1', type: 'invoice.paid', data: { object: { id: 'in_1' } } };
    const raw = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const sig = `t=${ts},v1=${createHmac('sha256', 'whsec_abc').update(`${ts}.${raw}`).digest('hex')}`;
    expect((await t.deliver(event, { 'stripe-signature': sig })).workflowData![0][0].json).toEqual(event);
    expect((await t.deliver(event, { 'stripe-signature': `t=${ts},v1=bad` })).webhookResponse).toMatchObject({ statusCode: 400 });
    // events the trigger does not listen to are acknowledged and dropped
    const other = { ...event, type: 'charge.failed' };
    const otherSig = `t=${ts},v1=${createHmac('sha256', 'whsec_abc').update(`${ts}.${JSON.stringify(other)}`).digest('hex')}`;
    expect((await t.deliver(other, { 'stripe-signature': otherSig })).workflowData).toBeUndefined();

    expect(verifyStripeSignature('whsec_abc', sig, Buffer.from(raw), 300, (ts + 600) * 1000)).toBe(false);
    await t.hook('delete');
    expect(t.state().webhookId).toBeUndefined();
  });
});

/* ---------- HubSpot ---------- */

describe('HubSpot', () => {
  it('upserts contacts by email and associates them', async () => {
    route(/POST https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/contacts\/batch\/upsert/, () => ({ results: [{ id: '51', properties: { email: 'ada@x.io', firstname: 'Ada' }, createdAt: 'c', updatedAt: 'u', archived: false }] }));
    route(/PUT https:\/\/api\.hubapi\.com\/crm\/v4\/objects\/contacts\/51\/associations\/default\/companies\/9/, () => ({}));
    const [c] = await runNode('hubspot', { resource: 'contact', operation: 'upsert', email: 'ada@x.io', propertiesUi: { propertyValues: [{ property: 'firstname', value: 'Ada' }] }, associateWith: { values: [{ objectType: 'companies', objectId: '9' }] } }, 'hubspotAppToken');
    expect(c).toEqual({ id: '51', email: 'ada@x.io', firstname: 'Ada', createdAt: 'c', updatedAt: 'u', archived: false });
    expect(calls[0].body).toEqual({ inputs: [{ idProperty: 'email', id: 'ada@x.io', properties: { firstname: 'Ada', email: 'ada@x.io' } }] });
    expect(calls).toHaveLength(2);
  });

  it('creates deals with inline associations', async () => {
    route(/POST https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/deals$/, () => ({ id: '7', properties: { dealname: 'Big', amount: '100' } }));
    await runNode('hubspot', { resource: 'deal', operation: 'create', dealname: 'Big', dealstage: 'qualifiedtobuy', propertiesUi: { propertyValues: [{ property: 'amount', value: '100' }] }, associateWith: { values: [{ objectType: 'contacts', objectId: '51' }] } }, 'hubspotAppToken');
    expect(calls[0].body).toEqual({
      properties: { amount: '100', dealname: 'Big', dealstage: 'qualifiedtobuy' },
      associations: [{ to: { id: '51' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }],
    });
  });

  it('searches with filter groups across pages', async () => {
    route(/POST https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/companies\/search/, (call) =>
      call.body.after ? { results: [{ id: '3', properties: {} }] } : { results: [{ id: '1', properties: {} }, { id: '2', properties: {} }], paging: { next: { after: '2' } } },
    );
    const rows = await runNode('hubspot', {
      resource: 'company',
      operation: 'search',
      returnAll: true,
      sortBy: 'createdate',
      filterGroupsUi: { filterGroupsValues: [{ filtersUi: { filterValues: [{ propertyName: 'domain', operator: 'CONTAINS_TOKEN', value: 'acme' }, { propertyName: 'industry', operator: 'IN', value: 'SOFTWARE, RETAIL' }] } }] },
    }, 'hubspotAppToken');
    expect(rows.map((r) => r.id)).toEqual(['1', '2', '3']);
    expect(calls[0].body).toMatchObject({ sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }], filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'CONTAINS_TOKEN', value: 'acme' }, { propertyName: 'industry', operator: 'IN', values: ['SOFTWARE', 'RETAIL'] }] }] });
    expect(hubspotFilterGroups({ filterGroupsValues: [{ filtersUi: { filterValues: [{ propertyName: 'email', operator: 'HAS_PROPERTY', value: 'x' }] } }, {}] })).toEqual([{ filters: [{ propertyName: 'email', operator: 'HAS_PROPERTY' }] }]);
  });

  it('creates notes associated with a contact', async () => {
    route(/POST https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/notes$/, (call) => ({ id: 'n1', properties: call.body.properties }));
    const [note] = await runNode('hubspot', { resource: 'engagement', operation: 'create', type: 'note', body: 'Called, interested', timestamp: '2026-10-01T10:00:00Z', associations: { contacts: '51, 52' } }, 'hubspotAppToken');
    expect(note).toMatchObject({ id: 'n1', hs_note_body: 'Called, interested', hs_timestamp: '2026-10-01T10:00:00.000Z' });
    expect(calls[0].body.associations.map((a: any) => [a.to.id, a.types[0].associationTypeId])).toEqual([['51', 202], ['52', 202]]);
  });
});

/* ---------- Jira ---------- */

describe('Jira', () => {
  it('converts text to and from ADF', () => {
    const adf = textToAdf('Line one\nline two\n\nSecond paragraph');
    expect(adf).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Line one' }, { type: 'hardBreak' }, { type: 'text', text: 'line two' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] },
      ],
    });
    expect(adfToText(adf).trim()).toBe('Line one\nline two\nSecond paragraph');
    expect(simplifyIssue({ id: '1', key: 'P-1', fields: { summary: 'S', status: { name: 'Done' }, labels: ['a'], description: adf } })).toMatchObject({ key: 'P-1', status: 'Done', labels: ['a'], description: 'Line one\nline two\nSecond paragraph' });
  });

  it('creates Cloud issues with ADF descriptions and custom fields', async () => {
    route(/POST https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue$/, () => ({ id: '100', key: 'PROJ-1' }));
    const [issue] = await runNode('jira', {
      resource: 'issue', operation: 'create', project: '10000', issueType: '10001', summary: 'Broken login',
      additionalFields: { description: 'Steps:\n1. open', labels: 'bug, auth', priority: '2', assignee: 'acc-1', customFieldsUi: { customFieldsValues: [{ fieldId: 'customfield_10016', fieldValue: '5' }, { fieldId: 'customfield_1', fieldValue: 'text' }] } },
    }, 'jiraSoftwareCloudApi');
    expect(issue).toEqual({ id: '100', key: 'PROJ-1' });
    expect(calls[0].body.fields).toEqual({
      project: { id: '10000' }, issuetype: { id: '10001' }, summary: 'Broken login',
      description: textToAdf('Steps:\n1. open'), labels: ['bug', 'auth'], priority: { id: '2' }, assignee: { accountId: 'acc-1' }, customfield_10016: 5, customfield_1: 'text',
    });
  });

  it('updates fields and transitions in one operation', async () => {
    route(/PUT https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue\/PROJ-1$/, () => new Response(null, { status: 204 }));
    route(/POST https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue\/PROJ-1\/transitions/, () => new Response(null, { status: 204 }));
    expect(await runNode('jira', { resource: 'issue', operation: 'update', issueKey: 'PROJ-1', updateFields: { summary: 'New title', statusId: '31' } }, 'jiraSoftwareCloudApi')).toEqual([{ success: true, key: 'PROJ-1' }]);
    expect(calls.map((c) => [c.method, c.body])).toEqual([['PUT', { fields: { summary: 'New title' } }], ['POST', { transition: { id: '31' } }]]);
  });

  it('searches with the enhanced JQL API on Cloud and startAt paging on Server', async () => {
    route(/POST https:\/\/acme\.atlassian\.net\/rest\/api\/3\/search\/jql/, (call) => (call.body.nextPageToken ? { issues: [{ key: 'P-3' }], isLast: true } : { issues: [{ key: 'P-1' }, { key: 'P-2' }], nextPageToken: 'n2', isLast: false }));
    const cloud = await runNode('jira', { resource: 'issue', operation: 'getAll', returnAll: true, options: { jql: 'project = P', fields: 'summary,status' } }, 'jiraSoftwareCloudApi');
    expect(cloud.map((x) => x.key)).toEqual(['P-1', 'P-2', 'P-3']);
    expect(calls[0].body).toMatchObject({ jql: 'project = P', fields: ['summary', 'status'] });

    route(/POST https:\/\/jira\.acme\.io\/rest\/api\/2\/search$/, (call) => ({ total: 3, issues: call.body.startAt ? [{ key: 'S-3' }] : [{ key: 'S-1' }, { key: 'S-2' }] }));
    const server = await runNode('jira', { jiraVersion: 'server', resource: 'issue', operation: 'getAll', returnAll: true, options: { jql: 'project = S' } }, 'jiraSoftwareServerApi');
    expect(server.map((x) => x.key)).toEqual(['S-1', 'S-2', 'S-3']);
  });

  it('adds comments as ADF on Cloud and plain text on Server', async () => {
    route(/POST https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue\/P-1\/comment/, () => ({ id: 'c1' }));
    route(/POST https:\/\/jira\.acme\.io\/rest\/api\/2\/issue\/S-1\/comment/, () => ({ id: 'c2' }));
    await runNode('jira', { resource: 'issueComment', operation: 'add', issueKey: 'P-1', comment: 'Done' }, 'jiraSoftwareCloudApi');
    await runNode('jira', { jiraVersion: 'server', resource: 'issueComment', operation: 'add', issueKey: 'S-1', comment: 'Done' }, 'jiraSoftwareServerApi');
    expect(calls.map((c) => c.body.body)).toEqual([textToAdf('Done'), 'Done']);
  });

  it('registers the webhook with a JQL filter and checks signatures', async () => {
    route(/POST https:\/\/acme\.atlassian\.net\/rest\/webhooks\/1\.0\/webhook$/, () => ({ self: 'https://acme.atlassian.net/rest/webhooks/1.0/webhook/42' }));
    const t = webhookTrigger('jiraTrigger', { events: ['jira:issue_created'], additionalFields: { filter: 'project = P' } }, 'jiraSoftwareCloudApi');
    await t.hook('create');
    expect(calls[0].body).toMatchObject({ url: 'https://8n8.example/webhook/abc/webhook', events: ['jira:issue_created'], filters: { 'issue-related-events-section': 'project = P' } });
    expect(t.state().webhookId).toBe('42');
    const body = { webhookEvent: 'jira:issue_created', issue: { key: 'P-9' } };
    const sig = `sha256=${createHmac('sha256', String(t.state().secret)).update(JSON.stringify(body)).digest('hex')}`;
    expect((await t.deliver(body, { 'x-hub-signature': sig })).workflowData![0][0].json).toEqual(body);
    expect((await t.deliver(body, { 'x-hub-signature': 'sha256=00' })).webhookResponse).toMatchObject({ statusCode: 401 });
  });
});

/* ---------- Trello ---------- */

describe('Trello', () => {
  it('sends key and token as query parameters with the fields', async () => {
    // the harness authenticates with a header; the server puts key/token in the query string
    route(/POST https:\/\/api\.trello\.com\/1\/cards$/, (call) => ({ id: 'card1', name: call.url.searchParams.get('name') }));
    const [card] = await runNode('trello', { resource: 'card', operation: 'create', listId: 'l1', name: 'Write tests', description: 'now', additionalFields: { due: '2026-11-01T10:00:00Z', idLabels: 'a,b' } }, 'trelloApi');
    expect(card).toEqual({ id: 'card1', name: 'Write tests' });
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ idList: 'l1', name: 'Write tests', desc: 'now', due: '2026-11-01T10:00:00Z', idLabels: 'a,b' });
  });

  it('manages checklists, labels and comments', async () => {
    route(/POST https:\/\/api\.trello\.com\/1\/checklists\/cl1\/checkItems/, () => ({ id: 'ci1' }));
    route(/PUT https:\/\/api\.trello\.com\/1\/cards\/c1\/checkItem\/ci1/, () => ({ id: 'ci1', state: 'complete' }));
    route(/POST https:\/\/api\.trello\.com\/1\/cards\/c1\/idLabels/, () => ['lb1']);
    route(/POST https:\/\/api\.trello\.com\/1\/cards\/c1\/actions\/comments/, () => ({ id: 'a1' }));
    await runNode('trello', { resource: 'checklist', operation: 'createCheckItem', id: 'cl1', name: 'step', additionalFields: { checked: true } }, 'trelloApi');
    await runNode('trello', { resource: 'checklist', operation: 'updateCheckItem', cardId: 'c1', checkItemId: 'ci1', additionalFields: { state: 'complete' } }, 'trelloApi');
    await runNode('trello', { resource: 'label', operation: 'addLabel', cardId: 'c1', id: 'lb1' }, 'trelloApi');
    await runNode('trello', { resource: 'cardComment', operation: 'create', cardId: 'c1', text: 'LGTM' }, 'trelloApi');
    expect(calls.map((c) => `${c.method} ${c.url.pathname}?${c.url.searchParams}`)).toEqual([
      'POST /1/checklists/cl1/checkItems?name=step&checked=true',
      'PUT /1/cards/c1/checkItem/ci1?state=complete',
      'POST /1/cards/c1/idLabels?value=lb1',
      'POST /1/cards/c1/actions/comments?text=LGTM',
    ]);
  });

  it('answers the HEAD check, creates the webhook and verifies deliveries', async () => {
    route(/POST https:\/\/api\.trello\.com\/1\/webhooks$/, () => ({ id: 'wh1' }));
    const url = 'https://8n8.example/webhook/t1/webhook';
    const t = webhookTrigger('trelloTrigger', { id: 'board1' }, 'trelloApi', url);
    await t.hook('create');
    expect(Object.fromEntries(calls[0].url.searchParams)).toMatchObject({ callbackURL: url, idModel: 'board1' });
    expect((await t.deliver('', {}, 'setup', 'HEAD')).webhookResponse).toMatchObject({ statusCode: 200 });

    const body = { action: { type: 'createCard' }, model: { id: 'board1' } };
    const sig = createHmac('sha1', 'trello-secret').update(JSON.stringify(body) + url).digest('base64');
    expect(verifyTrelloSignature('trello-secret', Buffer.from(JSON.stringify(body)), url, sig)).toBe(true);
    expect((await t.deliver(body, { 'x-trello-webhook': sig })).workflowData![0][0].json).toEqual(body);
    expect((await t.deliver(body, { 'x-trello-webhook': 'nope' })).webhookResponse).toMatchObject({ statusCode: 401 });
  });
});


/* ---------- Microsoft ---------- */

describe('Microsoft Outlook', () => {
  it('sends mail with recipients, HTML and attachments', async () => {
    route(/POST https:\/\/graph\.microsoft\.com\/v1\.0\/me\/sendMail/, () => new Response(null, { status: 202 }));
    const wf = makeWorkflow(
      [
        node('Trigger', 'manualTrigger'),
        node('File', 'convertToFile', { operation: 'toText', sourceProperty: 'text', binaryPropertyName: 'doc', options: { fileName: 'notes.txt', mimeType: 'text/plain' } }),
        node('Mail', 'microsoftOutlook', { resource: 'message', operation: 'send', toRecipients: 'a@x.io, b@x.io', subject: 'Hi', bodyContent: '<b>Hello</b>', additionalFields: { bodyContentType: 'HTML', ccRecipients: 'c@x.io', attachments: 'doc', saveToSentItems: false } }, withCred('microsoftOutlookOAuth2Api')),
      ],
      { Trigger: { main: [[{ node: 'File', type: 'main', index: 0 }]] }, File: { main: [[{ node: 'Mail', type: 'main', index: 0 }]] } },
    );
    const { run } = await import('./helpers');
    const r = await run(wf, { triggerData: [{ json: { text: 'abc' } }], additional: { credentialsHelper } });
    expect(r.status).toBe('success');
    expect(calls[0].headers.authorization).toBe('Bearer ms-outlook');
    expect(calls[0].body).toEqual({
      message: {
        subject: 'Hi',
        body: { contentType: 'HTML', content: '<b>Hello</b>' },
        toRecipients: [{ emailAddress: { address: 'a@x.io' } }, { emailAddress: { address: 'b@x.io' } }],
        ccRecipients: [{ emailAddress: { address: 'c@x.io' } }],
        attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'notes.txt', contentType: 'text/plain', contentBytes: Buffer.from('abc').toString('base64') }],
      },
      saveToSentItems: false,
    });
  });

  it('lists messages with OData filters, following nextLink, simplified', async () => {
    const msg = (id: string) => ({ id, subject: `S${id}`, from: { emailAddress: { address: 'boss@x.io' } }, toRecipients: [{ emailAddress: { address: 'me@x.io' } }], receivedDateTime: '2026-10-01T00:00:00Z', isRead: false });
    route(/GET https:\/\/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages/, (c) => (c.url.searchParams.get('$skip') ? { value: [msg('3')] } : { value: [msg('1'), msg('2')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=2' }));
    const rows = await runNode('microsoftOutlook', { resource: 'message', operation: 'getAll', returnAll: true, filters: { foldersToInclude: 'inbox', sender: "o'neil@x.io", readStatus: 'unread' } }, 'microsoftOutlookOAuth2Api');
    expect(rows.map((m) => [m.id, m.from, m.to])).toEqual([['1', 'boss@x.io', ['me@x.io']], ['2', 'boss@x.io', ['me@x.io']], ['3', 'boss@x.io', ['me@x.io']]]);
    expect(calls[0].url.searchParams.get('$filter')).toBe("from/emailAddress/address eq 'o''neil@x.io' and isRead eq false");
    expect(outlookFilter({ categories: 'Red, Blue', hasAttachments: true })).toBe("hasAttachments eq true and (categories/any(x:x eq 'Red') or categories/any(x:x eq 'Blue'))");
  });

  it('creates Teams-enabled events in a time zone', async () => {
    route(/POST https:\/\/graph\.microsoft\.com\/v1\.0\/me\/events/, (c) => ({ id: 'ev1', ...c.body }));
    await runNode('microsoftOutlook', { resource: 'event', operation: 'create', subject: 'Sync', start: '2026-11-02T09:00:00Z', end: '2026-11-02T09:30:00Z', eventFields: { attendees: 'a@x.io', isOnlineMeeting: true, location: 'Room 1' } }, 'microsoftOutlookOAuth2Api');
    expect(calls[0].body).toEqual({
      subject: 'Sync',
      start: { dateTime: '2026-11-02T09:00:00.000', timeZone: 'UTC' },
      end: { dateTime: '2026-11-02T09:30:00.000', timeZone: 'UTC' },
      location: { displayName: 'Room 1' },
      attendees: [{ emailAddress: { address: 'a@x.io' }, type: 'required' }],
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    });
  });

  it('polls for mail received since the last check', async () => {
    const wf = makeWorkflow([node('T', 'microsoftOutlookTrigger', { filters: { readStatus: 'unread' } }, withCred('microsoftOutlookOAuth2Api'))], {});
    const poll = () => wf.nodeTypes.getByNameAndVersion('8n8.microsoftOutlookTrigger').poll!.call(new PollContext({ workflow: wf, node: wf.getNode('T')!, additionalData: additionalData({ mode: 'trigger', credentialsHelper }) }, () => {}));
    expect(await poll()).toBeNull();
    const since = (wf.staticData['node:T'] as IDataObject).lastTimeChecked as string;
    route(/GET https:\/\/graph\.microsoft\.com\/v1\.0\/me\/messages/, () => ({ value: [{ id: 'm1', subject: 'New', receivedDateTime: '2099-01-01T00:00:00Z' }] }));
    const out = await poll();
    expect(out![0].map((x) => x.json.subject)).toEqual(['New']);
    expect(calls[0].url.searchParams.get('$filter')).toBe(`receivedDateTime gt ${since} and isRead eq false`);
    expect((wf.staticData['node:T'] as IDataObject).lastTimeChecked).toBe('2099-01-01T00:00:00Z');
  });
});

describe('Microsoft Teams', () => {
  it('posts channel messages and replies', async () => {
    route(/POST https:\/\/graph\.microsoft\.com\/v1\.0\/teams\/t1\/channels\/c1\/messages/, () => ({ id: 'm1' }));
    await runNode('microsoftTeams', { resource: 'channelMessage', operation: 'create', teamId: 't1', channelId: 'c1', contentType: 'html', message: '<p>Deploy done</p>' }, 'microsoftTeamsOAuth2Api');
    await runNode('microsoftTeams', { resource: 'channelMessage', operation: 'create', teamId: 't1', channelId: 'c1', message: 'ok', options: { makeReply: 'm1' } }, 'microsoftTeamsOAuth2Api');
    expect(calls.map((c) => [c.url.pathname, c.body])).toEqual([
      ['/v1.0/teams/t1/channels/c1/messages', { body: { contentType: 'html', content: '<p>Deploy done</p>' } }],
      ['/v1.0/teams/t1/channels/c1/messages/m1/replies', { body: { contentType: 'text', content: 'ok' } }],
    ]);
  });

  it('updates Planner tasks with the current ETag', async () => {
    route(/GET https:\/\/graph\.microsoft\.com\/v1\.0\/planner\/tasks\/k1/, () => ({ id: 'k1', '@odata.etag': 'W/"abc"' }));
    route(/PATCH https:\/\/graph\.microsoft\.com\/v1\.0\/planner\/tasks\/k1/, () => new Response(null, { status: 204 }));
    await runNode('microsoftTeams', { resource: 'task', operation: 'update', taskId: 'k1', taskFields: { percentComplete: 100, assignedTo: 'u1' } }, 'microsoftTeamsOAuth2Api');
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.headers['if-match']).toBe('W/"abc"');
    expect(patch.body).toEqual({ percentComplete: 100, assignments: { u1: { '@odata.type': 'microsoft.graph.plannerAssignment', orderHint: ' !' } } });
  });
});

describe('Microsoft OneDrive', () => {
  it('uploads by path, downloads as binary and creates nested folders', async () => {
    route(/PUT https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/root:/, (c) => ({ id: 'f1', name: 'q 1.txt', size: c.raw?.length }));
    const [up] = await runNode('microsoftOneDrive', { resource: 'file', operation: 'upload', fileName: 'q 1.txt', parentId: '/Reports/2026', binaryData: false, fileContent: 'hola' }, 'microsoftOneDriveOAuth2Api');
    expect(up).toEqual({ id: 'f1', name: 'q 1.txt', size: 4 });
    expect(calls[0].url.pathname).toBe('/v1.0/me/drive/root:/Reports/2026/q%201.txt:/content');
    expect(calls[0].url.searchParams.get('@microsoft.graph.conflictBehavior')).toBe('replace');
    expect(driveItemPath('/a b/c')).toBe('/me/drive/root:/a%20b/c:');

    route(/POST https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/(root|items\/[\w-]+)\/children/, (c) => ({ id: `id-${c.body.name}`, name: c.body.name }));
    const [folder] = await runNode('microsoftOneDrive', { resource: 'folder', operation: 'create', name: 'invoices/2026' }, 'microsoftOneDriveOAuth2Api');
    expect(folder).toEqual({ id: 'id-2026', name: '2026' });
    expect(calls.slice(-2).map((c) => c.url.pathname)).toEqual(['/v1.0/me/drive/root/children', '/v1.0/me/drive/items/id-invoices/children']);
  });
});
