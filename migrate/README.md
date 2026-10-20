# Migration

One-time import of existing notes into Mimers Brain.

`import.ps1` reads a tab-separated file where each line is:

```text
<tier><TAB><content>
```

`tier` is `open` or `vault`. Each content is one paragraph with no newlines,
best kept under 1,200 characters (the limit the MCP tools enforce), written as a
standalone statement that makes sense years later without the conversation it
came from.

```powershell
.\import.ps1 -TsvFile notes.tsv -KeyFile <file containing MCP_ACCESS_KEY> [-HostName 192.0.2.41]
```

The script posts to the full listener (port 8790), so imported rows count as
confirmed by you. Re-running is safe: `upsert_thought` matches on a fingerprint of
the normalised content and merges instead of duplicating.

- **No raw secrets.** Vault rows hold sensitive context and `SECRET_REF` pointers.
  The server refuses text shaped like a password, token or key, and that line is
  reported as failed.
- **Keep the `.tsv` files out of git.** They are gitignored because they describe
  real systems.
- **Encoding.** The script sends UTF-8 bytes with an explicit charset.
  `Invoke-RestMethod` otherwise falls back to ISO-8859-1 and every å, ä and ö is
  stored as U+FFFD; that happened once (see `history.md`).

Without an embedding provider configured, rows are saved without a vector and are
marked `NO EMBEDDING`; the nightly maintenance embeds them once a provider is set.
