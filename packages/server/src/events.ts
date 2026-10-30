import { randomUUID } from 'node:crypto';
import type { IDataObject } from '@8n8/workflow';

/** An event as log streaming destinations receive it (n8n's event bus message shape). */
export interface BusEvent {
  __type: '$$EventMessageWorkflow' | '$$EventMessageNode' | '$$EventMessageAudit';
  id: string;
  ts: string;
  eventName: string;
  message: string;
  payload: IDataObject;
}

export type BusListener = (event: BusEvent) => void;

const typeOf = (name: string): BusEvent['__type'] => (name.startsWith('n8n.node.') ? '$$EventMessageNode' : name.startsWith('n8n.audit.') ? '$$EventMessageAudit' : '$$EventMessageWorkflow');

/**
 * In-process event bus with n8n's event names (n8n.workflow.success, n8n.node.started, n8n.audit.workflow.created…).
 * Log streaming and insights subscribe to it; listeners must not throw or block.
 */
export class EventBus {
  private listeners = new Set<BusListener>();

  on(listener: BusListener) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  emit(eventName: string, payload: IDataObject = {}) {
    const event: BusEvent = { __type: typeOf(eventName), id: randomUUID(), ts: new Date().toISOString(), eventName, message: eventName, payload };
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error(`Event listener failed on ${eventName}: ${(e as Error).message}`);
      }
    }
  }
}

/** Every event name, grouped the way the destination editor shows them. */
export const EVENT_NAMES = {
  workflow: ['n8n.workflow.started', 'n8n.workflow.success', 'n8n.workflow.failed', 'n8n.workflow.cancelled', 'n8n.workflow.waiting'],
  node: ['n8n.node.started', 'n8n.node.finished'],
  audit: [
    'n8n.audit.workflow.created',
    'n8n.audit.workflow.updated',
    'n8n.audit.workflow.deleted',
    'n8n.audit.workflow.activated',
    'n8n.audit.workflow.deactivated',
    'n8n.audit.user.credentials.created',
    'n8n.audit.user.credentials.updated',
    'n8n.audit.user.credentials.deleted',
    'n8n.audit.variable.created',
    'n8n.audit.variable.updated',
    'n8n.audit.variable.deleted',
    'n8n.audit.source-control.pushed',
    'n8n.audit.source-control.pulled',
    'n8n.audit.package.installed',
    'n8n.audit.package.uninstalled',
  ],
};

/** "n8n.workflow" matches every n8n.workflow.* event; "*" matches all. */
export function eventMatches(eventName: string, subscriptions: string[]) {
  return subscriptions.some((s) => s === '*' || s === eventName || eventName.startsWith(`${s}.`));
}
