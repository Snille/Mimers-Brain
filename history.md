# History

*[Svenska](history.sv.md)*

What was built, why, and what went wrong along the way. Newest first.

---

## 2026-08-09 — 0.9.0: statistics measure memory health, not just traffic

The Statistics page now leads with what can safely be used: active memories,
the review queue, missing embeddings and metadata, recall receipt coverage and
overdue client reports. Raw rows remain visible as records including history,
so an archived ingest source, rejected memory or superseded predecessor no
longer inflates a KPI labelled as usable memory. Creation charts split records
by whether they are still active or are now inactive for the same reason.

Privacy-safe recall traces now have their own daily charts and per-client table.
Receipt coverage is reports divided by searches; usefulness is used ids divided
only by returned ids on traces that were actually reported, so an unknown result
is not silently called unused. The page explicitly starts this history with the
first 0.8.0 receipt and never treats older calls as missing reports. Queries,
answers and memory content remain absent from both the database telemetry and
the UI.

The existing activity, client, tool and MQTT views remain, grouped below memory
health and recall quality. Tool statistics add errors and p95 latency. MQTT's
overdue-receipt health now covers all retained open traces rather than forgetting
a missing receipt at midnight. The layout was rendered in a real browser and the
SQL exercised against an isolated pgvector database, including proof that the
open listener cannot aggregate vault records or full-listener receipts. A load
fixture with 20,000 memories, 150,000 usage events and 10,000 recall traces
returned the complete Statistics v2 payload in about 235 ms on the development
machine. All 24 Node tests and all 55 write-enabled container smoke checks pass.

---

## 2026-08-09 — 0.8.0: agent memory becomes governed memory

Memories now record where they came from, how certain they are and what a model
may do with them. Agent-authored inferences start as pending evidence rather than
silently becoming user instructions. A trusted review can confirm, restrict,
mark stale, keep as evidence, or reject them, and source and artifact references
remain attached to the record.

Long source text no longer has to become one transcript-shaped blob. Smart
ingest first proposes standalone atomic memories, saves nothing before approval,
then archives the verbatim source and links every accepted memory with
`derived_from`. The new Review page also presents semantic near-duplicates with
explicit keep, relate, supersede and merge actions; nothing is merged or removed
automatically.

Search now returns a privacy-preserving recall trace. Clients can report which
returned UUIDs materially influenced their answer, without storing the query,
answer or memory content. The central MCP/OpenAPI policy tells every model how
to apply these trust and reporting rules.

Home Assistant discovery now carries the review queue and aggregate recall
receipt coverage as counters only. A receipt left open for more than ten minutes
degrades service status, making clients that search but never report visible;
the companion TokenTracker 1.8.0 displays pending reviews and today's receipt
ratio without exposing queries or memory text.

The smoke test is read-only by default, emits clean JSON on request and requires
`-Write` for its 48 canary checks. Canary rows are cleaned in a `finally` block.
Together with 21 Node tests, the new flows were exercised against a real
temporary pgvector database before release.

---

## 2026-08-09 — 0.7.0: memories become records instead of incident-shaped blobs

The first 84 memories proved that good content is not enough. Free-form topic
tags had produced 171 spellings, completed work was labelled as tasks, and a
question about current SSH access could rank the canonical answer below shorter
side notes. Metadata v2 adds a title, summary, kind, lifecycle, task status,
project, systems, verification date and a controlled topic vocabulary while
keeping the old `type` field readable for existing clients.

Search is now hybrid: semantic similarity remains the base, but title and
summary word matches can lift the canonical answer. Superseded memories are
hidden by default but no longer have to be destroyed. `supersede_thought`
creates a replacement, preserves every predecessor and records full UUID
relations that the UI can follow in either direction.

The vault wording was corrected everywhere at the same time. It is for
sensitive context and exact `SECRET_REF` pointers, never raw passwords, tokens,
API keys or private keys. A migration command defaults to `--dry-run`, refuses
to apply unless the expected row count matches, prints no memory content, and
preserves non-canonical old tags under `legacy_topics`.

The UI exposes the new filters and history, semantic results return compact
title/summary cards, and the test suite now combines Node unit tests with 36
live-container isolation and history checks.

---

## 2026-08-09 — 0.6.0: a second door, for clients that never learned MCP

Open WebUI can call external tools, but it reads an OpenAPI document and calls
plain REST; it has no idea what JSON-RPC over `/mcp` is, and no setting makes it
learn. The usual answer is a proxy in front — Open WebUI ships one — but that is
a second service to run, update and forget about, wrapping a server that already
knows perfectly well what its own tools are. So the brain describes itself
instead: `GET /openapi.json` and one `POST /tools/<name>` per tool, on both
listeners, behind the same key.

