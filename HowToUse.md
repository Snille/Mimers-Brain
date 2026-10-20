# Using Mimers Brain

*[Svenska](HowToUse.sv.md)*

How to connect a model to the memory, what to put in it, and how to reconnect
after a reinstall. Installing the server is in [install.md](install.md).

> **Start with the Connect page.** Open the web UI and go to **Connect**: the
> same instructions as below, filled in with your instance's addresses, keys and
> tool list, with copy buttons. This document explains the choices and covers
> what the page cannot.

## Pick an address

| Address | Reaches | Use for |
| --- | --- | --- |
| `http://192.0.2.41:8790/mcp` | open **+ vault** | your own clients on the LAN or VPN |
| `https://brain.example.net/mcp` | open only | everything else, including cloud-run clients |
| `http://192.0.2.41:8792/mcp` | open, **read only** | a model that should look things up but not write |

| Key | Opens |
| --- | --- |
| `MCP_ACCESS_KEY` | 8790 and 8791, as a bearer header |
| `MCP_OPEN_KEY` | 8791 only, as `?key=` in the URL, for clients without a header field |
| `MCP_READ_KEY` | 8792 only, as a header or `?key=` |

The open address cannot reach the vault however it is called, so any external
model can be pointed at it safely.

**Decide deliberately before giving a cloud model the vault.** The vault address
works from any client running on your machine, but every vault memory a search
returns goes into the model's context and so to the model provider. Point a
client at the open address when that matters.

On the read-only port the model is told it cannot save anything, so it asks you
instead of promising to remember.

## Connect a client

### Claude Code

```bash
claude mcp add --transport http mimers-brain http://192.0.2.41:8790/mcp --header "Authorization: Bearer <MCP_ACCESS_KEY>"
```

This writes to `~/.claude.json` under `mcpServers`. Adding the public address as a
second entry (`mimers-brain-remote`) keeps the open tier available off the home
network. New sessions pick up the change.

Optional: the [recall hook](tools/hooks/README.md) brings relevant memories to
each prompt without the model having to search.

**Claude Code and Claude Desktop are separate clients**, even inside the same
desktop app. The *Code* pane uses `~/.claude.json`; the chat pane uses account
connectors. A server added to one does not appear in the other.

### Codex (VS Code)

```bash
codex mcp add mimers-brain --url http://192.0.2.41:8790/mcp --bearer-token-env-var MIMERS_VALV_KEY
```

This writes `[mcp_servers.mimers-brain]` to `~/.codex/config.toml`. The key stays
out of the file: set `MIMERS_VALV_KEY` as a user environment variable and restart
VS Code. The `codex` binary ships inside the extension
(`~/.vscode/extensions/openai.chatgpt-*/bin/<platform>/codex`); check with
`codex mcp list`. If Codex ignores server instructions, put the memory policy
from the Connect page in `~/.codex/AGENTS.md`.

### Claude Desktop (chat)

Add a custom connector under *Settings → Connectors*. Two limits apply: the URL
must be **https**, and the connection is made from Anthropic's servers, not your
machine. So chat can reach the **open tier only**, through the public hostname.
The dialog has no header field, so the key goes in the URL:

```text
https://brain.example.net/mcp?key=<MCP_OPEN_KEY>
```

If an authenticator is in front, the proxy must answer **404** on
`/.well-known/oauth-*`, or the connector fails with *couldn't register with the
sign-in service*. Check:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://brain.example.net/.well-known/oauth-authorization-server
```

`404` is right; `302` means the connector will fail. The template in
[docs/nginx-brain.conf](docs/nginx-brain.conf) handles this.

To use the vault from chat anyway, bridge locally with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) in
`claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows) and restart the
app. Not every version reads this file; if the server never appears, keep vault
work in Claude Code.

```json
{
  "mcpServers": {
    "mimers-brain": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://192.0.2.41:8790/mcp",
               "--header", "Authorization: Bearer <MCP_ACCESS_KEY>"]
    }
  }
}
```

### ChatGPT, Gemini and other MCP clients

Use the public address with a bearer header. Clients that expect a simple
search-and-fetch pair get `search` and `fetch`. Never give a cloud client the
8790 address.

