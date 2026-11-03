import type { WebSocket } from 'ws';

export type PushEvent =
  | { type: 'executionStarted'; data: { executionId: string; workflowId?: string; workflowName: string; mode: string; startedAt: string } }
  | { type: 'nodeExecuteBefore'; data: { executionId: string; nodeName: string } }
  | { type: 'nodeExecuteAfter'; data: { executionId: string; nodeName: string; data: unknown } }
  | { type: 'executionFinished'; data: { executionId: string; workflowId?: string; status: string; lastNodeExecuted?: string } }
  | { type: 'executionWaiting'; data: { executionId: string; waitTill?: string } }
  | { type: 'executionRecovered'; data: { executionId: string } }
  | { type: 'sendConsoleMessage'; data: { source: string; messages: unknown[] } }
  | { type: 'testWebhookReceived'; data: { workflowId: string; executionId: string } }
  | { type: 'testWebhookDeleted'; data: { workflowId: string } }
  | { type: 'workflowActivated'; data: { workflowId: string } }
  | { type: 'workflowDeactivated'; data: { workflowId: string } }
  | { type: 'workflowFailedToActivate'; data: { workflowId: string; errorMessage: string } };

/** Anything that can deliver editor events: the WebSocket fan-out, or (on workers) the Redis relay to main. */
export interface PushSender {
  send(event: PushEvent, pushRef?: string): void;
}

/** Fan-out of live events to connected editors over WebSocket. Clients identify with ?pushRef=. */
export class Push implements PushSender {
  private readonly clients = new Map<string, { ws: WebSocket; userId?: string }>();

  /** Whether a user may see events about a workflow (set when user management is on) */
  canSee: (userId: string, workflowId: string) => boolean = () => true;

  add(pushRef: string, ws: WebSocket, userId?: string) {
    this.clients.get(pushRef)?.ws.close();
    this.clients.set(pushRef, { ws, userId });
    ws.on('close', () => {
      if (this.clients.get(pushRef)?.ws === ws) this.clients.delete(pushRef);
    });
  }

  /**
   * Sends to one client when `pushRef` is given (e.g. the editor that started a manual run), otherwise to
   * every client whose user can see the event's workflow.
   */
  send(event: PushEvent, pushRef?: string) {
    const msg = JSON.stringify(event);
    const workflowId = (event.data as { workflowId?: string }).workflowId;
    const targets = pushRef
      ? [this.clients.get(pushRef)].filter((c) => !!c)
      : [...this.clients.values()].filter((c) => !workflowId || !c.userId || this.canSee(c.userId, workflowId));
    for (const { ws } of targets) if (ws.readyState === 1) ws.send(msg);
  }

  get size() {
    return this.clients.size;
  }

  closeAll() {
    for (const { ws } of this.clients.values()) ws.close();
    this.clients.clear();
  }
}
