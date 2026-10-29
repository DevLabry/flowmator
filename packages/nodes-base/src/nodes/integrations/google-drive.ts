import { randomBytes } from 'node:crypto';
import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, ILoadOptionsFunctions, INodeExecutionData, INodeProperties, INodeType, IPollFunctions } from '@8n8/workflow';
import { forEachItem, forOp, listLimit, operationProp, pollTimesProp, returnAllProps } from '../../utils/api';
import { googleAuthProp, googleCredentials, googlePages, googleRequest } from './google';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const CRED = 'googleDriveOAuth2Api';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,parents,webViewLink,webContentLink,size,createdTime,modifiedTime,trashed,owners(displayName,emailAddress)';
// every call works on shared drives too
const ALL_DRIVES = { supportsAllDrives: true };

/** Accepts an ID or a drive.google.com / docs.google.com URL. */
export function driveId(value: string) {
  const v = String(value ?? '').trim();
  return v.match(/\/(?:folders|d)\/([a-zA-Z0-9_-]+)/)?.[1] ?? v.match(/[?&]id=([a-zA-Z0-9_-]+)/)?.[1] ?? v;
}

/** Google Docs/Sheets/Slides have no bytes of their own: they are exported to a regular format. */
const EXPORTS: Record<string, Record<string, { mime: string; ext: string }>> = {
  'application/vnd.google-apps.document': {
    office: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
    pdf: { mime: 'application/pdf', ext: 'pdf' },
    text: { mime: 'text/plain', ext: 'txt' },
    html: { mime: 'text/html', ext: 'html' },
  },
  'application/vnd.google-apps.spreadsheet': {
    office: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
    pdf: { mime: 'application/pdf', ext: 'pdf' },
    text: { mime: 'text/csv', ext: 'csv' },
    html: { mime: 'application/zip', ext: 'zip' },
  },
  'application/vnd.google-apps.presentation': {
    office: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
    pdf: { mime: 'application/pdf', ext: 'pdf' },
    text: { mime: 'text/plain', ext: 'txt' },
    html: { mime: 'application/pdf', ext: 'pdf' },
  },
  'application/vnd.google-apps.drawing': {
    office: { mime: 'image/png', ext: 'png' },
    pdf: { mime: 'application/pdf', ext: 'pdf' },
    text: { mime: 'image/svg+xml', ext: 'svg' },
    html: { mime: 'image/png', ext: 'png' },
  },
};