The tier rule did not need restating so much as re-proving. Nothing about the new
surface can reach further than the listener it runs on: the open listener's
document does not mention `delete_thought`, offers no `vault` value for
`capture_thought`, and refuses to fetch a vault row by id. `test-isolation.ps1`
now checks all three, along with the fact that `MCP_OPEN_KEY` still stops at
`/mcp` — a URL key exists for dialogs with nowhere to put a header, and an
OpenAPI tool server has a perfectly good field for one.

`/openapi.json` is served without a key on purpose. It is tool names and argument
schemas, every word of it already published in this repo, and a client that
cannot read the document before it has been given a key cannot be configured at
all.

The one genuinely new exposure is CORS, since the browser fetches that document
from the page's own origin. `CORS_ORIGINS` lists the origins allowed to ask, and
is empty by default; an origin that is not on the list receives no CORS headers
and the browser refuses the answer. Nginx must not add a second set of headers on
top — a duplicated `Access-Control-Allow-Origin` is rejected outright, which
looks exactly like the server having no CORS at all.

What this costs: two descriptions of the same six tools, one in `mcp.mjs` for a
model to read and one in `openapi.mjs` for a program to parse. Merging them was
tried on paper and abandoned — the shapes are genuinely different, and the price
of unifying them was a rewrite of the file every existing client depends on.
Adding a tool now means adding it in both places; both files say so.

---

## 2026-08-08 — 0.5.1: a memory count is a gauge, not a meter

The four windowed memory counters — today, week, month, year — were published to
Home Assistant with `state_class: total_increasing`, which promises the value
only ever climbs and that any fall is a counter reset. Deleting memories breaks
that promise, and Home Assistant said so out loud: *"has state class
total_increasing, but its state is not strictly increasing"*, after a
housekeeping pass removed three superseded memories and the yearly count dropped.
Every such fall was being recorded as the start of a new cycle, quietly
corrupting the long-term statistics behind those sensors. They are now
`measurement`, which is what a count that can move in both directions actually
is. The call counters keep `total_increasing` deliberately: a call already made
cannot be un-made, so those only ever rise within their window.

---

## 2026-08-07 — one installation, three kinds of host

The short Compose snippet grew into a complete installation guide for Proxmox
LXC, Docker Desktop and an existing Ubuntu Server. It includes the failure modes
that only showed up in real operation: AppArmor errors disguised as failed build
steps, Docker ports bypassing simple firewall assumptions, the pinned Compose
name that protects the data volume, and the difference between stopping a stack
and deleting it with `-v`. The backup script also accepts host-side overrides
for its directory, retention and database identity, so a non-`mimer` service
account no longer needs to keep a locally edited script.

---

## 2026-08-06 — 0.5.0: the interface learns languages

The documentation had always existed in English and Swedish, but the live web
interface was Swedish-only. It now loads every visible label, message and guide
from JSON catalogs, chooses the browser language on first visit and remembers a
manual choice. English is the complete fallback. Adding another language means
copying one catalog and adding one entry to the manifest — no view code changes.

---

## 2026-08-06 — Three things the memory could not say about itself

The brain had answered faithfully for months without being able to say anything
about its own existence. Three questions had no answer: *how do I connect this
model?* (the answer lived in a document full of placeholder addresses), *is it
being used?*, and *is it alive?*

**The connection guide** became a third view in the web interface. The same
content as HowToUse, but filled in by the instance itself — addresses, keys, tool
list — with copy buttons. The document stays for what a page cannot explain: why
a setting is what it is, and how to rebuild the server.

The question that took longest to answer was which keys the page may show.
Everything is on a private network and the interface always sits behind Authelia,
so "someone signed out could see it" does not hold. But that is the wrong
question. The right one is *where the key travels*: showing `MCP_ACCESS_KEY` on
the proxied listener sends the vault key outside the trusted network through the
proxy,
across the internet and into a browser cache every time the page opens — and it
is the only credential that unlocks the vault on the LAN. So the rule became that
the vault key is served by the LAN listener alone. `MCP_OPEN_KEY` appears on
both; it is designed to travel in URLs and can never reach more than open tier.
Two new checks in `test-isolation.ps1` guard that.

**The statistics** demand honesty about what can be known. MCP hands over
`clientInfo` in the initialize handshake and never again — and the server is
stateless, a fresh transport per HTTP request, so by the time a `tools/call`
arrives the name is gone. The answer was a small cache: remember what initialize
said, keyed by source address plus user agent. That also meant reading the body
in the server rather than letting the transport do it, which it fortunately
accommodates by accepting an already-parsed body for exactly this case.

