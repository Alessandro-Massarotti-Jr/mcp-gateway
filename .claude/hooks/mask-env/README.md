# Hook `mask-env`

A `PostToolUse` hook that **allows** reading `.env` files, but **replaces the values** before the content reaches the model. The variable names are preserved — the agent still knows what exists, without knowing what it is worth.

```diff
- DATABASE_URL=postgres://admin:sup3rs3cret@db.internal:5432/app
+ DATABASE_URL=<redacted>
```

See [../README.md](../README.md) for the overview of this repository's hooks, and the [official Claude Code hooks reference](https://code.claude.com/docs/en/hooks) for the runtime contract.

---

## Files

| File                                         | Role                                           |
| -------------------------------------------- | ---------------------------------------------- |
| [`../../settings.json`](../../settings.json) | Hook registration (the file Claude Code reads) |
| [`mask-env.mjs`](mask-env.mjs)               | Node script that does the masking              |
| [`selftest.mjs`](selftest.mjs)               | Test suite for the script                      |
| `README.md`                                  | This document                                  |

Claude Code reads the configuration from `.claude/settings.json` (versioned, applies to the whole project). This folder holds only the hook code.

---

## How it is registered

In `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "statusMessage": "mask-env",
            "command": "node",
            "args": [
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/mask-env/mask-env.mjs",
              "--allow=.env.example",
              "--placeholder=<redacted>"
            ],
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**No `matcher`, on purpose** — the hook runs after _every_ tool. This is the last point before a
secret reaches the model, and a matcher that forgets a new tool (or an MCP tool that reads a
file) turns into a silent leak. The price is one Node process per tool call (~50 ms); the script
stays quiet within microseconds when nothing environment-related is involved. If that cost
bothers you, a matcher like `[Rr]ead|[Gg]rep|[Bb]ash|[Pp]ower[Ss]hell` covers the common path —
knowing that it becomes a bet on which tools can expose file content.

### How the masked output gets back to the model

The replacement goes out in `hookSpecificOutput.updatedToolOutput`, and Claude Code **requires
the value to have the same shape as the tool's original output**: an object `{stdout, stderr,
interrupted, isImage}` for `Bash`, `{type, file: {filePath, content, ...}}` for `Read`, and so
on.

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "updatedToolOutput": {
      "stdout": "DB_PASSWORD=<redacted>",
      "stderr": "",
      "interrupted": false,
      "isImage": false
    },
    "additionalContext": "Environment variable values were masked..."
  }
}
```

**A value with the wrong shape is silently discarded and the raw text reaches the model** —
which is exactly the leak the hook exists to prevent. That is why the script never builds a new
object: it **clones** the original output and replaces only the content of the strings,
preserving keys, arrays, numbers and booleans. `selftest.mjs` has an `assertSameShape` that
locks that regression out.

