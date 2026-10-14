"""Claude Code hook: bring relevant memories to every prompt, unasked.

Install as a UserPromptSubmit hook (see tools/hooks/README.md). Each prompt the
user sends is searched once in Mimers Brain; clear hits are added to the
model's context as a short list, and nothing at all is added on a miss. The
idea comes from OB1's live-retrieval recipe.

Why a hook and not a rule: the standing rule says "search before you act", and
models follow it unevenly - the memory that would have saved an afternoon sits
unread because nothing made the model look. A hook does not depend on the model
remembering. It only reminds, though: the server returns hits above a similarity
floor, and the model still searches and fetches before it relies on one.

Quiet by design. A short prompt, a slash command or an unreachable server
produces no output and no error, and an unreachable server is not tried again
for ten minutes, so a laptop away from the LAN does not pay a timeout on every
prompt. A memory shown once in a session is not shown again in it.

Configuration:
  --url URL             the brain's base URL, e.g. http://192.0.2.41:8790
                        (or MIMERS_BRAIN_URL)
  MIMERS_BRAIN_TOKEN    bearer key for that listener (environment only, so it
                        never appears in settings.json or a process list)

The full listener (8790) includes vault memories; the open listener (8791)
does not. Through a reverse proxy /api sits behind forward auth, so point the
hook at a LAN address.
"""

import argparse
import json
import os
import pathlib
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request

TIMEOUT_SECONDS = 4
BACKOFF_SECONDS = 600
STATE = pathlib.Path(tempfile.gettempdir()) / "claude-mimer"

PREAMBLE = (
    "Mimers Brain recalled these memories for the user's prompt automatically. "
    "This is a similarity hint, not a search you ran, so no report_memory_usage "
    "receipt is owed for it. They may not matter. If one bears on the task, fetch "
    "it before relying on it, and still run search_thoughts before build, deploy, "
    "connection or credential steps:"
)


def state_file(name: str) -> pathlib.Path:
    return STATE / re.sub(r"[^A-Za-z0-9_.-]", "_", name)


def backing_off(url: str) -> bool:
    try:
        stamp = float(state_file(f"recall-down-{url}").read_text())
    except (OSError, ValueError):
        return False
    return time.time() - stamp < BACKOFF_SECONDS


def mark_down(url: str) -> None:
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        state_file(f"recall-down-{url}").write_text(str(time.time()))
    except OSError:
        pass


def shown_ids(session: str) -> list:
    try:
        return json.loads(state_file(f"recall-shown-{session}.json").read_text())
    except (OSError, ValueError):
        return []


def remember_shown(session: str, ids: list) -> None:
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        state_file(f"recall-shown-{session}.json").write_text(json.dumps(ids[-200:]))
    except OSError:
        pass


def line(hit: dict) -> str:
    tags = [hit.get("kind") or "memory"]
    if hit.get("project"):
        tags.append(hit["project"])
    if hit.get("tier") == "vault":
        tags.append("VAULT")
    if hit.get("evidence_only"):
        tags.append("evidence only")
    if hit.get("age"):
        tags.append(f"AGE: {hit['age']}")
    tags.append(f"{round(float(hit.get('similarity') or 0) * 100)}%")
    summary = hit.get("summary") or ""
    return f"- [{' | '.join(tags)}] {hit.get('title', '')} - {summary} (id {hit.get('id')})"


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--url", default=os.environ.get("MIMERS_BRAIN_URL", ""))
    args, _ = parser.parse_known_args()
    url = args.url.rstrip("/")
    token = os.environ.get("MIMERS_BRAIN_TOKEN", "")
    if not url or not token:
        return

    # Bytes, not text: Windows hands Python a cp1252 stdin, and a Swedish
    # prompt would arrive mangled before it was ever searched.
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except Exception:
        return
    prompt = str(payload.get("prompt") or "").strip()
    if len(prompt) < 12 or prompt.startswith("/"):
        return
    if backing_off(url):
        return

    session = str(payload.get("session_id") or "nosession")
    seen = shown_ids(session)
    request = urllib.request.Request(
        f"{url}/api/recall-hint",
        data=json.dumps({"prompt": prompt, "exclude": seen}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "mimer-recall/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            hits = json.loads(response.read().decode("utf-8")).get("hits") or []
    except urllib.error.HTTPError:
        # The server answered, so it is up; a 401 or 500 is not worth a backoff
        # and not worth a message in front of the user either.
        return
    except Exception:
        mark_down(url)
        return
    if not hits:
        return

    remember_shown(session, seen + [hit.get("id") for hit in hits])
    # ensure_ascii keeps the output safe whatever encoding stdout has.
    print(json.dumps({
        "systemMessage": f"Mimers Brain: {len(hits)} "
                         f"{'memory' if len(hits) == 1 else 'memories'} for this prompt",
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": PREAMBLE + "\n" + "\n".join(line(hit) for hit in hits),
        },
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