What the cache yields, though, is the **client application** — Claude Code,
Codex, a ChatGPT connector — never the model answering inside it. A model name is
simply not on the wire. The interface says so plainly instead of letting a column
promise something it cannot deliver.

The usage log deliberately stores **no content**: not the search query, not the
memory, not the result. A traffic log that quoted vault searches back would undo
the whole tier split it sits behind — and the statistics are readable from the
open listener. For the same reason that view counts only traffic that arrived on
the open listener, so it cannot even reveal that vault traffic exists.

Two traps along the way. The day boundary has to be cut in local time: left as
UTC, "today" would roll over at one or two in the morning and an evening memory
would land on tomorrow — which looks like a bug in the chart long before anyone
suspects the timezone. And the API returns only buckets that had activity, which
is right on the wire and wrong in a chart: two bars a month apart would sit side
by side, and a single quiet day stretched one bar across the whole card. The
series is made dense in the browser instead, so a quiet day is a gap you can see.

**MQTT to Home Assistant** publishes the counters as HA discovery under the
device Mimers Brain. The point of the availability topic is its *last will*: if
the process dies, the broker publishes `offline` on its behalf. Without one, a
dead brain looks exactly like a healthy one with nothing new to say — precisely
the confusion the Tokentracker sensors were once built to kill. Verified against
a throwaway broker in Docker, on both a planned stop and a hard kill.

The broker password lives in `.env`, not in a settings table in the interface.
The database is dumped nightly, and a credential that changes with one
`docker compose up -d` does not need to be in the backups too.

One detail that cost a restart: the variables have to be listed in
`docker-compose.yml` under `environment:`. A line in `.env` only reaches
Compose's own interpolation — it never lands in the container by itself.

**0.4.2 — the sidebar, not the list.** Erik asked whether the interface would get
slow once there were thousands of memories. Measuring beat guessing: a local
instance loaded with 20 000 memories and 150 000 usage rows put `/api/thoughts`
at **7 ms** — it is capped at 100 rows, so pagination would have solved nothing —
and `/api/stats` at **550 ms** for an 819-byte answer. That one is worse than it
looks, because the interface refreshes it on every search keystroke.

The interesting part was *where* the time went, because it was not where either
of us assumed. Postgres was innocent: fetching every row's metadata takes 43 ms,
and aggregating the same thing in SQL takes 53 ms — no win in the database at
all. The remaining ~540 ms was the driver decoding 20 000 JSONB values into JS
objects and the loop over them. So `stats()` now counts in SQL, and the win is
not that SQL counts faster: it is that the answer is one row instead of twenty
thousand. Measured after: **60 ms**, and the tier isolation suite still passes
all 22 checks.

Two details worth keeping. The `jsonb_typeof` guards are the old
`Array.isArray()` checks — metadata is free-form, and one hand-edited row whose
`topics` is a string must not fail the whole call; that case is now covered by a
test row. And `first`/`last` were quietly wrong before: the old code sorted Date
objects with the default comparator, which compares them as strings and
therefore ordered by weekday name. Nothing reads those fields yet, which is why
nobody noticed.

A trap walked straight into on the way out, and caught only because the same one
had been documented before: the `problem` text ends up on an ESPHome display
whose fonts carry a fixed glyph list, and `|` is not in it. A character outside
that list draws as *nothing* — it does not fall back to a box, it silently eats
part of the sentence. The separator is a slash now, and the whole string is run
through the same glyph vocabulary before publishing, so a database error full of
punctuation degrades to dots rather than to a message with holes in it.

The connection guide first had a `LAN_URL` to fill in by hand, and Erik objected
straight away to typing in an IP that can go stale. He was right. The obvious fix
does not work, though: `os.networkInterfaces()` inside the container returns
Docker's bridge address, and `socket.localAddress` returns the same, since the
port is NAT'd — auto-detection would have printed an address that works for
nobody, which is worse than an empty field. But there is a source that cannot be
wrong in the way that matters: the `Host` header on the LAN listener is by
definition an address a browser just reached us on. So the server learns its own
address from real visits and keeps it in a small `app_settings` table so it
survives a restart. `localhost` and `127.*` are filtered out — true, but useless
to hand to another machine. `LAN_URL` remains as a pure override.

---

## 2026-08-04 — A key that fits in a URL

