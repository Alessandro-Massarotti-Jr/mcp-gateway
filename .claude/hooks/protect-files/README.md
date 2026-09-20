# Hook `protect-files`

A `PreToolUse` hook that **lets the agent read** the project's configuration files, but **blocks any attempt to change them**. When it blocks, it gives the model an explicit instruction: stop trying and hand the change to a human to apply.

```diff
  view jest.config.js             -> ok, the agent reads and understands the rules
- edit jest.config.js             -> denied
- echo "{}" > .prettierrc.json    -> denied
- sed -i 's/50/0/' jest.config.js -> denied
```

See [../README.md](../README.md) for the overview of this repository's hooks, and the [official Claude Code hooks reference](https://code.claude.com/docs/en/hooks) for the runtime contract.

---

## Files

| File                                         | Role                                           |
| -------------------------------------------- | ---------------------------------------------- |
| [`../../settings.json`](../../settings.json) | Hook registration (the file Claude Code reads) |
| [`protect-files.mjs`](protect-files.mjs)     | Node script that decides `allow`/`deny`        |
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
        "matcher": "[Ww]rite|[Ee]dit|[Nn]otebook|[Bb]ash|[Pp]ower[Ss]hell|[Ss]hell|[Cc]md|[Tt]erminal|apply_patch|create_file|str_replace",
        "hooks": [
          {
            "type": "command",
            "statusMessage": "protect-files",
            "command": "node",
            "args": [
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/protect-files/protect-files.mjs",
              "--paths=.eslintrc*,eslint.config.*,...",
              "--allow=",
              "--message="
            ],
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Details of this registration form:

- **`command` + `args` (exec form).** With `args` present, `command` is resolved as an
  executable and called **without a shell**: each item becomes an exact argument, with no
  quoting and no expansion. **`timeout` is in seconds** (it used to be `timeoutSec`) and
  **there is no per-hook `env` field**, hence the configuration coming through `args`.
- **The refusal goes out in `hookSpecificOutput.permissionDecision`**, not at the top of the
  object. At the top it fails schema validation and becomes a _non-blocking_ error, which means
  the write would go through. The script also exits with **exit 2**, which on `PreToolUse`
  blocks on its own even if stdout is discarded.
- **The `matcher` is only treated as a regular expression** when it contains a character outside
  `[A-Za-z0-9_- ,|]`; with letters and `|` only it becomes a list of **exact** names. The `[Ww]`
  in the pattern above are there to keep it on the regex path, which makes a single pattern
  catch `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash` and `PowerShell` at once.

The `matcher` is the first sieve — it limits the hook to write tools, avoiding the cost of a Node process on every read. The script **revalidates on its own**: even if the matcher is widened to `*`, read tools (`view`, `grep`, `glob`, `web_fetch`, …) pass in silence.

---

## Configuration (through `args` in settings.json)

| Argument     | Equivalent environment variable | Default                        | What it does                                                             |
| ------------ | ------------------------------- | ------------------------------ | ------------------------------------------------------------------------ |
| `--paths=`   | `PROTECT_FILES_PATHS`           | lint + jest + prettier (below) | Comma-separated list of the protected files                              |
| `--allow=`   | `PROTECT_FILES_ALLOW`           | _(empty)_                      | Exceptions: they match `PATHS` but stay editable                         |
| `--message=` | `PROTECT_FILES_MESSAGE`         | _(empty)_                      | Extra text appended to the block reason (e.g. who to ask for the change) |

The argument beats the environment variable, which beats the default. An **empty** value
(`--allow=`) means "no exception", not "fall back to the default". The environment variable
still exists because it is what `selftest.mjs` uses; day to day, configure through `args`.

**In this repository** `--paths=` also includes `tsconfig.json` and `tsconfig.*.json`. They
were not on the original list, but `verify-changes` explicitly forbids loosening the TypeScript
config to make the build pass; protecting both files makes the rule hold in practice, instead of
relying on the agent obeying the text. To go back to the original behavior, remove the last two
patterns from `--paths=` in `.claude/settings.json`.

### Protected by default

```
.eslintrc*        eslint.config.*     .eslintignore
jest.config.*     jest.setup.*
.prettierrc*      prettier.config.*   .prettierignore
```

### Pattern syntax

- Without a slash → compared against the **file name**, in any folder: `jest.config.*` catches `jest.config.js` and `packages/api/jest.config.ts`.
- With a slash → compared against the **path**: `config/jest.config.js` catches only that one; `other/jest.config.js` passes.
- Wildcards: `*` (inside a segment), `**` (crosses folders), `?` (one character).
- The comparison ignores case and normalizes `\` → `/`, `./`, `C:` and absolute paths — a Windows path and a POSIX one both match `jest.config.*`.

### Example: protect the TypeScript config too, freeing the test one

```json
"args": [
  "${CLAUDE_PROJECT_DIR}/.claude/hooks/protect-files/protect-files.mjs",
  "--paths=.eslintrc*,eslint.config.*,jest.config.*,.prettierrc*,tsconfig*.json",
  "--allow=tsconfig.test.json",
  "--message=Changes to these files go through platform team review."
]
```

---

## How it works

1. Claude Code is about to run a write tool and, **before** that, hands the `PreToolUse` payload to the hook's `stdin`.
2. The script classifies the tool:
   - **read** (`view`, `grep`, `glob`, `task`, `web_*`, …) → allowed straight away, nothing analyzed;
   - **shell** (`bash`, `powershell`) → the command is analyzed;
   - **anything else** → treated as a write.
3. It walks the arguments and applies two different rules:

| Field type | Examples                                     | Rule                                                   |
| ---------- | -------------------------------------------- | ------------------------------------------------------ |
| Path field | `path`, `file_path`, `notebook_path`, `dest` | Matched the list → **deny**                            |
| Free text  | `command`, `content`, `input` (patch)        | Matched the list **and** has a write marker → **deny** |

The split exists for a concrete case: writing a `README.md` that _mentions_ the Jest config is not changing the Jest config. Without a write marker along with it, the text passes.

4. Write markers recognized in free text:

   - redirection (`>`, `>>`) — `2>&1` and `->` do not count;
   - `rm`, `mv`, `cp`, `tee`, `truncate`, `dd`, `touch`, `chmod`, `ln`, `patch`, …;
   - in-place editing: `sed -i`, `perl -pi`;
   - `git checkout|restore|apply|rm|mv|reset|clean|stash|revert`;
   - `prettier --write`, `eslint --fix`, `npm pkg set`;
   - PowerShell: `Set-Content`, `Out-File`, `Remove-Item`, `Move-Item`, `New-Item`, …;
   - Node/Python: `writeFileSync`, `appendFile`, `open(..., 'w')`, `[IO.File]::Write`;
   - patch headers: `*** Update File:`, `--- a/`, `+++ b/`, `diff --git`.

5. When denying, it prints one line and exits with `0`:

```json
{
  "permissionDecision": "deny",
  "permissionDecisionReason": "[protect-files] jest.config.js is a protected file..."
}
```

6. When allowing, it **prints nothing** and exits with `0` — silence means "the runtime's default decision". Emitting `allow` would be worse: it would pre-approve calls that should go through the normal permission flow.

---

## What the agent sees when blocked

The `permissionDecisionReason` goes straight to the model. It says, in this order:

> `[protect-files] jest.config.js is a protected file of this repository: the agent may read it, but may not change it. The call was blocked (tool `edit`) and nothing was written. What to do now: do NOT try another route (shell, redirection, patch, rename, script, subagent) - the same hook blocks them all. Carry on with the rest of the task that does not depend on this change and, at the end, hand the human an explicit change request with (1) the file and the exact excerpt, (2) the proposed diff, (3) the reason and what breaks without it, (4) how to validate it once applied.`

Three things on purpose:

- **it says nothing was written** — without that the agent carries on as if the edit had happened and the rest of the plan goes wrong;
- **it closes the workarounds explicitly** — the model's natural reaction to a denied `edit` is to try `bash`, then `apply_patch`. Saying that all of them hit the same hook saves that round of attempts;
- **it tells the agent to carry on** — one blocked file is no reason to abandon the whole task.

The text is ASCII with no accents, as in [`mask-env`](../mask-env/README.md): the message crosses JSON, a shell and two operating systems before reaching the model.

---

## Behavior on failure

`PreToolUse` is **fail-closed** by the runtime's definition: a crash, a non-zero exit or invalid output denies the tool call. The script aligns with that predictably:

| Situation                                       | Result                                                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Valid payload, protected file                   | `deny` with a reason                                                                                                  |
| Valid payload, ordinary file                    | silence (allowed)                                                                                                     |
| Empty `stdin` (manual run, outside the runtime) | silence — there is no tool call to deny                                                                               |
| `stdin` present but unreadable                  | `deny`, with a reason asking to tell the human                                                                        |
| Internal exception                              | `deny`, quoting the error name                                                                                        |
| **Timeout**                                     | **fail-open** — the runtime allows the tool. Hence `timeout: 10` (seconds) with a script free of disk and network I/O |

If the hook starts denying _everything_, the off switch is removing its entry from
[`../../settings.json`](../../settings.json), which leaves the other three hooks active. To turn
all of them off at once, use `"disableAllHooks": true` at the root of the same file.

---

## Known limitations

- **Broad destructive commands are not detected.** `git checkout .`, `git reset --hard`, `rm -rf .` do not name the protected file, so they pass. The hook protects against a targeted change, not against a repository reset.
- **The shell block errs on the safe side.** Piping a protected file into a copy elsewhere is denied: there is a protected file and a redirection on the same line, and the script does not simulate the shell to find out which one is the destination. Copy it another way or use the read tool.
- **It applies to the agent only.** It is a session hook, not a filesystem permission. The human (and any script outside the session) keeps editing normally — which is exactly the intent.

---

## Tests

```bash
node .claude/hooks/protect-files/selftest.mjs
```

41 cases covering blocking through a write tool, workarounds through the shell (redirection, `sed -i`, `git checkout`, PowerShell, `node -e`, `apply_patch`), allowed reads, both payload formats (camelCase and snake_case), absolute Windows and Linux paths, the three configuration variables and the output contract.
