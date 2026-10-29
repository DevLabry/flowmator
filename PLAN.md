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
Done: Manual Trigger, Form Trigger (+ Wait on form), Date & Time, Crypto, Rename Keys, Summarize, Compare Datasets, XML, HTML, Markdown, Extract from File (CSV/XLSX/PDF/JSON/HTML/text), Convert to File (CSV/XLSX/JSON/HTML/text/base64), Read/Write Files from Disk, Send Email (SMTP), Execute Command, Webhook, Schedule Trigger, Error Trigger, HTTP Request (auth, pagination, batching, files), Respond to Webhook, Execute Workflow Trigger, If, Switch, Merge, Loop Over Items, Wait, Filter, Stop and Error, No Op, Execute Workflow, Edit Fields (Set), Code, Aggregate, Split Out, Sort, Limit, Remove Duplicates, Sticky Note.

- [ ] Triggers still missing: Chat, Local File Trigger, Email (IMAP)
- [x] Flow: If, Switch, Merge, Loop Over Items, Wait, Filter, Stop and Error, No Op, Execute Workflow, Respond to Webhook
- [ ] Data still missing: ODS/RTF/iCal file formats, multi-page Form node
- [ ] Network still missing: SSH, FTP, cURL import in the editor

### Platform
- [x] REST API: workflows, executions, credentials, tags, variables, folders, API keys (data tables pending)
- [x] Activation: webhook registration, pollers, cron
- [x] Test vs production webhook URLs
- [x] Executions list, retry, stop, delete, pruning (debug-in-editor is an editor feature)
- [x] Credentials: AES-256-GCM, OAuth2 (code, PKCE, client credentials, refresh), test (OAuth1 pending)
- [x] Workflow version history and restore
- [x] Variables, tags, folders (data tables pending)
- [x] Public API with API keys (CLI pending)
- [ ] Queue mode with workers
- [ ] Source control (git), external secrets, log streaming, insights
- [ ] Community nodes from npm, node SDK
- [ ] Templates

### Editor
- [x] Canvas: add/connect/move/delete, sticky notes, minimap, undo/redo, copy/paste JSON
- [x] Node creator panel with search
- [x] Node detail view with generated parameter forms, input/output (table/JSON/schema/binary), drag-to-map
- [x] Expression editor with autocomplete and live preview
- [x] Live execution, run data per node, pin data
- [x] Executions view, workflow settings, version history, debug in editor
- [x] Credentials (incl. OAuth2 connect), variables, settings pages

### AI
- [ ] AI Agent with sub-node slots (Model, Memory, Tools, Output Parser)
- [ ] Chat models: Anthropic, OpenAI, Ollama, Gemini
- [ ] Memory, vector stores, embeddings, document loaders, text splitters
- [ ] Workflow as tool, MCP server trigger, MCP client tool
- [ ] Chat UI, evaluations
