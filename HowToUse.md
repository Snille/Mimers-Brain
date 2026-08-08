# Using Mimers Brain

*[Svenska](HowToUse.sv.md)*

How to connect an AI model to the memory, and how to set everything up again if a
machine has to be reinstalled.

> **The web interface does this for you.** Open the memory in a browser and go to
> **Connect**: the same instructions as below, but rendered with the running
> instance's own addresses, keys and tool list, with copy buttons. This document
> explains *why* each setting is what it is, and covers the parts a page cannot —
> rebuilding the server, the reverse proxy, a reinstalled laptop. Start with the
> page; come here when something does not behave.

---

## What it is, briefly

Mimers Brain is an **MCP server** (Model Context Protocol) — a standard way for a
language model to call tools. It exposes six:

| Tool | What it does |
| --- | --- |
| `search_thoughts` | Search by meaning, not words. This is the important one. |
| `list_thoughts` | List recent memories, filtered by type, topic, person, time |
| `capture_thought` | Save a new memory |
| `thought_stats` | Totals, types, topics, people |
| `search` + `fetch` | The same thing in the shape ChatGPT and Gemini expect |
| `delete_thought` | LAN listener only |

Anything that speaks MCP can therefore use the memory — you do not build
something per model.

---

## The two addresses

This is the only detail that really matters:

| Address | Contents | Use when |
| --- | --- | --- |
| `http://192.0.2.41:8790/mcp` | open **+ vault** | on the LAN or over VPN |
| `https://brain.example.net/mcp` | **open only** | everything else, and every other model |

The vault — keys, passwords, tokens — is served only by the first. This is not a
setting that can be switched on for the second: the MCP server on 8791 is built
entirely without the ability to reach those rows, so no header, parameter or path
can lift them out. That is why you can point any external model at the public
hostname without thinking about it.

Both require `MCP_ACCESS_KEY` as a bearer token.

### Where the key lives

```bash
ssh <server> 'grep ^MCP_ACCESS_KEY= ~/mimers-brain/.env | cut -d= -f2'
```

---

## Connecting a model

### Claude Code and Claude Desktop are two different clients

The desktop app holds both, which is where most of the confusion starts. The
*Code* pane is Claude Code; the chat pane is Claude Desktop. They keep their MCP
servers in separate registries and neither one sees the other's:

| Client | Registry | Set up through |
| --- | --- | --- |
| Claude Code (the *Code* pane) | `~/.claude.json` | `claude mcp add`, or edit the file |
| Claude Desktop (chat) | account connectors, `claude_desktop_config.json` | *Settings → Connectors* |

A memory that answers in a Code session therefore says nothing about the chat
side, and an empty Connectors list is not a fault — just a registry nobody has
written to.

### Claude Code

```bash
claude mcp add --transport http mimers-brain http://192.0.2.41:8790/mcp --header "Authorization: Bearer <KEY>"
```

Or edit `~/.claude.json` directly — under `mcpServers` at the top level:

```json
"mimers-brain": {
  "type": "http",
  "url": "http://192.0.2.41:8790/mcp",
  "headers": { "Authorization": "Bearer <KEY>" }
}
```

Consider registering **both** addresses as two entries (`mimers-brain` and
`mimers-brain-remote`). The memory then still works when the laptop is off the
home network — open tier only, but better than nothing.

The change takes effect in the next session.

### VS Code (Codex)

The editor opens the connection itself, from your machine — so the LAN address
works and you get the **whole** vault, `delete_thought` included. Which model
answers is irrelevant to reachability; a cloud model does not change where the
MCP client runs.

It does change where the *contents* go. Every vault row a tool returns is placed
in the context and sent to the model provider on the next turn. The tier split
exists to keep keys off third-party clouds, and pointing an editor at 8790 sends
them there the moment a search happens to match a vault row. Worth deciding
deliberately rather than discovering later. Point it at the public hostname
instead and the question does not arise.

```bash
codex mcp add mimers-brain --url http://192.0.2.41:8790/mcp --bearer-token-env-var MIMERS_VALV_KEY
```

That writes `[mcp_servers.mimers-brain]` into `~/.codex/config.toml`. The key
itself stays out of the file — Codex reads it from the named environment
variable at launch, so set that as a user-level variable and restart the editor
so the extension host inherits it.

The `codex` binary ships inside the VS Code extension rather than on `PATH`; on
Windows it is under
`~/.vscode/extensions/openai.chatgpt-*/bin/windows-x86_64/codex.exe`. Verify with
`codex mcp list`.

### Claude Desktop (the chat side)

