# Hook `verify-changes`

A `Stop` hook that **keeps the agent from ending a task leaving the project broken**. When the task touched `src/`, it runs `format` (so the final result matches the project style), then `lint`, `build` and `test`, and only allows the end of the turn after showing the result of each one.

```diff
  "what does this file do?"        -> no command runs (nothing changed in src/), just the status line
  "explain this flow"              -> same
+ "fix the bug in src/routes.ts"   -> format + lint + build + test before ending
```

At **every** end of turn the agent is required to say whether the verification ran and with what result — silence is not an option, because there is no way to tell "there was nothing to verify" from "the hook is not loaded".

See [../README.md](../README.md) for the overview of this repository's hooks, and the [official Claude Code hooks reference](https://code.claude.com/docs/en/hooks) for the runtime contract.

---

## Files

| File                                         | Role                                                           |
| -------------------------------------------- | -------------------------------------------------------------- |
| [`../../settings.json`](../../settings.json) | Hook registration (the file Claude Code reads)                 |
| [`verify-changes.mjs`](verify-changes.mjs)   | Node script that decides `block`/`allow` and runs the commands |
| [`selftest.mjs`](selftest.mjs)               | Test suite for the script                                      |
| `README.md`                                  | This document                                                  |

Claude Code reads the configuration from `.claude/settings.json` (versioned, applies to the whole project). This folder holds only the hook code.

---

## What it does, in order

