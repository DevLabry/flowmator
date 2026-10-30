import { spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync, type Stats } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { FtpSrv } from 'ftp-srv';
// @ts-expect-error no types
import hoodiecrow from 'hoodiecrow-imap';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIcs, imapSearchQuery, parseIcs } from '@flowmator/nodes-base';
import { parseCurl, shellWords, type INodeExecutionData } from '@flowmator/workflow';
import { connections, items, makeWorkflow, node, out as rawOut, run } from './helpers';
import { creds, credentialsHelper, withCred } from './integration-harness';

const out = (...args: Parameters<typeof rawOut>) => rawOut(...args) as any[];
/** Full output items (with binary data) of a node's first run */
const outItems = (r: Awaited<ReturnType<typeof run>>, name: string): INodeExecutionData[] => (r.data.resultData.runData as Record<string, any>)[name][0].data.main[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'flowmator-core-nodes-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function runOk(nodes: ReturnType<typeof node>[], links: Array<[string, string]>, input = items({})) {
  const r = await run(makeWorkflow([node('Trigger', 'manualTrigger'), ...nodes], connections(['Trigger', nodes[0].name], ...links)), {
    triggerData: input,
    additional: { credentialsHelper },
  });
  if (r.status !== 'success') throw new Error(r.data.resultData.error?.message);
  return r;
}

/* ---------------- cURL import ---------------- */

