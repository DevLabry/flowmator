import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IBinaryData } from '@flowmator/workflow';

export interface BinaryDataStore {
  /** Stores the buffer and returns the binary metadata (with `id` set when stored externally). */
  store(buffer: Buffer, meta: Omit<IBinaryData, 'data'>, executionId: string): Promise<IBinaryData>;
  get(binary: IBinaryData): Promise<Buffer>;
  deleteForExecution?(executionId: string): Promise<void>;
}

export class MemoryBinaryDataStore implements BinaryDataStore {
  async store(buffer: Buffer, meta: Omit<IBinaryData, 'data'>): Promise<IBinaryData> {
    return { ...meta, data: buffer.toString('base64'), fileSize: buffer.length };
  }
  async get(binary: IBinaryData): Promise<Buffer> {
    return Buffer.from(binary.data, 'base64');
  }
}

/** Keeps binary payloads out of the execution JSON. Files live in <dir>/<executionId>/<uuid>. */
export class FilesystemBinaryDataStore implements BinaryDataStore {
  constructor(private readonly dir: string) {}

  async store(buffer: Buffer, meta: Omit<IBinaryData, 'data'>, executionId: string): Promise<IBinaryData> {
    const id = `${executionId || 'temp'}/${randomUUID()}`;
    await mkdir(path.join(this.dir, executionId || 'temp'), { recursive: true });
    await writeFile(path.join(this.dir, id), buffer);
    return { ...meta, data: 'filesystem-v2', id: `filesystem-v2:${id}`, fileSize: buffer.length };
  }

  async get(binary: IBinaryData): Promise<Buffer> {
    if (!binary.id?.startsWith('filesystem-v2:')) return Buffer.from(binary.data, 'base64');
    const rel = binary.id.slice('filesystem-v2:'.length);
    const full = path.resolve(this.dir, rel);
    if (!full.startsWith(path.resolve(this.dir))) throw new Error('Invalid binary data id');
    return readFile(full);
  }

  async deleteForExecution(executionId: string): Promise<void> {
    await rm(path.join(this.dir, executionId), { recursive: true, force: true });
  }
}

const EXT_TO_MIME: Record<string, string> = {
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown',
  js: 'text/javascript',
  yaml: 'application/yaml',
  yml: 'application/yaml',
};

export function mimeFromFileName(fileName?: string): string | undefined {
  const ext = fileName?.split('.').pop()?.toLowerCase();
  return ext ? EXT_TO_MIME[ext] : undefined;
}

export function extensionFromMime(mime: string): string | undefined {
  return Object.entries(EXT_TO_MIME).find(([, m]) => m === mime)?.[0];
}
