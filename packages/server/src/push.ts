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
  private readonly clients = new Map<string, WebSocket>();

  add(pushRef: string, ws: WebSocket) {
    this.clients.get(pushRef)?.close();
    this.clients.set(pushRef, ws);
    ws.on('close', () => {
      if (this.clients.get(pushRef) === ws) this.clients.delete(pushRef);
    });
  }

  /** Sends to one client when `pushRef` is given (e.g. the editor that started a manual run), otherwise to all. */
  send(event: PushEvent, pushRef?: string) {
    const msg = JSON.stringify(event);
    const targets = pushRef ? [this.clients.get(pushRef)].filter(Boolean) : [...this.clients.values()];
    for (const ws of targets) if (ws!.readyState === 1) ws!.send(msg);
  }

  get size() {
    return this.clients.size;
  }

  closeAll() {
    for (const ws of this.clients.values()) ws.close();
    this.clients.clear();
  }
}
