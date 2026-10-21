# How Mimers Brain works

The design decisions behind the server, for anyone changing it or judging whether
to trust it. Setup is in [install.md](../install.md); connecting clients is in
[HowToUse.md](../HowToUse.md); the reasons behind each change are in
[history.md](../history.md).

## The tier boundary

Every memory is either **open** or **vault**. The vault holds sensitive context
and `SECRET_REF` pointers to where a credential is kept; raw passwords, tokens,
API keys and private keys are refused on every write path before the text reaches
a model, the embedder or the database.

The tier is a property of the **listener**, never of a header. A check on
`X-Forwarded-For` could be lifted by anyone who sets that header. Instead:

| Port | Built with | Tools |
| --- | --- | --- |
| 8790 full | `tiers = ['open', 'vault']` | all |
| 8791 open | `tiers = ['open']` | all except `review_memory`, `supersede_thought`, `delete_thought` |
| 8792 read | `tiers = ['open']`, no write tools | search, list, fetch, digest, statistics, `report_memory_usage` |

The open and read listeners are constructed without the ability to reach vault
rows, so no parameter, header or path changes what they return. Someone who gets
past the proxy still reaches open knowledge only.

The read listener exists because a less capable model tends to treat the memory
as a scratchpad. Rather than ask it to behave, the port never registers a tool
that changes a memory. `report_memory_usage` stays: it writes a recall receipt,
not a memory. Port 8792 serves only `/mcp`, `/openapi.json`, `/tools/*` and
`/healthz`.

`test-isolation.ps1` checks all of this against a running instance: vault rows
are invisible and unfetchable on the open port, vault writes from outside are
refused, statistics do not reveal that a vault exists, the Connect page withholds
the vault key on the open listener, the usage log holds no content, and the read
port registers no write tool and accepts only its own key.

## Authentication

The server tries, in order:

1. **Bearer key** — `Authorization: Bearer <key>`. MCP clients and scripts.
2. **Cookie** — the web UI trades `MCP_ACCESS_KEY` for an HttpOnly cookie
   (30 days) via `POST /api/login`. It is derived from the key, so there is no
   session table.
3. **Forward auth** — open listener only. The proxy has run the request past
   Authelia (or similar) and set `Remote-User`.
4. **URL key** — `/mcp?key=<MCP_OPEN_KEY>` on the open listener, or
   `?key=<MCP_READ_KEY>` on the read listener. For clients with a URL field and
   no header field, such as Claude Desktop's connector dialog.

Points 3 and 4 are safe only because those listeners cannot reach the vault.
A URL key is a downgrade — it lands in client configs and proxy logs — so it must
differ from `MCP_ACCESS_KEY`, and the nginx template turns off the access log for
`/mcp`. OAuth would be the cleaner answer; it is sketched in
[oidc-connector-plan.md](oidc-connector-plan.md) but not built.

The Connect page masks keys until asked, and serves `MCP_ACCESS_KEY` **only on
the LAN listener**: sending the vault key through the proxy would put it in every
visiting browser's cache.

The LAN address on the Connect page is **learned**, not configured. Inside a
container the OS and the socket both report Docker's bridge address. The `Host`
header of a visit to port 8790 is an address a browser just reached, so it is
stored and shown even when the page is read through the proxy. `LAN_URL`
overrides it.

## Memories

The base is OB1's `thoughts` table plus `tier`. Metadata (v2) adds `title`,
`summary`, `kind`, `lifecycle`, `task_status`, `project`, `systems`,
`verified_at`, `origin`, `provenance`, `review_status`, `captured_by`,
allowed-use flags, `source_refs` and `artifact_refs`. The older `type`, `topics`
and `people` remain for older clients.

- **Metadata** is proposed by the metadata model and validated by
  `server/memory-model.mjs`. `topics` has a closed vocabulary; `project` is free
  text and names the repository or service that owns the knowledge, never the
  client that wrote it.
- **Long text.** Direct writes of 1,200 characters or more are refused; long
  source text goes through `preview_ingest`, which proposes atomic memories, and
  `apply_ingest`, which saves the approved ones.
- **Trust.** Memories written by an agent start as pending evidence and are not
  treated as instructions. `review_memory` or the Review page confirms, keeps as
  evidence, marks stale or rejects them. `captured_by` comes from the MCP
  handshake, never from the caller's own metadata.
- **Corrections.** `supersede_thought` writes a replacement and keeps the old
  memory as navigable history in `thought_relations`. A superseded row is hidden
  from current searches, not deleted.
- **Change log.** A trigger on `thoughts` writes every create, update and delete
  to `thought_changes`, including changes made directly in psql. The web UI shows
  each memory's history with *Restore this version*. A deleted memory keeps its
  text for `CHANGE_LOG_DELETED_DAYS` (30) and can be restored under its own id. A
  change that ever touched the vault is never shown on the open listener.
- **Tier promotion.** `upsert_thought` can move a row into the vault but never out
  of it: capturing the same content as `open` leaves it in the vault.

## Search and recall

- **Ranking** (`RANK_WEIGHTS` in `server/lib.mjs`) is mostly semantic similarity,
  plus title and keyword matches and the memory's review state.
