import { parseArgs } from 'node:util';
import { executeWorkflow, exportCredentials, exportWorkflows, importCredentials, importWorkflows, listWorkflows, updateWorkflows } from './commands/data';
import { startMain, startWebhookProcess, startWorker } from './commands/processes';

const HELP = `Usage: flowmator <command> [options]

Processes
  start                       Editor, API, webhooks and triggers (default)
  worker [--concurrency=10]   Runs queued executions (EXECUTIONS_MODE=queue)
  webhook                     Production webhooks only, executions go to workers (EXECUTIONS_MODE=queue)

Workflows
  execute --id=<id> | --file=<path> [--rawOutput]
  import:workflow --input=<file|folder> [--separate]
  export:workflow --all | --id=<id> [--output=<path>] [--pretty] [--separate] [--backup]
  list:workflow [--active=true|false] [--onlyId]
  update:workflow --id=<id> | --all --active=true|false

Credentials
  import:credentials --input=<file|folder> [--separate]
  export:credentials --all | --id=<id> [--output=<path>] [--decrypted] [--pretty] [--separate] [--backup]

Settings come from environment variables (N8N_USER_FOLDER, N8N_PORT, EXECUTIONS_MODE, QUEUE_BULL_REDIS_HOST, ...).`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    input: { type: 'string' },
    output: { type: 'string' },
    id: { type: 'string' },
    file: { type: 'string' },
    all: { type: 'boolean' },
    separate: { type: 'boolean' },
    pretty: { type: 'boolean' },
    backup: { type: 'boolean' },
    decrypted: { type: 'boolean' },
    rawOutput: { type: 'boolean' },
    onlyId: { type: 'boolean' },
    active: { type: 'string' },
    concurrency: { type: 'string' },
    port: { type: 'string' },
  },
});

const command = positionals[0] ?? 'start';
const port = o.port ? { port: Number(o.port) } : {};
const bool = (name: string, v: string | undefined) => {
  if (v === undefined) return undefined;
  if (v !== 'true' && v !== 'false') throw new Error(`--${name} must be true or false`);
  return v === 'true';
};
const report = (message: string | null) => message && console.error(message);
const need = (value: string | undefined, flag: string) => {
  if (!value) throw new Error(`Missing --${flag}`);
  return value;
};

try {
  if (o.help) console.log(HELP);
  else
    switch (command) {
      case 'start':
        await startMain(port);
        break;
      case 'worker':
        await startWorker({ concurrency: Number(o.concurrency ?? 10) }, port);
        break;
      case 'webhook':
        await startWebhookProcess(port);
        break;
      case 'execute':
        process.exitCode = await executeWorkflow({ id: o.id, file: o.file, rawOutput: o.rawOutput });
        break;
      case 'import:workflow':
        report(await importWorkflows({ input: need(o.input, 'input'), separate: o.separate }));
        break;
      case 'export:workflow':
        report(await exportWorkflows(o));
        break;
      case 'list:workflow':
        console.log(await listWorkflows({ active: bool('active', o.active), onlyId: o.onlyId }));
        break;
      case 'update:workflow': {
        const active = bool('active', o.active);
        if (active === undefined) throw new Error('Missing --active=true|false');
        report(await updateWorkflows({ id: o.id, all: o.all, active }));
        break;
      }
      case 'import:credentials':
        report(await importCredentials({ input: need(o.input, 'input'), separate: o.separate }));
        break;
      case 'export:credentials':
        report(await exportCredentials(o));
        break;
      default:
        console.error(`Unknown command "${command}"\n\n${HELP}`);
        process.exitCode = 1;
    }
} catch (e) {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
}
