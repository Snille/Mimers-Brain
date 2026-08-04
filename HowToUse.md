# Using Mimers Brain

*[Svenska](HowToUse.sv.md)*

How to connect an AI model to the memory, and how to set everything up again if a
machine has to be reinstalled.

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

### Claude Desktop

Claude Desktop adds remote MCP servers as **connectors** through its settings:
look for *Connectors* and a button to add a custom one. Fill in the URL and add
the key as an `Authorization` header with the value `Bearer <KEY>`.

Menu wording moves between versions, so navigate by *connector* and *custom*
rather than an exact path. Some older versions only accept stdio servers in
`claude_desktop_config.json` and need [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)
as a bridge:

```json
{
  "mcpServers": {
    "mimers-brain": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://brain.example.net/mcp",
               "--header", "Authorization: Bearer <KEY>"]
    }
  }
}
```

On Windows that file is at `%APPDATA%\Claude\claude_desktop_config.json`.

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

### Checking that it worked

```bash
curl -s -X POST https://brain.example.net/mcp -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Six tools in the response means everything works. A `401` means the key is wrong.
A `302` towards your authenticator means the proxy is sending `/mcp` through
forward auth, which it must not — see the proxy section below.

---

## The web interface

| Address | What you see |
| --- | --- |
| `http://192.0.2.41:8790` | everything, including the vault |
| `https://brain.example.net` | open tier only, behind the authenticator |

On 8790 you sign in by pasting `MCP_ACCESS_KEY` once; it is traded for a cookie
that lasts 30 days. From outside the authenticator handles it.

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
