# Flowmator

Workflow automation with n8n's editor, nodes and behaviour, for personal use. Workflows exported from n8n import as they are.

## Install with Docker

Build the image and start it with Docker Compose. Run these commands from this folder:

```bash
docker compose up -d
```

Open http://localhost:5678. Your workflows, credentials and executions are kept in the `flowmator_data` volume, so they survive restarts and upgrades.

To upgrade after pulling new code:

```bash
docker compose up -d --build
```

### Settings

Settings use the same environment variables as n8n. Put them in a `.env` file next to `docker-compose.yml`:

| Variable | Default | What it does |
| --- | --- | --- |
| `WEBHOOK_URL` | `http://localhost:5678/` | Public address, used for webhook and OAuth callback URLs |
| `FLOWMATOR_PORT` | `5678` | Port on your machine |
| `GENERIC_TIMEZONE` | `Europe/Madrid` | Time zone for schedules and dates |
| `N8N_BASIC_AUTH_USER`, `N8N_BASIC_AUTH_PASSWORD` | empty | Ask for a user and password before opening the editor |
| `N8N_ENCRYPTION_KEY` | generated | Key that encrypts credentials. It is generated on first start and stored in the volume. |

To back up the encryption key, use this command:

```bash
docker compose exec flowmator cat /home/node/.flowmator/config.json
```

### Without Compose

```bash
docker build -t flowmator .
docker run -d --name flowmator -p 5678:5678 -v flowmator_data:/home/node/.flowmator flowmator
```

### Queue mode (workers)

Queue mode runs Redis, the main process and workers that execute the workflows:

```bash
docker compose -f docker-compose.queue.yml up -d --scale flowmator-worker=2
```

### Command line

The image's command is the `flowmator` CLI. These are the same commands n8n has:

```bash
docker compose exec flowmator flowmator export:workflow --all --output=/home/node/.flowmator/backup.json
docker compose exec flowmator flowmator import:workflow --input=/home/node/.flowmator/backup.json
docker compose exec flowmator flowmator --help
```

## Development

You need Node 22 or later and pnpm 9.

```bash
pnpm install
pnpm build        # editor bundle
pnpm start        # server on http://localhost:5678 (data in ~/.flowmator)
pnpm dev          # server and editor with live reload
pnpm test
```

`PLAN.md` lists what is implemented.

Flowmator was called 8n8. If you used 8n8 before, your data and workflows still work:
- Workflows that use `8n8.*` node types are renamed when the server starts.
- If `~/.flowmator` does not exist, the server keeps using the `~/.8n8` folder.