- **Receipts.** Each search returns a `trace_id`. The client reports which
  returned memories it used with `report_memory_usage`. A trace stores the client
  and memory ids only — never the query, answer or content. Receipts nudge
  ranking by a few hundredths: memories that keep being used rise, ones that keep
  being passed over sink, and those returned often but never used are listed as
  *Rarely useful* on the Review page.
- **Age notes.** A current memory not verified for 180 days carries an `AGE`
  note, so a model checks before relying on it. Incidents are exempt.
- **Session digest.** `memory_digest` returns the full usage policy, the confirmed
  preference and profile memories, and anything pinned on the Thoughts page. It
  is capped at 15 memories or 9,000 characters and names what it left out. The
  *Session digest* filter on the Thoughts page shows its contents.
- **Thresholds.** Search keeps hits above 0.3 similarity; the recall hook shows
  memories above 0.5. Both were measured with `text-embedding-3-small` and belong
  to that model. They are stored and changed on the Models card.
- **Recall hook.** [tools/hooks/](../tools/hooks/README.md) searches each Claude
  Code prompt once and adds up to three clear hits. It creates no receipt.

### Measuring recall

`scripts/eval-recall.mjs` and the Models card run the same measurement: a set of
real questions, each listed with the memories that answer it (or none). It
reports hit@1, hit@5 and reciprocal rank, and for the hook how often it shows the
right memory, a wrong one, or anything for a question with no answer. It proposes
thresholds: search = the lowest score of a right answer minus 0.1; hint = the
floor with the best hit rate minus noise.

The question set holds real questions, so it stays out of git: copy
[eval/recall-questions.example.json](../eval/recall-questions.example.json) to
`eval/recall-questions.local.json` (gitignored). Either upload it on the Models
card, where it is stored in the database, or pipe it to the script:

```bash
ssh <server> "docker exec -i valv-app node scripts/eval-recall.mjs" < eval/recall-questions.local.json
ssh <server> "docker exec -i valv-app node scripts/eval-recall.mjs --variant 'no-title={\"title\":0}'" < eval/recall-questions.local.json
```

A `--variant` overrides any `RANK_WEIGHTS`; `current` always runs first. The run
is read-only and writes no receipts. The report names questions by id and
memories by UUID only.

## Models

The Models card (Connect page, LAN listener only) chooses the provider and model
for three jobs: embedding, metadata and the contradiction check. Providers are
OpenRouter, OpenAI, Ollama and one custom OpenAI-compatible server. Defaults:
`openai/text-embedding-3-small`, `openai/gpt-6-luna` and
`qwen/qwen3-235b-a22b-2507`.

- Addresses and keys can be set on the card instead of in `.env`; the card wins.
  Keys are sealed with AES-256-GCM under `SETTINGS_KEY` before storage, so dumps
  hold ciphertext. The card learns whether a key exists, never the key.
- Nothing is saved until a real call has succeeded.
- The two chat models change at once. A new embedding model is filled into a
  second vector column in the background; search keeps the old model, a compare
  view shows both answering the same question, and *Switch* swaps them in one
  transaction. Thresholds can be measured on the new vectors before the switch.
- The open listener refuses `/api/ai` entirely: choosing a model chooses where
  vault text is sent.

## Maintenance

Once a day the server prunes the usage log to the retention chosen on the
Statistics page, forgets deleted-memory text past its 30 days, embeds current
memories that lack a vector, and checks twenty pairs of memories for
contradictions.

- **Contradictions.** Pairs of current memories with similarity at or above the
  contradiction floor are read by the contradiction model, closest first. The
  floor belongs to the embedding model and is set with the search thresholds on
  the Models card: 0.6 by default, measured with text-embedding-3-small; 0.65
  for bge-m3. Conflicts appear on the Review page as
  *Possible contradictions*. A verdict holds until either memory changes.
- **Duplicates.** Pairs with similarity at or above the duplicate floor appear on
  the Review page. Like the contradiction floor it is set on the Models card:
  0.86 by default, measured with text-embedding-3-small; 0.82 for bge-m3, where
  0.86 showed nothing and the pairs merged or superseded by hand scored 0.83-0.90.
- **Audit.** `npm run audit` in `server/` is a read-only quality pass: metadata
  that would be normalised, oversized or multi-purpose memories, completed work
  filed as tasks, possible secret fragments, titles that are only the cut-off
  opening of the text. The report holds ids, fields and warning codes only.

Nothing in maintenance changes a memory on its own.

## Statistics and privacy

The Statistics page and the MQTT sensors count; they never quote. The usage log
holds no search query, memory or result: a log quoting vault searches would undo
the tier split. MCP identifies the **client application** (Claude Code, Codex, a
ChatGPT connector), never the model inside it, so no model names are shown.
Through the proxy the page counts only open-listener traffic, so it cannot reveal
that vault traffic exists.

## Naming

Container names, the volume and the Compose project are prefixed `valv` (Swedish
for *vault*) from when the project was called Mimers Valv. They stay: `name:
mimers-valv` is pinned in `docker-compose.yml` and the volume holding every memory
is `mimers-valv_valv-data`. Renaming either would silently start an empty
database.
