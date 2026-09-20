# Hook `guard-commands`

A `PreToolUse` hook that **blocks destructive or irreversible commands** before the shell runs. When it blocks, it gives the model an explicit instruction: stop trying and report to the human _which_ command you tried to run and _why_, so they can run it manually if they agree.

```diff
  git status                  -> ok
  npm test && npm run build   -> ok
- git push                    -> denied
- git push --force            -> denied
- npm test && git push        -> denied
- git reset --hard HEAD~1     -> denied
```

See [../README.md](../README.md) for the overview of this repository's hooks, and the [official Claude Code hooks reference](https://code.claude.com/docs/en/hooks) for the runtime contract.

---

## Files

| File                                         | Role                                           |
| -------------------------------------------- | ---------------------------------------------- |
| [`../../settings.json`](../../settings.json) | Hook registration (the file Claude Code reads) |
| [`guard-commands.mjs`](guard-commands.mjs)   | Node script that decides `allow`/`deny`        |
| [`selftest.mjs`](selftest.mjs)               | Test suite for the script                      |
| `README.md`                                  | This document                                  |

Claude Code reads the configuration from `.claude/settings.json` (versioned, applies to the whole project). This folder holds only the hook code.

---

## How it is registered

In `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "[Bb]ash|[Pp]ower[Ss]hell|[Ss]hell|[Cc]md|[Tt]erminal|run_command|execute_command|exec_command",
        "hooks": [
          {
            "type": "command",
            "statusMessage": "guard-commands",
            "command": "node",
            "args": [
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-commands/guard-commands.mjs",
              "--deny=git push,git branch -D,...",
              "--allow=git push --dry-run"
            ],
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Three details of this registration form:

- **`command` + `args` (exec form).** With `args` present, `command` is resolved as an
  executable and called **without a shell** — each `args` item becomes an exact argument, with
  no quoting, no expansion, no `$` interpretation. That is why a list of rules with spaces goes
  through whole, with no escaping.
- **`${CLAUDE_PROJECT_DIR}`** is the root of the project where the session started, so the hook
  works whatever the agent's directory is at the time of the call.
- **`timeout` is in seconds** (it used to be `timeoutSec`), and **there is no per-hook `env`
  field** — hence the configuration coming through `args`.

The `matcher` is only treated as a regular expression when it contains a character outside
`[A-Za-z0-9_- ,|]`; with letters and `|` only it becomes a list of **exact** names. The `[Bb]`
are there to keep it on the regex path.

The `matcher` is the first sieve — it limits the hook to execution tools, avoiding the cost of a Node process on every read. The script **revalidates on its own**: even if the matcher is widened to `*`, read tools (`view`, `grep`, `glob`, …) and file-writing tools (`create`, `edit`, `apply_patch`) pass in silence — file writing is the business of [`protect-files`](../protect-files/README.md).

---

## Configuration (through `args` in settings.json)

| Argument   | Equivalent environment variable | Default              | What it does                                   |
| ---------- | ------------------------------- | -------------------- | ---------------------------------------------- |
| `--deny=`  | `GUARD_COMMANDS_DENY`           | the list below       | Refused commands, comma-separated              |
| `--allow=` | `GUARD_COMMANDS_ALLOW`          | `git push --dry-run` | Exceptions: they match `DENY` but stay allowed |

The argument beats the environment variable, which beats the default. An **empty** value
(`--allow=`) means "no exception" — not "fall back to the default". The environment variable
still exists because it is what the `selftest.mjs` suites use; day to day, configure through
`args`.

`ALLOW` is evaluated **before** `DENY`: whatever matches an exception is never even compared against the refusal list.

### Refused by default

```
git push                git reset --hard        git checkout -f
git clean -f            git branch -D           git filter-branch
git stash drop          git stash clear         git update-ref -d
git reflog delete       rm -rf                  npm publish
npm install             npm ci                  Remove-Item -Recurse -Force
```

### Rule syntax

Each rule is a command written the way you would type it. The script splits it into **words** and **flags**:

- **Words** (`git`, `push`) must appear **in order**, anywhere in a segment. Between them there may only be flags and their values — which is why `git -c user.name=bot push` matches `git push`, but `git commit -m "push manual"` does **not**.
- **Flags** (`--hard`, `-f`) may appear in any position. Short flags match whether they are joined or separate: `-f` catches `-fd`, `-rf` and `-r -f`.
- Short flags are **case-sensitive** on purpose: the rule `git branch -D` does not block `git branch -d`.
- The wildcards `*` and `?` work on any token: `terraform destr*`, `git push origin refs/*`.
- A more specific rule narrows the block: swapping `git push` for `git push --force` frees the normal push and stops only the forced one.

### Example: allow the push, stop only what rewrites history

```json
"args": [
  "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-commands/guard-commands.mjs",
  "--deny=git push --force,git push -f,git filter-branch,npm publish",
  "--allow=git push --force-with-lease"
]
```

---

## How it works

1. Claude Code is about to run a shell tool and, **before** that, hands the `PreToolUse` payload to the hook's `stdin` — one call per invocation:

   ```json
   {
     "hook_event_name": "PreToolUse",
     "session_id": "...",
     "cwd": "...",
     "tool_name": "Bash",
     "tool_input": { "command": "git push --force", "description": "..." }
   }
   ```

   `toolCallsOf()` also accepts a batch format (`toolCalls: [{ name, args }]`, with `args` as a JSON string). No runtime used here delivers that, but supporting it costs nothing and covers an MCP tool that decides to batch calls.

2. The script picks what to analyze: only the command fields (`command`, `script`, `exec`, `args`, …). If the tool has none of them, it falls back to every text. That avoids stopping a `description` that merely _mentions_ the command.
3. It breaks the command into **segments** by `|`, `||`, `&&`, `;`, `&`, `$( )`, backticks, parentheses and line breaks — each segment is a command of its own. That is what keeps `npm test && git push` from escaping.
4. Segments that only print text (`echo`, `printf`) are ignored — except when the output is piped into an interpreter (`| bash`, `| node`, `| iex`), in which case the whole command is evaluated again.
5. For each segment: if it matches `ALLOW`, it goes on; if it matches `DENY`, it is denied.
6. When denying, it answers through **three channels**, so that no change in how the runtime reads things turns a block into a silent pass:

   - JSON on `stdout`, with the decision **inside `hookSpecificOutput`** — at the top of the object it would fail schema validation and become a _non-blocking_ error, that is, the command would run:
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "PreToolUse",
         "permissionDecision": "deny",
         "permissionDecisionReason": "[guard-commands] command blocked: `git push --force`..."
       }
     }
     ```
   - the same reason on `stderr`;
   - **exit code 2**, which on `PreToolUse` blocks on its own, even if `stdout` is discarded. The runtime uses the JSON's `permissionDecisionReason` as the message when it exists, and falls back to `stderr` when it does not.

7. When allowing, it **prints nothing** and exits with `0` — silence means "the runtime's default decision". Emitting `allow` would be worse: it would pre-approve calls that should go through the normal permission flow.

---

## What the agent sees when blocked

The `permissionDecisionReason` goes straight to the model:

> ``[guard-commands] command blocked: `git push --force origin main`. It matches the `git push` rule of destructive/irreversible commands of this repository, it was not executed and nothing changed. What to do now: do NOT try another route (another flag, alias, script, subagent, another shell, git plumbing) - the same hook blocks them all. Carry on with the rest of the task that does not depend on this command and, at the end, tell the human in plain text: (1) the exact command you tried to run, (2) why you wanted to run it now, (3) what stays pending while it does not run. The human decides and runs this command, manually.``

Four things on purpose:

- **it quotes the exact command** — the agent has to pass it on to the human; if the message does not quote it, the agent rebuilds it from memory and gets the flag wrong;
- **it says nothing was executed** — without that the agent carries on as if the push had happened and the rest of the plan goes wrong;
- **it closes the workarounds explicitly** — the model's natural reaction to a denied `git push` is to try another flag, then a script. Saying that all of them hit the same hook saves that round of attempts;
- **it asks for the reason alongside the command** — the human decides with context ("I wanted to publish the branch to open the PR") instead of getting a bare command.

The text is ASCII with no accents, as in [`mask-env`](../mask-env/README.md) and [`protect-files`](../protect-files/README.md): the message crosses JSON, a shell and two operating systems before reaching the model.

---

## Behavior on failure

`PreToolUse` is **fail-closed** by the runtime's definition: a crash, a non-zero exit or invalid output denies the tool call. The script aligns with that predictably:

| Situation                                       | Result                                                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Valid payload, command on the refusal list      | `deny` with a reason                                                                                                  |
| Valid payload, ordinary command                 | silence (allowed)                                                                                                     |
| Empty `stdin` (manual run, outside the runtime) | silence — there is no tool call to deny                                                                               |
| `stdin` present but unreadable                  | `deny`, with a reason asking to tell the human                                                                        |
| Internal exception                              | `deny`, quoting the error name                                                                                        |
| **Timeout**                                     | **fail-open** — the runtime allows the tool. Hence `timeout: 10` (seconds) with a script free of disk and network I/O |

If the hook starts denying _everything_, the off switch is removing its entry from
[`../../settings.json`](../../settings.json), which leaves the other three hooks active. To turn
all of them off at once, use `"disableAllHooks": true` at the root of the same file.

---

## Known limitations

- **The config is read when the session opens.** Editing `--deny=` in `settings.json` does not
  affect a session that is already open — restart before testing. To see what the hook decided,
  run the session with the debug log (`claude --debug`), or call the script directly:
  ```bash
  echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push"}}' \
    | node .claude/hooks/guard-commands/guard-commands.mjs
  ```
  Empty output and exit `0` mean the hook ran and **allowed** it.
- **It blocks by written form.** `npm install` is stopped, `npm i` is not — every variant has to be on the list.
- **It does not really understand the shell.** An alias (`alias gp='git push'`), a variable (`CMD="git push"; $CMD`) or base64 escape it. The target is the cooperative agent taking the obvious route, not an adversary.
- **It blocks by form, not by effect.** A destructive command outside the list goes through (`dd`, `truncate`, `DROP TABLE` through `psql`). Keep the list aligned with what the team considers irreversible.
- **It errs on the safe side for compound commands.** `git log && git push` is denied whole — there is no partial execution: the runtime denies the tool call, and not even `git log` runs.
- **It applies to the agent only.** It is a session hook, not a repository protection. The human keeps running everything normally — which is exactly the intent. For a real guarantee on `git push --force`, use branch protection on GitHub.

---

## Tests

```bash
node .claude/hooks/guard-commands/selftest.mjs
```

54 cases covering the commands refused by default, the workarounds (`&&`, `;`, subshell, `bash -c`, `sudo`, `git -c`, `echo | bash`, `exec` + `args`), legitimate commands that must pass, both payload formats (camelCase and snake_case), the batch payload (`toolCalls[]` with `args` as a JSON string, several calls in one invocation), the two configuration variables and the output contract (JSON + stderr + exit 2).
