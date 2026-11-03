# Flowmator

Workflow automation with n8n's editor, nodes and behaviour, for personal use. Workflows exported from n8n import as they are.

## Install with Docker

Build the image and start it with Docker Compose. Run these commands from this folder:

```bash
docker compose up -d
```

Open http://localhost:5678 and create the owner account. Your workflows, credentials and executions are kept in the `flowmator_data` volume, so they survive restarts and upgrades.

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

## License

Flowmator is released under the [MIT License](LICENSE).

Flowmator is an independent project. It is not affiliated with or endorsed by n8n GmbH. "n8n" is a trademark of n8n GmbH and is used here only to describe workflow compatibility.
