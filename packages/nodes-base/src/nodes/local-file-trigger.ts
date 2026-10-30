import path from 'node:path';
import { watch } from 'chokidar';
import type { IDataObject, INodeType, ITriggerFunctions } from '@flowmator/workflow';
import { assertFileAccess } from './files';

/* ---------------- Local File Trigger ---------------- */

export const LocalFileTrigger: INodeType = {
  description: {
    name: 'flowmator.localFileTrigger',
    displayName: 'Local File Trigger',
    description: 'Starts the workflow when files or folders change on the computer running Flowmator',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Local File Trigger', color: '#404040' },
    icon: 'fa:folder-open',
    inputs: [],
    outputs: ['main'],
    codex: { alias: ['Watch', 'Folder', 'File', 'Change'] },
    properties: [
      {
        displayName: 'Trigger On',
        name: 'triggerOn',
        type: 'options',
        default: '',
        required: true,
        options: [
          { name: 'Changes to a Specific File', value: 'file' },
          { name: 'Changes Involving a Specific Folder', value: 'folder' },
        ],
      },
      { displayName: 'File to Watch', name: 'path', type: 'string', default: '', placeholder: '/data/invoices/latest.csv', displayOptions: { show: { triggerOn: ['file'] } } },
      { displayName: 'Folder to Watch', name: 'path', type: 'string', default: '', placeholder: '/data/invoices', displayOptions: { show: { triggerOn: ['folder'] } } },
      {
        displayName: 'Watch for',
        name: 'events',
        type: 'multiOptions',
        default: [],
        required: true,
        displayOptions: { show: { triggerOn: ['folder'] } },
        options: [
          { name: 'File Added', value: 'add' },
          { name: 'File Changed', value: 'change' },
          { name: 'File Deleted', value: 'unlink' },
          { name: 'Folder Added', value: 'addDir' },
          { name: 'Folder Deleted', value: 'unlinkDir' },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Await Write Finish', name: 'awaitWriteFinish', type: 'boolean', default: false, description: 'Wait until a file stops growing before triggering' },
          { displayName: 'Include Linked Files/Folders', name: 'followSymlinks', type: 'boolean', default: true },
          { displayName: 'Ignore', name: 'ignored', type: 'string', default: '', placeholder: '**/*.tmp', description: 'Glob of files or paths to ignore' },
          { displayName: 'Ignore Existing Files/Folders', name: 'ignoreInitial', type: 'boolean', default: true, description: 'Do not trigger for what is already there when watching starts' },
          {
            displayName: 'Max Folder Depth',
            name: 'depth',
            type: 'options',
            default: -1,
            options: [
              { name: 'Unlimited', value: -1 },
              { name: 'Top Folder Only', value: 0 },
              { name: '1 Level Down', value: 1 },
              { name: '2 Levels Down', value: 2 },
              { name: '3 Levels Down', value: 3 },
              { name: '4 Levels Down', value: 4 },
            ],
          },
          { displayName: 'Use Polling', name: 'usePolling', type: 'boolean', default: false, description: 'Needed for network drives and some containers' },
        ],
      },
    ],
  },
  async trigger(this: ITriggerFunctions) {
    const triggerOn = this.getNodeParameter('triggerOn') as string;
    const target = assertFileAccess(this.getNodeParameter('path') as string);
    const events = triggerOn === 'file' ? ['change'] : (this.getNodeParameter('events', []) as string[]);
    const o = this.getNodeParameter('options', {}) as IDataObject;
    const glob = String(o.ignored ?? '').trim();
    const depth = Number(o.depth ?? -1);

    const watcher = watch(target, {
      persistent: true,
      ignoreInitial: o.ignoreInitial !== false,
      followSymlinks: o.followSymlinks !== false,
      usePolling: !!o.usePolling,
      awaitWriteFinish: !!o.awaitWriteFinish,
      depth: depth >= 0 ? depth : undefined,
      ignored: glob ? (p: string) => path.matchesGlob(p, glob) || path.matchesGlob(path.basename(p), glob) : undefined,
    });
    for (const event of events) {
      watcher.on(event as 'add', (changed: string) => this.emit([this.helpers.returnJsonArray([{ path: changed, event }])]));
    }
    watcher.on('error', (e) => this.emitError(e as Error));
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
    return { closeFunction: () => watcher.close() };
  },
};
