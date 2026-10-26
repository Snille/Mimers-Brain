# Mimers Brain

*[Svenska](README.sv.md)*

A self-hosted long-term memory for language models. Same idea as
[OB1](https://github.com/NateBJones-Projects/OB1), and built the same way:
PostgreSQL with [pgvector](https://github.com/pgvector/pgvector), where every
memory is stored with an embedding and found by semantic search. The
difference is that it runs on your own hardware, with a tier that never leaves
the local network.

Any client that speaks MCP (or OpenAPI) can search and write the memory. What you
know about your systems is written down once instead of re-explained in every
conversation.

![Thought list with metadata filters and a LAN-only vault entry](assets/screenshots/mimers-brain-thoughts.png)

## How it works, in short

1. **A memory is a row.** The `thoughts` table comes from OB1, plus a `tier`
   column. Each row holds the text, structured metadata and an embedding: a
   vector that describes what the text means.
2. **Writing.** On every write the server refuses text that looks like a
   secret, asks a metadata model for title, summary, kind, project, topics and
   systems, and asks an embedding model for the vector. A fingerprint of the
   text makes an exact copy update the existing row instead of adding one.
3. **Searching is semantic.** The question gets a vector too, and pgvector
   finds the closest memories by cosine similarity through an HNSW index.
   Ranking is hybrid: mostly meaning (0.80), plus full-text matches on title,
   summary and text, and the memory's review state. A question can find a
   memory that shares no words with it.
4. **Receipts.** Every search returns a `trace_id`, and the client reports which
   results it used. Memories that keep being used rise in the ranking; ones that
   are never used are listed for review.

Details: [docs/how-it-works.md](docs/how-it-works.md).

## What it does

- **Two tiers.** *Open* knowledge is reachable from anywhere through a reverse
  proxy. The *vault* — sensitive context and `SECRET_REF` pointers — is served on
  the LAN only. The tier is decided by the port, never by a header.
- **A secret gate.** Raw passwords, tokens, API keys and private keys are refused
  on every write path, before the text reaches a model, the embedder or the
  database.
- **Governed memory.** Memories written by an agent start as pending evidence,
  not instructions, until you confirm them. Corrections supersede the old memory
  and keep it as history instead of deleting it.
- **Long text in pieces.** A long source is split into proposed atomic memories,
  and only the ones you approve are saved.
- **A session digest.** `memory_digest` gives every client the usage policy and
  your confirmed rules once per session, whatever client it is.
- **Memories at the prompt.** A [Claude Code hook](tools/hooks/README.md) searches
  each prompt and adds up to three clear hits to the model's context.
- **Contradictions and duplicates.** A nightly check asks a model whether pairs
  of similar memories disagree. Near-duplicates are listed too. You decide each
  pair on the Review page, or with a model through the MCP tools.
- **A change log.** A database trigger records every create, update and delete,
  also from psql. Any version can be restored, and a deleted memory can be
  restored for 30 days.
- **Choose your models.** Embedding, metadata and the contradiction check each
  use their own provider and model: OpenRouter, OpenAI, Ollama or any
  OpenAI-compatible server. A local embedding model such as `bge-m3` in Ollama
  works, and a change of embedding model re-embeds in the background before
  the switch.
- **Measured, not guessed.** Your own questions measure recall and propose
  similarity thresholds for each embedding model. Cases with known answers test
  a contradiction model before it is put to work.
- **Home Assistant.** Optional MQTT sensors publish counts and health, never
  content. See [docs/home-assistant.md](docs/home-assistant.md).
- **Web UI** in English and Swedish, dark or light, for browsing, editing,
  reviewing, statistics and connecting clients.

## Stack

Node.js (no web framework), the MCP TypeScript SDK and `zod`, PostgreSQL 17
with pgvector in the `pgvector/pgvector:pg17` image, and Docker Compose. The
web UI is plain HTML and ES modules with no build step.

| Path | What it holds |
| --- | --- |
| `db/init.sql` | Schema: tables, pgvector and HNSW index, fingerprint upsert, change-log trigger |
| `server/index.mjs` | HTTP listeners on three ports, authentication, web API, nightly maintenance |
| `server/mcp.mjs`, `server/openapi.mjs` | The MCP tools and the same tools as REST |
| `server/lib.mjs` | Database access, search and ranking, relations, contradictions, duplicates |
| `server/memory-model.mjs` | Metadata rules, the usage policy and tool guidance |
| `server/ai.mjs`, `server/model-settings.mjs` | Providers, models, embeddings and re-embedding |
| `server/secret-gate.mjs` | The check that refuses secrets |
| `server/public/` | The web UI |
| `server/test/` | Tests (`npm test`) |

## Documentation

| | |
| --- | --- |
| **[install.md](install.md)** | Installation on Proxmox LXC, Docker Desktop or Ubuntu Server: configuration, reverse proxy, backups, updates, local embedding model, contradiction test |
| **[HowToUse.md](HowToUse.md)** | Connecting Claude Code, Codex, Claude Desktop, ChatGPT, Open WebUI; what belongs in the memory |
| **[docs/how-it-works.md](docs/how-it-works.md)** | Tier boundary, authentication, memory model, search, models, maintenance |
| **[docs/home-assistant.md](docs/home-assistant.md)** | MQTT sensors for Home Assistant |
| **[tools/hooks/](tools/hooks/README.md)** | Claude Code hook that brings memories to each prompt |
| **[docs/nginx-brain.conf](docs/nginx-brain.conf)** | Reverse proxy template |
| **[docs/translations.md](docs/translations.md)** | Adding a UI language |
| **[migrate/](migrate/README.md)** | One-time import of existing notes |
| **[history.md](history.md)** | What was built, why, and what went wrong |

> **Addresses in the docs are placeholders.** `192.0.2.x`
> ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)) and `example.net`
> ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)) resolve to nothing.
> Substitute your own, and keep real values in `docs/deployment.local.md`
> (gitignored).

