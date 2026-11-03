# Flowmator — features

Flowmator is a self-hosted workflow automation platform for personal and small-team use.
This page lists what it does today and what is still missing.

- Workflows are imported and exported as JSON; node types with other common prefixes are mapped onto `flowmator.*` names.
- Flowmator was called 8n8 until 2026-10: `8n8.*` / `8n8-ai.*` node types and the `~/.8n8` data folder still work.

## Stack

- pnpm workspaces + Turborepo, TypeScript, Node 22+
- Packages consume each other's `src/` directly (no build step in dev); `tsx` runs the server, `vitest` runs tests
- Server: Fastify, WebSocket push, SQLite (better-sqlite3 + Drizzle), optional Postgres; BullMQ + Redis for queue mode
- Editor: React + Vite + React Flow + Zustand + Monaco

## Packages

| Package | Role |
|---|---|
| `@flowmator/workflow` | Types, workflow graph helpers, expression engine, data helpers (shared with the editor) |
| `@flowmator/core` | Execution engine, node execution context, credentials crypto, binary data |
| `@flowmator/nodes-base` | Built-in nodes and credential types |
| `@flowmator/server` | REST API, webhooks, triggers/pollers, scheduler, push, persistence, CLI |
| `@flowmator/editor` | React UI |

## Engine
- [x] Item data model (`json`, `binary`, `pairedItem`)
- [x] Graph execution, multi-input/output, depth-first order
- [x] Multi-input nodes wait for inputs; run with partial inputs when nothing else can arrive
- [x] Loops (nodes running multiple times, run index)
- [x] Expressions `={{ }}`: `$json $input $('Node') $node $now $today $vars $env $workflow $execution $itemIndex $runIndex $prevNode $jmespath DateTime`
- [x] Data transformation helper methods on strings/arrays/objects/numbers/dates (core set)
- [x] Paired item resolution (`$('Node').item`)
- [x] Node settings: retryOnFail, maxTries, waitBetweenTries, alwaysOutputData, executeOnce, onError (stop / continue / error output), disabled
- [x] Pinned data
- [x] Partial execution (destination node, reuse run data)
- [x] Serializable execution state; Wait/resume (timer + webhook)
- [x] Sub-workflows (inline JSON and by ID)
- [x] Error workflows
- [x] Lifecycle hooks for live progress
- [x] Binary data (memory/filesystem)
- [x] Code node (JS in node:vm; Python via python3 subprocess, untested)

## Core nodes
- [x] Triggers: Manual, Webhook, Schedule, Form (+ Wait on form), Email (IMAP: IDLE, custom search rules, simple/resolved/raw, attachments), Local File, Error, Execute Workflow, Chat (in AI)
- [x] Flow: If, Switch, Merge, Loop Over Items, Wait, Filter, Stop and Error, No Op, Execute Workflow, Respond to Webhook
- [x] Data: Edit Fields (Set), Code, Aggregate, Split Out, Sort, Limit, Remove Duplicates, Rename Keys, Summarize, Compare Datasets, Date & Time, Crypto, XML, HTML, Markdown
- [x] Files: Extract from File (CSV/XLSX/XLS/ODS/RTF/PDF/JSON/HTML/iCal/text), Convert to File (CSV/XLSX/XLS/ODS/RTF/JSON/HTML/iCal/text/base64), Read/Write Files from Disk
- [x] Forms: multi-page Form node (next pages and an ending with text, redirect or custom HTML)
- [x] Network: HTTP Request (auth, pagination, batching, files, cURL import), SSH (commands, upload/download), FTP/SFTP (list, upload, download, rename, delete), Send Email (SMTP), Execute Command
- [x] Sticky Note

## App integrations
- [x] Slack (messages, channels, users, reactions; token or OAuth2) + Slack Trigger (Events API: signing secret, URL challenge, retries skipped, event/channel/bot filters)
- [x] Telegram + Telegram Trigger (webhook registered with Telegram, secret token checked)
- [x] GitHub + GitHub Trigger (repo webhook created on activation, HMAC signature checked)
- [x] Notion (database pages, pages, databases, blocks)
- [x] Gmail + Gmail Trigger (polling); Google Sheets (OAuth2 or service account)
- [x] Google Drive + Drive Trigger (upload, download with Docs export, copy, move, share, delete, search; polling for new/changed files)
- [x] Google Calendar + Calendar Trigger (events with Meet links, all-day, recurrence; availability; created/updated/cancelled/started/ended)
- [x] Postgres (SQL with parameters, insert/upsert/update/select/delete, transactions)
- [x] MySQL / MariaDB (same operations as Postgres; ON DUPLICATE KEY upsert, INSERT IGNORE)
- [x] MongoDB (find, aggregate, insert, update, find and update/replace, delete), Redis + Redis Trigger (pub/sub, patterns)
- [x] Discord (bot: messages with embeds/files, channels, member roles; webhook posting)
- [x] Airtable (records: create, upsert on fields, update by id or field, search with formulas; bases and schemas)
- [x] OpenAI (message a model with JSON output, moderation, image generation and analysis, speech, transcription and translation)
- [x] AWS S3 and S3-compatible storage (MinIO, R2…): buckets, files, folders; SigV4 signing, region redirects
- [x] Stripe + Stripe Trigger (signed webhook endpoints), HubSpot (CRM v3 objects, search, engagements, lists), Jira Software + Jira Trigger (Cloud ADF and Server), Trello + Trello Trigger
- [x] Microsoft Outlook + Outlook Trigger (polling), Microsoft Teams (channels, messages, Planner tasks), Microsoft OneDrive (Graph; upload sessions for big files)
- [ ] Still missing: Microsoft tenant-specific sign-in (uses "common"), Teams/OneDrive triggers, more integrations

