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

An ADR is a record of what people decided and why they decided it. The repository can
show what the code looks like today; it cannot show which forces were weighed, which
options were on the table, or why the obvious one was dropped. **Those parts come from
the user, by asking.** An invented rationale is worse than no ADR: it reads as history,
and six months later nobody can tell it apart from the real thing.

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

## What must come from the user

Ask for these. Do not fill them in from plausibility, from what the code seems to imply,
or from what usually motivates this kind of decision elsewhere:

- **The decision itself** — its exact wording and scope. "Use vertical slice" and "use
  vertical slice for the backends only" are different ADRs.
- **The drivers** — which forces actually pushed it. A benefit that is real but was never
  a reason is not a driver, and putting it in Context rewrites history.
- **The alternatives genuinely weighed** — which options were on the table, and whose
  they were when more than one person was involved.
- **Why each rejected option lost** — the reason it was dropped, which is rarely
  deducible from the winner's advantages.
- **The costs accepted knowingly** — the Negative bullets of the chosen option. If the
  user names none, ask once more; a decision with no downside was not a decision.
- **status** — `Proposed` (still open for discussion) or `Accepted` (already in force)
  is the user's call, never inferred from the code having been merged.
- **Scope limits and conditions** — where the decision does not apply, and what would
  trigger revisiting it.
- **References** — see the rule under _Section rules_. Never invent one.

Derive these yourself, without asking: the next ADR number, the current structure of the
code, file sizes and layout, the git history and its commit messages, and the tone and
level of detail of the existing ADRs.

## The interview

Read the repository first, then ask — informed questions cost the user seconds, blank
ones cost them the whole rationale.

1. **Batch the questions into one round.** A single `AskUserQuestion` call, up to four
   questions. Do not trickle them one per turn.
2. **Turn your reading into options.** Offer what the repository and the conversation
   suggest as the first option, so confirming is one click, and keep every option
   concrete — real alternatives with real names, not "yes / no / maybe".
3. **Ask only what you cannot derive.** A question whose answer is sitting in the git
   log wastes the round.
4. **Do not write the file before the answers arrive.** A draft on disk turns the
   interview into a review of your guesses, which is the failure this exists to prevent.
5. **Accept a deferral.** If the user tells you to decide it yourself, or the session
   cannot ask, write the ADR anyway — and list every point you supplied in the closing
   report, so they know what to check.
6. **Ask again when an answer is thin.** "It was better" is not a driver. One follow-up
   round is fine; a third is nagging, so take what you have and flag the gap.

What the conversation already answered is answered: if the user has just spent ten
messages explaining why they rejected an option, use it and ask only for what is still
missing.

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
- **Context** — the problem and its constraints, as the user described them. No options,
  no verdicts. An observation of your own belongs here only when the user confirmed it,
  or when it is a fact of the codebase any reader can check.
- **Decision** — the chosen option only. If the decision has conditions or a scope
  limit, state them here.
- **Alternatives considered** — one `###` subsection per option that was genuinely on
  the table, **including the one that was chosen**. Each one carries its own
  `#### Consequences` (with `##### Positive` and `##### Negative`) and
  `#### References`. Positive and Negative are bullet lists; an empty list is a signal
  the option was not really analysed, so fill both. Never pad the list with an option
  nobody weighed just to look thorough — a fabricated alternative tells the next reader
  it was already ruled out.
- **References** — only links the user gave you, or pages you actually opened and read
  in this session. Never reconstruct a URL from memory and never guess one from an
  article title you recall: a plausible link that is dead or points elsewhere is worse
  than no link. Leave the heading with no bullets when there are none; do not leave an
  empty `- []()` placeholder behind.

## Procedure

1. `ls docs/ADRs/` to find the highest existing number. The new ADR is that number
   plus one. If the directory does not exist, create it and start at `0001`.
2. Read the two or three most recent ADRs to match the level of detail and tone.
3. Confirm the decision is actually architectural — see _When to write one_ below. If
   it is not, say so instead of writing the file.
4. Read the code and the git history around the decision — not to settle the rationale,
   but so the interview is informed and its questions carry concrete options.
5. Run the interview — see _The interview_. Everything under _What must come from the
   user_ that the conversation has not already answered goes into that round. If only
   one option was ever on the table, the decision is not a decision; ask what else was
   considered before writing anything.
6. Write the file at `docs/ADRs/<number>-<title>.md` using the template, taking the
   user's answers as the source of truth wherever they differ from your reading.
7. Report the path, a one-line summary of the decision, and — explicitly — anything you
   wrote that the user did not tell you, so it can be corrected while that is cheap.

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
