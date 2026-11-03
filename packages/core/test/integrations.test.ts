import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMime, columnLetter, notionId, spreadsheetId } from '@flowmator/nodes-base';
import type { IDataObject, INodeExecutionData } from '@flowmator/workflow';
import { connections, items, makeWorkflow, node, out, run } from './helpers';
import { calls, creds, credentialsHelper, realFetch, route, runNode, withCred } from './integration-harness';

/* ---------- Slack ---------- */

describe('Slack', () => {
  it('posts a message in a thread', async () => {
    route(/POST https:\/\/slack.com\/api\/chat.postMessage/, () => ({ ok: true, ts: '1.2', channel: 'C1' }));
    const res = await runNode('slack', { resource: 'message', operation: 'post', channelId: 'C1', text: '={{ "Hi " + $json.name }}', otherOptions: { thread_ts: '1.0' } }, 'slackApi', items({ name: 'Ada' }));
    expect(res).toEqual([{ ok: true, ts: '1.2', channel: 'C1' }]);
    expect(calls[0].headers.authorization).toBe('Bearer xoxb-1');
    expect(calls[0].body).toEqual({ channel: 'C1', text: 'Hi Ada', thread_ts: '1.0' });
  });

  it('turns ok:false into an error with the missing scope', async () => {
    route(/slack.com/, () => ({ ok: false, error: 'missing_scope', needed: 'chat:write' }));
    await expect(runNode('slack', { resource: 'message', operation: 'post', channelId: 'C1', text: 'x' }, 'slackApi')).rejects.toThrow('Slack error: missing_scope (missing scope: chat:write)');
  });

  it('pages channel history with cursors up to the limit', async () => {
    route(/conversations.history/, (c) =>
      c.url.searchParams.get('cursor') ? { ok: true, messages: [{ ts: '3' }], response_metadata: {} } : { ok: true, messages: [{ ts: '1' }, { ts: '2' }], response_metadata: { next_cursor: 'abc' } },
    );
    const res = await runNode('slack', { resource: 'channel', operation: 'history', channelId: 'C1', returnAll: false, limit: 3 }, 'slackApi');
    expect(res.map((m) => m.ts)).toEqual(['1', '2', '3']);
    expect(calls[1].url.searchParams.get('cursor')).toBe('abc');
  });
});

/* ---------- Telegram ---------- */

