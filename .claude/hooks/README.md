# Hooks in this repository

Four Claude Code hooks, registered in [`../settings.json`](../settings.json). This folder holds
only the code.

| Hook                                         | Event                   | What it does                                                                                                                  |
| -------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [`guard-commands`](guard-commands/README.md) | `PreToolUse`            | Refuses destructive or irreversible commands (history rewriting, recursive removal, package publishing) before the shell runs |
| [`protect-files`](protect-files/README.md)   | `PreToolUse`            | The agent may **read** the ESLint, Jest, Prettier and TypeScript configuration files, but not change them                     |
| [`mask-env`](mask-env/README.md)             | `PostToolUse`           | Replaces environment variable values with a placeholder before the result reaches the model. The variable names stay visible  |
| [`verify-changes`](verify-changes/README.md) | `SessionStart` + `Stop` | If the session touched `src`, runs `format`, `lint`, `build` and `test` before letting the turn end                           |

Each folder has its own `README.md` with the configuration, the decision criteria and the known
limitations. The runtime reference is the
[official Claude Code hooks documentation](https://code.claude.com/docs/en/hooks).

## Tests

Each hook has a suite that runs the real script, through stdin, and checks the output JSON. They
do not touch the repository: `verify-changes` builds disposable fixture projects in
`os.tmpdir()` whose "commands" are millisecond-long `node -e` calls.

```bash
node .claude/hooks/guard-commands/selftest.mjs
node .claude/hooks/protect-files/selftest.mjs
node .claude/hooks/mask-env/selftest.mjs
node .claude/hooks/verify-changes/selftest.mjs
```

## How the hooks are registered

There is no per-hook `env` field in `settings.json`. The configuration is passed as a **command
line argument**, using the exec form (`command` + `args`): with `args` present, `command` is
resolved as an executable and called **without a shell**, so each item becomes an exact
argument, with no quoting, no expansion and no `$` interpretation. That is what allows passing a
list of rules with spaces without any escaping.

```json
{
  "type": "command",
  "command": "node",
  "args": [
    "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-commands/guard-commands.mjs",
    "--deny=git push,...",
    "--allow=git push --dry-run"
  ],
  "timeout": 10
}
```

Each script resolves the value in this order: **argument, environment variable, default**. The
environment variables still exist because they are what the test suites use. An **empty** value
(`--allow=`) means "no exception", never "fall back to the default" — the scripts use `??` and
not `||` precisely to preserve that.

`${CLAUDE_PROJECT_DIR}` is the root of the project where the session started, so the hooks work
whatever the agent's directory is at the time of the call.

About the `matcher`: it is only treated as a **regular expression** when it contains a character
outside `[A-Za-z0-9_- ,|]`. With letters and `|` only it becomes a list of **exact** names,
which silently stops matching variations. The `[Bb]` in the patterns in `settings.json` are
there to keep them on the regex path.

## Where the decision goes, in the output JSON

This is the part that fails most silently when you get it wrong. The runtime **validates the
whole object**: a decision field in the wrong place is not ignored — it fails validation and the
call becomes a _non-blocking_ error, which means **the action that should have been blocked
happens**.

| Event              | How to decide                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `PreToolUse`       | `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..." } }` |
| `PostToolUse`      | `{ "hookSpecificOutput": { "hookEventName": "PostToolUse", "updatedToolOutput": ... } }`                                       |
| `SessionStart`     | `{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "..." } }`                                    |
| `Stop`             | `{ "decision": "block", "reason": "..." }` — at the top of the object, and not in `hookSpecificOutput`                         |
| Allowing on `Stop` | do not send `decision`; `"allow"` **does not exist** in the schema                                                             |

Two points worth highlighting:

1. **`updatedToolOutput` must have the same shape as the tool's original output** (an object
   `{stdout, stderr, interrupted, isImage}` for `Bash`, a different one for `Read`). A value with
   a different shape is silently discarded and the raw content reaches the model. That is why
   `mask-env` clones the output and replaces only the content of the strings, instead of
   building a new object.
2. **Emitting `{"decision": "allow"}` on `Stop`** makes the turn pick up a hook error warning on
   every end of turn. `verify-changes` uses `systemMessage`, which on `Stop` only goes to the
   debug log.

## Exit codes

On `PreToolUse`, **exit 2 blocks on its own**, even if stdout is discarded. Both `PreToolUse`
hooks use both channels (JSON + exit 2).

On `Stop` the opposite holds: exit 2 also blocks, but the message then comes from stderr and the
turn is marked as a hook error. That is why `verify-changes` blocks with **exit 0** and the
`reason` on stdout.

## Loop caps

The runtime ends the turn on its own **after 8 consecutive `Stop` blocks**. The
`--max-blocks=6` of `verify-changes` sits below that on purpose: the one who gives up first is
the hook, which has the report in hand, and not the runtime, which just stops without
explaining.

## Known limitations

- **False positive of `protect-files` on text.** The hook blocks a write when the content of the
  call carries, at the same time, the name of a protected file and a "write marker" (a shell
  redirection, a unified patch, a `--fix`, a markdown blockquote citation). That includes
  **documentation about the protected files themselves**: editing
  `protect-files/README.md` runs into it. The block is conservative on purpose, but when it
  happens on a file that clearly is not protected, it is worth checking whether this was the
  case.
- **Cost of `mask-env`.** It runs without a `matcher`, that is, after every tool call (~50 ms of
  Node process). This is deliberate: it is the last point before a secret reaches the model.
  `mask-env/README.md` explains how to narrow that down, and what is lost.
- **Scope of `mask-env`.** When it decides that a result involves environment variables, it masks
  **every** `key=value` pair in that result, not only the secrets. Diagnostic output in the same
  text comes out masked along with it.