Two clients had been registered in Claude Code for a while, and the memory
answered there every day. Then an attempt to add the same server on the chat side
of the desktop app came back with *"Couldn't register with Mimers Brain's
sign-in service"*.

The first thing that had to be untangled was that Claude Code and Claude Desktop
are **two different clients that happen to share a window**. Code reads
`~/.claude.json`; chat reads its own connector list. Neither sees the other's, so
a working memory in one says nothing about the other, and the empty Connectors
list was never a fault. That distinction is now written down in HowToUse — it is
the sort of thing that costs an hour exactly once per person.

The error itself was the connector dialog having no field for a header. Only
OAuth Client ID and Secret. Given a URL it cannot authenticate to, the client
falls back to the OAuth flow, tries to register dynamically, and fails — the
server has no OAuth at all.

### What was considered

Doing it properly means becoming an OAuth resource server: RFC 9728 metadata, a
`WWW-Authenticate` header pointing at it, JWT validation against a provider's
JWKS, and a provider to issue the tokens. The existing authenticator could have
been that provider — but its OIDC side turned out not to be enabled at all, so
that work would have started from zero.

It was a lot of machinery for one client's dialog, and it was shelved rather than
discarded: the whole design is in
[docs/oidc-connector-plan.md](docs/oidc-connector-plan.md), ready for the day a
shared key stops being good enough.

### What was built instead

`MCP_OPEN_KEY`, accepted as `/mcp?key=…` — but only on the open listener, only on
`/mcp`, and only when the variable is set. Empty, and the server is byte-for-byte
what it was.

The important part is that it is a **second** key. A credential in a URL is
stored in the client's config and written to every proxy access log, and the main
key — the one that opens the vault on 8790 — must never be put in that position.
The open listener cannot reach vault rows no matter what it is shown, so the
worst this key can leak is open tier. `/mcp` also had `access_log off` added so
the value is not written to disk on every call, and the server warns at boot if
the two keys are ever set to the same value.

`test-isolation.ps1` grew four checks around it, the one that matters being that
the **full listener refuses the URL key**. A convenience that quietly worked on
8790 too would have undone the whole tier split.

## 2026-08-04 — Mimers Brain built and deployed

