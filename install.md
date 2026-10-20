# Installing Mimers Brain

Mimers Brain runs as one Docker Compose stack: a Node.js application container
(`valv-app`) and a PostgreSQL/pgvector container (`valv-db`). Compose is the only
supported way to run it, on any host.

Steps, in order:

1. [Prepare the host](#1-prepare-the-host) — Proxmox LXC, Docker Desktop or Ubuntu Server
2. [Configure `.env`](#2-configure-env)
3. [Start the stack](#3-start-the-stack)
4. [Network and reverse proxy](#4-network-and-reverse-proxy) (optional)
5. [Backups](#5-backups)
6. [Updating](#6-updating)
7. [Tune the search thresholds](#7-tune-the-search-thresholds) (once you have memories)

[Troubleshooting](#troubleshooting) is at the end.

## Before you start

- **Resources:** 2 CPU cores, 2 GB RAM, 20 GB disk. A few thousand memories is a
  small database.
- **Outbound HTTPS** to GitHub and Docker Hub for the install, and to OpenRouter
  (or another model provider) for embeddings and metadata.
- **Three ports**, each with a different reach:

| Port | Serves | Exposure |
| --- | --- | --- |
| `8790` | open tier + vault, web UI, all tools | trusted LAN/VPN only. **Never reverse-proxy it.** |
| `8791` | open tier only, web UI | the only port a public reverse proxy may forward to |
| `8792` | open tier only, read-only tools, no web UI | optional; for a model that must not write |

- **Data** lives in the Docker volume `mimers-valv_valv-data`, not in the checkout.

> **Never remove `name: mimers-valv` from `docker-compose.yml`, rename the
> volume, or run `docker compose down -v`.** The pinned project name keeps the
> volume attached when the checkout directory changes. `-v` deletes the volume and
> every memory in it.

## 1. Prepare the host

Pick one option, then continue at [section 2](#2-configure-env).

### Option A: Proxmox VE, unprivileged Ubuntu LXC

Docker inside an LXC shares the Proxmox host kernel, and the AppArmor exception
below weakens the LXC boundary. Use a dedicated container on a trusted host, or a
small VM if you want Docker to have its own kernel.

Create the container with Ubuntu 24.04 LTS, **unprivileged**, 2 cores, 2 GB RAM,
20 GB disk, a static address or DHCP reservation, start at boot, and the features
`nesting` and `keyctl`:

```bash
pct set <VMID> -features nesting=1,keyctl=1
```

Then allow Docker to start containers. On the Proxmox host:

```bash
pct stop <VMID>
echo "lxc.apparmor.profile: unconfined" >> /etc/pve/lxc/<VMID>.conf
pct start <VMID>
```

Without this line every container start fails with `runc run failed: unable to
apply apparmor profile`, often disguised as an `npm install` error halfway
through the build. The `security_opt` lines in the Compose file only fix running
containers; building inside the LXC needs the host setting.

Log in to the LXC and continue with [Option C](#option-c-ubuntu-server).

### Option B: Docker Desktop (Windows or macOS)

Install [Docker Desktop](https://docs.docker.com/desktop/) with Linux containers
(WSL 2 on Windows). In PowerShell:

```powershell
docker version
docker compose version
git clone https://github.com/Snille/Mimers-Brain.git
Set-Location Mimers-Brain
Copy-Item .env.example .env
```

On macOS use `cd Mimers-Brain` and `cp .env.example .env`. In `.env`, set
`CITATION_BASE_URL=http://localhost:8790/thoughts` and leave `PUBLIC_URL` empty.

Docker Desktop publishes the ports on all interfaces, so block unsolicited inbound
traffic in the host firewall. It suits development and evaluation; an always-on
install is easier to run and back up on a server.

### Option C: Ubuntu Server

Skip the Docker install if `docker version` and `docker compose version` already
work. Otherwise, following Docker's apt repository instructions:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Log out and in again, then check Docker, check that the ports are free, and clone:

```bash
docker run --rm hello-world
sudo ss -ltnp | grep -E ':(8790|8791|8792)\b' || true
git clone https://github.com/Snille/Mimers-Brain.git ~/mimers-brain
cd ~/mimers-brain
cp .env.example .env
```

Membership in the `docker` group is effectively root on the host. Add trusted
administrators only.

## 2. Configure `.env`

`.env` is gitignored; never commit it. Every variable is explained in
[.env.example](.env.example). Set at least these:

| Variable | Needed | Purpose |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | yes | database password (the container is not published) |
| `MCP_ACCESS_KEY` | yes | full access, vault included; also the web UI sign-in on 8790 |
| `OPENROUTER_API_KEY` | yes, in practice | embeddings and metadata. Without a provider there is no semantic search. |
| `CITATION_BASE_URL` | yes | base of the links a client gets to a memory, e.g. `http://192.0.2.41:8790/thoughts` |
| `PUBLIC_URL` | with a public proxy | e.g. `https://brain.example.net`; shown on the Connect page |
| `MCP_OPEN_KEY` | optional | URL key (`/mcp?key=`) for open-tier clients that cannot send a header |
| `MCP_READ_KEY` | with port 8792 | the read-only port's key. Empty means 8792 accepts `MCP_ACCESS_KEY`. |
| `CORS_ORIGINS` | for Open WebUI | browser origins allowed to call `/openapi.json` and `/tools/*` |
| `SETTINGS_KEY` | optional | seals provider keys typed on the Models card |
| `MQTT_URL` | optional | Home Assistant integration; see [docs/home-assistant.md](docs/home-assistant.md) |

Generate every secret separately, as long hex (safe inside the database URL):

```bash
openssl rand -hex 32
```

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

`MCP_ACCESS_KEY`, `MCP_OPEN_KEY` and `MCP_READ_KEY` must be three different
values. A URL key ends up in client configs and proxy logs; the full key unlocks
the vault; a read-only client given the open key could write on 8791.

Leave `LAN_URL` empty: the server learns its LAN address from your first visit to
port 8790. Set `STATS_TZ` to your IANA time zone, e.g. `Europe/Stockholm`.

Model providers other than OpenRouter (OpenAI, Ollama, any OpenAI-compatible
server) can be configured in `.env` or later on the **Models** card of the
Connect page. The card is also where the embedding, metadata and contradiction
models and the search thresholds are chosen; a value saved there wins over
`.env`.

## 3. Start the stack

From the repository root (the same commands work in PowerShell):

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

The first start builds the image and creates the database. Wait until `valv-db`
is healthy and `valv-app` is running, then check the three listeners:

```bash
curl -fsS http://127.0.0.1:8790/healthz   # "tier":"full","writable":true
curl -fsS http://127.0.0.1:8791/healthz   # "tier":"open","writable":true
curl -fsS http://127.0.0.1:8792/healthz   # "tier":"open","writable":false
```

On Windows use `curl.exe`. Open `http://<server>:8790` (or
<http://localhost:8790>) and sign in with `MCP_ACCESS_KEY`. Then go to
**Connect** to hook up your first model; [HowToUse.md](HowToUse.md) explains the
choices.

## 4. Network and reverse proxy

Keep `8790` reachable from trusted LAN or VPN clients only. Published Docker ports
bypass simple UFW rules, so enforce this in the Proxmox firewall, the router/VLAN
or Docker's `DOCKER-USER` chain.

Public access is optional. To enable it:

1. Create a DNS name, e.g. `brain.example.net`, and terminate TLS at the proxy.
2. Forward it to `http://<server>:8791`. **Check that it says 8791, not 8790.**
3. Start from [docs/nginx-brain.conf](docs/nginx-brain.conf) (nginx or Nginx Proxy
   Manager).

If an authenticator such as Authelia protects the web UI:

- `/mcp`, `/openapi.json` and `/tools/` must bypass it. Those clients send a
  bearer key and cannot complete a login page.
- `/.well-known/oauth-*` must answer **404**. Behind forward auth those paths
  redirect to a login page that answers 200, and an MCP client then tries to
  register with an OAuth server that does not exist.
- `/mcp` needs `proxy_buffering off` (MCP keeps a stream open).

The template does all three. Leave CORS to the application: a proxy
`add_header Access-Control-Allow-Origin` on top of the app's own header makes a
duplicate, which browsers reject.

Do not publish the open-tier web UI without an authenticator. Without one, proxy
only `/mcp` and `/healthz`, or keep 8791 private.

For port 8792, forward a second hostname to it the same way.

## 5. Backups

The image is disposable; the volume is not. `backup.sh` takes a gzipped
`pg_dump`, checks that it is valid and contains the `thoughts` data, and only then
rotates out old dumps, keeping the newest ten.

```bash
chmod +x backup.sh restore.sh
BACKUP_DIR="$HOME/valv-backups" ./backup.sh
```

Nightly, with cron:

```cron
10 0 * * * BACKUP_DIR=/home/mimer/valv-backups /home/mimer/mimers-brain/backup.sh >> /home/mimer/valv-backups/backup.log 2>&1
```

Adjust the paths to your user. Variables: `BACKUP_DIR` (default
`/home/mimer/valv-backups`), `BACKUP_KEEP` (10), and `DB_USER` / `DB_NAME` if you
changed `POSTGRES_USER` / `POSTGRES_DB`.

Restore replaces the whole database. Take a fresh backup first:

```bash
./restore.sh "$HOME/valv-backups/valv-YYYYMMDD-HHMM.sql.gz"
```

It prints the row count before and after. A logical dump also allows partial
restores, e.g. one memory, which a VM image cannot.

## 6. Updating

```bash
cd ~/mimers-brain
BACKUP_DIR="$HOME/valv-backups" ./backup.sh
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 app
```

The app adds any new tables and columns at startup. `db/init.sql` runs only when
a new, empty volume is created.

## 7. Tune the search thresholds

Search shows memories above a similarity of **0.3**, and the recall hook above
**0.5**. Those values were measured with `openai/text-embedding-3-small` on one
brain. Once yours holds a few dozen memories, measure them on your own questions.
Do it again after every change of embedding model, since another model scores the
same text differently.

**1. Write a question set.** Copy
[eval/recall-questions.example.json](eval/recall-questions.example.json) to
`eval/recall-questions.local.json` (gitignored: it describes your systems).

```json
{ "questions": [
  { "id": "proxy-port", "q": "Which port does the reverse proxy forward to?", "expect": ["<memory id>"] },
  { "id": "weather",    "q": "What will the weather be like this weekend?",   "expect": [] }
] }
```

- `q` is a question you would really ask, worded as you would ask it. Questions
  taken from real sessions are worth the most.
- `expect` lists the ids of the memories that answer it; any one counts as a hit.
  Copy an id with **Copy reference** on the Thoughts page.
- `expect: []` marks a question nothing should answer. These measure noise from
  the recall hook.
- For a suggestion you need at least **3 questions with an answer and 1
  without**. Around 40 and 5 give stable numbers.

**2. Measure.** On port 8790, open **Connect → Models → Search thresholds**.
Choose **Upload questions**, then **Measure**. It runs in the background and
takes a few seconds per question; it changes nothing.

**3. Read the result.**

| Line | Meaning | Good |
| --- | --- | --- |
| Right first | the right memory is the first search result | 75 % or more |
| In the first five | the right memory is among the first five | 90 % or more |
| Memory hints: right / noise | the hook shows the right memory / shows something for a question with no answer | high / 0 % |
| "*n* expected memories no longer exist or have been replaced" | a question points at a superseded or deleted memory | fix the `expect` id and upload again |

**4. Apply.** If the warnings are gone and the suggestion looks sensible, choose
**Use the suggestion**. It takes effect at once, without a restart. **Change**
sets the values by hand; an empty field brings back the default.

**When you change embedding model:** wait until the re-embedding is finished, but
do not switch yet. Choose **Measure** for the *new* model and **Save the
suggestion** for it. Its thresholds then take effect in the same step as
*Switch*.

The same measurement runs from the command line, with variants of the ranking
weights; see [docs/how-it-works.md](docs/how-it-works.md#measuring-recall).

## Troubleshooting

**The build fails in `npm install` inside an LXC.** Search the log for
`runc run failed` / `unable to apply apparmor profile`. Apply the host setting in
[Option A](#option-a-proxmox-ve-unprivileged-ubuntu-lxc). Changing npm registries
does not help.

**The UI works but semantic search does not.** No embedding provider is
configured. Set `OPENROUTER_API_KEY` (or a provider on the Models card) and run
`docker compose up -d`. Listing and text search work without one.

**A changed `.env` value has no effect.** Run `docker compose up -d` to recreate
the container. A *new* variable must also be listed under `app.environment` in
`docker-compose.yml`, or it never reaches the container.

**The database looks empty.** Stop writing. Check that `name: mimers-valv` is
still at the top of `docker-compose.yml`, then:

```bash
docker volume ls | grep valv
```

A changed project name attaches a new, empty volume while the old one still
exists. Delete nothing until you know which is which.

**Diagnostics:**

```bash
docker compose ps
docker compose logs --tail=200 app db
docker exec valv-db pg_isready
```

**Checking the tier boundary.** `test-isolation.ps1` checks that the open and
read-only ports cannot reach the vault or write where they must not. It reads
the keys from `.env`; `-HostName` points it at another machine.

```powershell
.\test-isolation.ps1          # read-only checks
.\test-isolation.ps1 -Write   # full canary suite; test rows are removed afterwards
```

## Platform documentation

- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Docker Desktop](https://docs.docker.com/desktop/)
- [Proxmox `pct`](https://pve.proxmox.com/pve-docs/pct.1.html)
