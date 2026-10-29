import { Cron } from 'croner';
import { HookContext, PollContext, TriggerContext, type NodeTypesRegistry } from '@8n8/core';
import type { IDataObject, INode, INodeExecutionData, ITriggerResponse, Workflow } from '@8n8/workflow';
import type { ServerConfig } from './config';
import type { Database, WorkflowEntity } from './db';
import type { ExecutionService } from './execution-service';
import type { PushSender } from './push';
import { resolveWebhook, webhookNodesOf, type WebhookService } from './webhooks';

interface ActiveState {
  workflow: Workflow;
  triggers: ITriggerResponse[];
  pollers: Cron[];
}

interface PollTime {
  mode: 'everyMinute' | 'everyHour' | 'everyDay' | 'everyWeek' | 'everyMonth' | 'everyX' | 'custom';
  hour?: number;
  minute?: number;
  weekday?: number;
  dayOfMonth?: number;
  value?: number;
  unit?: 'minutes' | 'hours';
  cronExpression?: string;
}

/** Poll schedule ("pollTimes" parameter) → cron expressions. Defaults to every minute. */
export function pollTimesToCron(param: unknown): string[] {
  const items = ((param as { item?: PollTime[] })?.item ?? []) as PollTime[];
  if (!items.length) return ['0 * * * * *'];
  return items.map((t) => {
    const m = t.minute ?? 0;
    const h = t.hour ?? 0;
    switch (t.mode) {
      case 'everyHour': return `0 ${m} * * * *`;
      case 'everyDay': return `0 ${m} ${h} * * *`;
      case 'everyWeek': return `0 ${m} ${h} * * ${t.weekday ?? 1}`;
      case 'everyMonth': return `0 ${m} ${h} ${t.dayOfMonth ?? 1} * *`;
      case 'everyX': return t.unit === 'hours' ? `0 0 */${t.value ?? 1} * * *` : `0 */${t.value ?? 1} * * * *`;
      case 'custom': return (t.cronExpression ?? '').trim().split(/\s+/).length === 5 ? `0 ${t.cronExpression}` : String(t.cronExpression);
      default: return '0 * * * * *';
    }
  });
}

/**
 * Keeps active workflows listening: production webhooks, trigger nodes (schedules, queues...) and pollers.
 */
export class ActiveWorkflows {
  private readonly active = new Map<string, ActiveState>();
  private readonly errors = new Map<string, string>();
  /** Called after a workflow's webhooks/triggers were set up or removed (queue mode tells webhook processes). */
  onChange?: (workflowId: string, active: boolean) => void;

  constructor(
    private readonly config: ServerConfig,
    private readonly db: Database,
    private readonly nodeTypes: NodeTypesRegistry,
    private readonly executions: ExecutionService,
    private readonly webhooks: WebhookService,
    private readonly push: PushSender,
  ) {}

  isActive(id: string) {
    return this.active.has(id);
  }

  activationError(id: string) {
    return this.errors.get(id);
  }

  /** On startup: re-activate everything marked active. Failures are kept as activation errors. */
  async init() {
    for (const wf of this.db.listWorkflows({ active: true })) {
      try {
        await this.add(wf, 'init');
      } catch (e) {
        console.error(`Could not activate workflow "${wf.name}" (${wf.id}): ${(e as Error).message}`);
      }
    }
  }

  /**
   * Webhook processes (queue mode) only route production webhooks: registrations without
   * triggers, pollers or registering with external services (main does that).
   */
  registerWebhooksOnly(wf: WorkflowEntity) {
    this.webhooks.removeProductionForWorkflow(wf.id);
    if (!wf.active) return;
    for (const { node, description } of webhookNodesOf(this.nodeTypes, wf.nodes)) {
      this.webhooks.registerProduction({ workflowId: wf.id, nodeName: node.name, webhookName: description.name, ...resolveWebhook(this.nodeTypes, node, description) });
    }
  }

  /** Stops listening without telling webhook processes: the workflows are still active. */
  async shutdown() {
    for (const id of [...this.active.keys()]) await this.remove(id, false);
  }

  private hasTrigger(wf: WorkflowEntity) {
    return wf.nodes.some((n) => {
      if (n.disabled || !this.nodeTypes.has(n.type)) return false;
      const t = this.nodeTypes.getByNameAndVersion(n.type, n.typeVersion);
      return !!(t.trigger || t.poll || t.webhook) && t.description.group.includes('trigger') && !n.type.endsWith('manualTrigger') && !n.type.endsWith('executeWorkflowTrigger') && !n.type.endsWith('errorTrigger');
    });
  }