describe('cURL import', () => {
  it('splits shell words like a shell', () => {
    expect(shellWords(`curl -H 'A: b c' "x \\"y\\"" $'a\\nb' one\\ two \\\n --flag`)).toEqual(['curl', '-H', 'A: b c', 'x "y"', 'a\nb', 'one two', '--flag']);
  });

  it('turns a JSON POST into HTTP Request parameters', () => {
    const p = parseCurl(`curl -X POST 'https://api.example.com/items?limit=10&tag=a' \\
      -H 'Content-Type: application/json' -H 'X-Key: k1' \\
      -d '{"name":"pizza","price":9}' --insecure -m 5`);
    expect(p).toEqual({
      method: 'POST',
      url: 'https://api.example.com/items',
      sendQuery: true,
      specifyQuery: 'keypair',
      queryParameters: { parameters: [{ name: 'limit', value: '10' }, { name: 'tag', value: 'a' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: JSON.stringify({ name: 'pizza', price: 9 }, null, 2),
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'X-Key', value: 'k1' }] },
      options: { allowUnauthorizedCerts: true, timeout: 5000 },
    });
  });

  it('handles form bodies, uploads, basic auth and -G', () => {
    expect(parseCurl('curl https://x.test/login -d user=ana -d "pass=a%20b"')).toMatchObject({
      method: 'POST',
      contentType: 'form-urlencoded',
      bodyParameters: { parameters: [{ name: 'user', value: 'ana' }, { name: 'pass', value: 'a b' }] },
    });
    expect(parseCurl('curl -F title=Report -F file=@/tmp/q3.pdf https://x.test/upload')).toMatchObject({
      method: 'POST',
      contentType: 'multipart-form-data',
      bodyParameters: { parameters: [{ parameterType: 'formData', name: 'title', value: 'Report' }, { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' }] },
    });
    expect(parseCurl('curl -u ana:secret x.test/me').headerParameters).toEqual({ parameters: [{ name: 'Authorization', value: `Basic ${btoa('ana:secret')}` }] });
    expect(parseCurl('curl -G https://x.test/search --data-urlencode "q=pizza pasta"')).toMatchObject({ method: 'GET', url: 'https://x.test/search', queryParameters: { parameters: [{ name: 'q', value: 'pizza pasta' }] } });
    expect(parseCurl('curl --json \'{"a":1}\' https://x.test')).toMatchObject({ contentType: 'json', headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] } });
    expect(parseCurl("curl -X PUT https://x.test -H 'Content-Type: text/csv' --data-binary 'a,b'")).toMatchObject({ method: 'PUT', contentType: 'raw', rawContentType: 'text/csv', body: 'a,b' });
    expect(() => parseCurl('wget https://x.test')).toThrow('must start with "curl"');
  });
});

/* ---------------- file formats ---------------- */

describe('file formats', () => {
  const rows = items({ name: 'Ana', score: 9.5 }, { name: 'Bob', score: 7 });

  it.each(['ods', 'xls'])('writes and reads %s spreadsheets', async (format) => {
    const r = await runOk(
      [node('Convert', 'convertToFile', { operation: format, binaryPropertyName: 'data', options: { sheetName: 'Scores' } }), node('Extract', 'extractFromFile', { operation: format, binaryPropertyName: 'data' })],
      [['Convert', 'Extract']],
      rows,
    );
    const file = outItems(r, 'Convert')[0].binary!.data;
    expect(file).toMatchObject({ fileName: `data.${format}`, fileExtension: format });
    expect(out(r, 'Extract')).toEqual([{ name: 'Ana', score: 9.5 }, { name: 'Bob', score: 7 }]);
  });

  it('writes RTF tables', async () => {
    const r = await runOk([node('Convert', 'convertToFile', { operation: 'rtf', binaryPropertyName: 'data' })], [], rows);
    const bin = outItems(r, 'Convert')[0].binary!.data;
    const text = Buffer.from(bin.data!, 'base64').toString();
    expect(text.startsWith('{\\rtf1')).toBe(true);
    expect(text).toContain('Ana');
    expect(bin.mimeType).toBe('application/rtf');
  });

  it('builds and parses iCalendar files', () => {
    const ics = buildIcs(
      [
        { title: 'Launch; party, v2', start: '2026-11-03T15:00:00Z', end: '2026-11-03T16:30:00Z', location: 'Madrid', organizer: 'Ana <ana@example.com>', attendees: ['bob@example.com'], description: 'Line 1\nLine 2 ' + 'x'.repeat(100), uid: 'evt-1', recurrenceRule: 'FREQ=WEEKLY;COUNT=3' },
        { title: 'Holiday', start: '2026-12-25', allDay: true },
      ],
      'Team',
    );
    expect(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    const cal = parseIcs(ics);
    expect(cal.name).toBe('Team');
    expect(cal.events).toEqual([
      expect.objectContaining({ uid: 'evt-1', summary: 'Launch; party, v2', start: '2026-11-03T15:00:00Z', end: '2026-11-03T16:30:00Z', allDay: false, location: 'Madrid', description: 'Line 1\nLine 2 ' + 'x'.repeat(100), rrule: 'FREQ=WEEKLY;COUNT=3', organizer: { name: 'Ana', email: 'ana@example.com' }, attendees: [{ email: 'bob@example.com', status: 'NEEDS-ACTION' }] }),
      expect.objectContaining({ summary: 'Holiday', start: '2026-12-25', end: '2026-12-26', allDay: true }),
    ]);
  });

  it('parses events from other calendars (folded lines, TZID)', () => {
    const cal = parseIcs(
      ['BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'BEGIN:VTIMEZONE', 'TZID:Europe/Madrid', 'END:VTIMEZONE', 'BEGIN:VEVENT', 'DTSTART;TZID=Europe/Madrid:20261103T100000', 'DTEND;TZID=Europe/Madrid:20261103T110000', 'SUMMARY:Stand', ' up', 'ATTENDEE;CN="Doe, Jane";PARTSTAT=ACCEPTED:mailto:jane@example.com', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
    );
    expect(cal.events).toEqual([{ start: '2026-11-03T10:00:00', startTimezone: 'Europe/Madrid', allDay: false, end: '2026-11-03T11:00:00', endTimezone: 'Europe/Madrid', summary: 'Standup', attendees: [{ name: 'Doe, Jane', email: 'jane@example.com', status: 'ACCEPTED' }] }]);
  });

  it('converts items to .ics files and extracts them back', async () => {
    const r = await runOk(
      [
        node('Convert', 'convertToFile', { operation: 'iCal', title: '={{ $json.name }}', start: '={{ $json.start }}', allDay: true, binaryPropertyName: 'data', additionalFields: { location: 'Office' } }),
        node('Extract', 'extractFromFile', { operation: 'fromIcs', binaryPropertyName: 'data', destinationKey: 'calendar' }),
      ],
      [['Convert', 'Extract']],
      items({ name: 'Review', start: '2026-11-10' }, { name: 'Retro', start: '2026-11-11' }),
    );
    const files = outItems(r, 'Convert');
    expect(files.map((f) => f.binary!.data.mimeType)).toEqual(['text/calendar', 'text/calendar']);
    expect(out(r, 'Extract').map((j) => j.calendar.events[0])).toEqual([
      expect.objectContaining({ summary: 'Review', start: '2026-11-10', end: '2026-11-11', allDay: true, location: 'Office' }),
      expect.objectContaining({ summary: 'Retro', start: '2026-11-11' }),
    ]);
  });
});

/* ---------------- Local File Trigger ---------------- */

describe('Local File Trigger', () => {
  it('emits when a file is added to the watched folder', async () => {
    const dir = path.join(tmp, 'watched');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'old.txt'), 'already here');
    const wf = makeWorkflow(
      [node('Watch', 'localFileTrigger', { triggerOn: 'folder', path: dir, events: ['add'], options: { ignored: '*.tmp' } }), node('After', 'noOp')],
      connections(['Watch', 'After']),
    );
    const result = run(wf);
    await sleep(300);
    writeFileSync(path.join(dir, 'skip.tmp'), 'ignored');
    await sleep(150);
    writeFileSync(path.join(dir, 'new.csv'), 'a,b');
    const r = await result;
    expect(r.status).toBe('success');
    expect(out(r, 'After')).toEqual([{ path: path.join(dir, 'new.csv'), event: 'add' }]);
  });

  it('emits when a specific file changes', async () => {
    const file = path.join(tmp, 'config.json');
    writeFileSync(file, '{}');
    const result = run(makeWorkflow([node('Watch', 'localFileTrigger', { triggerOn: 'file', path: file })], {}));
    await sleep(300);
    writeFileSync(file, '{"a":1}');
    expect(out(await result, 'Watch')).toEqual([{ path: file, event: 'change' }]);
  });
});

/* ---------------- SSH / SFTP server (ssh2) ---------------- */

const { STATUS_CODE } = ssh2.utils.sftp;
const userKey = ssh2.utils.generateKeyPairSync('ed25519');

/** An SSH server for the tests: commands run locally, SFTP is served from a folder. */
function startSshServer(root: string) {
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519').private;
  const allowedKey = ssh2.utils.parseKey(userKey.public) as ssh2.ParsedKey;
  const local = (p: string) => path.join(root, path.posix.normalize('/' + p));
  const attrs = (s: Stats) => ({ mode: s.mode, uid: s.uid, gid: s.gid, size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) });

  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.username === 'tester' && ctx.method === 'password' && ctx.password === 'secret') return ctx.accept();
      if (ctx.username === 'tester' && ctx.method === 'publickey' && ctx.key.algo === allowedKey.type && ctx.key.data.equals(allowedKey.getPublicSSH())) {
        if (!ctx.signature) return ctx.accept();
        if (allowedKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.accept();
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (accept, _reject, info) => {
          const stream = accept();
          const child = spawn('sh', ['-c', info.command], { cwd: root });
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr);
          child.on('close', (code) => {
            stream.exit(code ?? 0);
            stream.end();
          });
        });
        session.on('sftp', (accept) => {
          const sftp = accept();
          const handles = new Map<number, { fd?: number; dir?: string; listed?: boolean }>();
          let next = 0;
          const handle = (h: { fd?: number; dir?: string }) => {
            const id = next++;
            handles.set(id, h);
            const b = Buffer.alloc(4);
            b.writeUInt32BE(id);
            return b;
          };
          const get = (b: Buffer) => handles.get(b.readUInt32BE(0));
          const guard = (id: number, fn: () => void) => {
            try {
              fn();
            } catch {
              sftp.status(id, STATUS_CODE.FAILURE);
            }
          };
          sftp.on('OPEN', (id, file, flags) => guard(id, () => sftp.handle(id, handle({ fd: openSync(local(file), ssh2.utils.sftp.flagsToString(flags) ?? 'r') }))));
          sftp.on('READ', (id, h, offset, length) =>
            guard(id, () => {
              const buf = Buffer.alloc(length);
              const n = readSync(get(h)!.fd!, buf, 0, length, offset);
              if (n) sftp.data(id, buf.subarray(0, n));
              else sftp.status(id, STATUS_CODE.EOF);
            }),
          );
          sftp.on('WRITE', (id, h, offset, data) => guard(id, () => (writeSync(get(h)!.fd!, data, 0, data.length, offset), sftp.status(id, STATUS_CODE.OK))));
          sftp.on('FSTAT', (id, h) => guard(id, () => sftp.attrs(id, attrs(fstatSync(get(h)!.fd!)))));
          sftp.on('FSETSTAT', (id) => sftp.status(id, STATUS_CODE.OK));
          sftp.on('SETSTAT', (id) => sftp.status(id, STATUS_CODE.OK));
          const stat = (id: number, p: string) => (existsSync(local(p)) ? sftp.attrs(id, attrs(statSync(local(p)))) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE));
          sftp.on('STAT', stat);
          sftp.on('LSTAT', stat);
          sftp.on('CLOSE', (id, h) => {
            const entry = get(h);
            if (entry?.fd !== undefined) closeSync(entry.fd);
            handles.delete(h.readUInt32BE(0));
            sftp.status(id, STATUS_CODE.OK);
          });
          sftp.on('OPENDIR', (id, dir) => (existsSync(local(dir)) ? sftp.handle(id, handle({ dir: local(dir) })) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE)));
          sftp.on('READDIR', (id, h) => {
            const entry = get(h)!;
            if (entry.listed) return sftp.status(id, STATUS_CODE.EOF);
            entry.listed = true;
            sftp.name(id, readdirSync(entry.dir!).map((filename) => ({ filename, longname: filename, attrs: attrs(statSync(path.join(entry.dir!, filename))) })));
          });
          sftp.on('MKDIR', (id, dir) => guard(id, () => (mkdirSync(local(dir)), sftp.status(id, STATUS_CODE.OK))));
          sftp.on('RMDIR', (id, dir) => guard(id, () => (rmdirSync(local(dir)), sftp.status(id, STATUS_CODE.OK))));
          sftp.on('REMOVE', (id, file) => guard(id, () => (unlinkSync(local(file)), sftp.status(id, STATUS_CODE.OK))));
          sftp.on('RENAME', (id, from, to) => guard(id, () => (renameSync(local(from), local(to)), sftp.status(id, STATUS_CODE.OK))));
          sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: path.posix.normalize('/' + p), longname: '', attrs: {} as never }]));
        });
      });
    });
  });
  return new Promise<{ port: number; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() })),
  );
}

