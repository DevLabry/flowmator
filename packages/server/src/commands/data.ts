import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IDataObject, IWorkflowBase } from '@flowmator/workflow';
import type { ConfigOverrides } from '../config';
import { createContext, normalizeWorkflow, type AppContext } from '../context';
import { Cipher } from '../credentials';
import type { WorkflowEntity } from '../db';

/**
 * Commands that work on the data folder directly (no server needed). They also work while Flowmator is
 * running; changes to active workflows take effect when main restarts or the workflow is re-saved.
 */
async function withContext<T>(overrides: ConfigOverrides, fn: (ctx: AppContext) => T | Promise<T>): Promise<T> {
  // always run here, even when the instance is configured for queue mode
  const ctx = createContext({ ...overrides, executions: { ...overrides.executions, mode: 'regular' } });
  try {
    return await fn(ctx);
  } finally {
    ctx.db.close();
  }
}

/** One JSON file (object or array), or with `separate` every .json file in a folder. */
function readJsonInput(input: string, separate: boolean): unknown[] {
  if (!existsSync(input)) throw new Error(`"${input}" does not exist`);
  const files = separate || statSync(input).isDirectory()
    ? readdirSync(input).filter((f) => f.endsWith('.json')).map((f) => path.join(input, f))
    : [input];
  return files.flatMap((f) => {
    const parsed = JSON.parse(readFileSync(f, 'utf8'));
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

/** Writes to a file, one file per entry into a folder (`separate`), or stdout. */
function writeJsonOutput(entries: Array<{ id: string }>, opts: { output?: string; separate?: boolean; pretty?: boolean }) {
  const stringify = (v: unknown) => JSON.stringify(v, null, opts.pretty ? 2 : undefined);
  if (opts.separate) {
    if (!opts.output) throw new Error('--separate needs --output=<folder>');
    mkdirSync(opts.output, { recursive: true });
    for (const e of entries) writeFileSync(path.join(opts.output, `${e.id}.json`), stringify(e));
    return `${entries.length} file(s) written to ${opts.output}`;
  }
  if (!opts.output) {
    process.stdout.write(`${stringify(entries)}\n`);
    return null;
  }
  mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
  writeFileSync(opts.output, stringify(entries));
  return `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} written to ${opts.output}`;
}

/* ---------------- workflows ---------------- */

export interface ExportOptions {
  all?: boolean;
  id?: string;
  output?: string;
  separate?: boolean;
  pretty?: boolean;
  backup?: boolean;
}

function exportSelection<T extends { id: string }>(list: T[], opts: ExportOptions, what: string) {
  if (opts.backup) Object.assign(opts, { all: true, pretty: true, separate: true });
  if (!opts.all && !opts.id) throw new Error(`Choose what to export: --all or --id=<${what} id>`);
  const selected = opts.id ? list.filter((e) => e.id === opts.id) : list;
  if (!selected.length) throw new Error(opts.id ? `No ${what} with ID "${opts.id}"` : `There are no ${what}s to export`);
  return selected;
}

export function exportWorkflows(opts: ExportOptions, overrides: ConfigOverrides = {}) {
  return withContext(overrides, (ctx) => {
    const list = [...ctx.db.listWorkflows({}), ...ctx.db.listWorkflows({ archived: true })];
    return writeJsonOutput(exportSelection(list, opts, 'workflow'), opts);
  });
}

/** Imports workflow exports. IDs are kept, so importing again updates instead of duplicating. */
export function importWorkflows(opts: { input: string; separate?: boolean }, overrides: ConfigOverrides = {}) {
  return withContext(overrides, (ctx) => {
    const entries = readJsonInput(opts.input, !!opts.separate) as Array<Omit<Partial<WorkflowEntity>, 'tags'> & { tags?: Array<string | { name: string }> }>;
    let created = 0;
    let updated = 0;
    for (const raw of entries) {
      if (!raw?.nodes || !raw.connections) throw new Error(`"${raw?.name ?? 'entry'}" is not a workflow (missing nodes/connections)`);
      const { tags: rawTags, active: _ignored, createdAt: _c, updatedAt: _u, versionId: _v, ...rest } = raw;
      const wf = normalizeWorkflow(rest);
      const tags = rawTags?.map((t) => (typeof t === 'string' ? t : t.name));
      // imported workflows start inactive; activate them in the editor or with update:workflow
      if (wf.id && ctx.db.getWorkflow(wf.id)) {
        const current = ctx.db.getWorkflow(wf.id)!;
        if (current.active) ctx.db.updateWorkflow(wf.id, { active: false });
        ctx.db.updateWorkflow(wf.id, { ...wf, name: wf.name || current.name, tags });
        updated++;
      } else {
        ctx.db.createWorkflow({ ...(wf as IWorkflowBase), name: wf.name || 'Imported workflow', tags });
        created++;
      }
    }
    return `Imported ${entries.length} workflow(s): ${created} new, ${updated} updated. Imported workflows are inactive.`;
  });
}

export function listWorkflows(opts: { active?: boolean; onlyId?: boolean }, overrides: ConfigOverrides = {}) {
  return withContext(overrides, (ctx) => {
    const list = ctx.db.listWorkflows({ active: opts.active });
    return list.map((w) => (opts.onlyId ? w.id : `${w.id}|${w.name}`)).join('\n');
  });
}

/** Sets the active flag. A running main applies it on restart (or when the workflow is next saved). */
export function updateWorkflows(opts: { id?: string; all?: boolean; active: boolean }, overrides: ConfigOverrides = {}) {
  return withContext(overrides, (ctx) => {
    if (!opts.id && !opts.all) throw new Error('Choose the workflows: --id=<workflow id> or --all');
    const targets = opts.id ? [ctx.db.getWorkflow(opts.id)].filter((w): w is WorkflowEntity => !!w) : ctx.db.listWorkflows({});
    if (opts.id && !targets.length) throw new Error(`No workflow with ID "${opts.id}"`);
    for (const wf of targets) ctx.db.updateWorkflow(wf.id, { active: opts.active });
    return `${opts.active ? 'Activated' : 'Deactivated'} ${targets.length} workflow(s). Restart Flowmator for a running instance to pick this up.`;
  });
}

/* ---------------- credentials ---------------- */

export function exportCredentials(opts: ExportOptions & { decrypted?: boolean }, overrides: ConfigOverrides = {}) {
  return withContext(overrides, (ctx) => {
    const cipher = new Cipher(ctx.config.encryptionKey);
    const list = ctx.db.listCredentials().map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      // encrypted exports can only be imported into an instance with the same encryption key
      data: opts.decrypted ? cipher.decrypt(c.data) : c.data,
    }));
    return writeJsonOutput(exportSelection(list, opts, 'credential'), opts);
  });
}

