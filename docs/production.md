# Production

How to run Flowmator for real use: public address, https, backups, upgrades, limits and hardening. All settings are explained in [Configuration](configuration.md).

## Checklist

1. Put a reverse proxy with https in front (see below).
2. Set `WEBHOOK_URL` to the public https address, and `FLOWMATOR_SECURE_COOKIE=true`.
3. Create the owner account right after the first start. Until you do, anyone who can reach the instance can.
4. Back up the data volume and the encryption key.
5. Decide which limits and hardening settings you need (see [Hardening](#hardening)).

## Data

Everything lives in one folder, the `flowmator_data` volume in Docker (`/home/node/.flowmator`):

| Path | Content |
| --- | --- |
| `database.sqlite` | Workflows, credentials (encrypted), executions, users, settings |
| `binaryData/` | Files produced by executions |
| `config.json` | The generated encryption key, unless you set `FLOWMATOR_ENCRYPTION_KEY` |

The database is a SQLite file. That makes Flowmator simple to run and back up, but it is **one machine only**: there is no support for Postgres or another server database for Flowmator's own data, and the data folder must be on a local disk.

## HTTPS and a reverse proxy

Flowmator serves plain http. For https, put a reverse proxy (Caddy, nginx, Traefik, a cloud load balancer) in front and forward to port 5678.

- Set `WEBHOOK_URL` to the public address, with a trailing slash, for example `https://flowmator.example.com/`. Webhook URLs and OAuth callback URLs are built from it. If you use OAuth, register `https://flowmator.example.com/rest/oauth2-credential/callback` as the redirect URL in the provider.
- Set `FLOWMATOR_SECURE_COOKIE=true`. `WEBHOOK_URL` alone does not turn it on.
- The editor receives live updates over a WebSocket at `/rest/push`. The proxy must pass WebSocket upgrade headers on that path.
- Do not use long proxy timeouts to hide slow workflows: a webhook that answers when the workflow ends holds the connection open until then. Set the proxy read timeout higher than your slowest synchronous workflow, or answer immediately and finish in the background.

Example Caddyfile (Caddy handles WebSockets and certificates on its own):

```
flowmator.example.com {
    reverse_proxy localhost:5678
}
```

If the proxy is on the same machine, publish the port on localhost only, with `FLOWMATOR_LISTEN_ADDRESS` or by changing the `ports:` entry in the compose file to `"127.0.0.1:5678:5678"`.

## Users and access

The first visit asks for the owner account. See [Users and sharing](../README.md#users-and-sharing) for roles, invitations and projects.

For invitations and password resets by email, set the `FLOWMATOR_SMTP_*` variables and `FLOWMATOR_EMAIL_MODE=smtp`. Without SMTP the editor gives you links to send.

`FLOWMATOR_BASIC_AUTH_USER` and `FLOWMATOR_BASIC_AUTH_PASSWORD` add one more password in front of the editor and the `/rest` API. It does not protect webhooks, forms or `/api/v1`, which have their own authentication.

## Backups

Back up three things: the database, the binary data and the encryption key. Without the key, backed up credentials cannot be read.

**Whole volume.** Stop Flowmator first so the SQLite file is consistent, then copy the volume:

```bash
docker compose stop
docker run --rm -v flowmator_data:/data -v "$PWD":/backup debian \
  tar czf /backup/flowmator-data-$(date +%F).tgz -C /data .
docker compose start
```

In queue mode, stop everything (`docker compose -f docker-compose.queue.yml stop`) and use the same volume name.

**Workflows and credentials as JSON.** This works while Flowmator is running:

```bash
docker compose exec flowmator flowmator export:workflow --all --backup --output=/home/node/.flowmator/backups/workflows
docker compose exec flowmator flowmator export:credentials --all --backup --output=/home/node/.flowmator/backups/credentials
```

Credentials are exported encrypted. Add `--decrypted` to export them in plain text. Treat that file as a secret and delete it after use.

**Encryption key.** Keep a copy outside the server:

```bash
docker compose exec flowmator cat /home/node/.flowmator/config.json
```

To keep the key independent of the volume, set `FLOWMATOR_ENCRYPTION_KEY` yourself (keep it in a password manager) and the volume's `config.json` will not be needed.

**Restore.** Stop Flowmator, empty the volume, extract the archive into it and start again. Or start a fresh instance and use `import:workflow` and `import:credentials`. Credentials exported without `--decrypted` can only be imported by an instance with the same encryption key, so set `FLOWMATOR_ENCRYPTION_KEY` to the original key first.

## Upgrades

```bash
git pull
docker compose up -d --build
```

Take a backup first. Your data stays in the volume. In queue mode, use the same command with `-f docker-compose.queue.yml`: that rebuilds the image once and restarts the main process and the workers.

## Health and logs

- `GET /healthz` answers `{"status":"ok"}`. The image uses it as its Docker health check, so `docker ps` shows `healthy` or `unhealthy`.
- Logs go to the container output: `docker compose logs -f flowmator`.
- Insights in the editor show production executions, failure rate and time saved. Log streaming (webhook, syslog or Sentry) can send workflow, node and audit events to your own tools.

## Keeping the database small

Finished executions are deleted when they are older than `EXECUTIONS_DATA_MAX_AGE` hours (default 336, 14 days) or beyond `EXECUTIONS_DATA_PRUNE_MAX_COUNT` (default 10000). Set `EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=false` to stop saving executions started from the editor. Workflows that handle large payloads can also be set to not save execution data in their own settings.

## Hardening

Anyone who can edit workflows can run code on the server through the Code, Execute Command and file nodes. Give editor access only to people you trust, and consider these settings:

- `FLOWMATOR_DISABLE_EXECUTE_COMMAND=true` removes shell access from workflows.
- `FLOWMATOR_RESTRICT_FILE_ACCESS_TO=/home/node/files` limits where file nodes can read and write. By default they cannot touch the data folder.
- `FLOWMATOR_BLOCK_ENV_ACCESS_IN_NODE=true` hides environment variables (which may hold secrets such as the SMTP password) from workflows.
- `NODE_FUNCTION_ALLOW_BUILTIN` and `NODE_FUNCTION_ALLOW_EXTERNAL` limit the modules the Code node can load. The default allows every Node built-in module and no npm module.
- `EXECUTIONS_TIMEOUT` stops runaway executions.
- Use external secrets (Vault, AWS, Azure, GCP) if you do not want credentials stored in the database.

## Without Docker

You need Node 22 or later and pnpm 9.

```bash
pnpm install
pnpm build                                  # builds the editor
FLOWMATOR_USER_FOLDER=/var/lib/flowmator WEBHOOK_URL=https://flowmator.example.com/ pnpm start
```

The server runs its TypeScript sources directly, so there is no server build step. Run it under a process manager (systemd, pm2) so it restarts on failure, and send SIGTERM to stop it: it waits for running executions first. The Docker image also includes `git` and `ssh`, which the source control feature needs. Install them on the host if you run without Docker.
