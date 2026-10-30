import path from 'node:path/posix';
import { PassThrough, Readable } from 'node:stream';
import { Client as FtpClient, FileType, type FileInfo } from 'basic-ftp';
import ssh2, { type ConnectConfig, type SFTPWrapper, type Stats } from 'ssh2';
import { NodeOperationError, type IDataObject, type IExecuteFunctions, type INodeExecutionData, type INodeType } from '@8n8/workflow';
import { deepCopy } from '../utils/object';
import { perItem } from './markup';

/* ---------------- SSH connections ---------------- */

interface SshCredentials {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

/** Private keys pasted into a single-line field come with spaces instead of newlines. */
const formatPrivateKey = (key: string) => {
  const m = key.trim().match(/^(-----BEGIN [A-Z ]+-----)([\s\S]*?)(-----END [A-Z ]+-----)$/);
  return m ? `${m[1]}\n${m[2].trim().replace(/\s+/g, '\n')}\n${m[3]}\n` : key;
};

export function sshConnect(creds: SshCredentials, signal?: AbortSignal): Promise<ssh2.Client> {
  const config: ConnectConfig = {
    host: creds.host,
    port: Number(creds.port || 22),
    username: creds.username,
    readyTimeout: 20_000,
    ...(creds.privateKey ? { privateKey: formatPrivateKey(creds.privateKey), passphrase: creds.passphrase || undefined } : {}),
    ...(creds.password ? { password: creds.password } : {}),
  };
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    client.once('ready', () => resolve(client)).once('error', reject).connect(config);
    signal?.addEventListener('abort', () => client.end());
  });
}

const call = <T>(fn: (cb: (err: Error | null | undefined, value: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))));

const S_IFMT = 0o170000;
const entryType = (mode: number) => ((mode & S_IFMT) === 0o040000 ? 'd' : (mode & S_IFMT) === 0o120000 ? 'l' : '-');

/** Promise wrapper around an SFTP session. */
export class Sftp {
  private constructor(
    private readonly ssh: ssh2.Client,
    private readonly sftp: SFTPWrapper,
  ) {}

  static async connect(creds: SshCredentials, signal?: AbortSignal) {
    const ssh = await sshConnect(creds, signal);
    try {
      return new Sftp(ssh, await call<SFTPWrapper>((cb) => ssh.sftp(cb)));
    } catch (e) {
      ssh.end();
      throw e;
    }
  }

  close() {
    this.sftp.end();
    this.ssh.end();
  }

  async list(dir: string, recursive = false): Promise<IDataObject[]> {
    const entries = await call<Array<{ filename: string; attrs: Stats }>>((cb) => this.sftp.readdir(dir, cb as never));
    const out: IDataObject[] = [];
    for (const e of entries.sort((a, b) => a.filename.localeCompare(b.filename))) {
      const type = entryType(e.attrs.mode);
      const full = path.join(dir, e.filename);
      if (recursive && type === 'd') out.push(...(await this.list(full, true)));
      else out.push({ type, name: e.filename, size: e.attrs.size, modifyTime: e.attrs.mtime * 1000, accessTime: e.attrs.atime * 1000, rights: (e.attrs.mode & 0o777).toString(8), owner: e.attrs.uid, group: e.attrs.gid, path: full });
    }
    return out;
  }

  read(file: string) {
    return call<Buffer>((cb) => this.sftp.readFile(file, cb));
  }

  async write(file: string, data: Buffer) {
    await this.mkdirp(path.dirname(file));
    await call<void>((cb) => this.sftp.writeFile(file, data, cb as never));
  }

  async exists(p: string) {
    return call<Stats>((cb) => this.sftp.stat(p, cb)).then(
      () => true,
      () => false,
    );
  }

  async mkdirp(dir: string) {
    if (dir === '/' || dir === '.' || (await this.exists(dir))) return;
    await this.mkdirp(path.dirname(dir));
    await call<void>((cb) => this.sftp.mkdir(dir, cb as never));
  }

  rename(from: string, to: string) {
    return call<void>((cb) => this.sftp.rename(from, to, cb as never));
  }

  unlink(file: string) {
    return call<void>((cb) => this.sftp.unlink(file, cb as never));
  }

  async rmdir(dir: string, recursive: boolean) {
    if (recursive) {
      const entries = await call<Array<{ filename: string; attrs: Stats }>>((cb) => this.sftp.readdir(dir, cb as never));
      for (const e of entries) {
        const full = path.join(dir, e.filename);
        if (entryType(e.attrs.mode) === 'd') await this.rmdir(full, true);
        else await this.unlink(full);
      }
    }
    await call<void>((cb) => this.sftp.rmdir(dir, cb as never));
  }
}