describe('Telegram', () => {
  it('sends a message with an inline keyboard', async () => {
    route(/bot123:ABC\/sendMessage/, () => ({ ok: true, result: { message_id: 5 } }));
    const res = await runNode('telegram', { resource: 'message', operation: 'sendMessage', chatId: '42', text: 'hello', additionalFields: { parse_mode: 'HTML', reply_markup: '{"inline_keyboard":[[{"text":"Go","url":"https://x.dev"}]]}' } }, 'telegramApi');
    expect(res).toEqual([{ message_id: 5 }]);
    expect(calls[0].url.pathname).toBe('/bot123:ABC/sendMessage');
    expect(calls[0].body).toEqual({ chat_id: '42', text: 'hello', parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Go', url: 'https://x.dev' }]] } });
  });

  it('uploads a binary photo as multipart', async () => {
    route(/sendPhoto/, () => ({ ok: true, result: { message_id: 6 } }));
    const wf = makeWorkflow(
      [
        node('Trigger', 'manualTrigger'),
        node('File', 'convertToFile', { operation: 'toText', sourceProperty: 'name', binaryPropertyName: 'data', options: { fileName: 'pic.png', mimeType: 'image/png' } }),
        node('N', 'telegram', { resource: 'message', operation: 'sendPhoto', chatId: '42', binaryData: true, binaryPropertyName: 'data', caption: 'look' }, withCred('telegramApi')),
      ],
      connections(['Trigger', 'File'], ['File', 'N']),
    );
    const r = await run(wf, { triggerData: items({ name: 'pixels' }), additional: { credentialsHelper } });
    expect(r.status).toBe('success');
    const form = calls[0].form!;
    expect(form.get('chat_id')).toBe('42');
    expect(form.get('caption')).toBe('look');
    const photo = form.get('photo') as File;
    expect(photo.name).toBe('pic.png');
    expect(await photo.text()).toBe('pixels');
  });

  it('reports Telegram errors', async () => {
    route(/telegram/, () => new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    await expect(runNode('telegram', { resource: 'message', operation: 'sendMessage', chatId: '1', text: 'x' }, 'telegramApi')).rejects.toThrow('Telegram error 400: Bad Request: chat not found');
  });
});

/* ---------- GitHub ---------- */

describe('GitHub', () => {
  it('creates issues with labels', async () => {
    route(/POST https:\/\/api.github.com\/repos\/octo\/demo\/issues/, (c) => ({ number: 7, ...c.body }));
    const res = await runNode('github', { resource: 'issue', operation: 'create', owner: 'octo', repository: 'demo', title: 'Bug', body: 'Steps', labels: 'bug, p1' }, 'githubApi');
    expect(res[0]).toMatchObject({ number: 7, title: 'Bug', labels: ['bug', 'p1'] });
    expect(calls[0].headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('edits a file using its current sha', async () => {
    route(/GET .*\/contents\/docs\/a.md/, () => ({ sha: 'old-sha', content: '' }));
    route(/PUT .*\/contents\/docs\/a.md/, (c) => ({ content: { sha: 'new-sha' }, sent: c.body }));
    const res = await runNode('github', { resource: 'file', operation: 'edit', owner: 'o', repository: 'r', filePath: 'docs/a.md', fileContent: 'hi', commitMessage: 'update', branch: 'main' }, 'githubApi');
    expect(calls[0].url.searchParams.get('ref')).toBe('main');
    expect(res[0].sent).toEqual({ message: 'update', content: Buffer.from('hi').toString('base64'), branch: 'main', sha: 'old-sha' });
  });

  it('downloads a file as binary', async () => {
    route(/contents\/README.md/, () => ({ name: 'README.md', sha: 's', content: Buffer.from('# Title').toString('base64') }));
    const wf = makeWorkflow([node('Trigger', 'manualTrigger'), node('N', 'github', { resource: 'file', operation: 'get', owner: 'o', repository: 'r', filePath: 'README.md' }, withCred('githubApi'))], connections(['Trigger', 'N']));
    const r = await run(wf, { additional: { credentialsHelper } });
    const item = r.data.resultData.runData.N![0]!.data!.main![0]![0]!;
    expect(item.json).toEqual({ name: 'README.md', sha: 's' });
    expect(Buffer.from(item.binary!.data.data, 'base64').toString()).toBe('# Title');
  });

  it('pages lists until a short page', async () => {
    route(/\/repos\/o\/r\/issues/, (c) => (c.url.searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, n) => ({ n })) : [{ n: 100 }]));
    const res = await runNode('github', { resource: 'issue', operation: 'getAll', owner: 'o', repository: 'r', returnAll: true }, 'githubApi');
    expect(res).toHaveLength(101);
    expect(calls.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2']);
  });
});

/* ---------- Notion ---------- */

describe('Notion', () => {
  it('creates database pages from simple property rows', async () => {
    route(/POST https:\/\/api.notion.com\/v1\/pages/, (c) => ({ id: 'p1', url: 'https://notion.so/p1', properties: { Name: { type: 'title', title: [{ plain_text: 'Task' }] }, Tags: { type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] }, sent: c.body } }));
    const res = await runNode('notion', {
      resource: 'databasePage',
      operation: 'create',
      databaseId: 'https://www.notion.so/team/0123456789abcdef0123456789abcdef?v=1',
      propertiesUi: { propertyValues: [{ key: 'Name', type: 'title', value: 'Task' }, { key: 'Tags', type: 'multi_select', value: 'a, b' }, { key: 'Due', type: 'date', value: '2025-05-01' }, { key: 'Done', type: 'checkbox', value: 'true' }] },
      content: 'First line\nSecond line',
    }, 'notionApi');
    expect(res[0]).toMatchObject({ id: 'p1', Name: 'Task', Tags: ['a', 'b'] });
    expect(calls[0].body).toMatchObject({
      parent: { database_id: '01234567-89ab-cdef-0123-456789abcdef' },
      properties: {
        Name: { title: [{ type: 'text', text: { content: 'Task' } }] },
        Tags: { multi_select: [{ name: 'a' }, { name: 'b' }] },
        Due: { date: { start: '2025-05-01' } },
        Done: { checkbox: true },
      },
    });
    expect(calls[0].body.children).toHaveLength(2);
  });

  it('queries a database with filters across pages', async () => {
    route(/databases\/.*\/query/, (c) =>
      c.body.start_cursor ? { results: [{ id: 'b', properties: {} }], has_more: false } : { results: [{ id: 'a', properties: {} }], has_more: true, next_cursor: 'cur' },
    );
    const res = await runNode('notion', { resource: 'databasePage', operation: 'getAll', databaseId: '0123456789abcdef0123456789abcdef', filterJson: '{"property":"Done","checkbox":{"equals":true}}', returnAll: true }, 'notionApi');
    expect(res.map((r) => r.id)).toEqual(['a', 'b']);
    expect(calls[0].body.filter).toEqual({ property: 'Done', checkbox: { equals: true } });
    expect(calls[1].body.start_cursor).toBe('cur');
  });
});

/* ---------- Gmail ---------- */

describe('Gmail', () => {
  it('builds MIME with alternative bodies and attachments', () => {
    const mime = buildMime({ to: 'a@x.com', subject: 'Olá', text: 'plain', html: '<b>rich</b>', attachments: [{ fileName: 'r.txt', mimeType: 'text/plain', content: Buffer.from('file') }] });
    expect(mime).toContain('Subject: =?UTF-8?B?T2zDoQ==?=');
    expect(mime).toMatch(/multipart\/mixed[\s\S]*multipart\/alternative[\s\S]*text\/plain[\s\S]*text\/html[\s\S]*filename="r.txt"/);
    expect(mime).toContain(Buffer.from('file').toString('base64'));
  });

  it('sends HTML mail with an attachment from the input', async () => {
    route(/messages\/send/, (c) => ({ id: 'm1', raw: c.body.raw }));
    const wf = makeWorkflow(
      [
        node('Trigger', 'manualTrigger'),
        node('File', 'convertToFile', { operation: 'toText', sourceProperty: 'note', binaryPropertyName: 'report', options: { fileName: 'note.txt' } }),
        node('N', 'gmail', { resource: 'message', operation: 'send', sendTo: 'boss@x.com', subject: 'Report', emailType: 'html', message: '<p>See attached</p>', options: { attachments: 'report', ccList: 'cc@x.com' } }, withCred('gmailOAuth2')),
      ],
      connections(['Trigger', 'File'], ['File', 'N']),
    );
    const r = await run(wf, { triggerData: items({ note: 'numbers' }), additional: { credentialsHelper } });
    expect(r.status).toBe('success');
    expect(calls[0].headers.authorization).toBe('Bearer ya29.gmail');
    const mime = Buffer.from(calls[0].body.raw, 'base64url').toString();
    expect(mime).toContain('To: boss@x.com');
    expect(mime).toContain('Cc: cc@x.com');
    expect(mime).toContain('filename="note.txt"');
    expect(mime).toContain(Buffer.from('<p>See attached</p>').toString('base64'));
  });

  const fullMessage = (id: string, internalDate: number) => ({
    id,
    threadId: 't',
    labelIds: ['INBOX'],
    snippet: 'hi',
    internalDate: String(internalDate),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [{ name: 'From', value: 'Ann <ann@x.com>' }, { name: 'Subject', value: 'Hello' }],
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('plain body').toString('base64url') } },
        { mimeType: 'text/html', body: { data: Buffer.from('<p>html</p>').toString('base64url') } },
      ],
    },
  });

  it('lists messages with a search query and simplifies them', async () => {
    route(/GET .*\/users\/me\/messages$/, () => ({ messages: [{ id: 'a' }, { id: 'b' }] }));
    route(/GET .*\/users\/me\/messages\/(a|b)$/, (c) => fullMessage(c.url.pathname.split('/').pop()!, Date.now()));
    const res = await runNode('gmail', { resource: 'message', operation: 'getAll', returnAll: false, limit: 2, filters: { q: 'has:attachment', readStatus: 'unread', labelIds: 'INBOX' } }, 'gmailOAuth2');
    expect(calls[0].url.searchParams.get('q')).toBe('has:attachment is:unread');
    expect(calls[0].url.searchParams.getAll('labelIds')).toEqual(['INBOX']);
    expect(res[0]).toMatchObject({ id: 'a', from: 'Ann <ann@x.com>', subject: 'Hello', text: 'plain body', html: '<p>html</p>' });
  });

  it('trigger returns the latest message when tested manually', async () => {
    route(/GET .*\/users\/me\/messages$/, () => ({ messages: [{ id: 'z' }] }));
    route(/GET .*\/users\/me\/messages\/z$/, () => fullMessage('z', Date.now()));
    const wf = makeWorkflow([node('Mail', 'gmailTrigger', { filters: {} }, withCred('gmailOAuth2')), node('Next', 'noOp')], connections(['Mail', 'Next']));
    const r = await run(wf, { additional: { credentialsHelper } });
    expect(out(r, 'Next')).toMatchObject([{ id: 'z', subject: 'Hello' }]);
    expect(calls[0].url.searchParams.get('maxResults')).toBe('1');
  });
});