Remote MCP servers go in under *Settings → Connectors*, as a custom connector.
Menu wording moves between versions, so navigate by *connector* and *custom*
rather than an exact path.

Two limits decide what is actually possible there:

- The URL field takes **https only**. The LAN address is plain http and cannot be
  entered at all.
- The connector is opened from Anthropic's infrastructure, not from your machine,
  so a private address stays unreachable even if you give it an https name.

Which means **the vault tier cannot be reached from the chat side** — and that is
the design holding, not a limitation to work around. 8790 is never exposed
outward; that rule is the whole point of the split. What belongs in a connector
is the public hostname, giving chat the open tier.

The dialog has no field for a header either — only OAuth Client ID and Secret.
Given a URL it cannot authenticate to, the client falls back to the OAuth flow and
fails with a message about not being able to register with the sign-in service.
So the key rides in the URL instead:

```
https://brain.example.net/mcp?key=<MCP_OPEN_KEY>
```

`MCP_OPEN_KEY` is a second key that only the open listener honours, and it must
not be the same value as `MCP_ACCESS_KEY` — see *Authentication* in the
[README](README.md) for why. Set it in `.env` and restart.

**If there is an authenticator in front, one more thing is needed.** The client
asks for OAuth metadata before it sends any JSON-RPC. Behind forward auth those
paths answer 302 to the login page, which answers 200 — so the client decides an
authorization server exists, tries to register with it, and fails with *couldn't
register with the sign-in service*. The URL key never gets a chance, because the
request it would have authenticated is never made. The proxy has to answer 404
there instead; the block is in [docs/nginx-brain.conf](docs/nginx-brain.conf).
Check it with:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://brain.example.net/.well-known/oauth-authorization-server
```

404 is correct. A 302 means the connector will fail no matter what key you give
it. If you would rather
have real sign-in than a shared key, the design for that is in
[docs/oidc-connector-plan.md](docs/oidc-connector-plan.md); it needs an OIDC
provider, which is why it is not the default.

If you do want the vault in chat, bridge it locally instead of opening a port.
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) runs as a stdio server
on your own machine, so it reaches the LAN address over plain http and adds the
header itself:

```json
{
  "mcpServers": {
    "mimers-brain": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://192.0.2.41:8790/mcp",
               "--header", "Authorization: Bearer <KEY>"]
    }
  }
}
```

On Windows that file is at `%APPDATA%\Claude\claude_desktop_config.json`; restart
the app afterwards. Whether a given version still reads `mcpServers` from that
file varies — if the server never appears, keep vault work on the Code side and
let chat have the open tier. That split costs little, since the Code side is
where the vault is usually needed anyway.

### ChatGPT

ChatGPT reads MCP servers as connectors and expects the server to provide
`search` and `fetch` — which exist for exactly this. Point it at the public
hostname with the same bearer header. **Never** use the 8790 address here: it is
not reachable from outside, and if it ever became so the vault would be exposed
to a third party.

### Gemini and others

Same principle: a remote MCP server over HTTP with a bearer token. Anything that
follows the spec works. The `search`/`fetch` pair exists for clients that expect
the simpler search-and-fetch model instead of the named tools.

### Open WebUI, and anything else that speaks OpenAPI instead of MCP

Open WebUI's external tool servers do not speak MCP at all — they read an
OpenAPI document and call plain REST. Mimers Brain therefore describes itself as
well, on the same two listeners and behind the same key:

| | |
| --- | --- |
| `GET /openapi.json` | the document; no key required |
| `POST /tools/<name>` | one endpoint per tool, bearer key required |

The tools are the same memory as `/mcp` with the same tier rule — the open
listener still cannot reach a vault row. `search`/`fetch` are not repeated here;
they exist for MCP clients that expect that pair. The OpenAPI side has
`fetch_thought` instead, and `delete_thought` only on 8790.

In Open WebUI, under **Settings → Tools**, add a server with the URL
`http://192.0.2.41:8791` (`openapi.json` is the default path it looks for), pick
bearer auth and paste the key. The address given here is the LAN one on purpose:
Open WebUI sits on the same network, and going straight there avoids both the
proxy and the authenticator.

**CORS.** The dialog's warning is real — the browser fetches the document from
the page's own origin, so the server has to allow it by name. Put the Open WebUI
origin in `CORS_ORIGINS` in `.env`, scheme and port included, and restart:

```bash
CORS_ORIGINS=http://192.0.2.19:8080,https://llm.example.net
```

Empty is the default and means no browser on another origin gets in, which is
what you want everywhere else. An unlisted origin simply receives no CORS
headers and the browser refuses the response.

