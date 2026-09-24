# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (Model Context Protocol) gateway in Node.js + TypeScript. It exposes PostgreSQL, MongoDB,
RabbitMQ and Redis as MCP tools over HTTP, so an agent needs to know a single endpoint to reach the
infrastructure. The `README.md` is the user-facing reference and stays authoritative
for env vars and the tool catalogue.

## Commands

| Task                    | Command                                        |
| ----------------------- | ---------------------------------------------- |
| Dev server (watch)      | `npm run dev`                                  |
| Build (`dist/`)         | `npm run build`                                |
| Run built output        | `npm start`                                    |
| Type check only         | `npm run typecheck`                            |
| Lint / autofix          | `npm run lint` / `npm run lint:fix`            |
| Format / check          | `npm run format` / `npm run format:check`      |
| Tests                   | `npm test`                                     |
| Tests, watch / coverage | `npm run test:watch` / `npm run test:coverage` |
| Full gate               | `npm run check` (typecheck + lint + test)      |

Single test file: `npx jest src/providers/PostgresProvider.unit.spec.ts`
Single test case: `npm test -- -t "returns a validation error"`

Docker: `docker compose up --build` (see `docker-compose.yml`).

## Architecture: vertical slice

**Each backend is one vertical slice: a single file under `src/providers/` holding everything that
belongs to it** — the provider class, its error mapper, its input guards/codecs and its tool
definitions — plus its `.unit.spec.ts` next to it. Slices do not import each other.

`src/providers/index.ts` deliberately does **not** re-export the concrete providers — that would
create a runtime cycle with the subclasses. Import each provider from its own file.

### Invariants worth preserving

- **Tools are built with `Tool.create()` and registered only by `src/server/mcp-server.ts`.** Each
  provider exposes its tools in `tools`; `registerTools()` in the MCP server builds the name,
  publishes the envelope as `outputSchema` and delivers the response. `Tool.execute()` wraps the
  handler in a try/catch that turns any exception into the envelope, so no stack trace ever reaches
  the agent. Handlers return the `ToolResponse` literal themselves. Gateway-owned tools are
  registered by `buildMcpServer` with no provider segment. Never call `server.registerTool`
  anywhere else.
- **Providers are singletons** (`getInstance`, like `Config`) and own their connection lifecycle:
  `connect`/`disconnect` are each provider's own, not part of the `Provider` base class.
- **Every tool returns `ToolResponse`** (`isError`, `errorCategory`, `isRetryable`, `message`,
  `userFriendlyMessage`, `data`), delivered both as `structuredContent` and as JSON text. Error
  categories: `transient` (retryable), `validation`, `business`, `permission`.
- **Providers are optional and failure-tolerant.** No connection URL in env ⇒ the provider registers
  no tools and the gateway still boots. A backend that is down at startup is retried on demand.
- **Tool names** follow `{GATEWAY_NAME}_{PROVIDER_NAME}_{TOOL_NAME}`, uppercased and normalized;
  gateway-owned tools skip the provider segment. Clients usually cap names at 64 chars.