describe('SSH and SFTP', () => {
  let ssh: { port: number; close: () => void };
  let root: string;
  beforeAll(async () => {
    root = path.join(tmp, 'ssh-root');
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'readme.txt'), 'hello over ssh');
    ssh = await startSshServer(root);
    creds.sshPassword = { host: '127.0.0.1', port: ssh.port, username: 'tester', password: 'secret' };
    // keys pasted into a one-line field lose their newlines
    creds.sshPrivateKey = { host: '127.0.0.1', port: ssh.port, username: 'tester', privateKey: userKey.private.replace(/\n/g, ' ') };
    creds.sftp = { host: '127.0.0.1', port: ssh.port, username: 'tester', password: 'secret' };
  });
  afterAll(() => ssh.close());

  it('runs commands with a password or a private key', async () => {
    const r = await runOk([node('SSH', 'ssh', { resource: 'command', operation: 'execute', command: 'pwd >/dev/null; ls; echo oops >&2', cwd: 'docs' }, withCred('sshPassword'))], []);
    expect(out(r, 'SSH')).toEqual([{ code: 0, signal: null, stdout: 'readme.txt', stderr: 'oops' }]);
    const k = await runOk([node('SSH', 'ssh', { authentication: 'privateKey', resource: 'command', operation: 'execute', command: 'exit 3', cwd: '/' }, withCred('sshPrivateKey'))], []);
    expect(out(k, 'SSH')[0]).toMatchObject({ code: 3 });
  });

  it('downloads and uploads files', async () => {
    const r = await runOk(
      [
        node('Get', 'ssh', { resource: 'file', operation: 'download', path: '/docs/readme.txt', binaryPropertyName: 'data' }, withCred('sshPassword')),
        node('Put', 'ssh', { resource: 'file', operation: 'upload', path: '/docs', binaryPropertyName: 'data', options: { fileName: 'copy.txt' } }, withCred('sshPassword')),
      ],
      [['Get', 'Put']],
    );
    expect(outItems(r, 'Get')[0].binary!.data.fileName).toBe('readme.txt');
    expect(out(r, 'Put')).toEqual([{ success: true, path: '/docs/copy.txt' }]);
    expect(readFileSync(path.join(root, 'docs', 'copy.txt'), 'utf8')).toBe('hello over ssh');
  });

  it('manages files over SFTP with the FTP node', async () => {
    const sftp = (name: string, params: Record<string, unknown>) => node(name, 'ftp', { protocol: 'sftp', ...params }, withCred('sftp'));
    const r = await runOk(
      [
        sftp('Upload', { operation: 'upload', path: '/in/deep/note.txt', binaryData: false, fileContent: 'from flowmator' }),
        sftp('Rename', { operation: 'rename', oldPath: '/in/deep/note.txt', newPath: '/archive/2026/note.txt', options: { createDirectories: true } }),
        sftp('List', { operation: 'list', path: '/', recursive: true }),
      ],
      [['Upload', 'Rename'], ['Rename', 'List']],
    );
    expect(out(r, 'List').map((e) => [e.type, e.path])).toEqual([
      ['-', '/archive/2026/note.txt'],
      ['-', '/docs/copy.txt'],
      ['-', '/docs/readme.txt'],
    ]);
    const d = await runOk([sftp('Download', { operation: 'download', path: '/archive/2026/note.txt', binaryPropertyName: 'file' }), sftp('Delete', { operation: 'delete', path: '/archive', options: { folder: true, recursive: true } })], [['Download', 'Delete']]);
    expect(Buffer.from(outItems(d, 'Download')[0].binary!.file.data!, 'base64').toString()).toBe('from flowmator');
    expect(existsSync(path.join(root, 'archive'))).toBe(false);
  });
});