/* ---------------- SSH ---------------- */

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function sshExec(ssh: ssh2.Client, command: string) {
  return new Promise<IDataObject>((resolve, reject) => {
    ssh.exec(command, (err, stream) => {
      if (err) return reject(err);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let code: number | null = null;
      let signal: string | null = null;
      stream.on('data', (d: Buffer) => stdout.push(d));
      stream.stderr.on('data', (d: Buffer) => stderr.push(d));
      stream.on('exit', (c: number | null, s?: string) => {
        code = c;
        signal = s ?? null;
      });
      stream.on('close', () => resolve({ code, signal, stdout: Buffer.concat(stdout).toString().trimEnd(), stderr: Buffer.concat(stderr).toString().trimEnd() }));
    });
  });
}

const sshCredentialName = (ctx: IExecuteFunctions) => (ctx.getNodeParameter('authentication', 0, 'password') === 'privateKey' ? 'sshPrivateKey' : 'sshPassword');

export const Ssh: INodeType = {
  description: {
    name: '8n8.ssh',
    displayName: 'SSH',
    description: 'Runs commands and moves files on a remote server over SSH',
    group: ['input'],
    version: 1,
    defaults: { name: 'SSH', color: '#000000' },
    icon: 'fa:terminal',
    subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      { name: 'sshPassword', required: true, displayOptions: { show: { authentication: ['password'] } } },
      { name: 'sshPrivateKey', required: true, displayOptions: { show: { authentication: ['privateKey'] } } },
    ],
    codex: { alias: ['Remote', 'Shell', 'Server', 'SCP'] },
    properties: [
      { displayName: 'Authentication', name: 'authentication', type: 'options', default: 'password',
        options: [{ name: 'Password', value: 'password' }, { name: 'Private Key', value: 'privateKey' }] },
      { displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true, default: 'command',
        options: [{ name: 'Command', value: 'command' }, { name: 'File', value: 'file' }] },
      { displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true, default: 'execute', displayOptions: { show: { resource: ['command'] } },
        options: [{ name: 'Execute', value: 'execute', action: 'Execute a command' }] },
      { displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true, default: 'upload', displayOptions: { show: { resource: ['file'] } },
        options: [
          { name: 'Download', value: 'download', action: 'Download a file' },
          { name: 'Upload', value: 'upload', action: 'Upload a file' },
        ] },
      { displayName: 'Command', name: 'command', type: 'string', typeOptions: { rows: 3 }, default: '', required: true, displayOptions: { show: { resource: ['command'] } } },
      { displayName: 'Working Directory', name: 'cwd', type: 'string', default: '/', required: true, displayOptions: { show: { resource: ['command'] } } },
      { displayName: 'Input Binary Field', name: 'binaryPropertyName', type: 'string', default: 'data', required: true, displayOptions: { show: { resource: ['file'], operation: ['upload'] } } },
      { displayName: 'Target Directory', name: 'path', type: 'string', default: '', required: true, placeholder: '/home/user', displayOptions: { show: { resource: ['file'], operation: ['upload'] } } },
      { displayName: 'Path', name: 'path', type: 'string', default: '', required: true, placeholder: '/home/user/report.pdf', description: 'The file to download', displayOptions: { show: { resource: ['file'], operation: ['download'] } } },
      { displayName: 'File Property', name: 'binaryPropertyName', type: 'string', default: 'data', required: true, displayOptions: { show: { resource: ['file'], operation: ['download'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        displayOptions: { show: { resource: ['file'] } },
        options: [{ displayName: 'File Name', name: 'fileName', type: 'string', default: '', description: 'Overrides the binary data file name' }],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const creds = await this.getCredentials<SshCredentials>(sshCredentialName(this));
    const resource = this.getNodeParameter('resource', 0) as string;
    const ssh = await sshConnect(creds, this.getExecutionCancelSignal());
    let sftp: SFTPWrapper | undefined;
    const getSftp = async () => (sftp ??= await call<SFTPWrapper>((cb) => ssh.sftp(cb)));
    try {
      return [
        await perItem(this, async (item, i) => {
          const op = this.getNodeParameter('operation', i) as string;
          if (resource === 'command') {
            const cwd = (this.getNodeParameter('cwd', i, '/') as string) || '/';
            const command = this.getNodeParameter('command', i) as string;
            return { json: await sshExec(ssh, `cd ${shellQuote(cwd)} && ${command}`) };
          }
          const o = this.getNodeParameter('options', i, {}) as IDataObject;
          const prop = this.getNodeParameter('binaryPropertyName', i) as string;
          const s = await getSftp();
          if (op === 'download') {
            const remote = this.getNodeParameter('path', i) as string;
            const data = await call<Buffer>((cb) => s.readFile(remote, cb));
            return { json: deepCopy(item.json), binary: { ...(item.binary ?? {}), [prop]: await this.helpers.prepareBinaryData(data, (o.fileName as string) || path.basename(remote)) } };
          }
          const bin = this.helpers.assertBinaryData(i, prop);
          const dir = this.getNodeParameter('path', i) as string;
          const target = path.join(dir, (o.fileName as string) || bin.fileName || prop);
          const data = await this.helpers.getBinaryDataBuffer(i, prop);
          await call<void>((cb) => s.writeFile(target, data, cb as never));
          return { json: { success: true, path: target } };
        }),
      ];
    } finally {
      sftp?.end();
      ssh.end();
    }
  },
};

/* ---------------- FTP ---------------- */

interface FtpCredentials {
  host: string;
  port?: number;
  username?: string;
  password?: string;
}

/** The FTP and SFTP operations the node needs, over either protocol. */
interface RemoteFs {
  list(dir: string, recursive: boolean): Promise<IDataObject[]>;
  read(file: string): Promise<Buffer>;
  write(file: string, data: Buffer): Promise<void>;
  rename(from: string, to: string, createDirectories: boolean): Promise<void>;
  remove(target: string, folder: boolean, recursive: boolean): Promise<void>;
  close(): void;
}

const ftpType = (t: FileType) => (t === FileType.Directory ? 'd' : t === FileType.SymbolicLink ? 'l' : '-');

async function ftpFs(creds: FtpCredentials): Promise<RemoteFs> {
  const client = new FtpClient(30_000);
  await client.access({ host: creds.host, port: Number(creds.port || 21), user: creds.username || 'anonymous', password: creds.password || 'anonymous@' });
  const list = async (dir: string, recursive: boolean): Promise<IDataObject[]> => {
    const entries: FileInfo[] = await client.list(dir);
    const out: IDataObject[] = [];
    for (const e of entries.filter((x) => x.name !== '.' && x.name !== '..').sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (recursive && e.type === FileType.Directory) out.push(...(await list(full, true)));
      else out.push({ type: ftpType(e.type), name: e.name, size: e.size, modifyTime: e.modifiedAt?.toISOString() ?? e.rawModifiedAt, path: full });
    }
    return out;
  };
  // ensureDir changes the working directory, so go back to where the session started
  const home = await client.pwd();
  const ensureDir = async (dir: string) => {
    await client.ensureDir(dir);
    await client.cd(home);
  };
  return {
    list,
    async read(file) {
      const chunks: Buffer[] = [];
      const sink = new PassThrough();
      sink.on('data', (c: Buffer) => chunks.push(c));
      await client.downloadTo(sink, file);
      return Buffer.concat(chunks);
    },
    async write(file, data) {
      await ensureDir(path.dirname(file));
      await client.uploadFrom(Readable.from(data), file);
    },
    async rename(from, to, createDirectories) {
      if (createDirectories) await ensureDir(path.dirname(to));
      await client.rename(from, to);
    },
    async remove(target, folder, recursive) {
      if (!folder) return void (await client.remove(target));
      if (recursive) await client.removeDir(target);
      else await client.send(`RMD ${target}`);
      await client.cd(home);
    },
    close: () => client.close(),
  };
}

async function sftpFs(creds: SshCredentials, signal?: AbortSignal): Promise<RemoteFs> {
  const s = await Sftp.connect(creds, signal);
  return {
    list: (dir, recursive) => s.list(dir, recursive),
    read: (file) => s.read(file),
    write: (file, data) => s.write(file, data),
    async rename(from, to, createDirectories) {
      if (createDirectories) await s.mkdirp(path.dirname(to));
      await s.rename(from, to);
    },
    remove: (target, folder, recursive) => (folder ? s.rmdir(target, recursive) : s.unlink(target)),
    close: () => s.close(),
  };
}

export const Ftp: INodeType = {
  description: {
    name: '8n8.ftp',
    displayName: 'FTP',
    description: 'Transfers files over FTP or SFTP',
    group: ['input'],
    version: 1,
    defaults: { name: 'FTP', color: '#303050' },
    icon: 'fa:server',
    subtitle: '={{$parameter["protocol"] + ": " + $parameter["operation"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      { name: 'ftp', required: true, displayOptions: { show: { protocol: ['ftp'] } } },
      { name: 'sftp', required: true, displayOptions: { show: { protocol: ['sftp'] } } },
    ],
    codex: { alias: ['SFTP', 'FTP', 'Transfer', 'Upload', 'Download'] },
    properties: [
      { displayName: 'Protocol', name: 'protocol', type: 'options', default: 'ftp', options: [{ name: 'FTP', value: 'ftp' }, { name: 'SFTP', value: 'sftp' }] },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'download',
        options: [
          { name: 'Delete', value: 'delete', action: 'Delete a file or folder' },
          { name: 'Download', value: 'download', action: 'Download a file' },
          { name: 'List', value: 'list', action: 'List folder content' },
          { name: 'Rename', value: 'rename', action: 'Rename / move a file or folder' },
          { name: 'Upload', value: 'upload', action: 'Upload a file' },
        ],
      },
      { displayName: 'Path', name: 'path', type: 'string', default: '', required: true, placeholder: '/public/reports/q3.pdf', displayOptions: { show: { operation: ['delete', 'download'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        displayOptions: { show: { operation: ['delete'] } },
        options: [
          { displayName: 'Folder', name: 'folder', type: 'boolean', default: false, description: 'The path is a folder' },
          { displayName: 'Recursive', name: 'recursive', type: 'boolean', default: false, description: 'Delete everything inside the folder too', displayOptions: { show: { folder: [true] } } },
        ],
      },
      { displayName: 'Put Output File in Field', name: 'binaryPropertyName', type: 'string', default: 'data', required: true, displayOptions: { show: { operation: ['download'] } } },
      { displayName: 'Old Path', name: 'oldPath', type: 'string', default: '', required: true, displayOptions: { show: { operation: ['rename'] } } },
      { displayName: 'New Path', name: 'newPath', type: 'string', default: '', required: true, displayOptions: { show: { operation: ['rename'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        displayOptions: { show: { operation: ['rename'] } },
        options: [{ displayName: 'Create Directories', name: 'createDirectories', type: 'boolean', default: false, description: 'Create the folders of the new path when they are missing' }],
      },
      { displayName: 'Path', name: 'path', type: 'string', default: '', required: true, placeholder: '/public/reports/q3.pdf', description: 'Where to store the file, including its name', displayOptions: { show: { operation: ['upload'] } } },
      { displayName: 'Binary File', name: 'binaryData', type: 'boolean', default: true, displayOptions: { show: { operation: ['upload'] } } },
      { displayName: 'Input Binary Field', name: 'binaryPropertyName', type: 'string', default: 'data', required: true, displayOptions: { show: { operation: ['upload'], binaryData: [true] } } },
      { displayName: 'File Content', name: 'fileContent', type: 'string', typeOptions: { rows: 4 }, default: '', displayOptions: { show: { operation: ['upload'], binaryData: [false] } } },
      { displayName: 'Path', name: 'path', type: 'string', default: '/', required: true, displayOptions: { show: { operation: ['list'] } } },
      { displayName: 'Recursive', name: 'recursive', type: 'boolean', default: false, description: 'Also list the files inside sub-folders', displayOptions: { show: { operation: ['list'] } } },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const protocol = this.getNodeParameter('protocol', 0) as string;
    const fs = protocol === 'sftp' ? await sftpFs(await this.getCredentials<SshCredentials>('sftp'), this.getExecutionCancelSignal()) : await ftpFs(await this.getCredentials<FtpCredentials>('ftp'));
    try {
      return [
        await perItem(this, async (item, i): Promise<INodeExecutionData | INodeExecutionData[]> => {
          const op = this.getNodeParameter('operation', i) as string;
          switch (op) {
            case 'list':
              return (await fs.list(this.getNodeParameter('path', i) as string, !!this.getNodeParameter('recursive', i, false))).map((json) => ({ json }));
            case 'download': {
              const remote = this.getNodeParameter('path', i) as string;
              const prop = this.getNodeParameter('binaryPropertyName', i) as string;
              const binary = await this.helpers.prepareBinaryData(await fs.read(remote), path.basename(remote));
              return { json: deepCopy(item.json), binary: { ...(item.binary ?? {}), [prop]: binary } };
            }
            case 'upload': {
              const remote = this.getNodeParameter('path', i) as string;
              const data = this.getNodeParameter('binaryData', i, true)
                ? await this.helpers.getBinaryDataBuffer(i, this.getNodeParameter('binaryPropertyName', i) as string)
                : Buffer.from(String(this.getNodeParameter('fileContent', i, '')));
              await fs.write(remote, data);
              return { json: deepCopy(item.json), ...(item.binary ? { binary: item.binary } : {}) };
            }
            case 'rename': {
              const o = this.getNodeParameter('options', i, {}) as IDataObject;
              await fs.rename(this.getNodeParameter('oldPath', i) as string, this.getNodeParameter('newPath', i) as string, !!o.createDirectories);
              return { json: { success: true } };
            }
            case 'delete': {
              const o = this.getNodeParameter('options', i, {}) as IDataObject;
              await fs.remove(this.getNodeParameter('path', i) as string, !!o.folder, !!o.recursive);
              return { json: { success: true } };
            }
          }
          throw new NodeOperationError(this.getNode(), `Unsupported operation ${op}`);
        }),
      ];
    } finally {
      fs.close();
    }
  },
};