### Open WebUI and other OpenAPI clients

Open WebUI's tool servers speak OpenAPI, not MCP. The same tools are served as
REST on every listener:

| | |
| --- | --- |
| `GET /openapi.json` | the description; no key needed |
| `POST /tools/<name>` | one endpoint per tool; bearer key required |

In Open WebUI, *Settings → Tools*: add `http://192.0.2.41:8791`, choose bearer
auth and paste `MCP_ACCESS_KEY`. Then allow the Open WebUI page's origin in `.env`
and run `docker compose up -d`:

```dotenv
CORS_ORIGINS=http://192.0.2.19:8080,https://llm.example.net
```

Through the proxy instead, `/openapi.json` and `/tools/` must bypass forward
auth; the nginx template does this.

### A read-only client

```bash
claude mcp add --transport http mimers-brain-read http://192.0.2.41:8792/mcp --header "Authorization: Bearer <MCP_READ_KEY>"
```

To reach 8792 from outside, forward a second hostname to it.

### Check the connection

```bash
curl -s -X POST https://brain.example.net/mcp \
  -H "Authorization: Bearer <MCP_ACCESS_KEY>" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A tool list means it works: 10 tools on the open port, 13 on 8790, 7 on 8792.
`401` means a wrong key. A `302` to your authenticator means the proxy sends
`/mcp` through forward auth; it must not.

## How a model should use the memory

Each client receives a short usage policy when it connects, and the full policy
from `memory_digest`. The Connect page shows the policy for clients that ignore
server instructions; paste it into their system or global instructions.

The essentials:

- **Start** a session with `memory_digest`.
- **Search** with `search_thoughts` before answering about your systems, and
  before any build, deploy or credential step.
- **Report** every search that returned results with `report_memory_usage`:
  its `trace_id` and which ids were used and ignored. Three searches mean three
  reports. A search without a report shows as *awaiting report*, and as overdue
  after ten minutes.
- **Check history.** `fetch` can return a superseded memory; when `superseded_by`
  is set, fetch that one instead.
- **Save** only durable, verified knowledge that would change a future answer,
  one subject per memory. Agent-written memories start as pending evidence until
  you review them. Set `user_confirmed` only when you approved that exact text.
- **Correct** with `supersede_thought` rather than adding a contradicting memory.
- **Long text** (1,200 characters or more) goes through `preview_ingest` and
  `apply_ingest`.

## What belongs in the memory

Write each memory as a **standalone statement** that makes sense years later.
"It worked" is worthless; "the Lagersystem deploy aborts if `data/languages/`
differs from origin, because the translation tool writes those files on the
server" is useful.

- **Do save:** where things are and how to reach them, decisions and their
  reasons, procedures, and traps that cost time.
- **Do not save:** project status, completed work, release notes or session
  history. Those belong in the repository's README and history files.
- **Vault:** sensitive context, and `SECRET_REF` pointers to where a key,
  password or token is kept. Never the value itself; the server refuses
  credential-shaped text. Everything else is open, which is better: any model can
  use it from anywhere.

## Editing in the web UI

Hover a memory on **Thoughts** and choose **Edit** to change its text, title,
summary, kind, lifecycle, task status, project, topics, people, systems, tier or
verification date, or to pin it into the session digest. Saving re-embeds the memory, since the title and
summary are part of what search compares. **Copy reference** copies the id and
title as one line to paste into a chat with a connected model, followed by what
should change.

## Reconnecting after a reinstall

**A client machine** keeps nothing important: the knowledge is on the server.
Register the MCP server again, as above. To fetch a key from the server:

```bash
ssh <server> 'grep ^MCP_ACCESS_KEY= ~/mimers-brain/.env | cut -d= -f2'
```

On Windows, create an SSH key from `cmd`, not PowerShell, which turns `-N '""'`
into a passphrase of two quote characters:

```powershell
cmd /c 'ssh-keygen -t ed25519 -C "mimers-brain" -f C:\Users\<you>\.ssh\mimers_brain -N ""'
```

**The server:** install as in [install.md](install.md), then restore the latest
dump with `./restore.sh`. Reuse the old `.env` if you have it; a new
`MCP_ACCESS_KEY` means updating every client.