/* ---------------- FTP (ftp-srv) ---------------- */

describe('FTP', () => {
  let ftp: FtpSrv;
  let root: string;
  beforeAll(async () => {
    root = path.join(tmp, 'ftp-root');
    mkdirSync(path.join(root, 'reports'), { recursive: true });
    writeFileSync(path.join(root, 'reports', 'q3.csv'), 'a,b\n1,2');
    const port = await freePort();
    ftp = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: 40000, pasv_max: 40100, anonymous: false, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never });
    ftp.on('login', ({ username, password }, resolve, reject) => (username === 'ftpuser' && password === 'pw' ? resolve({ root }) : reject(new Error('Bad login'))));
    await ftp.listen();
    creds.ftp = { host: '127.0.0.1', port, username: 'ftpuser', password: 'pw' };
  });
  afterAll(() => ftp.close());

  it('uploads, lists, renames, downloads and deletes', async () => {
    const f = (name: string, params: Record<string, unknown>) => node(name, 'ftp', { protocol: 'ftp', ...params }, withCred('ftp'));
    const r = await runOk(
      [
        f('Get', { operation: 'download', path: '/reports/q3.csv', binaryPropertyName: 'data' }),
        f('Put', { operation: 'upload', path: '/backup/2026/q3.csv', binaryPropertyName: 'data' }),
        f('Rename', { operation: 'rename', oldPath: '/backup/2026/q3.csv', newPath: '/backup/q3-final.csv' }),
        f('List', { operation: 'list', path: '/', recursive: true }),
      ],
      [['Get', 'Put'], ['Put', 'Rename'], ['Rename', 'List']],
    );
    // recursive listings descend into folders, so only files (here) come back
    expect(out(r, 'List').map((e) => [e.type, e.path, e.size])).toEqual([
      ['-', '/backup/q3-final.csv', 7],
      ['-', '/reports/q3.csv', 7],
    ]);
    expect(readFileSync(path.join(root, 'backup', 'q3-final.csv'), 'utf8')).toBe('a,b\n1,2');

    await runOk([f('Delete', { operation: 'delete', path: '/backup', options: { folder: true, recursive: true } })], []);
    expect(existsSync(path.join(root, 'backup'))).toBe(false);
  });
});