The whole system came together in a day. It inherits its name from its
predecessor: a cloud-hosted [OB1](https://github.com/NateBJones-Projects/OB1)
install on Supabase, also called Mimers Brain. During the build the new one was
called "Mimers Valv" after its protected tier, but the vault is only one tier
inside the brain — not the whole system — so the name went back. Traces of
`valv` remain in container names, the volume and the SSH alias, deliberately left
alone: they are internal identifiers, and renaming them would have risked the
database for nothing.

### Why the move

The cloud version worked, but two things argued against putting secrets there:
every saved memory is sent to OpenRouter for embedding and metadata extraction,
and the MCP endpoint is a public URL behind a single key. The permission filter
in Claude Code said the same thing in practice — three of the first entries with
credential-shaped content were refused outright.

The conclusion was a self-hosted database on Proxmox, with a tier
that never leaves the local network.

### The architectural decision that matters most

The tier split lives in the **listener**, not the request. Port 8790 serves open
plus vault, port 8791 serves open only, and the MCP server on 8791 is built
entirely without the ability to reach vault rows. The alternative — reading
`X-Forwarded-For` and deciding whether the call came from inside — was rejected:
that header is caller-controlled, so one line would have lifted the whole vault.

`test-isolation.ps1` guards the boundary with eleven checks. All green, both
locally and against the deployed server.

### What was built

- Postgres 17 with pgvector, OB1's `thoughts` schema plus a `tier` column
- MCP server in Node, two listeners in one process, no deps beyond the SDK and `pg`
- Web UI with text and semantic search, filters, inline editing
- `backup.sh` + cron: nightly `pg_dump`, ten days of history
- Migration of 23 memories from the old brain, project notes and system docs

### Five traps that cost time

**OB1's schema was half-installed.** Reading and searching worked, but
`capture_thought` failed because `upsert_thought` was missing — the whole of step
2.6 in the setup guide had never been run. Fixed with an idempotent migration
before the move even started.

**`ssh-keygen -N '""'` in PowerShell** sets the passphrase to two literal quote
characters. The symptom was `ssh -v` reporting *"Server accepts key"* and then
denying anyway — which means the public key **is** installed correctly and the
fault is local. Two tool timeouts were burned before `-o BatchMode=yes` was used,
which would have failed immediately with the reason.

**AppArmor in an unprivileged LXC.** Surfaced as `npm install ... exit code 1`
mid-build, i.e. as a network problem. The real error was higher up the log:
`runc run failed: unable to apply apparmor profile`. Running was fixed with
`security_opt`; building needed one line on the Proxmox host.

**`Invoke-RestMethod` encodes the body as ISO-8859-1** when the charset is
missing from the `-ContentType` parameter. All sixteen imported memories got
U+FFFD where Swedish characters should have been, with embeddings computed from
the corrupted text. It looked like odd characters in the console, was dismissed
as a rendering artifact, and **the user was the one who spotted that the data was
actually destroyed**. Lesson: check the receiving end, not the console —
`select count(*) filter (where content like '%'||chr(65533)||'%')` must be zero.

**A false alarm about a leak.** The first proxy test reported that the vault was
visible from outside. It was not — the search patterns matched *open* memories
that happened to contain the words. Re-checked with six strings that exist only
in vault rows.

### Adjustments after measurement

The semantic search threshold was lowered from OB1's 0.5 to **0.3**. Measured
against Swedish paraphrases: identical sentence 1.00, shared keywords 0.79, a
rewording with no words in common 0.43. At 0.5 that last case was silently
dropped — which is exactly the kind of recall the memory exists for.

The web interface also needed real authentication. It called `/api/*` with only a
bearer key accepted, and a browser sends no such thing — the page had never
worked for a human. The key is now traded for an HttpOnly cookie, and from
outside the authenticator handles it.

### Surrounding setup

- LXC on `192.0.2.41`, Ubuntu 26.04, Docker 29.7.1, passwordless sudo
- Public hostname through the reverse proxy to 8791, with `/mcp` outside forward auth
- Registered in Claude Code as `mimers-brain` (LAN, full) and `mimers-brain-remote`
- Icon from a sticker PNG: background removed by flood fill from the corners, three sizes
- The Supabase project disconnected but left dormant as a fallback

### Version control

Until now the server had received its files piecemeal over `scp`, in four rounds,
and had drifted from the laptop: ten files missing and a duplicate sitting in the
wrong directory. Nobody could say what was actually running.

The repo now lives on GitHub, and the server is a real clone. Updating is one
command:

```bash
ssh <server> 'cd ~/mimers-brain && git pull && docker compose up -d --build'
```

The rename surfaced a trap that could have cost the whole database: Compose
derives the project name from the directory name, and the volume is called
`mimers-valv_valv-data`. A renamed directory would have silently created a fresh,
empty database. Solved by pinning `name: mimers-valv` in the compose file — hence
containers, volume and SSH alias still carrying the old name.

Eight memories also pointed at the old path, which no longer exists. They were
rewritten and re-embedded. **A memory that points somewhere wrong is worse than
no memory** — the next session would have followed the path straight into a wall.

### Topic casing

Verifying the translation turned up a real defect. The metadata extractor had
produced both `Home Automation` and `home automation` for the same idea, so they
filtered as two separate facets in the UI — and the stats object ended up with
keys differing only by case, which PowerShell's `ConvertFrom-Json` refuses,
silently returning the raw string instead of an object. That is why the isolation
suite suddenly reported an empty total.

Topics are now trimmed, lowercased and deduped on write; people keep their
capitalisation, being proper nouns. Twenty-five existing rows were normalised in
place. Embeddings are computed from content, not metadata, so nothing needed
re-embedding.

The suite also grew a twelfth check: it now verifies that it cleaned up its own
test rows. An earlier aborted run had left two behind.

### Commit identity

The initial commits were authored under an unintended Git identity. Before public
release the history was rewritten to use the maintainer's chosen public identity.
The identity is now pinned in the repo and the rule recorded: let Git resolve the
author itself instead of inheriting an account from the surrounding session.

### Editable tags

Topics and people could only be set at creation. Correcting a typo or merging two
spellings meant an API call by hand, so the edit form now carries type, topics and
people alongside the content.

Building it exposed a real gap: normalisation lived inside `captureThought`, so
anything written through `PATCH` bypassed it entirely and could reintroduce the
case-collision described above. It now lives in `normaliseMeta()` and runs on
every write. The form also leaves `content` out of the request when it has not
changed — the server re-embeds whenever it sees that field, and that is a paid
call.

The same defect had already split the person facet: the extractor produced both
`Erik` and `Erik Pettersson` for one person, so filtering on either missed rows.
Merged in place; embeddings come from content, so nothing needed recomputing.

### Documentation language

The docs were written in Swedish throughout, against the project's own rule that
code, comments and documentation are in English precisely so a repo can be
published. English is now the default, with the Swedish text kept alongside as
`*.sv.md`.
