// Shared connector contracts (#329, epic #328). Single source of truth for the
// connector type namespace and the HTTP wire shapes of the connector registry,
// consumed by the server (validation/serialization), the client (services and
// views), and later the curated catalog (#326/#330 slices).
//
// Types only — same rules as contracts.ts: no runtime imports, no
// dependencies; must typecheck under both server (commonjs) and client
// (esnext + verbatimModuleSyntax) configs. The one exception is the
// CONNECTOR_TYPES const below: a plain string array with no deps, safe in
// both module systems, and load-bearing for server-side zod validation.

/*
 * The connector type namespace. `mcp.pat` is today's URL + bearer-token
 * connector (the only creatable type until #327 lands); `mcp.oauth` arrives
 * with #327; `api` / `sdk` are reserved names — parsed but rejected at create
 * time until a real use case exists (epic non-goal).
 */
export const CONNECTOR_TYPES = ['mcp.pat', 'mcp.oauth', 'api', 'sdk'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

// Scope semantics preserved from the MCP-server era: platform rows are
// owner-curated and read-only for users; user rows are personal and owned.
export type ConnectorScope = 'platform' | 'user';

export type ConnectorStatus = 'connected' | 'unreachable' | 'never-tested';

export interface ConnectorToolInfo {
  name: string;
  description: string;
}

// Wire shape of one connected connector, as returned by GET /api/connectors
// and POST /api/connectors. `authConfigured` is the type-agnostic "secret
// material is stored" flag: for `mcp.pat` it mirrors the encrypted header
// envelope; #327's `mcp.oauth` reports it from token vault fields instead.
// No token, header, or envelope content is ever included.
export interface ConnectorInfo {
  id: string;
  scope: ConnectorScope;
  type: ConnectorType;
  name: string;
  url: string;
  status: ConnectorStatus;
  authConfigured: boolean;
  tools: ConnectorToolInfo[];
}

// POST /api/connectors body. `authToken` is the pat-type secret, submitted
// once and stored encrypted server-side.
export interface ConnectorAddInput {
  type: ConnectorType;
  name: string;
  url: string;
  authToken?: string;
}

// Catalog definition shape (ticket #329 ask 4): one curated connector entry
// as the catalog slices (#330/#332) will populate it and the UI grid (#331)
// will render it. `id` is the catalog slug (e.g. 'notion'); `iconRef` and
// `instructionsRef` point at client-side assets/content (per-provider PAT
// setup copy, #332).
export interface ConnectorDefinition {
  id: string;
  name: string;
  authType: ConnectorType;
  endpoint: string;
  summary?: string;
  iconRef?: string;
  instructionsRef?: string;
}
