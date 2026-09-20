---
name: adr
description: 'Write an Architecture Decision Record (ADR) in docs/ADRs/ using the repository template. Use when an architectural or cross-cutting decision needs to be recorded, revisited, superseded or deprecated. Triggers on: ADR, architecture decision record, record this decision, document this decision, architectural decision.'
disable-model-invocation: false
user-invocable: true
---

# Architecture Decision Records

An ADR records **one** architectural decision: the forces that made it necessary, the
option that was chosen, and the options that were rejected. It is written once, at the
moment the decision is taken, and never rewritten afterwards — a decision that changes
gets a **new** ADR that supersedes the old one.

ADRs are always written in **English**, regardless of the language of the conversation.

## Location and file name

Every ADR lives at:

```
docs/ADRs/<number>-<title>.md
```

- `number` — four digits, zero-padded, strictly sequential: `0001`, `0002`, `0013`.
  Never reuse a number, never renumber an existing file, even for a rejected or
  superseded ADR.
- `title` — kebab-case, lowercase, ASCII only, no trailing `.md` noise.

### The title must be descriptive

The file name has to state **the decision**, not the topic it belongs to. A reader
scanning `ls docs/ADRs/` should know what was decided without opening anything.

A good name names an action and its object — usually `<verb>-<object>-<qualifier>`:

```
0001-use-vertical-slice-as-the-project-architecture.md
0002-expose-every-tool-response-through-a-single-envelope.md
0003-keep-providers-optional-and-failure-tolerant.md
```

A bad name names only the area, so every future ADR about that area would collide with it:

```
0001-project-architecture.md          # which architecture? decided what?
0002-tool-responses.md                # decided what about them?
0003-providers.md                     # a topic, not a decision
```

Rules of thumb:

1. Start with a verb in the imperative: `use`, `adopt`, `replace`, `split`, `keep`,
   `drop`, `standardize-on`, `move`.
2. Include the object of the decision and, when two ADRs would otherwise clash, the
   qualifier that distinguishes them.
3. Do not include the status, the date, or the word `adr` in the file name.
4. The `#` heading in the file is the same title, written in prose with normal
   capitalization.

## Template

Copy this structure exactly. Keep the sections in this order and do not add, rename or
drop headings.

```markdown
# ADR-0001 Use Vertical Slice As The Project Architecture

- **status**: Accepted
- **Date**: 2026-09-20

## Context

Why this decision had to be made: the forces, constraints and problems in play at the
time. Written in the present tense, describing the situation as it is — no solution
here, and no hindsight added later.

## Decision

The option that was chosen, stated in one or two sentences, in the active voice.

## Alternatives considered

### Vertical slice architecture

What this option is, in one or two sentences.

#### Consequences

##### Positive

- What this option buys.
- Another benefit.

##### Negative

- What it costs.

#### References

- [Title of the source](https://example.com)
```

### Section rules

- **Heading** — `# ADR-<number> <Title>`, with the same number as the file name.
- **status** — exactly one of `Proposed`, `Accepted`, `Rejected`, `Deprecated`,
  `Superseded by ADR-XXXX`.
- **Date** — ISO `YYYY-MM-DD`, the date the status was reached. Use today's date.
- **Context** — the problem and its constraints. No options, no verdicts.
- **Decision** — the chosen option only. If the decision has conditions or a scope
  limit, state them here.
- **Alternatives considered** — one `###` subsection per option that was genuinely on
  the table, **including the one that was chosen**. Each one carries its own
  `#### Consequences` (with `##### Positive` and `##### Negative`) and
  `#### References`. Positive and Negative are bullet lists; an empty list is a signal
  the option was not really analysed, so fill both.
- **References** — links that informed the option. Leave the heading with no bullets
  if there are none; do not leave an empty `- []()` placeholder behind.

## Procedure

1. `ls docs/ADRs/` to find the highest existing number. The new ADR is that number
   plus one. If the directory does not exist, create it and start at `0001`.
2. Read the two or three most recent ADRs to match the level of detail and tone.
3. Confirm the decision is actually architectural — see *When to write one* below. If
   it is not, say so instead of writing the file.
4. Collect the alternatives from the conversation, the code and the git history. If
   only one option exists, the decision is not a decision; look harder or ask.
5. Write the file at `docs/ADRs/<number>-<title>.md` using the template.
6. Report the path and a one-line summary of the decision.

## When to write one

Write an ADR for a decision that is **hard to reverse** or that **future readers will
otherwise have to reverse-engineer**:

- Choosing or replacing an architectural style, a framework, a database or a protocol.
- A convention every file in the codebase must obey.
- Deliberately accepting a trade-off that looks wrong without the context.
- Dropping an obvious option for a non-obvious reason.

Do **not** write an ADR for a naming choice inside one module, a dependency bump, a bug
fix, or anything the code already states plainly.

## Changing a decision

ADRs are append-only. To change a past decision:

1. Write a new ADR with the new decision, and reference the old one in its `Context`.
2. In the old ADR, change **only** the `status` line to
   `Superseded by ADR-XXXX` — leave its Context, Decision and Alternatives untouched,
   so the historical reasoning stays readable.

Use `Deprecated` when a decision no longer applies but nothing replaced it, and
`Rejected` for an option that was written up as a proposal and then turned down.
