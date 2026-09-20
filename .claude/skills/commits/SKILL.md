---
name: commit-format
description: 'Generate a Conventional Commits message based on the changes made. Use when committing code changes. Triggers on: commit, git commit, create commit message.'
disable-model-invocation: false
user-invocable: false
---

# Conventional Commits

All commit messages in this repository follow the
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) spec.

## Format

```
<type>(<scope>)<!>: <description>

<body>

<footer>
```

- `type` — required, lowercase, from the table below.
- `scope` — optional but preferred; the area of the codebase touched (see Scopes).
- `!` — optional, placed before the `:` to mark a breaking change.
- `description` — required. Imperative mood ("add", not "added"/"adds"), lowercase
  first letter, no trailing period, max 72 characters for the whole subject line.
- `body` — optional. Blank line before it. Explains _why_, not _what_.
- `footer` — optional. Blank line before it. `BREAKING CHANGE: <desc>` and issue
  references (`Refs: #123`, `Closes: #123`).

## Types

| Type       | Use for                                                 |
| ---------- | ------------------------------------------------------- |
| `feat`     | A new feature or capability                             |
| `fix`      | A bug fix                                               |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf`     | Performance improvement                                 |
| `test`     | Adding or correcting tests only                         |
| `docs`     | Documentation only (README, comments, JSDoc)            |
| `build`    | Build system, Docker, TypeScript config, dependencies   |
| `ci`       | CI pipelines and workflows                              |
| `style`    | Formatting, lint fixes with no behavior change          |
| `chore`    | Housekeeping that fits nothing above                    |
| `revert`   | Reverts a previous commit                               |

## Breaking changes

Mark with `!` **and** a `BREAKING CHANGE:` footer explaining the migration:

```
feat(providers)!: require explicit connection timeout

changing the provider connection timeout behavior to require an explicit value because users need to be aware of and configure the timeout explicitly.

BREAKING CHANGE: ProviderConfig.timeoutMs is now mandatory. Existing configs
must add an explicit value; the previous implicit 30s default is gone.
```

## Rules

1. One logical change per commit. If the staged diff covers several unrelated
   concerns, split it into separate commits rather than picking a vague type.
2. Choose the type by intent, not by file extension — a change to a `*.spec.ts`
   file that fixes production behavior is still `fix`.
3. When a commit both adds a feature and refactors around it, the feature wins.
4. Never use `chore` as a catch-all when a precise type applies.
5. Do not mention tooling or the assistant in the description.
6. All commits should be co-authored between user and model

## Examples

```
feat(tools): add check-providers-status tool
```

```
fix(server): return 503 when a provider health check times out

The HTTP layer surfaced a 500 for unreachable providers, which made retries
indistinguishable from real server faults.
```

```
refactor(providers): flatten provider modules into single files

Refs: #42
```

```
build(deps): bump @modelcontextprotocol/sdk to 1.12.0
```

## Procedure

1. `git status` and `git diff --staged` (plus `git diff` if nothing is staged) to
   see exactly what changed.
2. `git log --oneline -10` to match the existing tone.
3. Pick one type and one scope that describe the dominant intent of the diff.
4. Write the subject, then a body only if the _why_ is not obvious from the subject.
5. Commit with a heredoc so the multi-line message survives the shell.
