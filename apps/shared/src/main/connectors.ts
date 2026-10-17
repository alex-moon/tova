// Shared connector contracts: single source of truth for the connector type namespace and wire shapes; types only.
// @see #329 #328 #326 #330

/* The connector type namespace; `api`/`sdk` are reserved names, parsed but rejected at create time. */
// @see #327
export const CONNECTOR_TYPES = ['mcp.pat', 'mcp.oauth', 'api', 'sdk'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

// Platform rows are owner-curated and read-only for users; user rows are personal and owned.
export type ConnectorScope = 'platform' | 'user';

export type ConnectorStatus = 'connected' | 'unreachable' | 'never-tested';

// Grant health: an mcp.oauth grant flips to 'needs-reauth' when proactive refresh fails; only re-auth clears it.
// @see #327
export type ConnectorAuthState = 'ok' | 'needs-reauth';

export interface ConnectorToolInfo {
  name: string;
  description: string;
}

// Wire shape of one connected connector; `authConfigured` is the type-agnostic "secret material is stored" flag, never any secret content.
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

// POST /api/connectors body; OAuth connectors are created by the browser flow, not this endpoint.
export interface ConnectorAddInput {
  type: ConnectorType;
  name: string;
  url: string;
  authToken?: string;
}

// OAuth connect flow: start probes discovery and returns the consent URL; the callback completes the exchange and creates/updates the connector.
// @see #327
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

// Catalog definition shape: one curated entry as the catalog slices populate it and the UI grid renders it.
// @see #329 #330 #332 #331
export interface ConnectorDefinition {
  id: string;
  name: string;
  authType: ConnectorType;
  endpoint: string;
  summary?: string;
  iconRef?: string;
  instructionsRef?: string;
}
