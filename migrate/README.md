# Migration

One-time import of existing knowledge into Mimers Brain.

`import.ps1` reads a tab-separated file where each line is:

```
<tier><TAB><content>
```

`tier` is `open` or `vault`. The content is one paragraph, no newlines — write it
as a standalone statement that makes sense years later with no surrounding
conversation, because that is exactly how it will be read.

```powershell
.\import.ps1 -TsvFile systeminfo.tsv -KeyFile <fil med MCP_ACCESS_KEY>
```

The import is idempotent: `upsert_thought` dedupes on a fingerprint of the
normalised content, so re-running merges metadata rather than duplicating rows.

## The .tsv files are gitignored

They carry real credentials in their `vault` rows. They stay on disk as a record
of what was imported and are never committed. The vault itself is the source of
truth, and it is backed up nightly.

## Encoding

`import.ps1` sends the body as UTF-8 bytes with an explicit charset. This is not
optional: `Invoke-RestMethod` silently falls back to ISO-8859-1 when the charset
is missing, and every å/ä/ö lands in the database as U+FFFD. It happened once
already — see `history.md`.
