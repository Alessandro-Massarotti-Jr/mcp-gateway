# ADR-0002 Make Each Provider Own The Conversion Of Its Data

- **status**: Accepted
- **Date**: 2026-09-24

## Context

ADR-0001 made each backend a vertical slice and listed serialization among the
infrastructure `core/` holds for all slices. That infrastructure was
`src/core/serialization.ts`: a generic `toJsonSafe` / `stringifySafe` pair that walked any
value and converted whatever `JSON.stringify` cannot represent (`BigInt`, `Buffer`,
`Date`, `Map`, `Set`, non-finite numbers, circular references, excessive depth). The MCP
registrar ran every `ToolResponse` through it, and `PostgresProvider` ran its rows through
it.

A generic serialization function like this becomes a crutch that blurs the separation of
responsibilities. Knowing what a backend's data looks like — which types its driver
produces on the way out, and what it expects on the way in — is part of that backend.
While a catch-all converter sits in `core/`, that knowledge is not held by the slice that
owns it: a provider can hand back raw driver values and rely on something downstream to
fix them.

## Decision

Every provider handles its own input and output data. A provider converts what its driver
produces into plain JSON before putting it in the `data` of a `ToolResponse`, and decodes
what it receives, inside its own slice, without the help of shared serialization classes
or modules. `core/` holds no serialization helper, and the registrar delivers the envelope
exactly as the provider returned it.

## Alternatives considered

### Each provider converts its own data

Each slice owns its codec: `MongoProvider` uses EJSON, `RabbitMqProvider` decodes message
buffers into JSON, text or base64, and `PostgresProvider` converts the values `pg` returns
(`Date`, `bytea` buffers, non-finite `float8`) itself.

#### Consequences

##### Positive

- The rules for a backend's data live with that backend, in the same file as the rest of
  its slice.
- The `data` a provider returns is already what the agent receives; nothing downstream
  reshapes it.
- Each conversion covers only the types its driver actually produces, rather than every
  type any driver might produce.

##### Negative

- Similar conversions can end up repeated across slices.
- Nothing in `core/` enforces the rule: every new provider has to remember to convert its
  own data.

#### References

### Keep a shared serializer in `core/`

Keep `src/core/serialization.ts` as the single converter used by the registrar and by any
provider that needs it.

#### Consequences

##### Positive

- One place converts every problematic type, so a provider that forgets to convert
  still produces valid JSON.
- Edge cases such as circular references and excessive depth are handled once for the
  whole gateway.

##### Negative

- It acts as a crutch: providers can leave their data half-handled and rely on a generic
  function to fix it, which pulls part of each backend's responsibility out of its slice.
- It has to handle every type any driver could produce, most of which no provider in this
  gateway ever returns.

#### References