/* ---------------- Email Trigger (IMAP) ---------------- */

describe('Email Trigger (IMAP)', () => {
  let imap: any;
  const message = (subject: string, body: string, attachment?: string) =>
    [
      'From: Ana <ana@example.com>',
      'To: me@example.com',
      `Subject: ${subject}`,
      'Message-ID: <' + subject.replace(/\W/g, '') + '@example.com>',
      'Date: Tue, 03 Nov 2026 10:00:00 +0000',
      'MIME-Version: 1.0',
      ...(attachment
        ? ['Content-Type: multipart/mixed; boundary="b1"', '', '--b1', 'Content-Type: text/plain', '', body, '--b1', 'Content-Type: text/plain; name="notes.txt"', 'Content-Disposition: attachment; filename="notes.txt"', '', attachment, '--b1--']
        : ['Content-Type: text/plain', '', body]),
    ].join('\r\n');

  beforeAll(async () => {
    const port = await freePort();
    imap = hoodiecrow({
      plugins: ['IDLE', 'ENABLE', 'UIDPLUS', 'ID', 'NAMESPACE'],
      storage: { INBOX: { messages: [{ raw: message('Old and read', 'seen'), flags: ['\\Seen'] }, { raw: message('Invoice 42', 'Please pay', 'line 1'), flags: [] }] } },
    });
    await new Promise<void>((r) => imap.listen(port, '127.0.0.1', r));
    creds.imap = { host: '127.0.0.1', port, secure: false, user: 'testuser', password: 'testpass' };
  });
  afterAll(() => new Promise<void>((r) => imap.close(r)));

  it('maps custom search rules', () => {
    expect(imapSearchQuery(['UNSEEN', ['FROM', 'boss@x.com'], ['SINCE', '2026-01-01'], ['OR', 'FLAGGED', ['SUBJECT', 'urgent']], ['NOT', 'DELETED'], ['HEADER', 'X-Tag', 'a']])).toEqual({
      seen: false,
      from: 'boss@x.com',
      since: new Date('2026-01-01'),
      or: [{ flagged: true }, { subject: 'urgent' }],
      not: { deleted: true },
      header: { 'X-Tag': 'a' },
    });
    expect(() => imapSearchQuery([['FOO', 1]])).toThrow('Unsupported search rule');
  });

  it('emits unread emails with attachments and marks them read', async () => {
    const wf = makeWorkflow(
      [node('Mail', 'emailReadImap', { format: 'simple', downloadAttachments: true, options: { trackLastMessageId: true } }, withCred('imap')), node('After', 'noOp')],
      connections(['Mail', 'After']),
    );
    const r = await run(wf, { additional: { credentialsHelper } });
    expect(r.status).toBe('success');
    const [mail] = outItems(r, 'After');
    expect(mail.json).toMatchObject({ from: '"Ana" <ana@example.com>', to: 'me@example.com', subject: 'Invoice 42', textPlain: 'Please pay', messageId: '<Invoice42@example.com>' });
    expect(Buffer.from(mail.binary!.attachment_0.data!, 'base64').toString()).toBe('line 1');
    expect(imap.getMailbox('INBOX').messages[1].flags).toContain('\\Seen');
  });

  it('waits for new emails and emits them as they arrive', async () => {
    const wf = makeWorkflow([node('Mail', 'emailReadImap', { format: 'resolved', postProcessAction: 'nothing' }, withCred('imap'))], {});
    const result = run(wf, { additional: { credentialsHelper } });
    await sleep(400);
    imap.appendMessage('INBOX', [], new Date(), message('Fresh', 'Just arrived'));
    const r = await result;
    expect(r.status).toBe('success');
    expect(out(r, 'Mail')).toEqual([expect.objectContaining({ subject: 'Fresh', text: 'Just arrived', from: expect.objectContaining({ text: '"Ana" <ana@example.com>' }) })]);
    expect(imap.getMailbox('INBOX').messages[2].flags).not.toContain('\\Seen');
  });
});
