# Development

## Requirements

- Node 22 or later (the Docker image uses Node 24)
- pnpm 9
- For the queue mode tests, a `redis-server` binary on your `PATH`. Without it those tests are skipped.

## Setup

```bash
pnpm install
pnpm build        # builds the editor bundle into packages/editor/dist
```

## Running

| Command | What it does |
| --- | --- |
| `pnpm start` | Server on http://localhost:5678. It also serves the built editor, so run `pnpm build` first. |
| `pnpm dev` | Server with restart on changes, and the editor on http://localhost:5173 with live reload |
| `pnpm dev:server` | Only the server, with restart on changes |
| `pnpm dev:editor` | Only the editor (Vite). It proxies `/rest`, `/api`, `/webhook*` and the WebSocket to `http://localhost:5678`; set `BACKEND_URL` to point it somewhere else. |

During development open the editor at **http://localhost:5173**. Webhook URLs still use the server's address (`http://localhost:5678`).

There is no build step for the server or the shared packages: they consume each other's `src/` directly, and `tsx` runs the server.

### Data folder

Data is kept in `~/.flowmator` (database, binary data and encryption key). To work on a clean copy, or to run two instances side by side, point `FLOWMATOR_USER_FOLDER` to another folder and use another port:

```bash
FLOWMATOR_USER_FOLDER=/tmp/flowmator-dev FLOWMATOR_PORT=5679 pnpm start
```

To start over, delete the folder. All settings are listed in [Configuration](configuration.md).

### Command line

```bash
node packages/server/bin/flowmator.mjs --help
node packages/server/bin/flowmator.mjs list:workflow
```

### Queue mode locally

Start Redis, then run the main process and a worker with the same variables and data folder:

```bash
redis-server                                                        # terminal 1
EXECUTIONS_MODE=queue pnpm start                                    # terminal 2
EXECUTIONS_MODE=queue node packages/server/bin/flowmator.mjs worker # terminal 3
```

See [Queue mode](queue-mode.md) for how the processes work together.

### Docker

```bash
docker compose up -d --build                                          # one process
docker compose -f docker-compose.queue.yml up -d --build --scale flowmator-worker=2  # queue mode
```

The Dockerfile builds the editor in one stage, installs production dependencies in another, and copies the TypeScript sources into the runtime image. Rebuild the image after any code change.

## Tests and checks

```bash
pnpm test         # all tests (vitest)
pnpm typecheck    # TypeScript in every package
```

Run one file or one test while working:

```bash
pnpm exec vitest run packages/server/test/queue.test.ts
pnpm exec vitest run -t "queues production executions"
```

Run `pnpm typecheck` and `pnpm test` before opening a pull request. Tests for the Postgres node run against an in-process Postgres and need nothing installed. Tests for queue mode start a throwaway Redis, so they need `redis-server`.

## Project layout

| Package | Role |
| --- | --- |
| `packages/workflow` | Types, workflow graph helpers and expression engine, shared with the editor |
| `packages/core` | Execution engine, credential encryption, binary data |
| `packages/nodes-base` | Built-in nodes and credential types |
| `packages/server` | REST API, webhooks, scheduler, persistence (SQLite) and the `flowmator` CLI |
| `packages/editor` | React editor (Vite, React Flow) |

How a request flows through the server:

- `packages/server/src/app.ts` builds the Fastify app. Routes live in `src/routes/`: workflows, executions, credentials, users and platform features, webhooks and the public API (`/api/v1`, authenticated with the `X-FLOWMATOR-API-KEY` header).
- `src/execution-service.ts` runs executions, either in the process or, in queue mode, through `src/scaling.ts` (BullMQ and Redis).
- `src/active-workflows.ts` registers the webhooks, schedules and pollers of active workflows.
- `src/db.ts` holds the SQLite schema. The server uses Node's built-in `node:sqlite`.
- `src/commands/` has the CLI commands, and `src/cli.ts` wires them to `flowmator <command>`.

[FEATURES.md](../FEATURES.md) lists what is implemented and what is missing.

## Adding a node

Built-in nodes are in `packages/nodes-base/src/nodes/` and credential types in `packages/nodes-base/src/credentials/`. Start from an existing node of the same kind and follow its structure, and register the new node in `packages/nodes-base/src/index.ts`. Node tests live in `packages/core/test/` (for example `integrations.test.ts` for app integrations, which run against fake or in-process services instead of the real ones).
