# History

*[Svenska](history.sv.md)*

What was built, why, and what went wrong along the way. Newest first.

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
the proxied listener sends the vault key outside the trusted network through the proxy,
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

The repo now lives on GitHub, and the server is a real clone
used for deployment. Updating is one command:

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

The initial commits were authored under an unintended Git identity. The cause
was not configuration — the global `.gitconfig` had the right address all along.
Every commit was made with an explicit
`-c user.email="…"` override taken from the session's own environment, which says
which account the tool was started under and nothing about who should be recorded
as the author. Before public release the history was rewritten; the identity is
now pinned in the repo and the rule recorded: let git resolve the author itself.

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
