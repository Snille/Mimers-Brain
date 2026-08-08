# Installing Mimers Brain

This guide covers three supported ways to run Mimers Brain:

1. an unprivileged Ubuntu LXC on Proxmox VE;
2. Docker Desktop on Windows or macOS;
3. an existing Ubuntu Server.

All three use the same Docker Compose stack: one Node.js application container
and one PostgreSQL/pgvector container. A native installation without Docker is
possible, but is not documented or tested; Compose is the supported deployment
path even on an existing Linux server.

## Before you start

Recommended minimum resources are 2 CPU cores, 2 GB RAM and 20 GB disk. The
machine also needs outbound HTTPS access to GitHub and Docker Hub, plus
OpenRouter when semantic search is wanted.

Mimers Brain listens on two ports with deliberately different capabilities:

| Port | Contents | Exposure |
| --- | --- | --- |
| `8790` | open tier + vault + web UI | trusted LAN/VPN only; never reverse-proxy it |
| `8791` | open tier + web UI | the only port that may sit behind a reverse proxy |

Choose where the persistent data and backups will live before installing. The
database is stored in the named Docker volume `mimers-valv_valv-data`, not in
the Git checkout.

> **Do not remove `name: mimers-valv` from `docker-compose.yml`, rename the
> volume, or run `docker compose down -v`.** The pinned project name is what
> makes the existing database volume follow the installation when the checkout
> directory changes. The `-v` flag deletes that volume and every memory in it.

## 1. Prepare the host

