# Org Memory

A private Node.js MVP that turns approved Codex and Claude work histories into searchable organizational memory and an admin-only knowledge graph.

## What works

- Workspace registration, password login, secure HTTP-only sessions, and admin/member roles
- Admin invitations, including inviting a second administrator such as `second-admin@example.com`
- Direct local import from supported Claude JSONL transcripts and Codex SQLite thread stores
- A laptop connector for syncing into a remotely hosted dashboard
- Strict local privacy scanning that replaces sensitive sessions with generic placeholders before any network request
- Idempotent imports with source provenance
- Chunking and vector search, using Ollama when configured and a private local hashing embedder otherwise
- Automatic topic classification and a work graph of work area → project → session
- Searchable team context for people, roles, functions, and interests
- A private Slack `/context` command with progressive answers
- Admin-only organization graph and member management
- Strict owner isolation: users can only list, open, search, and summarize their own raw conversation history; admins cannot read another member's transcripts
- Responsive dashboard, search, conversation viewer, and interactive SVG graph

## How it works

**The problem.** Nobody knows what person XYZ is actually working on, and people on different teams end up building the same thing without realizing it.

**The flow.** Every two hours a connector on each employee laptop pulls their Claude and Codex chat history. A privacy scan runs locally first, then an LLM classifies each chat into team, project, and person, and the result is stored as nodes and edges in a knowledge graph. A dashboard and a Slack `/context` command sit on top of that graph.

```mermaid
flowchart LR
    subgraph ingest["Ingestion pipeline"]
        direction TB
        L["Employee laptops<br/>~/.claude  ~/.codex"] -- every 2 hours --> C["Connector pulls transcripts<br/>privacy scan runs locally"]
        C --> M["LLM classifies every chat<br/>team -> project -> person"]
        M --> E["Embed + store as<br/>nodes and edges"]
    end

    subgraph graph["Knowledge graph"]
        direction TB
        ORG((Org)) --> Supply((Supply))
        ORG --> Demand((Demand))
        ORG --> Product((Product))
        Supply --> P1[Lead scraping]
        Supply --> P2[Enrichment API]
        Demand --> P3[CRM automation]
        Product --> P4[Dashboard v2]
        P1 --> U1([Dhiram])
        P2 --> U2([Rohan])
        P3 --> U3([Shubh])
        P4 --> U4([Joel])
        U1 --- S1{{chats}}
        U2 --- S2{{chats}}
        U3 --- S3{{chats}}
        U4 --- S4{{chats}}
    end

    E ==> ORG
    graph --> UI["Dashboard + Slack /context<br/>who is working on lead scraping?<br/>what did Dhiram ship this week?"]
```

**The graph.** The org is the root. Each team node leads to its current running projects. Each project holds the people working on it, and each person edges out to the chats they had for that work. Walking the graph answers both what someone is working on and what they have already achieved. A person who shows up under two teams is exactly the cross-team overlap the second problem is about.

