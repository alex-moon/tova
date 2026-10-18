// Shared connector contracts: single source of truth for wire shapes.
// @see #329 #328 #326 #330

/* The connector type namespace; `api`/`sdk` are reserved names. */
// @see #327
export const CONNECTOR_TYPES = ['mcp.pat', 'mcp.oauth', 'api', 'sdk'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

// Platform rows are owner-curated and read-only; user rows are personal.
export type ConnectorScope = 'platform' | 'user';

export type ConnectorStatus = 'connected' | 'unreachable' | 'never-tested';

// Grant health: 'needs-reauth' when proactive refresh fails.
// @see #327
export type ConnectorAuthState = 'ok' | 'needs-reauth';

export interface ConnectorToolInfo {
  name: string;
  description: string;
}

// Wire shape of one connector; `authConfigured` never carries secret content.
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

// POST /api/connectors body; OAuth connectors use the browser flow.
export interface ConnectorAddInput {
  type: ConnectorType;
  name: string;
  url: string;
  authToken?: string;
}

// OAuth flow: start returns the consent URL; callback completes the exchange.
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

// Catalog definition shape: one curated catalog entry.
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
