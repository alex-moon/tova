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

// Grant health for the auth types that can die (#327): a static pat token
// is always 'ok' server-side; an mcp.oauth grant flips to 'needs-reauth'
// when the proactive refresh fails (revoked or expired grant) and only a
// successful re-auth clears it. Surfaced so the UI can offer re-connect
// without deleting the connector.
export type ConnectorAuthState = 'ok' | 'needs-reauth';

export interface ConnectorToolInfo {
  name: string;
  description: string;
}

// Wire shape of one connected connector, as returned by GET /api/connectors
// and POST /api/connectors. `authConfigured` is the type-agnostic "secret
// material is stored" flag: for `mcp.pat` it mirrors the encrypted header
// envelope; for `mcp.oauth` it reports the token vault. No token, header,
// or envelope content is ever included.
export interface ConnectorInfo {
  id: string;
  scope: ConnectorScope;
  type: ConnectorType;
  name: string;
  url: string;
  status: ConnectorStatus;
  authConfigured: boolean;
  authState: ConnectorAuthState;
  tools: ConnectorToolInfo[];
}

// POST /api/connectors body. `authToken` is the pat-type secret, submitted
// once and stored encrypted server-side. OAuth connectors are NOT created
// here — they are created by the browser flow (ConnectorOAuthStart /
// ConnectorOAuthCallback below); posting type 'mcp.oauth' to the registry
// endpoint is answered with a pointer to that flow.
export interface ConnectorAddInput {
  type: ConnectorType;
  name: string;
  url: string;
  authToken?: string;
}

// OAuth connect flow (#327). Start probes discovery, registers the client
// (RFC 7591 dynamic registration) and returns the consent-screen URL the
// browser must be redirected to; the callback completes the code exchange
// and creates (or, via the re-auth path, updates) the connector.
export interface ConnectorOAuthStartInput {
  name: string;
  url: string;
}

export interface ConnectorOAuthStart {
  authorizationUrl: string;
}

export interface ConnectorOAuthCallbackInput {
  code: string;
  state: string;
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