## Quick start

Requires Docker with Compose. Full instructions: [install.md](install.md).

```bash
git clone https://github.com/Snille/Mimers-Brain.git && cd Mimers-Brain
cp .env.example .env    # set POSTGRES_PASSWORD, MCP_ACCESS_KEY, OPENROUTER_API_KEY, CITATION_BASE_URL
docker compose up -d --build
```

Open <http://localhost:8790>, sign in with `MCP_ACCESS_KEY`, and go to
**Connect**: it shows ready-to-copy setup for every client, filled in with this
instance's addresses and keys. For Claude Code on the LAN:

```bash
claude mcp add --transport http mimers-brain http://192.0.2.41:8790/mcp --header "Authorization: Bearer <MCP_ACCESS_KEY>"
```

The default models run on OpenRouter. Instead of `OPENROUTER_API_KEY` you can
set any provider on the **Settings** page. Without an embedding provider nothing
gets a vector, and only listing and text search work.

## Three ports

| Port | Serves | Who may reach it |
| --- | --- | --- |
| **8790** | open + vault, web UI, all tools | LAN/VPN only. **Never proxy it.** |
| **8791** | open tier, web UI | the only port a public reverse proxy forwards to |
| **8792** | open tier, read-only tools, no UI | a model that may look things up but must not write |

The open and read listeners are built without the ability to reach vault rows,
so no parameter, header or path changes what they return. See
[docs/how-it-works.md](docs/how-it-works.md#the-tier-boundary).

## MCP tools

| Tool | 8790 | 8791 | 8792 |
| --- | :-: | :-: | :-: |
| `memory_digest` — usage policy and standing rules; call once per session | ✓ | ✓ | ✓ |
| `search_thoughts` — semantic search | ✓ | ✓ | ✓ |
| `list_thoughts`, `thought_stats` | ✓ | ✓ | ✓ |
| `search` + `fetch` — the pair ChatGPT expects | ✓ | ✓ | ✓ |
| `report_memory_usage` — receipt for a search | ✓ | ✓ | ✓ |
| `capture_thought`, `preview_ingest` + `apply_ingest` | ✓ | ✓ | |
| `supersede_thought`, `review_memory`, `delete_thought` | ✓ | | |
| `list_contradictions` + `dismiss_contradiction` — go through the Review page's possible contradictions | ✓ | | |
| `list_duplicates` + `resolve_duplicate` — go through the Review page's possible duplicates | ✓ | | |

That is 17 tools on 8790, 10 on 8791 and 7 on 8792. The same tools are
available as REST for OpenAPI clients: `GET /openapi.json` and
`POST /tools/<name>` (with `fetch_thought` instead of `search`/`fetch`).

## The web interface

| Page | What it is for |
| --- | --- |
| **Thoughts** | List, hybrid search, facets, reviewing new agent memories with their whole text, editing, change history with restore, *Copy reference* for a chat, pinning memories into the session digest |
| **Review** | How many memories await review (with a link to them on Thoughts), duplicates, possible contradictions, rarely useful memories, recently deleted |
| **Statistics** | A 3D map of the memory (can be switched off), health, recall usefulness, client activity, MQTT status, receipt retention |
| **Connect** | Setup for every client |
| **Settings** | Port 8790 only: theme and accent colour, providers and keys, models, re-embedding, the four similarity thresholds, and the recall and contradiction measurements |

The UI is served on 8790 (sign in with `MCP_ACCESS_KEY`) and 8791 (open tier,
behind your authenticator). It loads its text from JSON catalogs, picks the
browser language, and remembers a manual choice.

![Memory health, recall quality and activity statistics](assets/screenshots/mimers-brain-statistics.png)

## Development

```bash
cd server
npm ci
npm test          # database tests are skipped without TEST_DATABASE_URL
npm run audit     # read-only quality report on the database in DATABASE_URL
```

Database tests need a disposable pgvector Postgres; see the header of
`server/testing/db.mjs`. A new environment variable must be added to `.env.example`
and passed under `app.environment` in `docker-compose.yml`. A new MCP tool goes
into both `server/mcp.mjs` and `server/openapi.mjs`.

The Compose project, containers and volume keep their old `valv` names on
purpose; renaming them would start an empty database. See
[docs/how-it-works.md](docs/how-it-works.md#naming).