The full hand-drawn version is in [`docs/org-memory-overview.excalidraw`](./docs/org-memory-overview.excalidraw). Open it at [excalidraw.com](https://excalidraw.com) or with the Excalidraw VS Code extension.

## Project layout

Everything is TypeScript. Node runs the `.ts` server, connector, tests and scripts directly (type stripping), so there is no compile step for the backend; `tsc` is only used for type-checking. esbuild bundles the two pieces that must ship as plain JavaScript.

```
src/
  server/        HTTP server, SQLite store, importer, embeddings, answer logic, Slack
  connector/     Laptop connector that syncs local Claude/Codex history to the server
  shared/        Code and types used by both (privacy scanner, conversation types)
  web/           Browser dashboard (bundled to dist/public/app.js)
public/          Static UI assets, installer script, and docs served to users
slack-app/       Slack app manifest (+ example) and Slack CLI config
scripts/         build.ts (esbuild bundles) and the architecture diagram generator
docs/            Architecture diagrams (Excalidraw)
test/            node:test suites
dist/            Build output (gitignored)
data/            Local SQLite database (gitignored)
```

| Command | What it does |
| --- | --- |
| `npm start` | Build bundles, then run the server |
| `npm run dev` | Rebuild bundles and restart the server on change |
| `npm run typecheck` | Type-check everything with `tsc` |
| `npm test` | Run the test suites |
| `npm run build` | Bundle `dist/public/app.js` and the standalone `dist/connector.js` |
| `npm run diagram` | Regenerate `docs/org-memory-system.excalidraw` |

## Start locally

Node 22.18+ is required: the MVP uses Node's built-in SQLite module and runs TypeScript directly.

```bash
cd /Users/rohan/org-memory
npm install
npm start
```

Open <http://localhost:4310>, create the Flent workspace with `you@example.com`, then choose **Import my history**. The first workspace user is an admin.

To give the second admin graph access:

1. Open **People & access**.
2. Keep `second-admin@example.com` and **Admin — can view graph** selected.
3. Create and share the one-time invite code.
4. The second admin chooses **Use invite** on the sign-in screen.

## Sync from each employee laptop

A hosted browser cannot read `.claude` or `.codex` from an employee's computer. Each person should:

1. Sign in and open **Import my history**.
2. Generate a connector key.
3. Run the command shown by the dashboard from this project directory.

Equivalent command:

```bash
ORG_MEMORY_URL=https://memory.example.com \
ORG_MEMORY_TOKEN=om_personal_token \
npm run connector
```

The connector deliberately reads only:

- `.claude/projects/**/*.jsonl`
- `.codex/state_5.sqlite` thread metadata
- `.codex/thread_history_1.sqlite` user and assistant messages

For automatic macOS installation and hourly background sync, see [Automatic sync](public/AUTOMATIC_SYNC.md). The dashboard generates a curl command that stores the connector key in macOS Keychain and installs a user-level LaunchAgent.

It never reads or uploads auth files, API keys, settings, caches, shell snapshots, tool output, or arbitrary files from the employee's computer.

### Strict privacy guardrail

Every Claude and Codex session is inspected on the employee's machine before sync. Sessions involving personnel evaluation, hiring feedback, employment action, compensation, health or protected leave, identity and financial documents, credentials, or legally privileged material are fully redacted locally. The remote system receives only a generic `Private session — content redacted locally` placeholder; the original title, project, transcript, and matched category never leave the laptop.

The local privacy audit contains only a timestamp, source, hashed session ID, policy version, and category. The server rejects outdated connectors that do not declare the current privacy policy and performs the same scan again before storage.

## Embeddings

The default local embedder has no dependency and sends data nowhere. It is useful for an MVP but is lexical rather than deeply semantic. For stronger retrieval, run Ollama and set:

```bash
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=nomic-embed-text
```

The app falls back to local embeddings if Ollama is unavailable.

## Slack `/context`

The included Slack app manifest creates `/context`. The command acknowledges immediately, runs the same evidence-backed answer path as the dashboard, and progressively replaces a private ephemeral Slack response. It never makes another user's imported transcripts available to the caller.

1. Make this server available at a public HTTPS address.
2. In Slack, create an app from [`slack-app/manifest.example.json`](./slack-app/manifest.example.json), replacing `YOUR_HOST` with that HTTPS host.
3. Install the app to the workspace and copy its signing secret and bot token.
4. Configure the server:

```bash
SLACK_SIGNING_SECRET=your-signing-secret \
SLACK_BOT_TOKEN=xoxb-your-bot-token \
SLACK_TEAM_ID=T0123456789 \
SLACK_ORG_SLUG=flent \
npm start
```

The bot uses `users.info` to match the Slack user's email to an existing Org Memory account. The manifest requests `users:read` and `users:read.email` for that lookup. If email lookup is undesirable, omit the bot token/scopes and configure a private mapping instead:

```bash
SLACK_USER_MAP='{"U0123456789":"you@example.com"}'
```

Usage:

```text
/context what did I work on this week?
/context who is Ayub?
/context help
```

Slack requests are HMAC-verified and rejected when older than five minutes. Keep the signing secret, bot token, and user mapping out of source control.

## Data model

SQLite stores organizations, users, sessions, invitations, connector credentials, conversations, chunks, topics, and conversation-topic edges. Graph data is derived from those normalized records, so PostgreSQL/pgvector and Neo4j can be introduced later without changing the connector payload.

For a production rollout, move SQLite to managed PostgreSQL with pgvector, place TLS in front of the server, add SSO/SCIM and per-project ACLs, encrypt connector tokens at rest, add audit logs and retention/deletion controls, and replace keyword classification with a reviewed extraction pipeline. Do not expose this MVP directly to the public internet as-is.

## Verify

```bash
npm test
```
