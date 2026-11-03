# Queue mode (workers)

By default Flowmator runs everything in one process. In queue mode the main process hands executions to separate **worker** processes through a queue in Redis, so several executions can run in parallel on several processes.

Use it when one process is not enough: many webhooks arriving at once, long or heavy workflows, or workflows that should not slow the editor down. For personal use, the default mode is simpler and enough.

## How it works

| Process | Command | What it does |
| --- | --- | --- |
| Main | `flowmator start` | Editor, REST API, public API, triggers, schedules and webhooks. It puts executions in the queue. |
| Worker | `flowmator worker` | Takes executions from the queue and runs them. Start as many as you need. |
| Webhook (optional) | `flowmator webhook` | Receives production webhooks, forms and the URLs of waiting executions, and queues the executions. It takes that load off the main process. |
| Redis | | Holds the queue and passes messages between processes. |

- Workflow triggers and schedules stay on the main process. Only the running of the workflow goes to a worker.
- Executions started from the editor run on the main process. Set `OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true` to run them on workers too.
- Live progress in the editor, Respond to Webhook, Wait nodes, stopping and retrying an execution all work across processes. Redis carries those messages.
- Each execution is tried once. If a worker crashes while running one, it is not started again by itself: retry it from the Executions view.

## What all processes share

Every process (main, workers and webhook) must use the same:

- **Data folder**: `FLOWMATOR_USER_FOLDER`, which holds `database.sqlite` and `binaryData/`. In the compose file it is the `flowmator_data` volume.
- **Encryption key**: `FLOWMATOR_ENCRYPTION_KEY`, or the `config.json` in the shared data folder. Workers cannot read credentials with a different key.
- **Redis settings**: `QUEUE_BULL_REDIS_*` and `QUEUE_BULL_PREFIX`.
- `EXECUTIONS_MODE=queue`.

The database is SQLite, which is a file. That has two consequences:

- Run every process on the **same machine**. Do not put the data folder on a network filesystem (NFS, SMB): SQLite does not work reliably on one.
- Workers do not scale across servers. Flowmator does not support Postgres or any other server database for its own data. (The Postgres node, to query your own databases from a workflow, is a separate feature.) To use more CPU you can add workers on the same machine, or raise each worker's concurrency.

## Run it with Docker Compose

```bash
docker compose -f docker-compose.queue.yml up -d --scale flowmator-worker=2
```

This starts Redis, the main process (editor and API on http://localhost:5678) and two workers. All of them share the `flowmator_data` volume. Redis data is kept in `redis_data`.

Check that it works:

```bash
docker compose -f docker-compose.queue.yml logs flowmator          # "queue mode: executions run on workers"
docker compose -f docker-compose.queue.yml logs flowmator-worker   # "Flowmator worker ready (concurrency 10, ...)"
```

Then activate a workflow with a Webhook trigger and call its production URL. The execution appears in the Executions view and runs on a worker.

Run the `flowmator` commands (export, import, `user-management:reset`...) with the same `-f docker-compose.queue.yml`:

```bash
docker compose -f docker-compose.queue.yml exec flowmator flowmator list:workflow
```

### More or fewer workers

Change the number of worker containers:

```bash
docker compose -f docker-compose.queue.yml up -d --scale flowmator-worker=4
```

Change how many executions each worker runs at the same time (default `10`) by editing the `command` of the `flowmator-worker` service in `docker-compose.queue.yml`:

```yaml
  flowmator-worker:
    command: worker --concurrency=20
```

Total parallelism is workers times concurrency.

### Stopping workers

When a worker receives SIGTERM it stops taking new executions, waits for the running ones to finish, and after `FLOWMATOR_GRACEFUL_SHUTDOWN_TIMEOUT` seconds (default `30`) aborts the rest. Docker kills a container after 10 seconds by default, so raise it if your workflows are long, in the `flowmator-worker` service of `docker-compose.queue.yml`:

```yaml
  flowmator-worker:
    stop_grace_period: 60s
```

Keep `stop_grace_period` a few seconds longer than `FLOWMATOR_GRACEFUL_SHUTDOWN_TIMEOUT`.

### Worker health check

Workers have no HTTP port by default, so the compose file only checks that the process is running. If your orchestrator needs an HTTP check, set `QUEUE_HEALTH_CHECK_ACTIVE=true` (and optionally `QUEUE_HEALTH_CHECK_PORT`, default `5678`) on the workers:

- `/healthz` answers `ok` while the process is up.
- `/healthz/readiness` also checks Redis and the database, and answers 503 if either fails.

## Webhook processes

Add them when the main process is slow to answer webhooks. The compose file has a `flowmator-webhook` service that is off by default. Start it with the `webhook` profile:

```bash
docker compose -f docker-compose.queue.yml --profile webhook up -d
```

It listens on port 5679 of your machine (`FLOWMATOR_WEBHOOK_PORT` changes it) and uses the image's `/healthz` health check. Use `--profile webhook` with the other `docker compose` commands too, or Compose will ignore it.

Then make your reverse proxy send production webhook traffic to it and everything else to the main process:

| Path | Goes to |
| --- | --- |
| `/webhook/*`, `/form/*`, `/webhook-waiting/*` | webhook process |
| everything else, including `/webhook-test/*` and `/form-test/*` | main process |

The webhook process only knows the webhooks of workflows that are active. It is told when a workflow is activated or deactivated on main.

## Redis

- The compose file starts `redis:7-alpine` with no password and does not publish its port, so only the containers can reach it. If you use your own Redis, set `QUEUE_BULL_REDIS_HOST`, `QUEUE_BULL_REDIS_PORT` and, if needed, `..._USERNAME`, `..._PASSWORD`, `..._DB` and `..._TLS=true`.
- Several Flowmator instances can share one Redis if each has a different `QUEUE_BULL_PREFIX`.
- If Redis is down when a process starts, it stops with a message that names the host and port it tried.

## Without Docker

Start Redis, then run each process with the same variables and the same data folder:

```bash
export EXECUTIONS_MODE=queue QUEUE_BULL_REDIS_HOST=localhost
pnpm start                                              # main
node packages/server/bin/flowmator.mjs worker           # worker, in another terminal
node packages/server/bin/flowmator.mjs worker --concurrency=5
```

Processes on the same machine need different ports if they listen: set `FLOWMATOR_PORT` for the main and webhook processes, and `QUEUE_HEALTH_CHECK_PORT` for workers with the health check on.

## Troubleshooting

- **The worker stops with "Workers need queue mode"**: `EXECUTIONS_MODE=queue` is not set on that process.
- **"Queue mode needs Redis at host:port"**: Redis is not reachable from that process. Check `QUEUE_BULL_REDIS_HOST` and, in Docker, that you used the service name (`redis`).
- **Executions stay "queued"**: no worker is running, or the worker uses another `QUEUE_BULL_PREFIX` or Redis database than the main process.
- **A worker cannot decrypt credentials**: it has a different encryption key. Share the data folder or set the same `FLOWMATOR_ENCRYPTION_KEY` everywhere.
- **"database is locked" errors**: too many processes writing at once, or the data folder is on a network filesystem. Lower the worker concurrency or move the data folder to a local disk.