1. **`SessionStart`** — takes a _fingerprint_ of the watched paths (a hash of the content of every file under `src/`) and stores it as the session baseline. It also injects a context line telling the agent the gate exists.
2. **`Stop`** — recomputes the fingerprint:
   - **equal to the baseline** → the agent only read/explored; no command runs and the hook merely asks the agent for a status line (see [`VERIFY_CHANGES_NOTIFY`](#the-agent-reports-at-every-end-of-turn---notify));
   - **different** → it runs `npm run format`, `npm run lint`, `npm run build`, `npm run test`.
3. **Runs every command**, without stopping at the first error, and returns a report with the result of each one.
4. **Blocks the end of the turn** (`decision: "block"`) and hands the report back as the next turn's prompt:
   - **with failures** → "fix it and end the turn again" (the verification runs once more on its own);
   - **with no failures** → "end the turn, but include this report in the final answer to the user".

The "no failures" block happens **exactly once** — the next turn goes straight through. That is what guarantees the requirement that the agent always tells the user what was verified.

---

## The agent reports at every end of turn (`--notify=`)

Silence is ambiguous: there is no way to tell "there was nothing to verify" from "the hook is not loaded". That is why, at the `always` default, **every** end of turn produces a status — including when no command ran:

```
[verify-changes] Verification status for this end of turn: NO command was run -
nothing changed in src since the session started.

Commands that would run if something had changed: npm run format, npm run lint, npm run build, npm run test.

What to do now: do not redo anything, do not repeat the previous answer and do not run those
commands on your own. Just end the turn adding ONE short status line for the user (...)
```

The "did not run" notice costs **one line**, not a cycle of work — the text explicitly forbids the agent from redoing the task or running the commands by hand. The execution reports (success and failure) still carry the result command by command.

| Value                | Behavior                                                                                |
| -------------------- | --------------------------------------------------------------------------------------- |
| `always` _(default)_ | Reports at every end of turn: it ran (with results) or it did not run (with the reason) |
| `on-run`             | Only speaks when some command ran; "nothing changed in `src/`" passes in silence        |
| `on-error`           | Only speaks when some verification fails                                                |

### The two dangerous silences

There are two states in which the hook **stops working** and the session looks identical to one where everything passed. In both, it warns before going quiet — only once:

| State                             | Notice                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Gate disarmed (block cap reached) | `the gate DISARMED ITSELF after N blocks` — and that from then on nothing is verified            |
| Broken hook (internal error)      | `the hook BROKE and ran nothing` — with the error, and the note that lint/build/test did not run |

The disarm notice costs **one block beyond the cap** (7 by default, against the runtime's 8): disarming quietly is the worst possible silence, because it is exactly when the safety net is gone.

Both notices are written to the state before going out, and **they only block if the write succeeded**. If the fault is on the disk itself, insisting at every end of turn would turn the failure into a loop.

> **Why this does not become a loop:** the turn that _delivers_ the notice also ends in `Stop`, and there too nothing changed. Without a guard it would be notice → turn → notice until `MAX_BLOCKS`. The state marks `pendingReport`; the next end of turn merely clears the mark and goes straight through. Result: **at most one notice per user question**.

### Why a content hash and not `mtime`

`format` rewrites the files. With `mtime`, the formatter itself would mark `src/` as "changed" and the hook would fire itself in a loop. The baseline is always recomputed **after** the commands, with the code already formatted.

### Why a session baseline and not `git status`

The repository almost always has uncommitted changes in `src/`. If the trigger were `git status`, **every question** would turn into a full build — exactly the annoyance this hook must avoid. The baseline compares against the state at the start of the session, so only what **the agent** touched counts.

`git status --porcelain -- src` is still used as a _fallback_ when there is no baseline (a resumed session, or a hook installed mid-session).

---

## How it is registered

In `.claude/settings.json`. `--event=agentStop` is the script's internal name for the end of a
turn, not the runtime's event name, which is `Stop`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": [
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/verify-changes/verify-changes.mjs",
              "--event=sessionStart",
              "--paths=src"
            ],
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "statusMessage": "verify-changes: format, lint, build, test",
            "command": "node",
            "args": [
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/verify-changes/verify-changes.mjs",
              "--event=agentStop",
              "--paths=src",
              "--format=format",
              "--commands=lint,build,test",
              "--max-attempts=3",
              "--budget-sec=900",
              "--command-timeout-sec=300",
              "--max-blocks=6",
              "--notify=always"
            ],
            "timeout": 960
          }
        ]
      }
    ]
  }
}
```

The `SessionStart` `matcher` is **`startup|resume|clear`**, and the absence of `compact` and
`fork` is deliberate: the baseline is born on that event, and recreating it on a compaction would
erase the memory of the changes made before it — the next end of turn would conclude "nothing
changed" and verify nothing.

> The `Stop` `timeout` has to be **larger** than `--budget-sec`. A hook timeout is always _fail-open_: the runtime kills the process and the turn ends **without** any verification — and with no report. The 960s against a 900s budget exist so the script always finishes on its own, with a report, before the runtime loses patience.

---

## Configuration (through `args` in settings.json)

| Argument                 | Equivalent environment variable      | Default                       | What it does                                                             |
| ------------------------ | ------------------------------------ | ----------------------------- | ------------------------------------------------------------------------ |
| `--paths=`               | `VERIFY_CHANGES_PATHS`               | `src`                         | Watched paths, comma-separated. `/src`, `./src` and `src` are equivalent |
| `--format=`              | `VERIFY_CHANGES_FORMAT`              | `format`                      | Script run **before** the verifications. Empty = no formatting           |
| `--commands=`            | `VERIFY_CHANGES_COMMANDS`            | `lint,build,test`             | npm scripts verified, in order. Empty = the gate is off                  |
| `--max-attempts=`        | `VERIFY_CHANGES_MAX_ATTEMPTS`        | `3`                           | Fix cycles before the hook gives up and asks for a report                |
| `--budget-sec=`          | `VERIFY_CHANGES_BUDGET_SEC`          | `900`                         | Total command execution time per session                                 |
| `--command-timeout-sec=` | `VERIFY_CHANGES_COMMAND_TIMEOUT_SEC` | `300`                         | Timeout of each individual command                                       |
| `--max-blocks=`          | `VERIFY_CHANGES_MAX_BLOCKS`          | `6`                           | Absolute block cap per session                                           |
| `--notify=`              | `VERIFY_CHANGES_NOTIFY`              | `always`                      | When the agent is required to report. `always` \| `on-run` \| `on-error` |
| `--state-dir=`           | `VERIFY_CHANGES_STATE_DIR`           | `<tmp>/claude-verify-changes` | Where the session state lives                                            |

The argument beats the environment variable, which beats the default. An **empty** value
(`--commands=`) means "run no verification at all" — not "fall back to the default".

> `--max-blocks=6` sits below Claude Code's own cap: **after 8 consecutive blocks the runtime
> ignores the hook and ends the turn**. The 6 exists so the hook gives up with a report and an
> explanation before the runtime gives up without saying anything.

Ignored while scanning: `node_modules`, `.git`, `dist`, `build`, `out`, `coverage`, `.next`, `.turbo`, `.cache`.

### Watching more than one folder

```json
"--paths=src,prisma,seeds"
```

### Turning it off temporarily

Pass `--commands=` and `--format=` empty, which turns off only this gate:

```json
"args": [
  "${CLAUDE_PROJECT_DIR}/.claude/hooks/verify-changes/verify-changes.mjs",
  "--event=agentStop",
  "--commands=",
  "--format="
]
```

To turn **every** project hook off at once, use `"disableAllHooks": true` at the root of
`.claude/settings.json`.

---

## A command that does not exist in `package.json`

That is not a failure. The command shows up in the report as not run, with the reason, and **the agent ends the turn normally**:

```
  npm run lint    ->  OK (3.1s)
  npm run build   ->  OK (7.4s)
  npm run test    ->  NOT RUN: the script "test" does not exist in package.json
