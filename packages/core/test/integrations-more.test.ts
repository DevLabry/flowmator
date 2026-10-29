import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { airtableId, buildDriveQuery, buildEvent, dateOnly, driveId, eventTime, matchFormula, mysqlConnector, verifySlackSignature, type MySqlSession } from '@8n8/nodes-base';
import type { IDataObject, INodeExecutionData, IWebhookRequest } from '@8n8/workflow';
import { PollContext, WebhookContext } from '../src';
import { additionalData, connections, items, makeWorkflow, node, run } from './helpers';
import { calls, creds, credentialsHelper, route, runNode, withCred } from './integration-harness';

Object.assign(creds, {
  discordBotApi: { botToken: 'bot-1' },
  discordWebhookApi: { webhookUri: 'https://discord.com/api/webhooks/1/abc' },
  airtableTokenApi: { accessToken: 'pat-1' },
  googleDriveOAuth2Api: { oauthTokenData: { access_token: 'ya29.drive' } },
  googleCalendarOAuth2Api: { oauthTokenData: { access_token: 'ya29.cal' } },
  openAiApi: { apiKey: 'sk-1', url: 'https://api.openai.com/v1', organizationId: 'org-1' },
  mySql: { host: 'db', database: 'app', user: 'root' },
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Runs `type` after a node that turns `text` into the binary property "data". */
async function runWithFile(type: string, params: Record<string, unknown>, cred: string, file: { text: string; name: string; mime: string }) {
  const wf = makeWorkflow(
    [
      node('Trigger', 'manualTrigger'),
      node('File', 'convertToFile', { operation: 'toText', sourceProperty: 'text', binaryPropertyName: 'data', options: { fileName: file.name, mimeType: file.mime } }),
      node('N', type, params, withCred(cred)),
    ],
    connections(['Trigger', 'File'], ['File', 'N']),
  );
  const r = await run(wf, { triggerData: items({ text: file.text }), additional: { credentialsHelper } });
  if (r.status !== 'success') throw new Error(r.data.resultData.error?.message);
  return r.data.resultData.runData.N![0]!.data!.main![0]!;
}

/** Full output items (json + binary) of a single node run. */
async function runItems(type: string, params: Record<string, unknown>, cred: string): Promise<INodeExecutionData[]> {
  const wf = makeWorkflow([node('Trigger', 'manualTrigger'), node('N', type, params, withCred(cred))], connections(['Trigger', 'N']));
  const r = await run(wf, { triggerData: items({}), additional: { credentialsHelper } });
  if (r.status !== 'success') throw new Error(r.data.resultData.error?.message);
  return r.data.resultData.runData.N![0]!.data!.main![0]!;
}

const binaryText = (item: INodeExecutionData, prop = 'data') => Buffer.from(item.binary![prop].data, 'base64').toString();

/** A polling trigger as the server runs it (mode "trigger", static data kept between polls). */
function poller(type: string, params: Record<string, unknown>, cred: string) {
  const wf = makeWorkflow([node('T', type, params, withCred(cred))], {});
  const poll = () => {
    const ctx = new PollContext({ workflow: wf, node: wf.getNode('T')!, additionalData: additionalData({ mode: 'trigger', credentialsHelper }) }, () => {});
    return wf.nodeTypes.getByNameAndVersion(`8n8.${type}`).poll!.call(ctx);
  };
  return Object.assign(poll, { state: () => wf.staticData['node:T'] as IDataObject });
}

/* ---------- Slack Trigger ---------- */

describe('Slack Trigger', () => {
  const secret = 'shh';
  const sign = (raw: string, ts = Math.floor(Date.now() / 1000)) => ({
    'x-slack-request-timestamp': String(ts),
    'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`,
  });

  async function deliver(body: IDataObject, params: Record<string, unknown> = { trigger: ['message'], watchWorkspace: true }, headers?: Record<string, string>) {
    creds.slackApi = { accessToken: 'xoxb-1', signatureSecret: secret };
    const raw = JSON.stringify(body);
    const wf = makeWorkflow([node('Slack', 'slackTrigger', params, withCred('slackApi'))], {});
    const request: IWebhookRequest = { method: 'POST', path: 'x', headers: headers ?? sign(raw), query: {}, params: {}, body, rawBody: Buffer.from(raw) };
    const ctx = new WebhookContext({ workflow: wf, node: wf.getNode('Slack')!, additionalData: additionalData({ mode: 'webhook', credentialsHelper }) }, request, 'default', () => '');
    return wf.nodeTypes.getByNameAndVersion('8n8.slackTrigger').webhook!.call(ctx);
  }
  const message = (event: IDataObject) => ({ type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1.1', ...event } });

  it('verifies signatures and rejects replays', () => {
    const raw = Buffer.from('{"a":1}');
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:{"a":1}`).digest('hex')}`;
    expect(verifySlackSignature(secret, ts, raw, sig)).toBe(true);
    expect(verifySlackSignature(secret, ts, raw, `${sig.slice(0, -1)}0`)).toBe(false);
    expect(verifySlackSignature(secret, ts, raw, sig, Date.now() + 10 * 60_000)).toBe(false);
  });

  it('answers the URL verification challenge', async () => {
    const r = await deliver({ type: 'url_verification', challenge: 'abc' });
    expect(r.webhookResponse).toEqual({ statusCode: 200, body: { challenge: 'abc' } });
    expect(r.workflowData).toBeUndefined();
  });

  it('starts on new messages and rejects forged requests', async () => {
    const r = await deliver(message({}));
    expect(r.workflowData![0][0].json).toMatchObject({ type: 'message', text: 'hi', channel: 'C1', team_id: 'T1', event_id: 'Ev1' });
    const forged = await deliver(message({}), undefined, { 'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)), 'x-slack-signature': 'v0=00' });
    expect(forged.webhookResponse!.statusCode).toBe(401);
  });

  it('skips retries, bot messages, edits and other channels', async () => {
    const raw = JSON.stringify(message({}));
    expect((await deliver(message({}), undefined, { ...sign(raw), 'x-slack-retry-num': '1' })).workflowData).toBeUndefined();
    expect((await deliver(message({ bot_id: 'B1' }))).workflowData).toBeUndefined();
    expect((await deliver(message({ subtype: 'message_changed' }))).workflowData).toBeUndefined();
    const inC2 = { trigger: ['message'], watchWorkspace: false, channelId: 'C2' };
    expect((await deliver(message({}), inC2)).workflowData).toBeUndefined();
    // reactions keep their channel under item
    const reaction = { type: 'event_callback', event: { type: 'reaction_added', user: 'U1', reaction: 'tada', item: { type: 'message', channel: 'C2', ts: '1.1' } } };
    expect((await deliver(reaction, { trigger: ['reaction_added'], watchWorkspace: false, channelId: 'C2' })).workflowData![0][0].json.reaction).toBe('tada');
  });
});

/* ---------- Discord ---------- */

describe('Discord', () => {
  it('sends a bot message with an embed as a reply', async () => {
    route(/POST https:\/\/discord.com\/api\/v10\/channels\/C1\/messages/, () => ({ id: 'M1' }));
    const res = await runNode(
      'discord',
      { resource: 'message', operation: 'send', guildId: 'G1', channelId: 'C1', content: 'Deploy done', embeds: { values: [{ inputMethod: 'fields', title: 'v1.2', color: '#5865F2' }] }, options: { replyTo: 'M0' } },
      'discordBotApi',
    );
    expect(res).toEqual([{ id: 'M1' }]);
    expect(calls[0].headers.authorization).toBe('Bot bot-1');
    expect(calls[0].body).toEqual({ content: 'Deploy done', embeds: [{ title: 'v1.2', color: 0x5865f2 }], message_reference: { message_id: 'M0', fail_if_not_exists: false } });
  });

  it('attaches binary files with payload_json', async () => {
    route(/messages/, () => ({ id: 'M2' }));
    await runWithFile('discord', { resource: 'message', operation: 'send', guildId: 'G1', channelId: 'C1', content: 'log', files: 'data' }, 'discordBotApi', { text: 'line1', name: 'build.log', mime: 'text/plain' });
    const form = calls[0].form!;
    expect(JSON.parse(String(form.get('payload_json')))).toEqual({ content: 'log', attachments: [{ id: 0, filename: 'build.log' }] });
    expect(await (form.get('files[0]') as File).text()).toBe('line1');
  });

  it('posts through a webhook and waits for the message', async () => {
    route(/POST https:\/\/discord.com\/api\/webhooks\/1\/abc/, () => ({ id: 'W1' }));
    await runNode('discord', { authentication: 'webhook', content: 'hello', webhookOptions: { username: 'Bot', thread_id: 'T9' } }, 'discordWebhookApi');
    expect(calls[0].url.searchParams.get('wait')).toBe('true');
    expect(calls[0].url.searchParams.get('thread_id')).toBe('T9');
    expect(calls[0].body).toEqual({ content: 'hello', username: 'Bot' });
  });

  it('pages messages backwards and adds roles', async () => {
    // ids 150..1, newest first; a full page means there may be more
    const page = (before: number, size: number) => Array.from({ length: Math.min(size, before - 1) }, (_, n) => ({ id: String(before - 1 - n) }));
    route(/GET .*\/channels\/C1\/messages/, (c) => page(Number(c.url.searchParams.get('before') ?? 151), Number(c.url.searchParams.get('limit'))));
    const msgs = await runNode('discord', { resource: 'message', operation: 'getAll', guildId: 'G1', channelId: 'C1', returnAll: false, limit: 120 }, 'discordBotApi');
    expect(msgs).toHaveLength(120);
    expect(msgs.at(-1)!.id).toBe('31');
    expect(calls[1].url.searchParams.get('before')).toBe('51');
    expect(calls[1].url.searchParams.get('limit')).toBe('20');

    route(/PUT .*\/members\/U1\/roles\//, () => new Response(null, { status: 204 }));
    await runNode('discord', { resource: 'member', operation: 'roleAdd', guildId: 'G1', userId: 'U1', roles: ['R1', 'R2'] }, 'discordBotApi');
    expect(calls.slice(-2).map((c) => c.url.pathname)).toEqual(['/api/v10/guilds/G1/members/U1/roles/R1', '/api/v10/guilds/G1/members/U1/roles/R2']);
  });

  it('reports Discord errors', async () => {
    route(/discord/, () => json({ message: 'Missing Permissions', code: 50013 }, 403));
    await expect(runNode('discord', { resource: 'channel', operation: 'get', guildId: 'G1', channelId: 'C1' }, 'discordBotApi')).rejects.toThrow('Discord error: Missing Permissions');
  });
});

/* ---------- Airtable ---------- */

describe('Airtable', () => {
  const rec = (id: string, fields: IDataObject) => ({ id, createdTime: '2026-01-01T00:00:00.000Z', fields });

  it('reads IDs from URLs and escapes formulas', () => {
    expect(airtableId('https://airtable.com/appABCDEFGHIJKLMN/tblABCDEFGHIJKLMN/viw1', 'app')).toBe('appABCDEFGHIJKLMN');
    expect(airtableId('https://airtable.com/appABCDEFGHIJKLMN/tblABCDEFGHIJKLMN/viw1', 'tbl')).toBe('tblABCDEFGHIJKLMN');
    expect(airtableId('Tasks', 'tbl')).toBe('Tasks');
    expect(matchFormula('Name', "O'Brien")).toBe("{Name} = 'O\\'Brien'");
    expect(matchFormula('Count', 3)).toBe('{Count} = 3');
  });

  it('creates records from the input and flattens the output', async () => {
    route(/POST https:\/\/api.airtable.com\/v0\/app1\/Tasks$/, (c) => rec('rec1', c.body.fields));
    const res = await runNode('airtable', { resource: 'record', operation: 'create', base: 'app1', table: 'Tasks', options: { typecast: true, ignoreFields: 'tmp' } }, 'airtableTokenApi', items({ Name: 'Ship', tmp: 1 }));
    expect(res).toEqual([{ id: 'rec1', createdTime: '2026-01-01T00:00:00.000Z', Name: 'Ship' }]);
    expect(calls[0].body).toEqual({ fields: { Name: 'Ship' }, typecast: true });
    expect(calls[0].headers.authorization).toBe('Bearer pat-1');
  });

  it('upserts on a field and updates every match of a field', async () => {
    route(/PATCH .*\/app1\/Tasks$/, (c) => ({ records: c.body.records.map((r: IDataObject, n: number) => rec(String(r.id ?? `new${n}`), r.fields as IDataObject)) }));
    await runNode('airtable', { resource: 'record', operation: 'upsert', base: 'app1', table: 'Tasks', columnToMatchOn: 'Key' }, 'airtableTokenApi', items({ Key: 'a', Done: true }));
    expect(calls[0].body).toEqual({ performUpsert: { fieldsToMergeOn: ['Key'] }, records: [{ fields: { Key: 'a', Done: true } }] });

    route(/POST .*\/app1\/Tasks\/listRecords$/, () => ({ records: [rec('r1', {}), rec('r2', {})] }));
    const res = await runNode('airtable', { resource: 'record', operation: 'update', base: 'app1', table: 'Tasks', columnToMatchOn: 'Key' }, 'airtableTokenApi', items({ Key: 'b', Done: false }));
    expect(res.map((r) => r.id)).toEqual(['r1', 'r2']);
    const list = calls.find((c) => c.url.pathname.endsWith('listRecords'))!;
    expect(list.body).toMatchObject({ filterByFormula: "{Key} = 'b'" });
    expect(calls.at(-1)!.body.records).toEqual([{ id: 'r1', fields: { Key: 'b', Done: false } }, { id: 'r2', fields: { Key: 'b', Done: false } }]);
  });

  it('searches across pages with sorting', async () => {
    route(/listRecords/, (c) => (c.body.offset ? { records: [rec('r3', { n: 3 })] } : { records: [rec('r1', { n: 1 }), rec('r2', { n: 2 })], offset: 'o2' }));
    const res = await runNode('airtable', { resource: 'record', operation: 'search', base: 'app1', table: 'Tasks', filterByFormula: '{n} > 0', returnAll: true, searchOptions: { sort: { values: [{ field: 'n', direction: 'desc' }] } } }, 'airtableTokenApi');
    expect(res.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(calls[0].body).toMatchObject({ filterByFormula: '{n} > 0', sort: [{ field: 'n', direction: 'desc' }] });
    expect(calls[1].body.offset).toBe('o2');
  });

  it('reports Airtable errors', async () => {
    route(/airtable/, () => json({ error: { type: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND', message: 'Invalid permissions' } }, 403));
    await expect(runNode('airtable', { resource: 'record', operation: 'get', base: 'app1', table: 'T', id: 'r1' }, 'airtableTokenApi')).rejects.toThrow('Airtable error: INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND: Invalid permissions');
  });
});

/* ---------- Google Drive ---------- */

describe('Google Drive', () => {
  it('parses IDs and builds search queries', () => {
    expect(driveId('https://drive.google.com/drive/folders/1AbC_d-9?usp=sharing')).toBe('1AbC_d-9');
    expect(driveId('https://docs.google.com/document/d/DOC123/edit')).toBe('DOC123');
    expect(buildDriveQuery({ name: "Q3's", folderId: 'F1', what: 'files' })).toBe("name contains 'Q3\\'s' and 'F1' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false");
  });

  it('uploads binary data as multipart/related', async () => {
    route(/POST https:\/\/www.googleapis.com\/upload\/drive\/v3\/files$/, () => ({ id: 'F9', name: 'notes.txt' }));
    const [res] = await runWithFile('googleDrive', { resource: 'file', operation: 'upload', binaryPropertyName: 'data', folderId: 'https://drive.google.com/drive/folders/PARENT' }, 'googleDriveOAuth2Api', { text: 'hello drive', name: 'notes.txt', mime: 'text/plain' });
    expect(res.json).toEqual({ id: 'F9', name: 'notes.txt' });
    expect(calls[0].url.searchParams.get('uploadType')).toBe('multipart');
    expect(calls[0].url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(calls[0].headers['content-type']).toMatch(/^multipart\/related; boundary=/);
    const body = calls[0].raw!.toString();
    expect(body).toContain('{"name":"notes.txt","parents":["PARENT"]}');
    expect(body).toContain('Content-Type: text/plain\r\n\r\nhello drive');
  });

  it('exports Google Docs and downloads regular files', async () => {
    route(/GET .*\/files\/DOC$/, () => ({ id: 'DOC', name: 'Plan', mimeType: 'application/vnd.google-apps.document' }));
    route(/GET .*\/files\/DOC\/export$/, () => new Response('docx-bytes'));
    const [doc] = await runItems('googleDrive', { resource: 'file', operation: 'download', fileId: 'DOC', googleFileConversion: 'office' }, 'googleDriveOAuth2Api');
    expect(doc.binary!.data.fileName).toBe('Plan.docx');
    expect(binaryText(doc)).toBe('docx-bytes');
    expect(calls[1].url.searchParams.get('mimeType')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    route(/GET .*\/files\/BIN$/, (c) => (c.url.searchParams.get('alt') === 'media' ? new Response('raw-bytes') : { id: 'BIN', name: 'a.zip', mimeType: 'application/zip' }));
    const [file] = await runItems('googleDrive', { resource: 'file', operation: 'download', fileId: 'BIN' }, 'googleDriveOAuth2Api');
    expect(binaryText(file)).toBe('raw-bytes');
  });

  it('moves files between folders and pages search results', async () => {
    route(/GET .*\/files\/F1$/, () => ({ parents: ['OLD'] }));
    route(/PATCH .*\/files\/F1$/, () => ({ id: 'F1' }));
    await runNode('googleDrive', { resource: 'file', operation: 'move', fileId: 'F1', folderId: 'NEW' }, 'googleDriveOAuth2Api');
    expect(calls[1].url.searchParams.get('addParents')).toBe('NEW');
    expect(calls[1].url.searchParams.get('removeParents')).toBe('OLD');

    route(/GET .*\/drive\/v3\/files$/, (c) => (c.url.searchParams.get('pageToken') ? { files: [{ id: 'c' }] } : { files: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' }));
    const found = await runNode('googleDrive', { resource: 'fileFolder', operation: 'search', queryString: 'report', returnAll: true }, 'googleDriveOAuth2Api');
    expect(found.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('trigger starts from now, then reports new files once', async () => {
    let files: IDataObject[] = [];
    route(/GET .*\/drive\/v3\/files$/, () => ({ files }));
    const poll = poller('googleDriveTrigger', { triggerOn: 'specificFolder', folderToWatch: 'F1', event: 'fileCreated' }, 'googleDriveOAuth2Api');
    expect(await poll()).toBeNull();
    expect(calls).toHaveLength(0);
    files = [{ id: 'new', name: 'x.pdf', createdTime: '2099-01-01T00:00:00.000Z' }];
    const [first] = (await poll())!;
    expect(first.map((i) => i.json.id)).toEqual(['new']);
    expect(calls[0].url.searchParams.get('q')).toMatch(/'F1' in parents and .* and createdTime > '/);
    files = [];
    expect(await poll()).toBeNull();
    expect(calls[1].url.searchParams.get('q')).toContain("createdTime > '2099-01-01T00:00:00.000Z'");
  });
});

/* ---------- Google Calendar ---------- */

describe('Google Calendar', () => {
  it('builds event times and bodies', () => {
    expect(dateOnly('2026-03-01T23:30:00Z', 'Europe/Madrid')).toBe('2026-03-02');
    expect(eventTime('2026-03-01T10:00:00+01:00', false)).toEqual({ dateTime: '2026-03-01T09:00:00.000Z' });
    expect(eventTime('2026-03-01 10:00', false, 'Europe/Madrid')).toEqual({ dateTime: '2026-03-01T10:00', timeZone: 'Europe/Madrid' });
    const { body, withConference } = buildEvent({ start: '2026-03-01', end: '2026-03-02', allday: true, attendees: 'a@x.com, b@x.com', rrule: 'FREQ=WEEKLY', conferenceData: true });
    expect(body).toMatchObject({ start: { date: '2026-03-01' }, end: { date: '2026-03-02' }, attendees: [{ email: 'a@x.com' }, { email: 'b@x.com' }], recurrence: ['RRULE:FREQ=WEEKLY'] });
    expect((body.conferenceData as IDataObject).createRequest).toMatchObject({ conferenceSolutionKey: { type: 'hangoutsMeet' } });
    expect(withConference).toBe(true);
  });

  it('creates events with a Meet link and notifies guests', async () => {
    route(/POST https:\/\/www.googleapis.com\/calendar\/v3\/calendars\/team%40x.com\/events$/, (c) => ({ id: 'E1', ...c.body }));
    const [ev] = await runNode('googleCalendar', { resource: 'event', operation: 'create', calendar: 'team@x.com', start: '2026-03-01T10:00:00Z', end: '2026-03-01T11:00:00Z', additionalFields: { summary: 'Sync', conferenceData: true }, sendUpdates: 'all' }, 'googleCalendarOAuth2Api');
    expect(ev).toMatchObject({ id: 'E1', summary: 'Sync', start: { dateTime: '2026-03-01T10:00:00.000Z' } });
    expect(calls[0].url.searchParams.get('conferenceDataVersion')).toBe('1');
    expect(calls[0].url.searchParams.get('sendUpdates')).toBe('all');
    expect(calls[0].headers.authorization).toBe('Bearer ya29.cal');
  });

  it('defaults to a one-hour event starting now', async () => {
    route(/POST .*\/events$/, (c) => c.body);
    const [ev] = await runNode('googleCalendar', { resource: 'event', operation: 'create', calendar: 'primary' }, 'googleCalendarOAuth2Api');
    const start = new Date(String((ev.start as IDataObject).dateTime)).getTime();
    const end = new Date(String((ev.end as IDataObject).dateTime)).getTime();
    expect(Math.abs(start - Date.now())).toBeLessThan(10_000);
    expect(end - start).toBeGreaterThanOrEqual(3_599_000);
    expect(end - start).toBeLessThanOrEqual(3_601_000);
  });

  it('lists occurrences across pages and checks availability', async () => {
    route(/GET .*\/calendars\/primary\/events$/, (c) => (c.url.searchParams.get('pageToken') ? { items: [{ id: '3' }] } : { items: [{ id: '1' }, { id: '2' }], nextPageToken: 'n' }));
    const evs = await runNode('googleCalendar', { resource: 'event', operation: 'getAll', calendar: 'primary', returnAll: true, timeMin: '2026-03-01T00:00:00Z', timeMax: '2026-03-08T00:00:00Z', options: { q: 'standup' } }, 'googleCalendarOAuth2Api');
    expect(evs.map((e) => e.id)).toEqual(['1', '2', '3']);
    expect(Object.fromEntries(calls[0].url.searchParams)).toMatchObject({ singleEvents: 'true', orderBy: 'startTime', q: 'standup', timeMin: '2026-03-01T00:00:00.000Z' });

    route(/POST .*\/freeBusy$/, () => ({ calendars: { primary: { busy: [{ start: 'a', end: 'b' }] } } }));
    const [slot] = await runNode('googleCalendar', { resource: 'calendar', operation: 'availability', calendar: 'primary', timeMin: '2026-03-01T10:00:00Z', timeMax: '2026-03-01T11:00:00Z' }, 'googleCalendarOAuth2Api');
    expect(slot).toEqual({ available: false });
  });

  it('trigger reports events that started since the last check', async () => {
    const now = Date.now();
    const at = (ms: number) => ({ dateTime: new Date(now + ms).toISOString() });
    route(/GET .*\/events$/, () => ({
      items: [
        { id: 'earlier', start: at(-3_600_000), end: at(60_000) },
        { id: 'just-started', start: at(-1000), end: at(60_000) },
        { id: 'later', start: at(3_600_000), end: at(7_200_000) },
      ],
    }));
    const poll = poller('googleCalendarTrigger', { calendar: 'primary', triggerOn: 'eventStarted' }, 'googleCalendarOAuth2Api');
    // the first poll only records the time; pretend it ran a minute ago
    expect(await poll()).toBeNull();
    poll.state().lastTimeChecked = new Date(now - 60_000).toISOString();
    const [started] = (await poll())!;
    expect(started.map((i) => i.json.id)).toEqual(['just-started']);
    expect(calls[0].url.searchParams.get('orderBy')).toBe('startTime');
    // nothing new in the next window
    expect(await poll()).toBeNull();
  });
});

/* ---------- MySQL ---------- */

describe('MySQL', () => {
  /** Records statements; answers by matching the SQL. */
  function fakeDb(answer: (sql: string, params?: unknown[]) => unknown = () => ({ affectedRows: 1, fieldCount: 0, insertId: 0 })) {
    const log: Array<{ sql: string; params?: unknown[] }> = [];
    const original = mysqlConnector.connect;
    mysqlConnector.connect = async () => ({
      query: async (sql: string, params?: unknown[]) => {
        log.push({ sql, params });
        if (sql === 'FAIL') throw new Error('boom');
        return answer(sql, params);
      },
      end: async () => {},
    }) as MySqlSession;
    return { log, restore: () => (mysqlConnector.connect = original) };
  }
  const mysqlNode = (params: Record<string, unknown>, input = items({})) => runNode('mySql', params, 'mySql', input);

  it('writes rows with ? placeholders and backtick identifiers', async () => {
    const db = fakeDb(() => ({ affectedRows: 1, fieldCount: 0, insertId: 7 }));
    try {
      const inserted = await mysqlNode({ operation: 'insert', table: 'app.users', options: { skipOnConflict: true } }, items({ name: 'Ada', meta: { a: 1 } }));
      expect(inserted).toEqual([{ name: 'Ada', meta: { a: 1 }, insertId: 7 }]);
      expect(db.log[0]).toEqual({ sql: 'INSERT IGNORE INTO `app`.`users` (`name`, `meta`) VALUES (?, ?)', params: ['Ada', '{"a":1}'] });

      await mysqlNode({ operation: 'upsert', table: 'users' }, items({ id: 1, name: 'B`ob' }));
      expect(db.log[1].sql).toBe('INSERT INTO `users` (`id`, `name`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `id` = VALUES(`id`), `name` = VALUES(`name`)');

      await mysqlNode({ operation: 'update', table: 'users', columnToMatchOn: 'id', options: { detailedOutput: true } }, items({ id: 1, name: 'Bo' }));
      expect(db.log[2]).toEqual({ sql: 'UPDATE `users` SET `name` = ? WHERE `id` = ?', params: ['Bo', 1] });
    } finally {
      db.restore();
    }
  });

  it('selects and deletes with conditions', async () => {
    const db = fakeDb((sql) => (sql.startsWith('SELECT') ? [{ id: 1 }] : { affectedRows: 2, fieldCount: 0 }));
    try {
      const rows = await mysqlNode({ operation: 'select', table: 'users', where: { values: [{ column: 'age', condition: '>=', value: '18' }, { column: 'deleted_at', condition: 'IS NULL' }] }, sort: { values: [{ column: 'name', direction: 'DESC' }] }, limit: 5 });
      expect(rows).toEqual([{ id: 1 }]);
      expect(db.log[0]).toEqual({ sql: 'SELECT * FROM `users` WHERE `age` >= ? AND `deleted_at` IS NULL ORDER BY `name` DESC LIMIT 5', params: ['18'] });
      const [deleted] = await mysqlNode({ operation: 'deleteTable', table: 'users', where: { values: [{ column: 'id', condition: 'equal', value: '3' }] } });
      expect(deleted).toMatchObject({ success: true, affectedRows: 2 });
    } finally {
      db.restore();
    }
  });

  it('returns the last result set of multi-statement queries', async () => {
    const db = fakeDb(() => [{ affectedRows: 1, fieldCount: 0 }, [{ total: 3 }]]);
    try {
      expect(await mysqlNode({ operation: 'executeQuery', query: 'UPDATE t SET x = ?; SELECT COUNT(*) total FROM t', options: { queryReplacement: '5' } })).toEqual([{ total: 3 }]);
      expect(db.log[0].params).toEqual(['5']);
    } finally {
      db.restore();
    }
  });

  it('rolls back a transaction when one item fails', async () => {
    const db = fakeDb();
    try {
      await expect(mysqlNode({ operation: 'executeQuery', query: '={{ $json.sql }}', options: { queryBatching: 'transaction' } }, items({ sql: 'SELECT 1' }, { sql: 'FAIL' }))).rejects.toThrow('boom');
      expect(db.log.map((l) => l.sql)).toEqual(['START TRANSACTION', 'SELECT 1', 'FAIL', 'ROLLBACK']);
    } finally {
      db.restore();
    }
  });
});

/* ---------- OpenAI ---------- */

describe('OpenAI', () => {
  it('messages a model and parses JSON replies', async () => {
    route(/POST https:\/\/api.openai.com\/v1\/chat\/completions/, () => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"sentiment":"positive"}' } }] }));
    const [res] = await runNode(
      '8n8-ai.openAi',
      { resource: 'text', operation: 'message', modelId: 'gpt-x', messages: { values: [{ role: 'system', content: 'Reply in JSON' }, { role: 'user', content: '={{ $json.review }}' }] }, jsonOutput: true, options: { maxTokens: 50 } },
      'openAiApi',
      items({ review: 'Great!' }),
    );
    expect(res).toEqual({ index: 0, message: { role: 'assistant', content: { sentiment: 'positive' } }, finish_reason: 'stop' });
    expect(calls[0].body).toEqual({ model: 'gpt-x', messages: [{ role: 'system', content: 'Reply in JSON' }, { role: 'user', content: 'Great!' }], max_completion_tokens: 50, response_format: { type: 'json_object' } });
    expect(calls[0].headers.authorization).toBe('Bearer sk-1');
    expect(calls[0].headers['openai-organization']).toBe('org-1');
  });

  it('generates images and speech as binary data', async () => {
    route(/images\/generations/, () => ({ data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }] }));
    const [img] = await runItems('8n8-ai.openAi', { resource: 'image', operation: 'generate', imageModel: 'dall-e-3', prompt: 'a fox', options: { size: '1024x1024' } }, 'openAiApi');
    expect(binaryText(img)).toBe('png-bytes');
    expect(calls[0].body).toEqual({ model: 'dall-e-3', prompt: 'a fox', n: 1, size: '1024x1024', response_format: 'b64_json' });

    route(/audio\/speech/, () => new Response('mp3-bytes', { headers: { 'content-type': 'audio/mpeg' } }));
    const [speech] = await runItems('8n8-ai.openAi', { resource: 'audio', operation: 'generate', input: 'Hello', voice: 'nova' }, 'openAiApi');
    expect(binaryText(speech)).toBe('mp3-bytes');
    expect(speech.binary!.data.mimeType).toBe('audio/mpeg');
  });

  it('transcribes audio and analyzes images from binary input', async () => {
    route(/audio\/transcriptions/, () => ({ text: 'hello world' }));
    const [t] = await runWithFile('8n8-ai.openAi', { resource: 'audio', operation: 'transcribe', binaryPropertyName: 'data', options: { language: 'en' } }, 'openAiApi', { text: 'wav', name: 'a.wav', mime: 'audio/wav' });
    expect(t.json).toEqual({ text: 'hello world' });
    expect(calls[0].form!.get('model')).toBe('whisper-1');
    expect(calls[0].form!.get('language')).toBe('en');

    route(/chat\/completions/, () => ({ choices: [{ index: 0, message: { role: 'assistant', content: 'A cat' } }] }));
    const [a] = await runWithFile('8n8-ai.openAi', { resource: 'image', operation: 'analyze', modelId: 'gpt-x', inputType: 'base64', binaryPropertyName: 'data' }, 'openAiApi', { text: 'img', name: 'c.png', mime: 'image/png' });
    expect(a.json).toEqual({ content: 'A cat' });
    expect(calls[1].body.messages[0].content[1].image_url.url).toBe(`data:image/png;base64,${Buffer.from('img').toString('base64')}`);
  });

  it('reports API errors', async () => {
    route(/openai/, () => json({ error: { message: 'Incorrect API key provided' } }, 401));
    await expect(runNode('8n8-ai.openAi', { resource: 'text', operation: 'classify', input: 'x' }, 'openAiApi')).rejects.toThrow('OpenAI error: Incorrect API key provided');
  });
});
