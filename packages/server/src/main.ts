import { createApp } from './app';

const { start, stop, ctx } = await createApp();
const url = await start();
const active = ctx.activeWorkflows;
const activeCount = ctx.db.listWorkflows({ active: true }).filter((w) => active.isActive(w.id)).length;

console.log(`8n8 ready on ${url}`);
console.log(`  data folder:  ${ctx.config.userFolder}`);
console.log(`  webhook base: ${ctx.config.webhookUrl}${ctx.config.endpoints.webhook}/`);
console.log(`  active workflows: ${activeCount}`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('\nStopping 8n8 (waiting for running executions)…');
    await stop();
    process.exit(0);
  });
}
