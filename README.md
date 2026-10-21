# Mimers Brain

*[Svenska](README.sv.md)*

A self-hosted long-term memory for language models. Same idea as
[OB1](https://github.com/NateBJones-Projects/OB1), but on your own hardware, with
a tier that never leaves the local network.

Any client that speaks MCP (or OpenAPI) can search and write the memory. What you
know about your systems is written down once instead of re-explained in every
conversation.

- **Two tiers.** *Open* knowledge is reachable from anywhere through a reverse
  proxy. The *vault* — sensitive context and `SECRET_REF` pointers — is served on
  the LAN only. Raw passwords, tokens and keys are refused on every write.
- **Search by meaning**, with metadata, review state and receipts that show which
  recalled memories were actually used.
- **Web UI** in English and Swedish for browsing, editing, reviewing and
  connecting clients.

![Thought list with metadata filters and a LAN-only vault entry](assets/screenshots/mimers-brain-thoughts.png)

## Documentation

| | |
| --- | --- |
| **[install.md](install.md)** | Installation on Proxmox LXC, Docker Desktop or Ubuntu Server: configuration, reverse proxy, backups, updates |
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

Without `OPENROUTER_API_KEY` (or another provider) nothing gets an embedding, and
only listing and text search work.

## Three ports

| Port | Serves | Who may reach it |
| --- | --- | --- |
| **8790** | open + vault, web UI, all tools | LAN/VPN only. **Never proxy it.** |
| **8791** | open tier, web UI | the only port a public reverse proxy forwards to |
| **8792** | open tier, read-only tools, no UI | a model that may look things up but must not write |

The tier is decided by which port a request arrives on, not by any header: the
open and read listeners are built without the ability to reach vault rows. See
[docs/how-it-works.md](docs/how-it-works.md#the-tier-boundary).

## MCP tools

| Tool | 8790 | 8791 | 8792 |
| --- | :-: | :-: | :-: |
| `memory_digest` — standing rules; call once per session | ✓ | ✓ | ✓ |
| `search_thoughts` — search by meaning | ✓ | ✓ | ✓ |
| `list_thoughts`, `thought_stats` | ✓ | ✓ | ✓ |
| `search` + `fetch` — the pair ChatGPT expects | ✓ | ✓ | ✓ |
| `report_memory_usage` — receipt for a search | ✓ | ✓ | ✓ |
| `capture_thought`, `preview_ingest` + `apply_ingest` | ✓ | ✓ | |
| `supersede_thought`, `review_memory`, `delete_thought` | ✓ | | |

The same tools are available as REST for OpenAPI clients: `GET /openapi.json`
and `POST /tools/<name>` (with `fetch_thought` instead of `search`/`fetch`).

## The web interface

| Page | What it is for |
| --- | --- |
| **Thoughts** | List, hybrid search, facets, editing, pinning memories into the session digest |
| **Review** | Agent memories awaiting review, duplicates, possible contradictions, rarely useful memories, recently deleted |
| **Statistics** | A 3D map of the memory, health, recall usefulness, client activity, MQTT status |
| **Connect** | Setup for every client |
| **Settings** | Port 8790 only: providers, models, re-embedding, similarity thresholds, and the recall and contradiction measurements |

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
and passed under `app.environment` in `docker-compose.yml`.

The Compose project, containers and volume keep their old `valv` names on
purpose; renaming them would start an empty database. See
[docs/how-it-works.md](docs/how-it-works.md#naming).