## Platform
- [x] REST API: workflows, executions, credentials, tags, variables, folders, API keys, data tables
- [x] Activation: webhook registration, pollers, cron
- [x] Test vs production webhook URLs
- [x] Executions list, retry, stop, delete, pruning
- [x] Credentials: AES-256-GCM, OAuth2 (code, PKCE, client credentials, refresh), test (OAuth1 pending)
- [x] Workflow version history and restore
- [x] Variables, tags, folders
- [x] Data tables: typed columns (string, number, boolean, date) stored in SQLite; Data Table node (insert, get, update, upsert, delete, if row exists / does not exist, dry run; create, list, rename, delete tables); editor page with inline editing, sorting, search, CSV import and export; public API `/api/v1/data-tables`
- [x] Public API with per-user API keys
- [x] Users and sharing: owner setup, sign-in, invitations (SMTP or copyable links), password reset, global roles (owner, admin, member), personal and team projects (admin, editor, viewer), sharing and moving workflows and credentials, `user-management:reset`
- [x] Queue mode (EXECUTIONS_MODE=queue): BullMQ/Redis, `flowmator worker` (concurrency, health check, graceful shutdown), `flowmator webhook` processes; editor events, Respond to Webhook, waits, stop and retry relayed through Redis; manual runs stay on main unless OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true
- [x] Docker image (`Dockerfile`, `docker-compose.yml`, `docker-compose.queue.yml` with Redis and workers): data in a `/home/node/.flowmator` volume, `start`/`worker`/`webhook` commands
- [x] CLI (`flowmator`): start, worker, webhook, execute, import/export workflows and credentials (--decrypted, --backup), list/update workflows
- [x] Source control (git push/pull of workflows, credential and variable stubs, tags, folders; SSH deploy key or HTTPS; conflicts, read-only branch)
- [x] External secrets (Vault, AWS, Azure, GCP → `$secrets`)
- [x] Log streaming (webhook, syslog, Sentry; workflow/node/audit events)
- [x] Insights (production executions, time saved, failure rate)
- [x] Community nodes from npm (loaded through a compatibility shim; legacy `request` helpers)
- [x] Templates (template library at `FLOWMATOR_TEMPLATES_HOST`, import as workflow)

## Editor
- [x] Canvas: add/connect/move/delete, sticky notes, minimap, undo/redo, copy/paste JSON
- [x] Node creator panel with search
- [x] Node detail view with generated parameter forms, input/output (table/JSON/schema/binary), drag-to-map
- [x] Resource locator "From list" search and resource mapper (column mapping loaded from the node)
- [x] Expression editor with autocomplete and live preview
- [x] Live execution, run data per node, pin data
- [x] Executions view, workflow settings, version history, debug in editor
- [x] Credentials (incl. OAuth2 connect), variables, settings pages
- [x] Sign-in pages, users page, project pages, share and move dialogs, read-only mode

## AI
- [x] AI Agent with sub-node slots (Model, Memory, Tools, Output Parser), tool loop, iteration limit
- [x] Chat models: Anthropic (official SDK, refusal fallback, effort), OpenAI-compatible, Ollama, Google Gemini (function calling, thought signatures kept), Mistral, Groq, DeepSeek, OpenRouter, xAI Grok, Azure OpenAI (deployments, api-key), AWS Bedrock (Converse API with SigV4 signing, tool use, on-demand models or inference profiles), Cohere (compatibility API), Hugging Face (Inference Providers router), Google Vertex AI (Gemini with a service account)
- [x] Memory: Simple, Postgres Chat Memory, Redis Chat Memory (LangChain storage layout)
- [x] RAG: embeddings (OpenAI, Ollama, Gemini, Cohere, Hugging Face, Vertex AI), Default Data Loader (JSON, text, CSV, JSON files, PDF per page, metadata), text splitters (recursive with code modes, character, token)
- [x] Vector stores (get many, insert, retrieve for chains, retrieve as agent tool) with metadata filters: Simple (in memory), Postgres PGVector, Qdrant, Pinecone, Supabase (PostgREST + match function), MongoDB Atlas ($vectorSearch), Weaviate (nearVector GraphQL), Milvus/Zilliz (REST v2, LangChain fields), Redis (Query Engine KNN, LangChain hash layout)
- [x] Vector Store Retriever, Question and Answer Chain, Basic LLM Chain, Answer Questions with a Vector Store tool
- [x] Information Extractor (attributes, JSON example or schema; retries on invalid output), Text Classifier (one output per category, multi-class, fallback), Sentiment Analysis (custom categories, strength/confidence), Summarization Chain (map-reduce, stuff, refine; node input or document loader; simple or connected splitter)
- [x] Tools: Workflow, HTTP Request, Code, Calculator, Think, Wikipedia, SerpApi (Google Search), MCP Client Tool (Streamable HTTP and SSE, auth, include/exclude tools)
- [x] MCP Server Trigger: serves its connected tools over stateless Streamable HTTP (JSON responses), bearer/header auth
- [x] Sub-node connections (database pools, MCP clients) are closed when the root node finishes
- [x] Chat trigger with hosted page and editor chat panel
- [x] Evaluations: Evaluation Trigger (dataset from a data table or Google Sheets), Evaluation node (outputs written back to the row; metrics: correctness and helpfulness judged by a model, string similarity, categorization, tools used, custom), test runs per row in "evaluation" mode with averaged metrics, Evaluations tab in the editor (runs, metric trends, per-case results linked to executions, cancel/delete)
