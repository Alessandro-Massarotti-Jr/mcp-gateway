# ADR-0001 Use Vertical Slice As The Project Architecture

- **status**: Accepted
- **Date**: 2026-09-20

## Context

This gateway is written and maintained largely by an AI coding agent. The agent works
from whatever it can pull into its context window, so the cost of a change is dominated
by how many files it has to open — and by whether it opens the right ones — before it can
edit anything.

The original layout split each backend by technical responsibility: a folder per backend
holding the provider, its error mapper and, for Postgres, a SQL guard
(`src/providers/postgres/postgres.provider.ts`, `postgres.errors.ts`,
`postgres.sql-guard.ts`). A single task — adding a tool, changing how an error is
classified, tightening a guard — meant reading three files to understand the backend and
editing more than one to finish. The split was technical; the unit of change was the
backend.

The gateway itself is small and bounded: a handful of backends exposed as MCP tools over
HTTP, each independent of the others at runtime. Nothing forces the backends to share
code, and nothing requires them to be deployed or versioned separately.

## Decision

Vertical slice is the architectural style of the whole project: work is organized by the
capability it belongs to, not by technical layer. Each backend is one slice — a single
file under `src/providers/` holding its provider class, error mapper, guards, codecs and
tool definitions, with its spec next to it — and slices do not import each other. `core/`
holds only the infrastructure shared across slices (the tool envelope, the registrar,
naming, logging, serialization), and any new capability added to the gateway follows the
same rule.

## Alternatives considered

### Vertical slice architecture

One file per capability, containing everything that belongs to it. A backend's provider,
its error mapper, its guards and codecs and its tool definitions live together, and the
slice is the unit that gets read, changed and reviewed.

#### Consequences

##### Positive

- The whole context for a task fits in one file, so the agent reads once and edits once
  instead of reconstructing a backend from three places.
- There is no ambiguity about which file a change belongs in — the slice is the answer.
- Slices not importing each other keeps a change to one backend from reaching the others.
- Adding a backend is adding a file, not threading a new concept through existing folders.

##### Negative

- Slice files are large: 679, 688 and 830 lines for Mongo, RabbitMQ and Postgres.
- Similar patterns are repeated across slices rather than factored into one shared place,
  so a good idea in one slice does not automatically reach the others.

#### References

### A folder per backend, split by technical responsibility

The layout this project started with: `providers/postgres/` holding `postgres.provider.ts`,
`postgres.errors.ts` and `postgres.sql-guard.ts`, each file a single responsibility, with
the same shape repeated for Mongo and RabbitMQ.

#### Consequences

##### Positive

- Each file is small and has one job, so it can be read in isolation.
- Error mapping and input guarding are visible as first-class concerns rather than buried
  inside a larger file.

##### Negative

- One task meant three files: the agent had to open the provider, the error mapper and the
  guard before it could make a change, spending context on navigation and risking editing
  the wrong one.

#### References

### Global layers across the project

Folders by technical layer for the project as a whole — `providers/`, `mappers/`,
`schemas/`, `tools/` — with every backend contributing one file to each.

#### Consequences

##### Positive

- Each layer is uniform, so a cross-cutting change to one concern is made in one folder.
- The boundary between layers is explicit and easy to enforce with lint rules.

##### Negative

- It spreads a single backend across four folders, which is the exact problem that
  prompted the change: the context for one backend ends up fragmented across the project.

#### References
