# Claude Code hooks

## mimer-recall.py — memories brought to the prompt

A `UserPromptSubmit` hook. Each prompt you send is searched once in Mimers Brain,
and up to three memories above a similarity floor are added to the model's
context before it answers. A miss adds nothing. "Search before you act" is a rule
models follow unevenly; a hook does not depend on the model remembering it.

Cost: one embedding call per prompt and about half a second before the answer
starts. It never stores the prompt, never creates a recall receipt, and never
embeds a prompt that contains a credential (the server checks it against the same
secret gate as every write).

### Install

1. Copy the script somewhere stable:

   ```bash
   cp tools/hooks/mimer-recall.py ~/.claude/hooks/
   ```

2. Put the listener's key in the environment variable `MIMERS_BRAIN_TOKEN` (on
   Windows a user variable; restart Claude afterwards). `MCP_ACCESS_KEY` also
   brings vault memories.

3. Add the hook to `~/.claude/settings.json`, with your brain's **LAN** address
   (through the proxy, `/api` sits behind forward auth, which a script cannot
   pass):

   ```json
   "hooks": {
     "UserPromptSubmit": [
       {
         "hooks": [
           {
             "type": "command",
             "command": "python \"$HOME/.claude/hooks/mimer-recall.py\" --url http://192.0.2.41:8790",
             "shell": "bash",
             "timeout": 8
           }
         ]
       }
     ]
   }
   ```

To switch it off, remove that entry.

### Tuning

The floor is the **memory hints** threshold on the Models card (Connect page,
port 8790), default `0.5`. Lower finds more and interrupts more. The card can
measure it against your own questions. `RECALL_HINT_FLOOR` in `.env` still works
when nothing is saved on the card. Calls show on the Statistics page as
`hook.recall` from the client `mimer-recall`.

### Behaviour

- Prompts shorter than 12 characters and slash commands are not searched.
- A memory shown once in a session is not shown again in that session.
- If the server cannot be reached, the hook stays silent and waits ten minutes
  before trying again, so working away from the LAN costs nothing.
