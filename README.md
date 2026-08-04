# Mimers Brain

*[Svenska](README.sv.md)*

A self-hosted long-term memory for language models. Same idea as
[OB1](https://github.com/NateBJones-Projects/OB1), but on your own hardware — and
with a tier that never leaves the local network.

Anything that speaks MCP can read and write the memory, so what you know about
your systems gets written down once instead of re-explained in every new
conversation. Secrets are served on the LAN only; everything else is reachable
from anywhere.

| | |
| --- | --- |
| **[HowToUse.md](HowToUse.md)** | Connecting a model, and rebuilding after a reinstall |
| **[history.md](history.md)** | What was built, why, and what went wrong |
| **[docs/nginx-brain.conf](docs/nginx-brain.conf)** | Ready-made reverse proxy config |
| **[migrate/](migrate/)** | One-time import of existing knowledge |

> **Addresses in the docs are placeholders.** `192.0.2.x`
> ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)) and `example.net`
> ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)) are reserved for
> documentation and resolve to nothing. Substitute your own. Keep the real values
> for a deployment in `docs/deployment.local.md`, which is gitignored.

## Why two ports

The tier split does **not** work by inspecting `X-Forwarded-For`. Anyone can set
that header, so a single line would lift the entire vault. Instead the tier is a
property of the **listener**:

| Port | Contents | Who |
| --- | --- | --- |
| **8790** | open + vault, plus the web UI | LAN only. **Never proxy this one.** |
| **8791** | open tier only | The only port a reverse proxy should forward to |

The MCP server on 8791 is built without the ability to reach the vault — its
tools are constructed with `tiers = ['open']` and `delete_thought` is not
registered at all. No parameter, header or path changes that. An attacker who
gets past the proxy still only reaches open knowledge.

Guarded by `test-isolation.ps1` (11 checks, all green):

```powershell
powershell -ExecutionPolicy Bypass -File .\test-isolation.ps1
```

The tests cover: vault rows are invisible on the open port, secret content never
leaks, looking a vault row up by id is refused, writing to the vault from outside
is refused, statistics do not even reveal that the vault exists, and a wrong key
returns 401.

## Running it

```powershell
Copy-Item .env.example .env    # fill in POSTGRES_PASSWORD, MCP_ACCESS_KEY, OPENROUTER_API_KEY
docker compose up -d --build
```

The interface: <http://localhost:8790>

Generate a key:
```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

**`OPENROUTER_API_KEY` is not optional in practice.** Without it nothing gets an
embedding, so neither semantic search nor `search_thoughts` works — only listing
and substring search.

## Connecting Claude Code

```bash
claude mcp add --transport http mimers-brain http://192.0.2.41:8790/mcp --header "Authorization: Bearer <MCP_ACCESS_KEY>"
```

From outside — and for other models — use the proxied hostname, which points at
8791. See [HowToUse.md](HowToUse.md) for every client.

## Authentication

Four ways in, in the order the server tries them:

1. **Bearer key** (`Authorization: Bearer <MCP_ACCESS_KEY>`) — what MCP clients
   and scripts use.
2. **Cookie** — the browser trades the key for an HttpOnly cookie once, via
   `POST /api/login`. It is derived from the key rather than stored, so there is
   no session table to maintain.
3. **Forward auth** (Authelia or similar) — on the open listener only. The proxy
   has already run the request past the authenticator and set `Remote-User`.
4. **URL key** (`/mcp?key=<MCP_OPEN_KEY>`) — open listener, `/mcp` only, and
   only if `MCP_OPEN_KEY` is set.

Points 3 and 4 are safe *there and only there*: that listener cannot reach vault
rows at all, so the worst a spoofed header or a leaked URL grants is open-tier
data anyone on the LAN could read from 8790 anyway. Never do the same on the full
listener.

Point 4 exists because some clients take a URL and offer no way to send a header
— Claude Desktop's connector dialog is the case that forced it. A credential in a
URL is a real downgrade: it is stored in the client's config and written to every
proxy access log, so `MCP_OPEN_KEY` must be a **different** value from
`MCP_ACCESS_KEY`, and `/mcp` has `access_log off` in
[docs/nginx-brain.conf](docs/nginx-brain.conf). The cleaner answer for that class
of client is OAuth, sketched but not built in
[docs/oidc-connector-plan.md](docs/oidc-connector-plan.md).

The UI is served on **both** ports. On 8790 you see the vault and sign in with
the key; through the proxy you see the open tier and the authenticator handles
sign-in.

## Docker inside an LXC

An unprivileged Proxmox LXC cannot apply an AppArmor profile, so every container
start fails with `runc run failed: unable to apply apparmor profile`. It shows up
deviously as an `npm install` failure mid-build — read the whole log for
`runc run failed` before debugging npm.

`security_opt: [apparmor=unconfined]` in the compose file fixes **running**, and
is harmless on machines without the problem. **Building** cannot be fixed from
inside (neither BuildKit nor `DOCKER_BUILDKIT=0` accepts `--security-opt`).

**The proper fix is on the Proxmox host**, not in the container: add
`lxc.apparmor.profile: unconfined` to `/etc/pve/lxc/<vmid>.conf`, check that
`features: nesting=1` is set, and reboot the container. Then
`docker compose up -d --build` works on the server directly.

## Deploying

1. Create an LXC (Debian or Ubuntu, 2 vCPU, 2 GB RAM, 20 GB disk is plenty —
   pgvector with a few thousand memories is small).
2. Install Docker, clone the repo, fill in `.env`, `docker compose up -d --build`.
3. Point a reverse proxy host at `http://<lxc-ip>:8791`. **Check that it says
   8791 and not 8790.**
4. If you put an authenticator in front: MCP clients cannot complete an
   interactive login, so `/mcp` needs a bypass — the bearer key is the protection
   there. `/.well-known/oauth-*` needs one too, answering **404**: behind forward
   auth it redirects to a login page that answers 200, and a client probing for
   OAuth reads that as an authorization server it must register with. See
   [docs/nginx-brain.conf](docs/nginx-brain.conf).

## Backups

`backup.sh` runs a nightly `pg_dump`, gzips it, and keeps ten days. It verifies
that the dump is valid gzip **and** contains the thoughts data before rotating
anything out — a truncated dump must never push a working one off the end.

```
10 0 * * * /path/to/mimers-brain/backup.sh >> /path/to/backups/backup.log 2>&1
```

A logical dump complements a full VM or container backup rather than duplicating
it: it can be restored selectively — a single thought, or the table into a fresh
database — which an image cannot do.

## Schema

The same shape as OB1's `thoughts` table plus `tier`, which keeps migration
trivial and the metadata format identical (`type`, `topics`, `people`).

One detail in `upsert_thought`: a row can be **promoted** into the vault but
never silently fall out of it. Capturing the same content again with
`tier='open'` leaves the row as `vault`.

## Naming

Container names, the Docker volume, and the compose project are `valv`-prefixed
(Swedish for *vault*), left over from when the project was called Mimers Valv.
They are deliberately untouched: `name: mimers-valv` is pinned at the top of
`docker-compose.yml` because Compose otherwise derives the project name from the
directory, and the volume holding every memory is `mimers-valv_valv-data`. A
rename would silently create a fresh, empty database.
