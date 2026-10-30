# 8n8 — build plan

Personal-use workflow automation platform with n8n-equivalent functionality.
All code is written from scratch (n8n's source is under the Sustainable Use License, so nothing is copied).
Workflows exported from n8n can be imported: `n8n-nodes-base.*` node types are aliased to `8n8.*`.

## Stack

- pnpm workspaces + Turborepo, TypeScript, Node 22+
- Packages consume each other's `src/` directly (no build step in dev); `tsx` runs the server, `vitest` runs tests
- Server: Fastify, WebSocket push, SQLite (better-sqlite3 + Drizzle), optional Postgres; BullMQ + Redis for queue mode
- Editor: React + Vite + React Flow + Zustand + Monaco

## Packages

| Package | Role |
|---|---|
| `@8n8/workflow` | Types, workflow graph helpers, expression engine, data helpers (shared with the editor) |
| `@8n8/core` | Execution engine, node execution context, credentials crypto, binary data |
| `@8n8/nodes-base` | Built-in nodes and credential types |
| `@8n8/server` | REST API, webhooks, triggers/pollers, scheduler, push, persistence, CLI |
| `@8n8/editor` | React UI |

## Feature checklist

### Engine
- [x] Item data model (`json`, `binary`, `pairedItem`)
- [x] Graph execution, multi-input/output, depth-first (v1) order
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

### Core nodes
Done: Manual Trigger, Form Trigger (+ Wait on form), Form (multi-page forms: next pages and an ending with text, redirect or custom HTML), Email Trigger (IMAP: IDLE, custom search rules, simple/resolved/raw, attachments), Local File Trigger, SSH (commands, upload/download), FTP/SFTP (list, upload, download, rename, delete), Date & Time, Crypto, Rename Keys, Summarize, Compare Datasets, XML, HTML, Markdown, Extract from File (CSV/XLSX/XLS/ODS/RTF/PDF/JSON/HTML/iCal/text), Convert to File (CSV/XLSX/XLS/ODS/RTF/JSON/HTML/iCal/text/base64), Read/Write Files from Disk, Send Email (SMTP), Execute Command, Webhook, Schedule Trigger, Error Trigger, HTTP Request (auth, pagination, batching, files), Respond to Webhook, Execute Workflow Trigger, If, Switch, Merge, Loop Over Items, Wait, Filter, Stop and Error, No Op, Execute Workflow, Edit Fields (Set), Code, Aggregate, Split Out, Sort, Limit, Remove Duplicates, Sticky Note.

- [x] Triggers: Email (IMAP), Local File Trigger, Chat (in AI)
- [x] Flow: If, Switch, Merge, Loop Over Items, Wait, Filter, Stop and Error, No Op, Execute Workflow, Respond to Webhook
- [x] Data: ODS/XLS/RTF (SheetJS) and iCal file formats, multi-page Form node
- [x] Network: SSH, FTP/SFTP, cURL import in the HTTP Request node

### App integrations
- [x] Slack (messages, channels, users, reactions; token or OAuth2)
- [x] Telegram + Telegram Trigger (webhook registered with Telegram, secret token checked)
- [x] GitHub + GitHub Trigger (repo webhook created on activation, HMAC signature checked)
- [x] Notion (database pages, pages, databases, blocks)
- [x] Gmail + Gmail Trigger (polling); Google Sheets (OAuth2 or service account)
- [x] Postgres (SQL with parameters, insert/upsert/update/select/delete, transactions)
- [x] Slack Trigger (Events API: signing secret, URL challenge, retries skipped, event/channel/bot filters)
- [x] Discord (bot: messages with embeds/files, channels, member roles; webhook posting)
- [x] Airtable (records: create, upsert on fields, update by id or field, search with formulas; bases and schemas)
- [x] Google Drive + Drive Trigger (upload, download with Docs export, copy, move, share, delete, search; polling for new/changed files)
- [x] Google Calendar + Calendar Trigger (events with Meet links, all-day, recurrence; availability; created/updated/cancelled/started/ended)
- [x] MySQL / MariaDB (same operations as Postgres; ON DUPLICATE KEY upsert, INSERT IGNORE)
- [x] OpenAI (message a model with JSON output, moderation, image generation and analysis, speech, transcription and translation)
- [ ] Still missing: HubSpot, Stripe, MongoDB, Redis, S3, Microsoft (Outlook, Teams, OneDrive), Jira, Trello, …

### Platform
- [x] REST API: workflows, executions, credentials, tags, variables, folders, API keys, data tables
- [x] Activation: webhook registration, pollers, cron
- [x] Test vs production webhook URLs
- [x] Executions list, retry, stop, delete, pruning (debug-in-editor is an editor feature)
- [x] Credentials: AES-256-GCM, OAuth2 (code, PKCE, client credentials, refresh), test (OAuth1 pending)
- [x] Workflow version history and restore
- [x] Variables, tags, folders
- [x] Data tables: typed columns (string, number, boolean, date) stored in SQLite; Data Table node (insert, get, update, upsert, delete, if row exists / does not exist, dry run; create, list, rename, delete tables); editor page with inline editing, sorting, search, CSV import and export; public API `/api/v1/data-tables`
- [x] Public API with API keys
- [x] Queue mode (EXECUTIONS_MODE=queue): BullMQ/Redis, `8n8 worker` (concurrency, health check, graceful shutdown), `8n8 webhook` processes; editor events, Respond to Webhook, waits, stop and retry relayed through Redis; manual runs stay on main unless OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true
- [x] CLI (`bin/8n8.mjs`): start, worker, webhook, execute, import/export workflows and credentials (n8n exports work, --decrypted, --backup), list/update workflows
- [ ] Source control (git), external secrets, log streaming, insights
- [ ] Community nodes from npm, node SDK
- [ ] Templates

### Editor
- [x] Canvas: add/connect/move/delete, sticky notes, minimap, undo/redo, copy/paste JSON
- [x] Node creator panel with search
- [x] Node detail view with generated parameter forms, input/output (table/JSON/schema/binary), drag-to-map
- [x] Resource locator "From list" search and resource mapper (column mapping loaded from the node)
- [x] Expression editor with autocomplete and live preview
- [x] Live execution, run data per node, pin data
- [x] Executions view, workflow settings, version history, debug in editor
- [x] Credentials (incl. OAuth2 connect), variables, settings pages

### AI
- [x] AI Agent with sub-node slots (Model, Memory, Tools, Output Parser), tool loop, iteration limit
- [x] Chat models: Anthropic (official SDK, refusal fallback, effort), OpenAI-compatible, Ollama, Google Gemini (function calling, thought signatures kept), Mistral, Groq, DeepSeek, OpenRouter, xAI Grok, Azure OpenAI (deployments, api-key), AWS Bedrock (Converse API with SigV4 signing, tool use, on-demand models or inference profiles)
- [x] Memory: Simple, Postgres Chat Memory, Redis Chat Memory (LangChain/n8n storage layout, so existing tables and keys work)
- [x] RAG: embeddings (OpenAI, Ollama, Gemini), Default Data Loader (JSON, text, CSV, JSON files, PDF per page, metadata), text splitters (recursive with code modes, character, token)
- [x] Vector stores with n8n's modes (get many, insert, retrieve for chains, retrieve as agent tool) and metadata filters: Simple (in memory), Postgres PGVector, Qdrant, Pinecone, Supabase (PostgREST + match function), MongoDB Atlas ($vectorSearch)
- [x] Vector Store Retriever, Question and Answer Chain, Basic LLM Chain, Answer Questions with a Vector Store tool
- [x] Information Extractor (attributes, JSON example or schema; retries on invalid output), Text Classifier (one output per category, multi-class, fallback), Sentiment Analysis (custom categories, strength/confidence), Summarization Chain (map-reduce, stuff, refine; node input or document loader; simple or connected splitter)
- [x] Tools: Workflow, HTTP Request, Code, Calculator, Think, Wikipedia, SerpApi (Google Search), MCP Client Tool (Streamable HTTP and SSE, auth, include/exclude tools)
- [x] MCP Server Trigger: serves its connected tools over stateless Streamable HTTP (JSON responses), bearer/header auth
- [x] Sub-node connections (database pools, MCP clients) are closed when the root node finishes
- [x] Chat trigger with hosted page and editor chat panel
- [x] Evaluations: Evaluation Trigger (dataset from a data table, limit and filter rows), Evaluation node (set outputs back to the row, metrics: correctness and helpfulness judged by a model, string similarity, categorization, tools used, custom; check if evaluating), test runs that execute the workflow per row in "evaluation" mode and average the metrics, Evaluations tab in the editor (runs, metric trends, per-case results linked to executions, cancel/delete)
- [ ] Still missing: Weaviate, Milvus, Redis and other vector stores; Cohere/Hugging Face/Vertex chat models; Google Sheets as an evaluation dataset
