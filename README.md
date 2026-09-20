# MCP Gateway

An **MCP (Model Context Protocol)** server in Node.js + TypeScript that exposes,
over HTTP, a set of tools for **PostgreSQL**, **MongoDB** (self-hosted or Atlas)
and **RabbitMQ**. Built to run in a container and to be the only endpoint an
agent needs to know in order to talk to your infrastructure.

---

## Table of contents

- [MCP Gateway](#mcp-gateway)
  - [Table of contents](#table-of-contents)
  - [How it works](#how-it-works)
  - [Tool naming pattern](#tool-naming-pattern)
  - [Response contract](#response-contract)
    - [Error categories](#error-categories)
  - [Available tools](#available-tools)
    - [Gateway](#gateway)
    - [PostgreSQL (data yes, structure no)](#postgresql-data-yes-structure-no)
      - [The database structure is untouchable](#the-database-structure-is-untouchable)
    - [MongoDB (read and write, unrestricted)](#mongodb-read-and-write-unrestricted)
    - [RabbitMQ (publishing and querying only)](#rabbitmq-publishing-and-querying-only)
      - [`PEEK_MESSAGES`: reading without consuming](#peek_messages-reading-without-consuming)
      - [What AMQP does not deliver](#what-amqp-does-not-deliver)
  - [Configuration (environment variables)](#configuration-environment-variables)
  - [Running with Docker](#running-with-docker)
    - [Just the gateway, pointing at the infrastructure you already have](#just-the-gateway-pointing-at-the-infrastructure-you-already-have)
    - [Full stack for development](#full-stack-for-development)
  - [Local development](#local-development)
  - [Connecting an agent](#connecting-an-agent)
  - [HTTP endpoints](#http-endpoints)

---

## How it works

The gateway starts an HTTP server with the MCP **Streamable HTTP** transport in
**stateless** mode: each request creates its own MCP server and transport, with
no shared session. That allows scaling the container horizontally without sticky
sessions.

The backend connections (PostgreSQL pool, MongoDB client, AMQP connection) are
**process singletons**: they survive across requests and are reused.

Every provider is **optional**. If its connection variable is not set, none of
that provider's tools are registered — the gateway starts normally with the
rest. A backend that is down does not stop the gateway from booting either: the
connection is retried on demand.

---

## Tool naming pattern

```
{GATEWAY_NAME}_{PROVIDER_NAME}_{TOOL_NAME}
```

All three segments are normalized to uppercase with underscores (accents and
symbols become `_`). The only exception is the gateway's own diagnostic tool,
which has no provider segment:

```
{GATEWAY_NAME}_CHECK_PROVIDERS_STATUS
```

With `GATEWAY_NAME=ACME`, the names become `ACME_POSTGRES_QUERY`,
`ACME_MONGO_FIND`, `ACME_RABBITMQ_PUBLISH_TO_QUEUE`,
`ACME_CHECK_PROVIDERS_STATUS` and so on.

> MCP clients usually cap tool names at 64 characters. The gateway logs a `warn`
> if a name goes past that limit — shorten the `GATEWAY_NAME` in that case.

---

## Response contract

**Every** tool answers with the same envelope, delivered both in
`structuredContent` and as JSON in the text block:

```ts
export type ToolErrorCategory = 'transient' | 'validation' | 'business' | 'permission';

export type ToolResponse<T = unknown> = {
  isError: boolean;
  errorCategory?: ToolErrorCategory | null;
  isRetryable?: boolean | null;
  message: string; // technical, for logs and debugging
  userFriendlyMessage: string; // ready for the agent to pass on to the user
  data?: T | null;
};
```

The envelope is also published as each tool's `outputSchema`, so the agent knows
the shape before calling.

### Error categories

| Category     | `isRetryable` | When it happens                                                  |
| ------------ | ------------- | ---------------------------------------------------------------- |
| `transient`  | `true`        | Network, timeout, deadlock, broker restarting, pool unavailable  |
| `validation` | `false`       | Invalid SQL, missing table/queue, malformed filter, bad argument |
| `business`   | `false`       | Duplicate key, integrity violation, message not routed           |
| `permission` | `false`       | Invalid credentials or a user without privileges on the backend  |

Unhandled exceptions also become this envelope: no stack trace ever leaks to the
agent. The `isError` field of the MCP result mirrors the envelope's `isError`.

**Success example:**

```json
{
  "isError": false,
  "errorCategory": null,
  "isRetryable": null,
  "message": "Statement \"SELECT\" executed, 2 row(s) affected",
  "userFriendlyMessage": "Query executed successfully (2 row(s) returned).",
  "data": { "command": "SELECT", "rowCount": 2, "rows": [] }
}
```

**Error example:**

```json
{
  "isError": true,
  "errorCategory": "business",
  "isRetryable": false,
  "message": "POSTGRES_QUERY: duplicate key value violates unique constraint",
  "userFriendlyMessage": "A record with this unique key already exists.",
  "data": { "sqlState": "23505", "constraint": "users_email_key" }
}
```

> One note: if the agent sends arguments that do not match a tool's
> `inputSchema`, the MCP SDK is what rejects them, before the handler runs. In
> that case the response is a `CallToolResult` with `isError: true` and the
> SDK's validation message — without the envelope. Every semantic validation
> (empty SQL, filter without an operator, missing queue) happens inside the
> handler and **does** use the envelope, with `errorCategory: "validation"`.

---

## Available tools

### Gateway

| Tool                     | What it does                                                                     |
| ------------------------ | -------------------------------------------------------------------------------- |
| `CHECK_PROVIDERS_STATUS` | Real ping on each provider, with latency, version and details. Accepts a filter. |

### PostgreSQL (data yes, structure no)

| Tool             | What it does                                                         |
| ---------------- | -------------------------------------------------------------------- |
| `QUERY`          | Runs ONE data statement with `$1, $2, ...` placeholders.             |
| `LIST_TABLES`    | Lists tables and views, with schema and estimated row count.         |
| `DESCRIBE_TABLE` | Columns, types, nullability, defaults, primary key and indexes.      |
| `TRANSACTION`    | Several statements in a single BEGIN/COMMIT, auto-ROLLBACK on error. |

The `QUERY` result is truncated at `DEFAULT_ROW_LIMIT`, and the envelope reports
`truncated`, `returnedRows` and `totalRows`.

#### The database structure is untouchable

`QUERY` and `TRANSACTION` go through a command allowlist before anything reaches
the database. Only these get through:

```
SELECT · INSERT · UPDATE · DELETE · WITH · VALUES · TABLE · SHOW · EXPLAIN
```

Any other command is refused with `errorCategory: "validation"` — `CREATE`,
`ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `COMMENT`, `REINDEX`, `VACUUM`,
`COPY`, `LOCK`, `DO`, `CALL`, `SET`, and unknown commands too, which fail closed
instead of slipping through.

The validation covers the less obvious ways of changing structure:

- **Several statements in one string.** `UPDATE t SET a = 1; DROP TABLE other`
  is refused: `QUERY` accepts one command per call.
- **A hidden semicolon.** The separator is looked for outside strings, quoted
  identifiers, `$$...$$` blocks and comments (including nested ones), so
  `SELECT 'a'; DROP TABLE t; --'` does not fool the guard.
- **`SELECT ... INTO new_table`**, which creates a table, is refused.
  `INSERT INTO` keeps working normally.
- **`EXPLAIN ANALYZE`**, which really executes: the analyzed command goes
  through the allowlist too, blocking
  `EXPLAIN ANALYZE CREATE TABLE ... AS SELECT`.

In a `TRANSACTION`, the validation runs over every statement **before** the
`BEGIN`: a refused statement never even opens a connection, and the message says
which one it was.

> The guard reads the command, not what it executes internally. A `SELECT` that
> calls a function with DDL in its body (`dblink`, procedures) still gets
> through. For a real barrier, point the gateway at a role without DDL
> privileges — this here is the safety net, not the wall.

### MongoDB (read and write, unrestricted)

| Tool               | What it does                                          |
| ------------------ | ----------------------------------------------------- |
| `LIST_DATABASES`   | Databases reachable by the connection user.           |
| `LIST_COLLECTIONS` | Collections and views of a database.                  |
| `FIND`             | Search with filter, projection, sort, limit and skip. |
| `AGGREGATE`        | Aggregation pipeline (including `$out` / `$merge`).   |
| `COUNT`            | Document count by filter.                             |
| `INSERT`           | Inserts one or more documents and returns the `_id`s. |
| `UPDATE`           | `updateOne`/`updateMany` with optional `upsert`.      |
| `DELETE`           | `deleteOne`/`deleteMany`.                             |

Filters and documents accept **Extended JSON**, so the agent works with plain
JSON and still reaches BSON types:

```json
{ "_id": { "$oid": "65f1c2d3e4f5a6b7c8d9e0f1" }, "createdAt": { "$date": "2024-01-01T00:00:00Z" } }
```

Documents come back in the same format, ready to be reused in a filter.

Two safety catches are built in:

- `UPDATE` refuses an `update` without an operator (`$set`, `$inc`, ...),
  preventing an accidental replacement of the whole document.
- `DELETE` with an empty filter and `multi: true` requires
  `confirmDeleteAll: true`.

It works the same with a self-hosted instance (`mongodb://`) and with Atlas
(`mongodb+srv://`) — the connection URL is all it takes.

### RabbitMQ (publishing and querying only)

| Tool                  | What it does                                                                |
| --------------------- | --------------------------------------------------------------------------- |
| `PUBLISH_TO_QUEUE`    | Publishes straight into an existing queue, with publisher confirms.         |
| `PUBLISH_TO_EXCHANGE` | Publishes to an exchange with a routing key, with confirms and `mandatory`. |
| `INSPECT_QUEUE`       | Pending messages and connected consumers on the queue.                      |
| `PEEK_MESSAGES`       | Reads idle messages without consuming: everything goes back to the broker.  |
| `CHECK_EXCHANGE`      | Checks whether the exchange exists.                                         |

**The gateway never changes the broker topology.** There is no tool to declare,
delete or purge a queue, create/remove an exchange, create bindings or touch
users. The tools only use `checkQueue` / `checkExchange`, which query without
creating anything — if the queue or exchange does not exist, the response comes
back with `errorCategory: "validation"`.

#### `PEEK_MESSAGES`: reading without consuming

It reads up to `count` messages (default 5, cap 50) with `basic.get` and hands
them all back to the broker with `nack(requeue)`. No message is lost. The body
comes back decoded as JSON, text or base64 according to the `contentType`,
truncated at `maxBodyBytes`.

The messages are only nacked after all of them have been read — returning one at
a time would make the next read bring the same message again — and the requeue
runs in reverse order, because each message goes back to the head of the queue.

Two effects worth knowing before using this in production:

- the messages read become marked as `redelivered`, which may trigger
  dead-letter policies based on delivery counts;
- messages already delivered to an active consumer do not show up, because they
  are reserved for that consumer until the ack.

#### What AMQP does not deliver

The AMQP 0-9-1 protocol has no command to **list** anything. It does not exist
and will not exist here: listing queues, listing exchanges, viewing bindings,
viewing consumer details or message rates per second are management-plane
operations (Management HTTP API, port 15672), not protocol ones.

About a queue, AMQP exposes exactly three things: the name, the message count
and the consumer count — which is what `INSPECT_QUEUE` returns. About an
exchange, only whether it exists. Durability, arguments, type, policy and the
configured DLQ do not travel over AMQP.

By design, the gateway speaks AMQP only: it opens no HTTP connection to the
broker and does not depend on the management plugin being enabled.

Publishing details:

- Always with **publisher confirms**: success is only reported after the broker
  confirms the write (capped by `RABBITMQ_PUBLISH_TIMEOUT_MS`).
- Always with **`mandatory`**: if no queue receives a message published to an
  exchange, the response comes back with `errorCategory: "business"` and
  `routed: false`, instead of vanishing silently.
- Objects and arrays are serialized as JSON (`application/json`); strings go as
  `text/plain`. This can be overridden with `contentType`.
- Supported AMQP options: `persistent` (default `true`), `headers`,
  `correlationId`, `messageId`, `replyTo`, `priority`, `expirationMs`, `type`.

> The queue and consumer counts come from AMQP itself. Listing **all** the
> broker's queues would require the HTTP Management API, which is not used here.

---

## Configuration (environment variables)

Copy `.env.example` to `.env` and adjust it. No variable is required: the
gateway starts with the defaults and with no provider at all.

| Variable                            | Default         | Description                                                      |
| ----------------------------------- | --------------- | ---------------------------------------------------------------- |
| `PORT`                              | `3000`          | HTTP port.                                                       |
| `HOST`                              | `0.0.0.0`       | Listening interface.                                             |
| `GATEWAY_NAME`                      | `MCP_GATEWAY`   | Prefix of every tool.                                            |
| `MCP_PATH`                          | `/mcp`          | Path of the MCP endpoint.                                        |
| `LOG_LEVEL`                         | `info`          | `debug`, `info`, `warn`, `error`, `silent`.                      |
| `REQUEST_BODY_LIMIT`                | `4mb`           | Maximum request body size.                                       |
| `POSTGRES_CONNECTION_URL`           | —               | Enables the PostgreSQL provider.                                 |
| `POSTGRES_POOL_MAX`                 | `10`            | Maximum connections in the pool.                                 |
| `POSTGRES_CONNECTION_TIMEOUT_MS`    | `10000`         | Timeout for getting a connection from the pool.                  |
| `POSTGRES_STATEMENT_TIMEOUT_MS`     | `30000`         | Timeout per statement.                                           |
| `MONGO_CONNECTION_URL`              | —               | Enables the MongoDB provider (`mongodb://` or `mongodb+srv://`). |
| `MONGO_DEFAULT_DATABASE`            | database in URL | Database used when the tool receives no `database`.              |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | `10000`         | Server selection timeout.                                        |
| `MONGO_MAX_POOL_SIZE`               | `10`            | Maximum connections in the pool.                                 |
| `RABBITMQ_CONNECTION_URL`           | —               | Enables the RabbitMQ provider (`amqp://` or `amqps://`).         |
| `RABBITMQ_CONNECTION_TIMEOUT_MS`    | `10000`         | AMQP connection timeout.                                         |
| `RABBITMQ_PUBLISH_TIMEOUT_MS`       | `10000`         | Cap on waiting for the publisher confirm.                        |
| `DEFAULT_ROW_LIMIT`                 | `100`           | Rows/documents returned without an explicit limit.               |
| `MAX_ROW_LIMIT`                     | `1000`          | Cap the call is allowed to ask for.                              |

The connection URLs are also read from alternative names, to live alongside
existing deploys:

- PostgreSQL: `POSTGRES_CONNECTION_URL`, `POSTGRESS_CONNECTION_URL`,
  `POSTGRES_CONECTION_URL`, `POSTGRESS_CONECTION_URL`, `DATABASE_URL`
- MongoDB: `MONGO_CONNECTION_URL`, `MONGODB_CONNECTION_URL`,
  `MONGO_CONECTION_URL`, `MONGODB_URI`
- RabbitMQ: `RABBITMQ_CONNECTION_URL`, `RABBIT_CONNECTION_URL`,
  `RABBITMQ_CONECTION_URL`, `RABBIT_CONECTION_URL`, `AMQP_URL`

A URL with an incompatible protocol (e.g. `mysql://` for PostgreSQL) takes the
process down at boot with a message naming the field — failing early, instead of
only on the tool's first call.

---

## Running with Docker

### Just the gateway, pointing at the infrastructure you already have

```bash
docker build -t mcp-gateway .

docker run -d --name mcp-gateway -p 3000:3000 \
  -e GATEWAY_NAME=ACME \
  -e POSTGRES_CONNECTION_URL="postgres://user:password@host:5432/app" \
  -e MONGO_CONNECTION_URL="mongodb+srv://user:password@cluster0.abc.mongodb.net/app" \
  -e RABBITMQ_CONNECTION_URL="amqp://user:password@host:5672" \
  mcp-gateway
```

### Full stack for development

Starts gateway + PostgreSQL + MongoDB + RabbitMQ, each backend with a
healthcheck:

```bash
docker compose up -d
docker compose logs -f mcp-gateway
```

The image runs as the `node` user (no root) and ships a `HEALTHCHECK` that hits
`/health` — the container turns `unhealthy` when a configured provider goes
down.

---

## Local development

```bash
npm install
cp .env.example .env    # adjust the URLs

npm run dev             # tsx watch, reloads on every change
npm run build           # compiles to dist/
npm start               # runs the build

npm test                # jest
npm run test:coverage   # jest with coverage
npm run lint            # eslint
npm run format          # prettier --write
npm run typecheck       # tsc --noEmit
npm run check           # typecheck + lint + test
```

---

## Connecting an agent

Any MCP client that speaks **Streamable HTTP** will do. Example configuration:

```json
{
  "mcpServers": {
    "acme-gateway": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Quick test from the command line:

```bash
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## HTTP endpoints

| Method | Route     | Response                                                            |
| ------ | --------- | ------------------------------------------------------------------- |
| `POST` | `/mcp`    | MCP endpoint (Streamable HTTP, stateless).                          |
| `GET`  | `/mcp`    | `405` — there is no server stream without a session.                |
| `GET`  | `/health` | `200` when all are healthy, `503` if a configured provider is down. |
| `GET`  | `/`       | Gateway name, MCP endpoint, prefix and list of registered tools.    |


<br>

---

Developed by [Alessandro Massarotti Jr](https://github.com/Alessandro-Massarotti-Jr) 🤖