export function importCredentials(opts: { input: string; separate?: boolean }, overrides: ConfigOverrides = {}) {
  return withContext(overrides, (ctx) => {
    const cipher = new Cipher(ctx.config.encryptionKey);
    const entries = readJsonInput(opts.input, !!opts.separate) as Array<{ id?: string; name: string; type: string; data: string | IDataObject }>;
    for (const c of entries) {
      if (!c?.name || !c.type || !c.data) throw new Error('Each credential needs name, type and data');
      if (!ctx.credentialTypes.getKnownTypes().includes(c.type)) throw new Error(`Unknown credential type "${c.type}" (credential "${c.name}")`);
      let encrypted: string;
      if (typeof c.data === 'string') {
        try {
          cipher.decrypt(c.data);
        } catch {
          throw new Error(`Credential "${c.name}" was encrypted with a different key. Export it with --decrypted, or set FLOWMATOR_ENCRYPTION_KEY to the original key.`);
        }
        encrypted = c.data;
      } else {
        encrypted = cipher.encrypt(c.data);
      }
      if (c.id && ctx.db.getCredential(c.id)) ctx.db.updateCredential(c.id, { name: c.name, data: encrypted });
      else ctx.db.createCredential(c.name, c.type, encrypted, c.id);
    }
    return `Imported ${entries.length} credential(s)`;
  });
}

/* ---------------- execute ---------------- */

/** Runs a workflow in this process and prints the result. Resolves to the exit code. */
export function executeWorkflow(opts: { id?: string; file?: string; rawOutput?: boolean }, overrides: ConfigOverrides = {}) {
  return withContext(overrides, async (ctx) => {
    let workflowData: IWorkflowBase;
    if (opts.file) {
      const parsed = JSON.parse(readFileSync(opts.file, 'utf8'));
      workflowData = normalizeWorkflow(Array.isArray(parsed) ? parsed[0] : parsed);
    } else if (opts.id) {
      const wf = ctx.db.getWorkflow(opts.id);
      if (!wf) throw new Error(`No workflow with ID "${opts.id}"`);
      workflowData = wf;
    } else {
      throw new Error('Choose the workflow: --id=<workflow id> or --file=<path>');
    }

    const start = ctx.executions.buildWorkflow(workflowData).getStartNode();
    if (!start) throw new Error('The workflow has no node to start from');
    const { executionId, promise } = ctx.executions.run({ workflowData, mode: 'cli', startNode: start.name });
    const run = await promise;
    await ctx.executions.stopAll();

    const output = run.data.resultData;
    if (opts.rawOutput) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else if (run.status === 'success' || run.status === 'waiting') {
      console.log(`Execution ${executionId} was successful${run.status === 'waiting' ? ' (now waiting)' : ''}:`);
      console.log('====================================');
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.error(`Execution ${executionId} failed:`);
      console.error('====================================');
      console.error(output.error?.message ?? run.status);
    }
    return run.status === 'success' || run.status === 'waiting' ? 0 : 1;
  });
}

/** Back to one owner who signs up again on the next visit; everything is kept and goes to them. */
export function resetUserManagement(overrides: ConfigOverrides = {}) {
  return withContext(overrides, (ctx) => {
    const removed = ctx.access.reset();
    return `User management reset: ${removed} user(s) removed, all workflows and credentials now belong to the owner. Open the editor to set up the owner again.`;
  });
}
