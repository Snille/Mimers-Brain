# Claude Code hooks

## mimer-recall.py — memories brought to the prompt

A `UserPromptSubmit` hook. Every prompt you send is searched once in Mimers
Brain, and up to three memories above a similarity floor are added to the
model's context before it answers. A miss adds nothing. The idea is OB1's
*live retrieval* recipe; the reason here is that "search before you act" is a
rule models follow unevenly, and a hook does not depend on the model
remembering it.

What it costs: one embedding call per prompt (fractions of a cent) and about
half a second before the answer starts. What it never does: store the prompt,
create a recall receipt, or embed a prompt that contains a credential — the
server checks it against the same secret gate as every write and skips it.

### Install

1. Copy the script somewhere stable:

   ```bash
   cp tools/hooks/mimer-recall.py ~/.claude/hooks/
   ```

2. Put the key for the listener in the environment as `MIMERS_BRAIN_TOKEN`
   (on Windows a user variable; restart Claude afterwards). The full listener
   key also brings vault memories; the open key only open ones.

3. Add the hook to `~/.claude/settings.json`, with your brain's LAN address:

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

   Use the LAN address: through the reverse proxy `/api` sits behind forward
   auth, which a script cannot pass.

### Tuning

`RECALL_HINT_FLOOR` in the server's `.env` sets the semantic floor (default
`0.5`). Lower finds more and interrupts more. On the Statistics page the calls
show up as `hook.recall` from the client `mimer-recall`.

### Behaviour worth knowing

- Prompts shorter than 12 characters and slash commands are not searched.
- A memory shown once in a session is not shown again in that session.
- If the server cannot be reached, the hook stays silent and does not try again
  for ten minutes, so working away from the LAN costs nothing per prompt.
