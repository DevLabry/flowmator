# Configuration

Flowmator is configured with environment variables. There is no settings file except `config.json` in the data folder, which only holds the generated encryption key.

## How to set them

**Docker Compose.** Compose passes into the container only the variables that `docker-compose.yml` lists under `environment:`. Those can be set from a `.env` file next to the compose file:

```
WEBHOOK_URL=https://flowmator.example.com/
GENERIC_TIMEZONE=Europe/Madrid
```

Any other variable in the tables below (for example `EXECUTIONS_TIMEOUT` or `FLOWMATOR_SECURE_COOKIE`) is ignored if it only appears in `.env`. Add it through a `docker-compose.override.yml` next to the compose file, which Compose merges automatically:

```yaml
services:
  flowmator:
    environment:
      - FLOWMATOR_SECURE_COOKIE=true
      - EXECUTIONS_TIMEOUT=3600
```

In queue mode, Compose does not load `docker-compose.override.yml` when you pass `-f docker-compose.queue.yml`. Add the variable to the `environment:` list of the `x-shared` block in `docker-compose.queue.yml` instead, so that the main process and every worker get it.

**Without Docker.** Export the variables before starting the process, for example `FLOWMATOR_PORT=8080 pnpm start`.

## Server and data

| Variable | Default | What it does |
| --- | --- | --- |
| `FLOWMATOR_USER_FOLDER` | `~/.flowmator` (`/home/node/.flowmator` in Docker) | Data folder: `database.sqlite`, `binaryData/` and `config.json` |
| `FLOWMATOR_PORT` | `5678` | Port the process listens on. In Docker Compose it is also the port published on your machine. |
| `FLOWMATOR_HOST` | `localhost` | Host name used to build the default `WEBHOOK_URL`. It is not the address the server binds to. |
| `FLOWMATOR_LISTEN_ADDRESS` | `0.0.0.0` | Address the server binds to |
| `FLOWMATOR_PROTOCOL` | `http` | Only used to build the default `WEBHOOK_URL` and to decide the default of `FLOWMATOR_SECURE_COOKIE`. Flowmator never serves https itself, see [Production](production.md#https-and-a-reverse-proxy). |
| `WEBHOOK_URL` | `<protocol>://<host>:<port>/` | Public address of the instance. Used for webhook URLs and OAuth callback URLs. |
| `FLOWMATOR_EDITOR_BASE_URL` | `WEBHOOK_URL` | Address used in invitation and password reset links |
| `FLOWMATOR_SECURE_COOKIE` | `true` if `FLOWMATOR_PROTOCOL=https`, else `false` | Send the sign-in cookie over https only. Set it to `true` when a proxy serves your instance over https. |
| `GENERIC_TIMEZONE` | the system time zone (`Europe/Madrid` in the compose files) | Time zone for schedules and dates |
| `FLOWMATOR_ENDPOINT_WEBHOOK` | `webhook` | Path of production webhooks |
| `FLOWMATOR_ENDPOINT_WEBHOOK_TEST` | `webhook-test` | Path of test webhooks |
| `FLOWMATOR_ENDPOINT_WEBHOOK_WAIT` | `webhook-waiting` | Path of the URLs that resume waiting executions |

## Encryption key

| Variable | Default | What it does |
| --- | --- | --- |
| `FLOWMATOR_ENCRYPTION_KEY` | generated | Key that encrypts credentials (AES-256-GCM). If it is not set, a key is generated on first start and saved in `config.json` in the data folder. |

If you lose the key, saved credentials cannot be read again. See [backups](production.md#backups).

## Executions

| Variable | Default | What it does |
| --- | --- | --- |
| `EXECUTIONS_MODE` | `regular` | `regular` runs everything in one process. `queue` sends executions to workers, see [Queue mode](queue-mode.md). |
| `EXECUTIONS_TIMEOUT` | `-1` | Seconds after which an execution is stopped. `-1` means no limit. |
| `EXECUTIONS_DATA_MAX_AGE` | `336` | Hours to keep finished executions (336 is 14 days) |
| `EXECUTIONS_DATA_PRUNE_MAX_COUNT` | `10000` | Maximum number of executions kept |
| `EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS` | `true` | Save executions started from the editor |
| `FLOWMATOR_INSIGHTS_MAX_AGE_DAYS` | `365` | Days to keep the data behind Insights |

## Queue mode

Used only when `EXECUTIONS_MODE=queue`. See [Queue mode](queue-mode.md).

| Variable | Default | What it does |
| --- | --- | --- |
| `QUEUE_BULL_REDIS_HOST` | `localhost` | Redis host |
| `QUEUE_BULL_REDIS_PORT` | `6379` | Redis port |
| `QUEUE_BULL_REDIS_DB` | `0` | Redis database number |
| `QUEUE_BULL_REDIS_USERNAME` | empty | Redis user |
| `QUEUE_BULL_REDIS_PASSWORD` | empty | Redis password |
| `QUEUE_BULL_REDIS_TLS` | `false` | Connect to Redis over TLS |
| `QUEUE_BULL_PREFIX` | `bull` | Prefix of the Redis keys and channels. Give each instance its own prefix if they share a Redis. |
| `OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS` | `false` | Run executions started from the editor on workers too |
| `QUEUE_HEALTH_CHECK_ACTIVE` | `false` | Workers: start a health check server |
| `QUEUE_HEALTH_CHECK_PORT` | `5678` | Workers: port of the health check server |
| `FLOWMATOR_GRACEFUL_SHUTDOWN_TIMEOUT` | `30` | Workers: seconds to let running executions finish when stopping |

## Email

Used for invitations and password resets. Without email, the editor shows a link that you send yourself.

| Variable | Default | What it does |
| --- | --- | --- |
| `FLOWMATOR_EMAIL_MODE` | empty | Set to `smtp` to send email |
| `FLOWMATOR_SMTP_HOST` | empty | SMTP server |
| `FLOWMATOR_SMTP_PORT` | `465` in the compose files | SMTP port |
| `FLOWMATOR_SMTP_USER` | empty | SMTP user |
| `FLOWMATOR_SMTP_PASS` | empty | SMTP password |
| `FLOWMATOR_SMTP_SENDER` | empty | Sender address |
| `FLOWMATOR_SMTP_SSL` | `true` in the compose files | Use SSL |

## Security

| Variable | Default | What it does |
| --- | --- | --- |
| `FLOWMATOR_BASIC_AUTH_USER`, `FLOWMATOR_BASIC_AUTH_PASSWORD` | empty | Ask for HTTP basic auth on the editor and the `/rest` API, in addition to the user sign-in. Webhooks, forms and the public API (`/api/v1`) are not behind it. Set both to turn it on. |
| `FLOWMATOR_DISABLE_EXECUTE_COMMAND` | `false` | Set to `true` to block the Execute Command node |
| `FLOWMATOR_RESTRICT_FILE_ACCESS_TO` | empty | Folders (separated by `;`) that the file nodes may read and write. Empty means no restriction. |
| `FLOWMATOR_BLOCK_FILE_ACCESS_TO_FLOWMATOR_FILES` | `true` | Stop the file nodes from touching the data folder. Set to `false` to allow it. |
| `FLOWMATOR_BLOCK_ENV_ACCESS_IN_NODE` | `false` | Set to `true` to hide environment variables from `$env` in expressions and nodes |

## Code node

| Variable | Default | What it does |
| --- | --- | --- |
| `NODE_FUNCTION_ALLOW_BUILTIN` | `*` | Node built-in modules the Code node may `require`, separated by commas. `*` allows all. |
| `NODE_FUNCTION_ALLOW_EXTERNAL` | empty | npm modules the Code node may `require`, separated by commas. Empty allows none. |
| `FLOWMATOR_PYTHON_BIN` | `python3` | Python executable for Python in the Code node. The Docker image does not include Python. |

## Other

| Variable | Default | What it does |
| --- | --- | --- |
| `FLOWMATOR_TEMPLATES_HOST` | empty | Address of a template library API. Templates are off until it is set. |
| `FLOWMATOR_EXTERNAL_SECRETS_UPDATE_INTERVAL` | `300` | Seconds between refreshes of external secrets |
