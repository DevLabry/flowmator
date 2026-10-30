import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import os from 'node:os';
import type { Database } from './db';
import { eventMatches, type BusEvent, type EventBus } from './events';

interface BaseDestination {
  id: string;
  label: string;
  enabled: boolean;
  /** Event names or prefixes ("n8n.workflow", "n8n.audit"); "*" for everything */
  subscribedEvents: string[];
}
export interface WebhookDestination extends BaseDestination {
  type: '$$MessageEventBusDestinationWebhook';
  url: string;
  method: 'POST' | 'PUT' | 'GET';
  headers: Array<{ name: string; value: string }>;
}
export interface SyslogDestination extends BaseDestination {
  type: '$$MessageEventBusDestinationSyslog';
  host: string;
  port: number;
  protocol: 'udp' | 'tcp';
  facility: number;
  app_name: string;
}
export interface SentryDestination extends BaseDestination {
  type: '$$MessageEventBusDestinationSentry';
  dsn: string;
}
export type Destination = WebhookDestination | SyslogDestination | SentryDestination;

const KEY = 'eventDestinations';

/** RFC 5424 syslog line; severity follows the event (failures are errors). */
export function syslogMessage(d: Pick<SyslogDestination, 'facility' | 'app_name'>, e: BusEvent) {
  const severity = /failed|crashed|error/.test(e.eventName) ? 3 : 6;
  const pri = (Number(d.facility ?? 16) || 0) * 8 + severity;
  const data = JSON.stringify({ ...e.payload, eventName: e.eventName, id: e.id });
  return `<${pri}>1 ${e.ts} ${os.hostname()} ${d.app_name || '8n8'} ${process.pid} ${e.eventName} - ${data}`;
}

/** Sentry DSN → envelope endpoint and auth header. */
export function sentryEndpoint(dsn: string) {
  const u = new URL(dsn);
  const projectId = u.pathname.replace(/^\/+/, '').split('/').pop();
  const prefix = u.pathname.replace(/\/[^/]*$/, '');
  return {
    url: `${u.protocol}//${u.host}${prefix}/api/${projectId}/envelope/`,
    auth: `Sentry sentry_version=7, sentry_client=8n8/0.1, sentry_key=${u.username}`,
    dsn,
  };
}

async function sendTo(d: Destination, e: BusEvent) {
  if (d.type === '$$MessageEventBusDestinationWebhook') {
    const headers: Record<string, string> = Object.fromEntries(d.headers.filter((h) => h.name).map((h) => [h.name, h.value]));
    const url = new URL(d.url);
    if (d.method === 'GET') {
      url.searchParams.set('eventName', e.eventName);
      url.searchParams.set('payload', JSON.stringify(e.payload));
    }
    const res = await fetch(url, { method: d.method, headers: { 'content-type': 'application/json', ...headers }, body: d.method === 'GET' ? undefined : JSON.stringify(e), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return;
  }
  if (d.type === '$$MessageEventBusDestinationSyslog') {
    const line = syslogMessage(d, e);
    if (d.protocol === 'tcp') {
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: d.host, port: d.port }, () => socket.end(`${line}\n`, () => resolve()));
        socket.setTimeout(10_000, () => socket.destroy(new Error('syslog timeout')));
        socket.on('error', reject);
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        const socket = createSocket(d.host.includes(':') ? 'udp6' : 'udp4');
        socket.send(Buffer.from(line), d.port, d.host, (err) => {
          socket.close();
          if (err) reject(err);
          else resolve();
        });
      });
    }
    return;
  }
  const s = sentryEndpoint(d.dsn);
  const eventId = randomUUID().replace(/-/g, '');
  const level = /failed|crashed|error/.test(e.eventName) ? 'error' : 'info';
  const event = { event_id: eventId, timestamp: e.ts, platform: 'node', level, logger: '8n8', message: { formatted: e.eventName }, tags: { eventName: e.eventName }, extra: e.payload, server_name: os.hostname() };
  const body = [JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: s.dsn }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n');
  const res = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': s.auth }, body, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Sentry HTTP ${res.status}`);
}

/** Forwards bus events to the configured destinations (stored in settings), one queue per destination. */
export class LogStreamingService {
  private queues = new Map<string, Promise<void>>();
  /** Last delivery error per destination, shown in the editor */
  readonly errors = new Map<string, { at: string; message: string }>();

  constructor(private readonly database: Database) {}

  attach(bus: EventBus) {
    return bus.on((e) => {
      for (const d of this.list()) if (d.enabled && eventMatches(e.eventName, d.subscribedEvents)) this.enqueue(d, e);
    });
  }

  list(): Destination[] {
    return this.database.getSetting<Destination[]>(KEY, []);
  }

  save(d: Partial<Destination> & { type: Destination['type'] }): Destination {
    const all = this.list();
    const defaults = { id: randomUUID(), label: 'Destination', enabled: true, subscribedEvents: ['n8n.workflow'] };
    const typeDefaults =
      d.type === '$$MessageEventBusDestinationWebhook'
        ? { url: '', method: 'POST', headers: [] }
        : d.type === '$$MessageEventBusDestinationSyslog'
          ? { host: '127.0.0.1', port: 514, protocol: 'udp', facility: 16, app_name: '8n8' }
          : { dsn: '' };
    const existing = d.id ? all.find((x) => x.id === d.id) : undefined;
    const merged = { ...defaults, ...typeDefaults, ...existing, ...d } as Destination;
    this.validate(merged);
    this.database.setSetting(KEY, existing ? all.map((x) => (x.id === merged.id ? merged : x)) : [...all, merged]);
    return merged;
  }

  delete(id: string) {
    this.database.setSetting(KEY, this.list().filter((d) => d.id !== id));
    this.errors.delete(id);
  }

  private validate(d: Destination) {
    if (d.type === '$$MessageEventBusDestinationWebhook') new URL(d.url);
    if (d.type === '$$MessageEventBusDestinationSentry') sentryEndpoint(d.dsn);
    if (d.type === '$$MessageEventBusDestinationSyslog' && !(d.port > 0)) throw new Error('Invalid syslog port');
  }

  /** Sends a test event right away and reports whether it arrived. */
  async test(id: string) {
    const d = this.list().find((x) => x.id === id);
    if (!d) return false;
    try {
      await sendTo(d, { __type: '$$EventMessageAudit', id: randomUUID(), ts: new Date().toISOString(), eventName: 'n8n.destination.test', message: 'n8n.destination.test', payload: { msg: 'Test message from 8n8' } });
      this.errors.delete(id);
      return true;
    } catch (e) {
      this.errors.set(id, { at: new Date().toISOString(), message: (e as Error).message });
      return false;
    }
  }

  private enqueue(d: Destination, e: BusEvent) {
    const prev = this.queues.get(d.id) ?? Promise.resolve();
    const next = prev
      .then(() => sendTo(d, e))
      .then(
        () => void this.errors.delete(d.id),
        (err: Error) => void this.errors.set(d.id, { at: new Date().toISOString(), message: err.message }),
      );
    this.queues.set(d.id, next);
    void next.finally(() => this.queues.get(d.id) === next && this.queues.delete(d.id));
  }

  /** Waits for queued deliveries (tests and shutdown). */
  async flush() {
    await Promise.all(this.queues.values());
  }
}