The same holds for the error fallback: if the masking fails, there is no way to return an
`updatedToolOutput` (the output's shape would be a guess, and a wrong guess is discarded). The
script then uses `decision: "block"` with a warning, which Claude Code places next to the result
without having to guess any schema.

---

## How it works

1. Claude Code runs the tool (`Read`, `Bash`, `Grep`, etc.) normally — **the read is not blocked**.
2. After it succeeds, the hook receives the `PostToolUse` payload on `stdin`.
3. The script decides whether that call touched the environment:
   - some path in the arguments has the basename `.env`, `.env.*` or `*.env` **and is not on the allowlist**;
   - the shell command names one of those files (`cat ./.env | head -20`);
   - the command is an environment dump (`printenv`, `env`).
4. If it did, it rewrites the result text and returns:

```json
{
  "modifiedResult": { "resultType": "success", "textResultForLlm": "..." },
  "additionalContext": "Environment variable values were masked..."
}
```

5. If it did not, it **prints nothing** and exits with `0` — the original result goes through untouched.

### Allowed files (allowlist)

Example files carry placeholders, not secrets — and the agent needs them to know **which
variables exist**. These pass untouched:

```
.env.sample   .env.example   .env.template   .env.dist
```

The comparison is by _basename_, so `infra/.env.sample` is allowed too. Any other member of the
family (`.env`, `.env.local`, `.env.production`, `staging.env`) is masked.

In `grep`/`rg` output, which carries the path on every line, the decision is **per line**: a
search across both files returns the `.env.sample` line readable and the `.env` one redacted.

To change the list, use `MASK_ENV_ALLOW` (comma-separated basenames). An empty
`MASK_ENV_ALLOW=` masks everything, including the samples.

### What is preserved

- Variable names, `export`, spacing and the `=`.
- Comments with no assignment (`# local credentials`).
- Blank lines and the total line count.
- Variables with no value (`EMPTY_VAR=` stays `EMPTY_VAR=`).
- Line numbering prefixes from the `view` tool (`   1→DATABASE_URL=...`).

### What is masked

- Every value of `KEY=value`, quoted or not.
- **Commented-out assignments** — `# OLD_DATABASE_URL=postgres://user:pw@host` is a live credential, not a comment.
- **Quoted multi-line values** (PEM private keys): the continuation lines come out empty until the closing quote.
- **`grep`/`rg` output**, which prefixes every hit with `path:` or `path:line:` — the prefix is preserved, the value is not.

---

## Configuration

| Argument         | Equivalent environment variable | Default                                            | Effect                                    |
| ---------------- | ------------------------------- | -------------------------------------------------- | ----------------------------------------- |
| `--placeholder=` | `MASK_ENV_PLACEHOLDER`          | `<redacted>`                                       | Text that replaces the values             |
| `--allow=`       | `MASK_ENV_ALLOW`                | `.env.sample,.env.example,.env.template,.env.dist` | Allowed basenames; empty masks everything |

The argument beats the environment variable, which beats the default. In this repository
`--allow=` is set to `.env.example`, which is the example file that exists here.

```json
"args": [
  "${CLAUDE_PROJECT_DIR}/.claude/hooks/mask-env/mask-env.mjs",
  "--allow=.env.example,.env.template",
  "--placeholder=***"
]
```

---

## Tests

```bash
node .claude/hooks/mask-env/selftest.mjs
```

30 cases: a typical `.env` file, `.env.production`, `cat .env` through bash, `printenv`,
`Get-Content` through powershell, `rg` and `grep` output with a path prefix, line numbering in
six formats (`168. `, `12| `, `12→`, `12: `, `12\t`, `12) `), the allowlist (the four example
variants, a search mixing `.env` and `.env.sample`, an empty allowlist), camelCase and
snake_case payloads, numbered output, a commented credential, a multi-line private key, a bare
URL that is not an assignment, an ordinary file unrelated to env, invalid `stdin`, an empty
result, and the output contract: shape preserved for `Bash` and for `Read`, fields only inside
`hookSpecificOutput`, and configuration through an argument.

### Why the line prefix is not a list of formats

Two earlier failures had the same root cause: the regex assumed **where** the key starts on the
line.

1. `rg '^DB_URL=.*$' .env` went through **unmasked**. `rg` prefixes each hit with the path
   (`C:\...\.env:DB_URL=postgres://...`) and the regex required the key at column 0 — the same
   secret came out redacted through one read path and in the clear through another.
2. A read with a line range numbers lines as `168. ` — a dot and a space. The prefix accepted a
   tab, a space, `:` and `|`, but not `.`, and the excerpt came out in the clear.

Hence `parseAssignment`: it finds the **first `=`** on the line, walks left over the valid key
characters and preserves as a prefix everything it finds in front — path, line number, `#`,
`export`, any combination. There stops being a list of formats to get right.

Two guards prevent overreach: the key must have 2+ characters and the shape of an identifier,
and it is discarded if it comes right after `?` or `&`. That is what keeps
`https://user:pw@host/path?a=b` intact.

---

## Known limitations

It is worth understanding the real reach before trusting this as the only control:

1. **`PostToolUse` cannot fail closed.** The event runs _after_ the tool. If the script breaks, the runtime is fail-open. The script compensates by catching any exception and returning the whole result suppressed — but if the `node` process does not start (Node missing from PATH, a 10s timeout), the original content goes through. For a hard block, the path is a `preToolUse` hook with `permissionDecision: "deny"` — which is fail-closed, but then reading stops being allowed, the opposite of what this hook does.
2. **Detection is by tool argument.** A search with `.env` in the path (`rg PATTERN .env`) is covered, including the `path:line:` prefix in the output. But `grep -r "PG_SQL_CONN_URL" .`, which finds the value in another file without naming `.env`, goes through. Turn on `MASK_ENV_SCAN_ALL=1` to cover part of that.
3. **Only the `KEY=value` form is masked.** A secret in JSON, YAML or inside a code string is not recognized.
4. **It does not protect against the agent itself.** A command such as `node -e "console.log(process.env.X.split('').join('-'))"` transforms the value before printing it, and the output has no assignment shape.
5. This reduces accidental exposure in context. It **does not replace** secret rotation, `.gitignore` and credential management.
