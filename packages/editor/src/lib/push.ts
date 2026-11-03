import { pushRef, useWorkflow } from '../store/workflow';

type Listener = (event: { type: string; data: any }) => void;
const listeners = new Set<Listener>();

/** Subscribe to every push event (e.g. to refresh an executions list). Returns an unsubscribe function. */
export function onPush(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let socket: WebSocket | null = null;
let retry = 0;
let wanted = false;

/** Live events need a session: connect after signing in, disconnect when signing out. */
export function disconnectPush() {
  wanted = false;
  socket?.close();
}

export function connectPush() {
  wanted = true;
  if (socket && socket.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/rest/push?pushRef=${pushRef}`);
  socket.onopen = () => (retry = 0);
  socket.onmessage = (msg) => {
    const event = JSON.parse(String(msg.data));
    useWorkflow.getState().applyPush(event);
    for (const l of listeners) l(event);
  };
  socket.onclose = () => {
    socket = null;
    if (wanted) setTimeout(() => wanted && connectPush(), Math.min(10_000, 500 * 2 ** retry++));
  };
}
