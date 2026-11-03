# Flowmator

Flowmator is a self-hosted workflow automation platform for personal use. You build workflows on a visual canvas, connect apps and APIs, and run them on triggers, schedules or webhooks. It is written from scratch and can import workflow files exported from other tools in the same JSON format.

## Features

- **Visual editor**: canvas, node creator, expression editor with autocomplete, live execution, pinned data, execution history and version history.
- **Interoperable**: imports workflow JSON files in a widely used format, including their node types and `={{ }}` expressions, and can load compatible community node packages from npm.
- **Many integrations**: HTTP Request, Webhook, Schedule, Code (JavaScript and Python), Slack, Telegram, GitHub, Notion, Google (Gmail, Sheets, Drive, Calendar), Postgres, MySQL, MongoDB, Redis, S3, Stripe, HubSpot, Jira, Trello, Microsoft (Outlook, Teams, OneDrive), Discord, Airtable, OpenAI and more.
- **AI**: AI Agent with tools, memory and output parsers; chat models (Anthropic, OpenAI, Gemini, Ollama, Mistral, Groq, Bedrock…), embeddings, vector stores for RAG, MCP client and server, and evaluations.
- **Platform**: users, roles and team projects, credential encryption, OAuth2, public REST API with API keys, queue mode with workers, source control, external secrets, log streaming and a data tables feature.

See [PLAN.md](PLAN.md) for the full list of what is implemented and what is still missing.

## Requirements

- **Docker** with Docker Compose (to run it), or
- **Node 22 or later** and **pnpm 9** (to run it from source, see [Development](#development)).

## Quick start

```bash
git clone https://github.com/DevLabry/flowmator.git
cd flowmator
docker compose up -d
```

Open http://localhost:5678 and create the owner account.

## Install with Docker

The Quick start above builds the image and starts it with Docker Compose. Run all `docker compose` commands from the repository folder. Your workflows, credentials and executions are kept in the `flowmator_data` volume, so they survive restarts and upgrades.

To upgrade after pulling new code:

```bash
docker compose up -d --build
```

### Settings

Settings are environment variables, using the `N8N_*` names for compatibility with existing setups. Put them in a `.env` file next to `docker-compose.yml`:

| Variable | Default | What it does |
| --- | --- | --- |
| `WEBHOOK_URL` | `http://localhost:5678/` | Public address, used for webhook and OAuth callback URLs |
| `FLOWMATOR_PORT` | `5678` | Port on your machine |
| `GENERIC_TIMEZONE` | `Europe/Madrid` | Time zone for schedules and dates |
| `N8N_EMAIL_MODE`, `N8N_SMTP_HOST`, `N8N_SMTP_PORT`, `N8N_SMTP_USER`, `N8N_SMTP_PASS`, `N8N_SMTP_SENDER`, `N8N_SMTP_SSL` | empty | Email invitations and password resets. Set `N8N_EMAIL_MODE=smtp` to use them. |
| `N8N_EDITOR_BASE_URL` | `WEBHOOK_URL` | Address used in invitation and password reset links |
| `N8N_SECURE_COOKIE` | `true` on https | Send the sign-in cookie over https only |
| `N8N_ENCRYPTION_KEY` | generated | Key that encrypts credentials. It is generated on first start and stored in the volume. |

To back up the encryption key, use this command:

```bash
docker compose exec flowmator cat /home/node/.flowmator/config.json
```

### Users and sharing

The first visit asks you to create the owner account. Workflows and credentials that already exist become the owner's.

- **Roles**: the owner and admins manage users and instance settings and see everything. Members see their own work and what is shared with them.
- **Inviting people**: open Settings › Users and invite them by email. Without SMTP, copy the invitation link and send it yourself. Admins can also copy a password reset link for any user.
- **Projects**: each user has a personal project. Admins create team projects and add members as admin, editor or viewer.
- **Sharing**: share a workflow with users or projects so they can edit it. Share a credential so the workflows of a project can use it without seeing its secrets. Move either one to another project from its menu.
- **API keys** belong to the user who created them, and the public API acts with that user's permissions.

If you lose the owner's password, this command removes the other users and team projects and keeps every workflow and credential for the owner. On the next visit you create the owner account again:

```bash
docker compose exec flowmator flowmator user-management:reset
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

The image's command is the `flowmator` CLI. Common commands:

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

### Project layout

| Package | Role |
| --- | --- |
| `packages/workflow` | Types, workflow graph helpers and expression engine, shared with the editor |
| `packages/core` | Execution engine, credential encryption, binary data |
| `packages/nodes-base` | Built-in nodes and credential types |
| `packages/server` | REST API, webhooks, scheduler, persistence and the `flowmator` CLI |
| `packages/editor` | React editor (Vite, React Flow) |

`PLAN.md` lists what is implemented.

## Contributing

Issues and pull requests are welcome. Run `pnpm typecheck` and `pnpm test` before opening a pull request.

Flowmator was called 8n8. If you used 8n8 before, your data and workflows still work:
- Workflows that use `8n8.*` node types are renamed when the server starts.
- If `~/.flowmator` does not exist, the server keeps using the `~/.8n8` folder.

## License

Flowmator is released under the [MIT License](LICENSE).

Flowmator is an independent project. All its code is original and was written from scratch. It is not affiliated with, endorsed by or sponsored by n8n GmbH. "n8n" is a trademark of its owner and is mentioned only to describe compatibility with files and settings (`N8N_*` variables, `n8n-nodes-*` packages); all other product names belong to their owners.