/* ---------- Google Sheets ---------- */

describe('Google Sheets', () => {
  const sheet = [
    ['id', 'name'],
    [1, 'Ada'],
    [2, 'Bob'],
  ];

  it('extracts ids from URLs and converts column letters', () => {
    expect(spreadsheetId('https://docs.google.com/spreadsheets/d/abc_123-x/edit#gid=0')).toBe('abc_123-x');
    expect([0, 25, 26, 701, 702].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
    expect(notionId('0123456789ABCDEF0123456789ABCDEF')).toBe('01234567-89ab-cdef-0123-456789abcdef');
  });

  it('updates matching rows, appends the rest and adds new columns, in batches', async () => {
    route(/GET .*\/values\//, () => ({ values: sheet }));
    route(/PUT .*\/values\//, (c) => ({ updated: c.body }));
    route(/POST .*values:batchUpdate/, () => ({}));
    route(/POST .*:append/, () => ({}));
    const res = await runNode('googleSheets', { resource: 'sheet', operation: 'appendOrUpdate', documentId: 'doc1', sheetName: "Bob's sheet", columnToMatchOn: 'id' }, 'googleSheetsOAuth2Api', items({ id: 2, name: 'Bobby', email: 'b@x.com' }, { id: 3, name: 'Cy' }));
    expect(res).toEqual([{ id: 2, name: 'Bobby', email: 'b@x.com', row_number: 3 }, { id: 3, name: 'Cy' }]);
    expect(decodeURIComponent(calls[0].url.pathname)).toContain("/values/'Bob''s sheet'");
    // new "email" header written next to the existing ones
    expect(decodeURIComponent(calls[1].url.pathname)).toContain("'Bob''s sheet'!C1");
    expect(calls[1].body).toEqual({ values: [['email']] });
    const batch = calls.find((c) => c.url.pathname.endsWith('values:batchUpdate'))!;
    expect(batch.body).toEqual({ valueInputOption: 'USER_ENTERED', data: [{ range: "'Bob''s sheet'!A3:C3", values: [[2, 'Bobby', 'b@x.com']] }] });
    const append = calls.find((c) => c.url.pathname.endsWith(':append'))!;
    expect(append.body).toEqual({ values: [[3, 'Cy', '']] });
    expect(append.url.searchParams.get('insertDataOption')).toBe('INSERT_ROWS');
  });

  it('reads rows with lookup filters', async () => {
    route(/GET .*\/values\//, () => ({ values: sheet }));
    const res = await runNode('googleSheets', { resource: 'sheet', operation: 'read', documentId: 'doc1', sheetName: 'S', filtersUI: { values: [{ lookupColumn: 'name', lookupValue: 'Bob' }] } }, 'googleSheetsOAuth2Api');
    expect(res).toEqual([{ row_number: 3, id: 2, name: 'Bob' }]);
  });
});

/* ---------- Postgres (real Postgres via PGlite) ---------- */

let pgServer: PGLiteSocketServer;

describe('Postgres', () => {
  beforeAll(async () => {
    const db = await PGlite.create();
    await db.exec('CREATE TABLE people (id int PRIMARY KEY, name text, meta jsonb, age int)');
    const port = 20000 + Math.floor(Math.random() * 20000);
    // the default of 1 connection resets a new client while the previous one is still closing
    pgServer = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 10 });
    await pgServer.start();
    creds.postgres = { host: '127.0.0.1', port, database: 'postgres', user: 'postgres', password: 'x', ssl: 'disable' };
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await pgServer?.stop();
  });
  // these tests use real sockets, not the fake fetch
  beforeEach(() => vi.stubGlobal('fetch', realFetch));

  const pgNode = (params: Record<string, unknown>, input = items({})) => runNode('postgres', params, 'postgres', input);

  it('inserts, upserts, updates, selects and deletes', async () => {
    const inserted = await pgNode({ operation: 'insert', table: 'people' }, items({ id: 1, name: 'Ada', meta: { lang: 'en' }, age: 36 }, { id: 2, name: 'Bob', age: 20 }));
    expect(inserted).toEqual([{ id: 1, name: 'Ada', meta: { lang: 'en' }, age: 36 }, { id: 2, name: 'Bob', meta: null, age: 20 }]);

    await pgNode({ operation: 'upsert', table: 'people', columnToMatchOn: 'id' }, items({ id: 2, name: 'Bobby' }, { id: 3, name: 'Cy', age: 50 }));
    await pgNode({ operation: 'update', table: 'people', columnToMatchOn: 'id', dataMode: 'defineBelow', valuesToSend: { values: [{ column: 'id', value: 1 }, { column: 'age', value: '37' }] } });

    const selected = await pgNode({
      operation: 'select',
      table: 'people',
      where: { values: [{ column: 'age', condition: '>=', value: '30' }] },
      sort: { values: [{ column: 'age', direction: 'DESC' }] },
      returnAll: true,
    });
    expect(selected.map((r) => [r.name, r.age])).toEqual([['Cy', 50], ['Ada', 37]]);

    const deleted = await pgNode({ operation: 'deleteTable', table: 'people', deleteCommand: 'delete', where: { values: [{ column: 'name', condition: 'LIKE', value: 'Bob%' }] } });
    expect(deleted.map((r) => r.id)).toEqual([2]);
  });

  it('runs parameterized SQL and refuses to splice values into the query', async () => {
    const rows = await pgNode({ operation: 'executeQuery', query: 'SELECT name FROM people WHERE name = $1', options: { queryReplacement: "={{ [\"x' OR '1'='1\"] }}" } });
    expect(rows).toEqual([{ success: true, command: 'SELECT', rowCount: 0 }]);
    const ok = await pgNode({ operation: 'executeQuery', query: 'SELECT count(*)::int AS n FROM people WHERE age > $1', options: { queryReplacement: '10' } });
    expect(ok).toEqual([{ n: 2 }]);
  });

  it('rolls back a transaction when one item fails', async () => {
    await expect(
      pgNode({ operation: 'insert', table: 'people', options: { queryBatching: 'transaction' } }, items({ id: 10, name: 'Tx' }, { id: 10, name: 'Duplicate' })),
    ).rejects.toThrow(/duplicate key/);
    const rows = await pgNode({ operation: 'select', table: 'people', where: { values: [{ column: 'id', condition: 'equal', value: '10' }] } });
    expect(rows).toEqual([]);
  });

  it('explains connection failures', async () => {
    const saved = creds.postgres;
    creds.postgres = { ...saved, port: 1 };
    await expect(pgNode({ operation: 'executeQuery', query: 'SELECT 1' })).rejects.toThrow(/Could not connect to Postgres/);
    creds.postgres = saved;
  });
});