Going through the proxy instead of the LAN address works too, but `/openapi.json`
and `/tools/` must be exempt from forward auth the same way `/mcp` is — the
config in `docs/nginx-brain.conf` already does this.

### Checking that it worked

```bash
curl -s -X POST https://brain.example.net/mcp -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Six tools in the response means everything works. A `401` means the key is wrong.
A `302` towards your authenticator means the proxy is sending `/mcp` through
forward auth, which it must not — see the proxy section below.

For the OpenAPI side:

```bash
curl -s http://192.0.2.41:8791/openapi.json | head -20
curl -s -X POST http://192.0.2.41:8791/tools/thought_stats -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" -d '{}'
```

---

## The web interface

| Address | What you see |
| --- | --- |
| `http://192.0.2.41:8790` | everything, including the vault |
| `https://brain.example.net` | open tier only, behind the authenticator |

On 8790 you sign in by pasting `MCP_ACCESS_KEY` once; it is traded for a cookie
that lasts 30 days. From outside the authenticator handles it.

Hovering a memory reveals **Edit**, which opens the content along with its type,
topics and people as comma-separated fields. This is how you correct what the
metadata extractor got wrong — it happily produces two spellings for one topic,
or a person's full name in some rows and their first name in others, and those
filter as separate facets in the sidebar. Merging them is a matter of editing the
text. Topics are lowercased and deduplicated on save; people keep their
capitalisation, being proper nouns.

Editing tags costs nothing. The embedding is computed from the content, so it is
only recomputed when the content itself changes.

Besides the list there are **Connect** and **Statistics** in the main menu.
Connect is this page's setup instructions, filled in with the instance's real
values. Statistics shows usage over time and per client — but note what it can
honestly say: MCP reports the client application, not the model answering inside
it, and the usage log never stores search queries or content. See the README for
how the Home Assistant MQTT sensors carry the same numbers.

---

## If the client machine is reinstalled

The server is unaffected — it is a separate machine with its own backups. Only
the client side is lost:

1. **SSH key.** Create one and put the public half in `~/.ssh/authorized_keys` on
   the server. On Windows, create it through `cmd`, not PowerShell:

   ```powershell
   cmd /c 'ssh-keygen -t ed25519 -C "mimers-brain" -f C:\Users\<you>\.ssh\mimers_brain -N ""'
   ```

   PowerShell turns `-N '""'` into a passphrase consisting of two literal quote
   characters, which makes the key unusable unattended. Then add to
   `~/.ssh/config`:

   ```
   Host brain
       HostName 192.0.2.41
       User <user>
       IdentityFile ~/.ssh/mimers_brain
       StrictHostKeyChecking accept-new
   ```

2. **Fetch the key** with the command near the top.

3. **Register the MCP server** as described above.

That is all. The knowledge lives in the database on the server, not on the
client.

## If the server has to be rebuilt

```bash
git clone <this repo> ~/mimers-brain && cd ~/mimers-brain
cp .env.example .env          # fill in POSTGRES_PASSWORD, MCP_ACCESS_KEY, OPENROUTER_API_KEY
docker compose up -d --build
```

Then restore the most recent dump:

```bash
gunzip -c ~/backups/valv-<latest>.sql.gz | docker exec -i valv-db psql -U <user> -d valv
```

**A new `MCP_ACCESS_KEY` means every client has to be updated.** To avoid that,
reuse the old key from a backup of `.env`.

### Docker inside an LXC

An unprivileged Proxmox LXC cannot apply AppArmor profiles, so every container
start fails — often disguised as an `npm install` error mid-build. Fix it on the
**host**, not in the container:

```bash
echo "lxc.apparmor.profile: unconfined" >> /etc/pve/lxc/<vmid>.conf
pct reboot <vmid>
```

`security_opt: apparmor=unconfined` stays in the compose file as belt and braces,
and is harmless afterwards.

### Reverse proxy

The public hostname points at **8791**. The config must give `/mcp` its own
`location` **without** forward auth, because MCP clients cannot complete an
interactive login — the bearer key is the protection there. It also needs
`proxy_buffering off`, because MCP holds an SSE stream open. The complete config
is in [docs/nginx-brain.conf](docs/nginx-brain.conf).

---

## What belongs in the memory

Write each memory as a **standalone statement** that makes sense years later with
no surrounding context. "It worked" is worthless; "the Lagersystem deploy aborts
if `data/languages/` differs from origin, because the translation tool writes
those files live on the server" is useful.

Put it in the **vault** if it contains a key, a password or a token — or if it
would help an outsider get in. Everything else is open, and open is better: it
reaches you anywhere and can be used by any model.
