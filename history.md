# History

*[Svenska](history.sv.md)*

What was built, why, and what went wrong along the way. Newest first.

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