  async add(wf: WorkflowEntity, activation: 'init' | 'activate' | 'update' = 'activate') {
    await this.remove(wf.id);
    if (!this.hasTrigger(wf)) {
      throw new Error('Workflow has no node to start the workflow - at least one trigger, poller or webhook node is required');
    }
    for (const n of wf.nodes) if (!this.nodeTypes.has(n.type)) throw new Error(`Unrecognized node type "${n.type}" in node "${n.name}"`);

    const workflow = this.executions.buildWorkflow(wf);
    const state: ActiveState = { workflow, triggers: [], pollers: [] };
    const additionalData = {
      executionId: '',
      mode: 'trigger' as const,
      credentialsHelper: this.executions.credentialsHelper,
      timezone: this.config.timezone,
      binaryData: this.executions.binaryData,
    };
    const saveStatic = (() => {
      let last = JSON.stringify(workflow.staticData);
      return () => {
        const now = JSON.stringify(workflow.staticData);
        if (now !== last) {
          last = now;
          this.db.saveStaticData(wf.id, workflow.staticData);
        }
      };
    })();

    try {
      // webhooks
      for (const { node, description } of webhookNodesOf(this.nodeTypes, wf.nodes)) {
        const r = resolveWebhook(this.nodeTypes, node, description);
        this.webhooks.registerProduction({ workflowId: wf.id, nodeName: node.name, webhookName: description.name, ...r });
        const methods = this.nodeTypes.getByNameAndVersion(node.type, node.typeVersion).webhookMethods?.[description.name];
        if (methods) {
          const hookCtx = new HookContext({ workflow, node, additionalData }, description.name, () => this.webhooks.webhookUrlFor(node, 'production'));
          if (!(await methods.checkExists.call(hookCtx))) await methods.create.call(hookCtx);
          saveStatic();
        }
      }

      for (const node of Object.values(workflow.nodes)) {
        if (node.disabled) continue;
        const type = this.nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
        const start = (items: INodeExecutionData[]) => {
          saveStatic();
          const fresh = this.db.getWorkflow(wf.id);
          if (!fresh) return;
          this.executions.run({ workflowData: { ...fresh, staticData: workflow.staticData }, mode: 'trigger', startNode: node.name, triggerData: items });
        };

        if (type.trigger && !node.type.endsWith('manualTrigger') && !node.type.endsWith('executeWorkflowTrigger') && !node.type.endsWith('errorTrigger')) {
          const ctx = new TriggerContext(
            { workflow, node, additionalData },
            activation,
            (data) => start(data[0] ?? []),
            (error) => console.error(`Trigger "${node.name}" in workflow ${wf.id} failed:`, error.message),
          );
          const response = await type.trigger.call(ctx);
          if (response) state.triggers.push(response);
        }

        if (type.poll) {
          for (const cron of pollTimesToCron(node.parameters.pollTimes)) {
            state.pollers.push(
              new Cron(cron, { timezone: this.config.timezone, protect: true }, async () => {
                try {
                  const ctx = new PollContext({ workflow, node, additionalData }, (data) => start(data[0] ?? []));
                  const data = await type.poll!.call(ctx);
                  saveStatic();
                  if (data?.[0]?.length) start(data[0]);
                } catch (e) {
                  console.error(`Poll of "${node.name}" in workflow ${wf.id} failed:`, (e as Error).message);
                }
              }),
            );
          }
        }
      }
    } catch (e) {
      await this.teardown(wf.id, state);
      this.errors.set(wf.id, (e as Error).message);
      this.push.send({ type: 'workflowFailedToActivate', data: { workflowId: wf.id, errorMessage: (e as Error).message } });
      throw e;
    }

    this.active.set(wf.id, state);
    this.errors.delete(wf.id);
    this.push.send({ type: 'workflowActivated', data: { workflowId: wf.id } });
    this.onChange?.(wf.id, true);
  }

  async remove(workflowId: string, notify = true) {
    const state = this.active.get(workflowId);
    this.webhooks.removeProductionForWorkflow(workflowId);
    if (!state) return;
    if (notify) this.onChange?.(workflowId, false);
    this.active.delete(workflowId);
    await this.teardown(workflowId, state);
    this.push.send({ type: 'workflowDeactivated', data: { workflowId } });
  }

  private async teardown(workflowId: string, state: ActiveState) {
    this.webhooks.removeProductionForWorkflow(workflowId);
    for (const p of state.pollers) p.stop();
    for (const t of state.triggers) await t.closeFunction?.().catch(() => {});
    // remove externally registered webhooks
    for (const node of Object.values(state.workflow.nodes) as INode[]) {
      if (node.disabled || !this.nodeTypes.has(node.type)) continue;
      const methods = this.nodeTypes.getByNameAndVersion(node.type, node.typeVersion).webhookMethods;
      for (const [name, m] of Object.entries(methods ?? {})) {
        const hookCtx = new HookContext({ workflow: state.workflow, node, additionalData: { executionId: '', mode: 'trigger', credentialsHelper: this.executions.credentialsHelper } }, name, () => this.webhooks.webhookUrlFor(node, 'production'));
        await m.delete.call(hookCtx).catch(() => {});
      }
    }
    this.db.saveStaticData(workflowId, state.workflow.staticData as IDataObject);
  }
}