/** multipart/related body: JSON metadata, then the file content. */
export function multipartRelated(metadata: IDataObject, content: Buffer, mimeType: string) {
  const boundary = `8n8-${randomBytes(12).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

/** Drive search query (q) for a name filter, folder and what to return. */
export function buildDriveQuery(o: { name?: string; folderId?: string; what?: 'all' | 'files' | 'folders'; includeTrashed?: boolean; query?: string }) {
  const parts: string[] = [];
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  if (o.query) parts.push(`(${o.query})`);
  if (o.name) parts.push(`name contains '${esc(o.name)}'`);
  if (o.folderId) parts.push(`'${esc(o.folderId)}' in parents`);
  if (o.what === 'files') parts.push(`mimeType != '${FOLDER_MIME}'`);
  if (o.what === 'folders') parts.push(`mimeType = '${FOLDER_MIME}'`);
  if (!o.includeTrashed) parts.push('trashed = false');
  return parts.join(' and ');
}

type Ctx = { helpers: IExecuteFunctions['helpers'] };
const drive = (ctx: Ctx, auth: unknown, options: IHttpRequestOptions, i = 0) => googleRequest(ctx, auth, CRED, options, i);

const fileIdProp: INodeProperties = { displayName: 'File', name: 'fileId', type: 'string', default: '', required: true, description: 'File ID or URL' };
const folderIdProp: INodeProperties = { displayName: 'Folder', name: 'folderId', type: 'string', default: 'root', description: 'Folder ID or URL ("root" is My Drive)' };

const shareProps: INodeProperties[] = [
  { displayName: 'Role', name: 'role', type: 'options', default: 'reader', options: ['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner'].map((r) => ({ name: r, value: r })) },
  { displayName: 'Type', name: 'permissionType', type: 'options', default: 'user', options: [{ name: 'User', value: 'user' }, { name: 'Group', value: 'group' }, { name: 'Domain', value: 'domain' }, { name: 'Anyone with the Link', value: 'anyone' }] },
  { displayName: 'Email Address', name: 'emailAddress', type: 'string', default: '', displayOptions: { show: { permissionType: ['user', 'group'] } } },
  { displayName: 'Domain', name: 'domain', type: 'string', default: '', displayOptions: { show: { permissionType: ['domain'] } } },
  { displayName: 'Send Notification Email', name: 'sendNotificationEmail', type: 'boolean', default: true, displayOptions: { show: { permissionType: ['user', 'group'] } } },
];

export const GoogleDrive: INodeType = {
  description: {
    name: '8n8.googleDrive',
    displayName: 'Google Drive',
    description: 'Upload, download, search, share and organize files in Google Drive',
    group: ['input'],
    version: [3],
    defaults: { name: 'Google Drive', color: '#1fa463' },
    icon: 'fa:google-drive',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: googleCredentials(CRED),
    codex: { categories: ['Data & Storage'] },
    properties: [
      googleAuthProp,
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'file',
        options: [{ name: 'File', value: 'file' }, { name: 'Folder', value: 'folder' }, { name: 'File/Folder', value: 'fileFolder' }],
      },
      operationProp('file', [
        { name: 'Upload', value: 'upload' },
        { name: 'Download', value: 'download' },
        { name: 'Create From Text', value: 'createFromText' },
        { name: 'Copy', value: 'copy' },
        { name: 'Move', value: 'move' },
        { name: 'Update', value: 'update' },
        { name: 'Share', value: 'share' },
        { name: 'Delete', value: 'deleteFile' },
      ]),
      operationProp('folder', [{ name: 'Create', value: 'create' }, { name: 'Share', value: 'share' }, { name: 'Delete', value: 'deleteFolder' }]),
      operationProp('fileFolder', [{ name: 'Search', value: 'search' }]),

      // file
      ...forOp('file', ['download', 'copy', 'move', 'update', 'share', 'deleteFile'], [fileIdProp]),
      ...forOp('file', 'upload', [
        { displayName: 'Input Binary Field', name: 'binaryPropertyName', type: 'string', default: 'data' },
        { displayName: 'File Name', name: 'name', type: 'string', default: '', description: 'Defaults to the binary file name' },
      ]),
      ...forOp('file', 'createFromText', [
        { displayName: 'File Name', name: 'name', type: 'string', default: '', required: true },
        { displayName: 'Text', name: 'content', type: 'string', typeOptions: { rows: 4 }, default: '' },
        { displayName: 'Convert to Google Doc', name: 'convertToGoogleDocument', type: 'boolean', default: false },
      ]),
      ...forOp('file', ['upload', 'createFromText', 'copy', 'move'], [{ ...folderIdProp, displayName: 'Parent Folder' }]),
      ...forOp('file', 'copy', [{ displayName: 'Copy Name', name: 'name', type: 'string', default: '', description: 'Defaults to "Copy of <name>"' }]),
      ...forOp('file', 'download', [
        { displayName: 'Put Output File in Field', name: 'binaryPropertyName', type: 'string', default: 'data' },
        { displayName: 'Convert Google Files To', name: 'googleFileConversion', type: 'options', default: 'office', options: [{ name: 'Office (DOCX/XLSX/PPTX)', value: 'office' }, { name: 'PDF', value: 'pdf' }, { name: 'Text (TXT/CSV)', value: 'text' }, { name: 'HTML', value: 'html' }] },
      ]),
      ...forOp('file', 'update', [
        { displayName: 'New Name', name: 'newName', type: 'string', default: '' },
        { displayName: 'Change File Content', name: 'changeContent', type: 'boolean', default: false },
        { displayName: 'Input Binary Field', name: 'binaryPropertyName', type: 'string', default: 'data', displayOptions: { show: { changeContent: [true] } } },
      ]),
      ...forOp('file', 'deleteFile', [{ displayName: 'Delete Permanently', name: 'deletePermanently', type: 'boolean', default: false, description: 'Off: move to the trash' }]),
      ...forOp('file', 'share', shareProps),

      // folder
      ...forOp('folder', 'create', [{ displayName: 'Folder Name', name: 'name', type: 'string', default: '', required: true }, { ...folderIdProp, displayName: 'Parent Folder' }]),
      ...forOp('folder', ['share', 'deleteFolder'], [{ ...folderIdProp, default: '', required: true }]),
      ...forOp('folder', 'deleteFolder', [{ displayName: 'Delete Permanently', name: 'deletePermanently', type: 'boolean', default: false }]),
      ...forOp('folder', 'share', shareProps),

      // search
      ...forOp('fileFolder', 'search', [
        { displayName: 'Search Method', name: 'searchMethod', type: 'options', default: 'name', options: [{ name: 'Name Contains', value: 'name' }, { name: 'Advanced Query', value: 'query' }] },
        { displayName: 'Name', name: 'queryString', type: 'string', default: '', displayOptions: { show: { searchMethod: ['name'] } } },
        { displayName: 'Query', name: 'query', type: 'string', default: '', placeholder: "mimeType = 'application/pdf'", displayOptions: { show: { searchMethod: ['query'] } }, hint: 'Google Drive query syntax' },
        { displayName: 'In Folder', name: 'folderId', type: 'string', default: '', description: 'Folder ID or URL; empty searches everywhere' },
        { displayName: 'Return', name: 'what', type: 'options', default: 'all', options: [{ name: 'Files and Folders', value: 'all' }, { name: 'Files', value: 'files' }, { name: 'Folders', value: 'folders' }] },
        { displayName: 'Include Trashed', name: 'includeTrashed', type: 'boolean', default: false },
        ...returnAllProps({ resource: ['fileFolder'], operation: ['search'] }),
      ]),
    ],
  },
  methods: {
    loadOptions: {
      async getFolders(this: ILoadOptionsFunctions) {
        const auth = this.getCurrentNodeParameters().authentication;
        const r = await drive(this, auth, { url: `${API}/files`, qs: { q: buildDriveQuery({ what: 'folders' }), fields: 'files(id,name)', pageSize: 200, ...ALL_DRIVES, includeItemsFromAllDrives: true } });
        return [{ name: 'My Drive (root)', value: 'root' }, ...((r.files as IDataObject[]) ?? []).map((f) => ({ name: String(f.name), value: String(f.id) }))];
      },
    },
  },
  async execute(this: IExecuteFunctions) {
    const auth = this.getNodeParameter('authentication', 0, 'oAuth2');
    return [
      await forEachItem(this, async (i, item) => {
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (options: IHttpRequestOptions) => drive(this, auth, { ...options, qs: { ...ALL_DRIVES, ...(options.qs ?? {}) } }, i);
        const resource = p('resource');
        const op = p('operation');

        const upload = async (metadata: IDataObject, content: Buffer, mimeType: string, fileId?: string) => {
          const { body, contentType } = multipartRelated(metadata, content, mimeType);
          return call({
            url: `${UPLOAD}/files${fileId ? `/${fileId}` : ''}`,
            method: fileId ? 'PATCH' : 'POST',
            qs: { uploadType: 'multipart', fields: FILE_FIELDS },
            headers: { 'Content-Type': contentType },
            body,
          });
        };
        const share = async (id: string) => {
          const type = p('permissionType', 'user');
          const permission: IDataObject = { role: p('role', 'reader'), type };
          if (type === 'user' || type === 'group') permission.emailAddress = p('emailAddress');
          if (type === 'domain') permission.domain = p('domain');
          const qs: IDataObject = type === 'user' || type === 'group' ? { sendNotificationEmail: p('sendNotificationEmail', true) } : {};
          if (permission.role === 'owner') qs.transferOwnership = true;
          return call({ url: `${API}/files/${id}/permissions`, method: 'POST', body: permission, qs });
        };
        const remove = async (id: string) => {
          if (p('deletePermanently', false)) await call({ url: `${API}/files/${id}`, method: 'DELETE' });
          else await call({ url: `${API}/files/${id}`, method: 'PATCH', body: { trashed: true } });
          return { id, success: true };
        };

        if (resource === 'fileFolder') {
          const q = buildDriveQuery({
            name: p('searchMethod', 'name') === 'name' ? p('queryString', '') : undefined,
            query: p('searchMethod', 'name') === 'query' ? p('query', '') : undefined,
            folderId: p('folderId', '') ? driveId(p('folderId')) : undefined,
            what: p('what', 'all') as 'all',
            includeTrashed: p('includeTrashed', false),
          });
          return googlePages(
            (pageToken, pageSize) => call({ url: `${API}/files`, qs: { q, pageSize, fields: `nextPageToken,files(${FILE_FIELDS})`, includeItemsFromAllDrives: true, ...(pageToken ? { pageToken } : {}) } }),
            'files',
            listLimit(this, i),
          );
        }

        if (resource === 'folder') {
          if (op === 'create') return call({ url: `${API}/files`, method: 'POST', qs: { fields: FILE_FIELDS }, body: { name: p('name'), mimeType: FOLDER_MIME, parents: [driveId(p('folderId', 'root'))] } });
          const id = driveId(p('folderId'));
          return op === 'share' ? share(id) : remove(id);
        }

        // file
        if (op === 'upload') {
          const prop = p('binaryPropertyName', 'data');
          const bin = this.helpers.assertBinaryData(i, prop);
          const content = await this.helpers.getBinaryDataBuffer(i, prop);
          return upload({ name: p('name', '') || bin.fileName || 'file', parents: [driveId(p('folderId', 'root'))] }, content, bin.mimeType);
        }
        if (op === 'createFromText') {
          const metadata: IDataObject = { name: p('name'), parents: [driveId(p('folderId', 'root'))] };
          if (p('convertToGoogleDocument', false)) metadata.mimeType = 'application/vnd.google-apps.document';
          return upload(metadata, Buffer.from(String(p('content', '')), 'utf8'), 'text/plain');
        }

        const id = driveId(p('fileId'));
        if (op === 'download') {
          const meta = await call({ url: `${API}/files/${id}`, qs: { fields: 'id,name,mimeType' } });
          const conversion = EXPORTS[String(meta.mimeType)]?.[p('googleFileConversion', 'office')];
          const data = (await call(
            conversion
              ? { url: `${API}/files/${id}/export`, qs: { mimeType: conversion.mime }, encoding: 'arraybuffer', json: false }
              : { url: `${API}/files/${id}`, qs: { alt: 'media' }, encoding: 'arraybuffer', json: false },
          )) as unknown as Buffer;
          const name = conversion ? `${meta.name}.${conversion.ext}` : String(meta.name);
          const out: INodeExecutionData = { json: { ...item.json, ...meta }, binary: { ...(item.binary ?? {}), [p('binaryPropertyName', 'data')]: await this.helpers.prepareBinaryData(data, name, conversion?.mime ?? String(meta.mimeType)) } };
          return out;
        }
        if (op === 'copy') {
          const body: IDataObject = { parents: [driveId(p('folderId', 'root'))] };
          if (p('name', '')) body.name = p('name');
          return call({ url: `${API}/files/${id}/copy`, method: 'POST', qs: { fields: FILE_FIELDS }, body });
        }
        if (op === 'move') {
          const current = await call({ url: `${API}/files/${id}`, qs: { fields: 'parents' } });
          return call({ url: `${API}/files/${id}`, method: 'PATCH', qs: { addParents: driveId(p('folderId', 'root')), removeParents: ((current.parents as string[]) ?? []).join(','), fields: FILE_FIELDS }, body: {} });
        }
        if (op === 'update') {
          const metadata: IDataObject = p('newName', '') ? { name: p('newName') } : {};
          if (p('changeContent', false)) {
            const prop = p('binaryPropertyName', 'data');
            const bin = this.helpers.assertBinaryData(i, prop);
            return upload(metadata, await this.helpers.getBinaryDataBuffer(i, prop), bin.mimeType, id);
          }
          return call({ url: `${API}/files/${id}`, method: 'PATCH', qs: { fields: FILE_FIELDS }, body: metadata });
        }
        if (op === 'share') return share(id);
        return remove(id);
      }),
    ];
  },
};

/* ---------------- trigger ---------------- */

export const GoogleDriveTrigger: INodeType = {
  description: {
    name: '8n8.googleDriveTrigger',
    displayName: 'Google Drive Trigger',
    description: 'Starts the workflow when files or folders are created or changed (checks on a schedule)',
    group: ['trigger'],
    version: [1],
    defaults: { name: 'Google Drive Trigger', color: '#1fa463' },
    icon: 'fa:google-drive',
    inputs: [],
    outputs: ['main'],
    credentials: googleCredentials(CRED),
    polling: true,
    properties: [
      googleAuthProp,
      pollTimesProp,
      { displayName: 'Trigger On', name: 'triggerOn', type: 'options', default: 'specificFolder', options: [{ name: 'Changes in a Specific Folder', value: 'specificFolder' }, { name: 'Changes Anywhere', value: 'anyFolder' }] },
      { displayName: 'Folder', name: 'folderToWatch', type: 'string', default: '', required: true, displayOptions: { show: { triggerOn: ['specificFolder'] } }, description: 'Folder ID or URL' },
      {
        displayName: 'Watch For',
        name: 'event',
        type: 'options',
        default: 'fileCreated',
        options: [
          { name: 'File Created', value: 'fileCreated' },
          { name: 'File Updated', value: 'fileUpdated' },
          { name: 'Folder Created', value: 'folderCreated' },
          { name: 'Folder Updated', value: 'folderUpdated' },
        ],
      },
      { displayName: 'File Type (MIME)', name: 'fileType', type: 'string', default: '', placeholder: 'application/pdf', displayOptions: { show: { event: ['fileCreated', 'fileUpdated'] } }, description: 'Only files of this type' },
    ],
  },
  async poll(this: IPollFunctions) {
    const auth = this.getNodeParameter('authentication', 'oAuth2');
    const event = this.getNodeParameter('event', 'fileCreated') as string;
    const state = this.getWorkflowStaticData('node');
    const manual = this.getMode() === 'manual';
    const now = new Date().toISOString();
    // first activation: only report what changes from now on
    if (!manual && !state.lastTimeChecked) {
      state.lastTimeChecked = now;
      return null;
    }
    const timeField = event.endsWith('Created') ? 'createdTime' : 'modifiedTime';
    const parts = [buildDriveQuery({
      what: event.startsWith('folder') ? 'folders' : 'files',
      folderId: this.getNodeParameter('triggerOn', 'specificFolder') === 'specificFolder' ? driveId(this.getNodeParameter('folderToWatch', '') as string) : undefined,
    })];
    const fileType = event.startsWith('file') ? (this.getNodeParameter('fileType', '') as string) : '';
    if (fileType) parts.push(`mimeType = '${fileType.replace(/'/g, "\\'")}'`);
    if (!manual) parts.push(`${timeField} > '${state.lastTimeChecked}'`);

    const files = await googlePages(
      (pageToken, pageSize) =>
        drive(this, auth, { url: `${API}/files`, qs: { q: parts.join(' and '), orderBy: `${timeField} desc`, pageSize, fields: `nextPageToken,files(${FILE_FIELDS})`, ...ALL_DRIVES, includeItemsFromAllDrives: true, ...(pageToken ? { pageToken } : {}) } }),
      'files',
      manual ? 1 : 500,
    );
    if (!manual) state.lastTimeChecked = files.reduce((max, f) => (String(f[timeField]) > max ? String(f[timeField]) : max), String(state.lastTimeChecked));
    return files.length ? [files.reverse().map((json) => ({ json }))] : null;
  },
};
