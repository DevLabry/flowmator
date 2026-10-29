import { Job, Queue, QueueEvents, Worker, type RedisOptions as QueueConnection } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';
import type { ExecutionStatus, INodeExecutionData, IRun, IWebhookResponse } from '@8n8/workflow';
import type { ServerConfig } from './config';
import type { QueuedRunRequest } from './execution-service';
import type { PushEvent } from './push';

/** Same queue name n8n uses, so a Redis instance can be inspected the same way. */
export const QUEUE_NAME = 'jobs';

/** What a worker is asked to do. Workflow data is read from the execution row, so jobs stay small. */
export type ExecutionJob =
  | { kind: 'run'; executionId: string; request: QueuedRunRequest }
  | { kind: 'resume'; executionId: string; resumeData?: INodeExecutionData[] }
  | { kind: 'retry'; executionId: string; retryOf: string };

export interface JobResult {
  executionId: string;
  status: ExecutionStatus;
  waitTill?: string | null;
}

/** Messages between main, webhook and worker processes (Redis pub/sub). */
export type ScalingMessage =
  /** worker → main: live editor events */
  | { type: 'push'; event: PushEvent; pushRef?: string }
  /** worker → waiting HTTP request: Respond to Webhook output */
  | { type: 'respond'; executionId: string; response: IWebhookResponse }
  /** worker → everyone: an execution ended. `data` is included when the execution was not saved. */
  | { type: 'finished'; executionId: string; result: JobResult; data?: IRun['data'] }
  /** main → workers: abort a running execution */
  | { type: 'stop'; executionId: string }
  /** main → webhook processes: a workflow's production webhooks changed */
  | { type: 'workflowChanged'; workflowId: string; active: boolean };

/** JSON with Buffers kept intact (webhook responses can carry binary bodies). */
export function encodeMessage(message: unknown): string {
  return JSON.stringify(message, function (key, value) {
    const raw = (this as Record<string, unknown>)[key];
    return Buffer.isBuffer(raw) ? { __buffer: raw.toString('base64') } : value;
  });
}

export function decodeMessage<T>(raw: string): T {
  return JSON.parse(raw, (_key, value) => (value && typeof value === 'object' && typeof value.__buffer === 'string' ? Buffer.from(value.__buffer, 'base64') : value));
}

export class ScalingService {
  readonly queue: Queue<ExecutionJob, JobResult>;
  private readonly channel: string;
  private readonly pub: Redis;
  private sub?: Redis;
  private readonly handlers = new Set<(message: ScalingMessage) => void>();
  private worker?: Worker<ExecutionJob, JobResult>;
  private queueEvents?: QueueEvents;

  constructor(private readonly config: ServerConfig) {
    this.queue = new Queue(QUEUE_NAME, {
      connection: this.connection(),
      prefix: config.queue.prefix,
      defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 3600 } },
    });
    this.queue.on('error', (e) => console.error(`Queue error: ${e.message}`));
    this.channel = `${config.queue.prefix}:8n8-events`;
    this.pub = new Redis(this.connection());
    this.pub.on('error', (e) => console.error(`Redis error: ${e.message}`));
  }

  connection(): QueueConnection & RedisOptions {
    const r = this.config.queue.redis;
    return { host: r.host, port: r.port, db: r.db, username: r.username, password: r.password, tls: r.tls ? {} : undefined, maxRetriesPerRequest: null };
  }

  /** Fails fast with a readable message when Redis is unreachable. */
  async ping() {
    const r = this.config.queue.redis;
    try {
      await Promise.race([this.pub.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 5000))]);
    } catch (e) {
      throw new Error(`Queue mode needs Redis at ${r.host}:${r.port} (QUEUE_BULL_REDIS_HOST / QUEUE_BULL_REDIS_PORT): ${(e as Error).message}`);
    }
  }

  async subscribe(handler: (message: ScalingMessage) => void) {
    this.handlers.add(handler);
    if (this.sub) return;
    this.sub = this.pub.duplicate();
    this.sub.on('error', (e) => console.error(`Redis error: ${e.message}`));
    this.sub.on('message', (_channel, raw) => {
      const message = decodeMessage<ScalingMessage>(raw);
      for (const h of this.handlers) {
        try {
          h(message);
        } catch (e) {
          console.error(`Handling ${message.type} failed:`, e);
        }
      }
    });
    await this.sub.subscribe(this.channel);
  }

  async publish(message: ScalingMessage) {
    await this.pub.publish(this.channel, encodeMessage(message));
  }

  async enqueue(job: ExecutionJob, priority?: number) {
    return this.queue.add(job.kind, job, priority ? { priority } : undefined);
  }

  /** A job that no worker has picked up yet. */
  async findPendingJob(executionId: string) {
    const jobs = await this.queue.getJobs(['waiting', 'prioritized', 'delayed']);
    return jobs.find((j) => j?.data.executionId === executionId);
  }

  /** Executions that are queued or being run by a worker right now. */
  async queuedExecutionIds() {
    const jobs = await this.queue.getJobs(['active', 'waiting', 'prioritized', 'delayed']);
    return jobs.filter(Boolean).map((j) => j.data.executionId);
  }

  async counts() {
    return this.queue.getJobCounts('active', 'waiting', 'prioritized', 'delayed', 'completed', 'failed');
  }

  /** Worker side: pull jobs and run them, `concurrency` at a time. */
  startWorker(concurrency: number, processor: (job: ExecutionJob) => Promise<JobResult>) {
    this.worker = new Worker<ExecutionJob, JobResult>(QUEUE_NAME, (job) => processor(job.data), {
      connection: this.connection(),
      prefix: this.config.queue.prefix,
      concurrency,
    });
    this.worker.on('error', (e) => console.error(`Worker error: ${e.message}`));
    return this.worker;
  }

  /**
   * Main side: jobs that failed outside the processor (a worker died mid-run and the job stalled out).
   * The processor itself never throws, so these are crashes.
   */
  async onJobCrashed(handler: (executionId: string, reason: string) => void) {
    this.queueEvents = new QueueEvents(QUEUE_NAME, { connection: this.connection(), prefix: this.config.queue.prefix });
    this.queueEvents.on('error', (e) => console.error(`Queue events error: ${e.message}`));
    this.queueEvents.on('failed', async ({ jobId, failedReason }) => {
      const job = await Job.fromId<ExecutionJob, JobResult>(this.queue, jobId).catch(() => undefined);
      if (job) handler(job.data.executionId, failedReason);
    });
    await this.queueEvents.waitUntilReady();
  }

  async close(gracefulSeconds = 0) {
    if (this.worker) {
      // let running executions finish, then give up on them
      const graceful = this.worker.close();
      const timedOut = await Promise.race([graceful.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), gracefulSeconds * 1000))]);
      if (timedOut) await this.worker.close(true);
    }
    // messages still buffered on the subscriber must not reach a process that is shutting down
    this.handlers.clear();
    await this.queueEvents?.close();
    await this.queue.close();
    this.sub?.disconnect();
    this.pub.disconnect();
  }
}
