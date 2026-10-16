# Plan — #329: Groundwork — connector model, types, and shared contracts

## Motivation

Ticket: [#329](https://github.com/alex-moon/tova/issues/329) (Epic
[#328](https://github.com/alex-moon/tova/issues/328)). The product concept is becoming
**connectors**, but the code speaks "MCP servers" end to end. Every later epic slice builds
on the type seam this slice introduces.

## Decisions

- **Type namespace in `@tova/shared`** (`apps/shared/src/connectors.ts`, re-exported by
  `index.ts`): `ConnectorType = 'mcp.pat' | 'mcp.oauth' | 'api' | 'sdk'` — all four names
  exist in the contract (`api`/`sdk` reserved, per the epic's non-goals). Wire shapes
  `ConnectorInfo` / `ConnectorAddInput` / `ConnectorToolInfo` / `ConnectorScope` /
  `ConnectorStatus` move there too; the client's local `services/mcp.ts` types and
  `types/mcp.ts` die into it.
- **Wire field `authConfigured`** replaces `headersConfigured` in the API response: the
  generic name is the type-agnostic seam (`mcp.oauth` in #327 will also report
  `authConfigured: true` without any "headers" existing). Storage keeps the pat-specific
  `headers` / `headersConfigured` fields — honest about what a pat-type connector stores;
  the serializer maps per-type storage → generic wire field.
- **Model rename with collection migration.** `McpServer` model → `Connector` (file
  `models/Connector.ts`), collection explicitly named `connectors`. Migration
  `20261016120000-rename-mcpservers-to-connectors` renames the collection via
  `renameCollection` (indexes ride along — same-database rename is a metadata operation) and
  backfills `type: 'mcp.pat'` on every row. Down reverses both. Fresh installs (no
  `mcpservers` collection) are no-ops.
- **`type` in the model** is `required: true` with `default: 'mcp.pat'` and enum
  `['mcp.pat']` for now — the default makes any row that races the migration behave as a pat
  connector instead of failing validation. `#327` extends the enum with `'mcp.oauth'`.
- **Create schema** `connectorCreateSchema`: `type` is required; the full
  `CONNECTOR_TYPES` enum is accepted at parse level so known-but-future types get a
  "not supported yet" message (distinct from "unknown type"), then a refine allows only
  `'mcp.pat'` today. Unknown types are rejected by the enum.
- **API rename** `/api/mcp-servers` → `/api/connectors` (file `routes/connectors.ts`);
  response keys `servers`/`server` → `connectors`/`connector`. A deprecated alias mount at
  `/api/mcp-servers` stays until the UI slices retire it (cheap insurance for anything not
  updated in lockstep, e.g. in-flight e2e mocks).
- **Service split by seam, not by name.** `mcpService.ts` → `connectorService.ts`. The
  MCP-protocol internals (handshake, `listMcpTools`, `callMcpTool`, `zodFromJsonSchema`,
  connection cache) stay — the wire still speaks MCP and the wire code does not move in this
  slice. The DB-facing layer is renamed and type-dispatching: `authFor(connector)` switches
  on `connector.type` (today only the `mcp.pat` branch), `connectorToolsetsForUser` replaces
  `mcpToolsetsForUser`, and `mastraService` calls `connectorToolsetsFrom`. The
  model-visible toolset key prefix `mcp_<name>` stays: renaming it churns traces/evals for
  zero product value.
- **Purge interlock (#327 comment):** `userDataPurge.ts` imports `Connector` and keeps
  sweeping `scope: 'user'` rows — token material stays inside the swept document, so the
  explicit collection list does not grow. Existing purge tests prove user rows die on
  factory reset.
- **Scope semantics, indexes, dedup rules, https-only SSRF guard, envelope encryption, and
  the toJSON header strip are all preserved unchanged.**

## Done

- [x] Shared contracts in `@tova/shared` (`connectors.ts`), consumed by both apps
- [x] `Connector` model + migration (collection rename + `type` backfill), model tests
- [x] `connectorCreateSchema` with required `type`; unknown/reserved types rejected (tests)
- [x] `/api/connectors` routes (+ deprecated alias), route tests updated
- [x] `connectorService` split (protocol internals stay; DB layer renamed, type-dispatched)
- [x] Client: `services/connectors.ts`, `types/mcp.ts` deleted, section updated
- [x] Purge sweep keeps working (tests), e2e mock path updated, README updated
- [x] `npm run ci` green

## Follow-ups

- `mcp.oauth` storage fields + enum extension arrive with #327.
- The deprecated `/api/mcp-servers` alias and the `McpServersSection` name/testids are
  retired by the UI slice (#331).
- Chat 413 copy still says "MCP servers" — UI-copy pass belongs to #331.