Choose one of the following host setups, then continue at
[Configure Mimers Brain](#2-configure-mimers-brain).

### Option A: Proxmox VE with an Ubuntu LXC

Proxmox recommends a QEMU VM for Docker workloads because containers inside an
LXC share the Proxmox host kernel. Mimers Brain does work in an unprivileged
LXC, but the AppArmor exception below weakens that LXC security boundary. Use a
dedicated unprivileged container on a trusted host; choose a small VM instead if
you want Docker to have its own kernel boundary.

Create the container in the Proxmox UI with:

- Ubuntu 24.04 LTS;
- unprivileged container enabled;
- 2 cores, 2 GB RAM and at least 20 GB disk;
- a static address or DHCP reservation;
- start at boot enabled;
- `Nesting` and `Keyctl` enabled under **Options → Features**.

The equivalent host command for the feature flags is:

```bash
pct set <VMID> -features nesting=1,keyctl=1
```

On the Proxmox host, stop the LXC:

```bash
pct stop <VMID>
```

Add this line to `/etc/pve/lxc/<VMID>.conf`:

```text
lxc.apparmor.profile: unconfined
```

Then start the container again:

```bash
pct start <VMID>
```

This is required on LXC hosts where Docker fails with `runc run failed: unable
to apply apparmor profile`. The error often appears halfway through
`npm install`, making it look like an npm or network failure. Read the complete
build log before troubleshooting npm. The `security_opt` entries already in the
Compose file handle runtime, but only the Proxmox-host setting also permits
image builds inside the LXC.

Log in to the LXC, create or choose a normal administration user, then follow
[Option C](#option-c-an-existing-ubuntu-server) from the package installation
through the repository clone. Then continue with section 2.

### Option B: Docker Desktop

Install [Docker Desktop](https://docs.docker.com/desktop/) and use Linux
containers. On Windows, the WSL 2 backend is the normal choice. Start Docker
Desktop and verify it from PowerShell:

```powershell
docker version
docker compose version
```

Clone the repository into a normal development directory:

```powershell
git clone https://github.com/Snille/Mimers-Brain.git
Set-Location Mimers-Brain
Copy-Item .env.example .env
```

In a macOS terminal, use `cd Mimers-Brain` and `cp .env.example .env` instead
of the two PowerShell-specific commands.

For access from the same computer, use these addresses in `.env`:

```dotenv
CITATION_BASE_URL=http://localhost:8790/thoughts
PUBLIC_URL=
LAN_URL=http://localhost:8790
```

Continue with section 2. The PowerShell equivalents for the start and verify
commands are included there.

The Compose file publishes both ports on the host. The URLs above do not make
them loopback-only, so keep unsolicited inbound access blocked in the host
firewall when this is only a local development instance.

Docker Desktop is excellent for development and evaluation. For an always-on
installation, Ubuntu Server or a dedicated Proxmox guest is easier to operate
and back up.

### Option C: an existing Ubuntu Server

These commands follow Docker's official apt-repository installation. Skip the
Docker installation if `docker version` and `docker compose version` already
work.

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Log out and back in so the Docker group membership takes effect, then verify:

```bash
docker version
docker compose version
docker run --rm hello-world
```

Membership in the `docker` group is effectively root access to the host. Only
add trusted administrators.

Check that the application ports are free, then clone the repository:

```bash
sudo ss -ltnp | grep -E ':(8790|8791)\b' || true
git clone https://github.com/Snille/Mimers-Brain.git ~/mimers-brain
cd ~/mimers-brain
cp .env.example .env
```

## 2. Configure Mimers Brain

Open `.env` in an editor. The file is gitignored and must never be committed.
At minimum, set these values:

| Variable | Required | Purpose |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | yes | password for the private database container |
| `MCP_ACCESS_KEY` | yes | full API/MCP access, including the vault |
| `OPENROUTER_API_KEY` | strongly recommended | embeddings, semantic search and metadata extraction |
| `CITATION_BASE_URL` | yes for correct links | base used when a client receives a link to a memory |
| `PUBLIC_URL` | when publicly proxied | address shown in the Connect page |
| `MCP_OPEN_KEY` | optional | URL key for open-tier clients that cannot send headers |
| `CORS_ORIGINS` | for OpenAPI tool servers | browser origins allowed to call `/openapi.json` and `/tools/*`, comma separated |

Use long hexadecimal values for the database password and access keys. Hex is
both strong and safe inside the PostgreSQL connection URL.

Linux:

```bash
openssl rand -hex 32
```

PowerShell:

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Generate separate values for `POSTGRES_PASSWORD`, `MCP_ACCESS_KEY`, and—if you
enable it—`MCP_OPEN_KEY`. Never reuse `MCP_ACCESS_KEY` as `MCP_OPEN_KEY`: URL
keys are stored in client configuration and may reach proxy logs, while the
full key unlocks the vault.

For a LAN-only server at a documentation address such as `192.0.2.41`:

```dotenv
CITATION_BASE_URL=http://192.0.2.41:8790/thoughts
PUBLIC_URL=
LAN_URL=
```

`LAN_URL` should normally remain empty. The server learns its usable LAN address
when the full UI is visited; set `LAN_URL` only when you want to force a specific
hostname. If you have a public reverse proxy, use its HTTPS address instead:

```dotenv
CITATION_BASE_URL=https://brain.example.net/thoughts
PUBLIC_URL=https://brain.example.net
LAN_URL=
```

The remaining variables are optional. Leave `MQTT_URL` empty unless Home
Assistant integration is wanted. Set `STATS_TZ` to the installation's IANA time
zone, for example `Europe/Stockholm` or `America/New_York`.

## 3. Start the stack

From the repository root:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

The first start downloads images, builds the application and initializes the
database. Later starts reuse the named volume. Wait until `valv-db` is healthy
and `valv-app` is running.

On Windows, the same commands work in PowerShell:

```powershell
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

Open <http://localhost:8790> on Docker Desktop, or
`http://<server-LAN-address>:8790` on a server, and sign in with
`MCP_ACCESS_KEY`.

Verify both listeners on Linux:

```bash
curl -fsS http://127.0.0.1:8790/healthz
curl -fsS http://127.0.0.1:8791/healthz
```

On Windows, use `curl.exe` to avoid PowerShell's historical `curl` alias:

```powershell
curl.exe -fsS http://127.0.0.1:8790/healthz
curl.exe -fsS http://127.0.0.1:8791/healthz
```

The first response should identify the `full` listener and the second the
`open` listener.

## 4. Network and reverse proxy

Keep port `8790` reachable only from trusted LAN or VPN clients. Published
Docker ports can bypass uncomplicated UFW rules, so enforce this boundary with
the Proxmox firewall, router/VLAN firewall, or Docker's `DOCKER-USER` chain—not
with UFW assumptions alone.

Public access is optional. If enabled:

1. create a DNS record for a hostname such as `brain.example.net`;
2. terminate TLS at the reverse proxy;
3. forward that host to `http://<server-LAN-address>:8791`;
4. never forward it to `8790`;
5. use [docs/nginx-brain.conf](docs/nginx-brain.conf) as the nginx/Nginx Proxy
   Manager template.

If forward authentication such as Authelia protects the web UI, `/mcp` must
bypass the interactive login because MCP clients authenticate with bearer keys.
The same applies to `/openapi.json` and `/tools/`, used by OpenAPI tool servers
such as Open WebUI: behind forward auth they would receive the login page's HTML
instead of JSON. The OAuth discovery paths in the supplied nginx configuration
deliberately return `404`, allowing clients to fall back cleanly when no OAuth
server exists.

Leave CORS to the application. It emits the headers itself for the origins in
`CORS_ORIGINS`; an `add_header Access-Control-Allow-Origin` in the proxy on top
of that produces a duplicate header, which browsers reject outright.

Do not publish the open-tier web UI without deciding how it will be protected.
The supplied nginx example puts the UI behind forward authentication. Without
such an authenticator, proxy only `/mcp` and `/healthz`, or keep port `8791`
private; otherwise browser sign-in would send the full `MCP_ACCESS_KEY` through
the public endpoint even though that listener can return only open-tier data.

## 5. Backups

Container images are disposable; the named database volume is not. Back up the
database even when the Proxmox guest or Docker Desktop data disk is also backed
up.

`backup.sh` creates a compressed logical `pg_dump`, validates it and retains ten
copies. It defaults to `/home/mimer/valv-backups`; override `BACKUP_DIR` when the
service account has a different home directory.

```bash
chmod +x backup.sh restore.sh
BACKUP_DIR="$HOME/valv-backups" ./backup.sh
ls -lh "$HOME/valv-backups/"
```

Example nightly cron entry:

```cron
10 0 * * * BACKUP_DIR=/home/mimer/valv-backups /home/mimer/mimers-brain/backup.sh >> /home/mimer/valv-backups/backup.log 2>&1
```

Replace `/home/mimer` in all three places if the installation uses another
service account. If `POSTGRES_USER` or `POSTGRES_DB` was changed from the
example defaults, also set `DB_USER` or `DB_NAME` in the cron command.

Test restoring before the backup is needed. `restore.sh` replaces the current
database contents, so read the script and take a fresh backup before using it:

```bash
./restore.sh "$HOME/valv-backups/valv-YYYYMMDD-HHMM.sql.gz"
```

## 6. Updating

Keep `.env` and the Docker volume in place. From the existing checkout:

```bash
cd ~/mimers-brain
BACKUP_DIR="$HOME/valv-backups" ./backup.sh
git pull --ff-only
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

The application applies required schema additions at startup, including for an
existing volume. The SQL under `db/init.sql` runs only when a brand-new database
volume is created.

On Docker Desktop, run the equivalent commands in PowerShell and omit
`./backup.sh` unless Bash is available; take a Docker Desktop or logical database
backup first.

## Troubleshooting

### The build fails during `npm install` inside an LXC

Search the complete output for `runc run failed` and `unable to apply apparmor
profile`. If present, apply the Proxmox-host AppArmor setting in Option A and
restart the LXC. Changing npm registries will not fix this error.

### The UI opens, but semantic search does not work

Check that `OPENROUTER_API_KEY` is set and that the app was recreated after the
change:

```bash
docker compose up -d
docker compose logs --tail=100 app
```

Without embeddings, list and text search still work, but semantic search does
not.

### The database suddenly appears empty

Stop before writing new data. Check that `name: mimers-valv` is still present at
the top of `docker-compose.yml` and inspect the volumes:

```bash
docker volume ls | grep valv
docker compose config | grep -A4 volumes
```

A changed Compose project name can attach a new empty volume while the original
still exists. Do not delete either volume until the correct one is identified.

### A changed `.env` value is ignored

Compose must recreate the application container for environment changes:

```bash
docker compose up -d
```

Developers adding a new variable must also pass it under `app.environment` in
`docker-compose.yml`; merely adding a line to `.env` does not automatically put
it inside the container.

### Useful diagnostics

```bash
docker compose ps
docker compose logs --tail=200 app db
docker inspect valv-app --format '{{.State.Status}}'
docker exec valv-db pg_isready
```

## Primary platform documentation

- [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Install the Docker Compose plugin](https://docs.docker.com/compose/install/linux/)
- [Install Docker Desktop](https://docs.docker.com/desktop/)
- [Proxmox Container Toolkit (`pct`)](https://pve.proxmox.com/pve-docs/pct.1.html)