```

The agent is instructed to pass that line on to the user in the final answer — the idea is that the missing script becomes visible to a human, not that it stops the work.

---

## Stop criteria

A `Stop` gate is a loop by construction: it blocks the end of the turn and the agent goes back to work. Three independent brakes guarantee that this loop **always** ends:

| Brake       | Default                      | What happens when it is hit                                 |
| ----------- | ---------------------------- | ----------------------------------------------------------- |
| Attempts    | 3 failing cycles             | Final report: "STOP trying to fix it, report to the user"   |
| Time budget | 900s of commands per session | The same, mentioning the time overrun                       |
| Block cap   | 6 blocks in the session      | The hook disarms itself (a safety net against its own bugs) |

When the attempts or the budget run out, the hook blocks **one last time** with the full report and the instruction to report the failures to the user — and after that it does not block again. The agent delivers the answer with whatever is left pending, instead of being stuck.

The runtime has its own limit (8 consecutive `block` continuations, see [the hooks reference](https://code.claude.com/docs/en/hooks)); the defaults here sit below it on purpose, so that whoever decides to stop is the hook — which has the report in hand — and not the runtime, which just gives up quietly.

### Ending the turn without fixing does not escape the gate

If the agent stops editing and tries to end the turn with the failures still standing, the hook blocks again (the state keeps `failing`) until the attempts run out. There is no escaping the verification simply by not touching `src/` any more.

---

## What the agent is forbidden to do to "pass"

The block text is explicit: no disabling a lint rule, no skipping a test, no `ts-ignore`/`any` and no changing a configuration file. The config files (`eslint`, `jest`, `prettier`) are already protected separately by the [`protect-files`](../protect-files/README.md) hook — the two reinforce each other.

---

## The output is always JSON, never silence

Blocking is `{"decision":"block","reason":"..."}` on stdout. **Allowing is sending no `decision`
at all**: `"allow"` does not exist in the `Stop` schema, and emitting it makes the turn pick up a
hook error warning at every end of turn.

Even when allowing, the hook answers with JSON — going quiet is indistinguishable from a hook
that did not run, from a crash and from a timeout. What it sends is a `systemMessage`, which on
`Stop` only goes to the debug log (visible with `claude --debug`):

```json
{
  "systemMessage": "[verify-changes] no command was run: nothing changed in src since the session started"
}
```

The diagnostic goes in that field, and never in `reason` or `additionalContext`: those two
**continue the conversation** in Claude Code, so a diagnostic text would turn into work for the
agent. The three possible messages:

```
[verify-changes] no command was run: nothing changed in src since the session started
[verify-changes] cap of 6 blocks reached in this session; the gate is disarmed
[verify-changes] unreadable Stop payload; the end of turn was allowed without verification
```

### A block goes out with exit `0` — and that is not a detail

The three-channel pattern `guard-commands` uses on `PreToolUse` (stdout + stderr + exit `2`)
**does not apply** here. On `Stop`, exit `2` also blocks, but with two differences that matter:
the message starts coming from **stderr** instead of the `reason`, and the turn is marked as a
**hook error** instead of normal feedback. The lint/build/test report would reach the agent as
runtime error text.

That is why, when blocking: **exit `0`, `reason` on stdout and nothing on stderr**. There are
asserts in the selftest locking both of those.

---

## The state is keyed by `cwd`, not by `sessionId`

The state file links the baseline written on `SessionStart` to the attempt counter read on
`Stop`. If the key diverges between the two events, the state spreads across several files and
the hook breaks in a silent way:

- the `SessionStart` baseline becomes invisible at the end of the turn, which falls back to
  `git status` and runs the whole suite for nothing;
- the attempt counter never accumulates — the symptom is `attempt 1 of 3` repeated, never
  reaching the final report.

`cwd` is the key because it is the most stable field across both events: it identifies the
project, not the invocation. An accepted side effect: two sessions in the same repository share
the counter — which is coherent, since what is being protected is the repository.

---

## `stop_hook_active`: the guard that does not depend on the state file

The runtime delivers `stop_hook_active: true` when **that turn was already forced to continue**, and it ignores the hook after 8 consecutive continuations. This hook's own counter lives on disk and may vanish (tmp cleaned, a new `sessionId`) — when that happens mid-cycle, counting from zero would stack new blocks on top of the ones the runtime already granted.

Hence: if `stop_hook_active` is `true` **and** the counter is at zero, the hook jumps straight to the last available block. It spends at most one more, with a report, instead of pushing the turn until the runtime gives up quietly.

---

## Fail-open, on purpose

Unlike `PreToolUse` (fail-closed), this hook **gets out of the way when it breaks**: an unreadable payload, a missing `package.json`, an internal error or a timeout all result in `allow` with a notice in the debug log. A buggy quality gate must not keep the agent from delivering the answer.

---

## Tests

```bash
node .claude/hooks/verify-changes/selftest.mjs
```

The suite runs against a disposable fixture project in `os.tmpdir()`, never against the real repository — the fixture's "commands" are millisecond-long `node -e` calls, so it exercises the state machine (trigger, report, attempts, budget, cap) without paying for a real lint/build/test.

It covers, among others: changes inside and outside `src/`, a rewrite with identical content, a normalized `/src`, every command running despite a failure in the middle, a missing script, the single success block, the three `NOTIFY` modes, the guarantee that the "did not run" notice does not feed itself, the three stop criteria and the fail-open paths.

---

## Known limitation in this repository (Windows)

If the `test` script in `package.json` is written as `TZ=UTC && jest ...`, `TZ=UTC` is Unix shell syntax; on Windows npm runs scripts through `cmd.exe`, which answers:

```
'TZ' is not recognized as an internal or external command
```

That is: **on Windows `npm run test` fails before jest even starts**, and the hook will report it as `FAILED exit 1` every time. That belongs to `package.json`, not to the hook — and it is exactly the kind of thing the report exposes. Two ways out, both outside the scope of this hook:

- swap the script for `cross-env TZ=UTC jest ...` (works on both systems); or
- configure `npm config set script-shell bash` on the machine.

Meanwhile, the 3-attempt limit keeps that failure from trapping the agent: it blocks 3 times, delivers the report and allows the turn to end.
