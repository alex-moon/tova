import { randomBytes } from 'crypto';
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ConnectorDocument } from '../models/Connector';
import { Connector } from '../models/Connector';
import { decryptEnvelope, encryptEnvelope } from './crypto';

/*
 * OAuth engine for mcp.oauth connectors (#327, epic #328). Tova is the OAuth
 * client; the browser is the consent surface. All RFC plumbing (discovery
 * well-knowns incl. path-inserted variants, dynamic client registration
 * RFC 7591, PKCE RFC 7636, token exchange RFC 6749) comes from the MCP SDK's
 * auth module; this file owns only the Tova-side state: pending consents,
 * the encrypted token vault, and the proactive refresh policy.
 *
 * Flow: POST /api/connectors/oauth/start probes discovery on the endpoint,
 * registers a client, and returns the consent URL (pending record keyed by
 * state, 10-minute TTL). The provider redirects the browser to the client's
 * /connectors/callback (same-origin app in dev and prod — no CORS story);
 * that page POSTs the code+state to /api/connectors/oauth/callback, which
 * exchanges the code and creates (or, with pending.connectorId, updates) the
 * connector. Tokens live in the connector document's encrypted `oauth`
 * envelope, so factory reset sweeps them (purge interlock, #327 comment).
 */

const PENDING_TTL_MS = 10 * 60 * 1000;
// Refresh an access token that expires within this window; the proactive
// skew keeps mid-turn expiry rare without a background prober.
const REFRESH_SKEW_MS = 60 * 1000;

export interface ConnectorOAuthVault {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
  // The RFC 8707 resource indicator the grant was issued for; re-sent on
  // refresh so the AS refreshes against the same resource.
  resource?: string;
  // The authorization server that issued these tokens plus the metadata it
  // served at discovery: refreshAuthorization does NOT re-discover — without
  // the stored metadata it would fall back to `{asUrl}/token`, wrong for any
  // server with custom endpoints.
  authorizationServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  // DCR-registered client (RFC 7591), reused on re-auth so a provider sees
  // one client per Tova server rather than one per consent. The FULL SDK
  // shape (snake_case, incl. token_endpoint_auth_method) is persisted —
  // narrowing it would make refresh guess the auth method.
  clientInformation?: OAuthClientInformationMixed;
}

interface PendingOAuth {
  userId: string;
  name: string;
  url: string;
  redirectUri: string;
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  clientInformation: OAuthClientInformationMixed;
  // RFC 8707 resource indicator from the endpoint's protected-resource doc;
  // echoed on the token exchange so the AS binds the tokens to the resource.
  resource?: string;
  codeVerifier: string;
  // Set by the re-auth path: the callback updates this row instead of
  // creating a new one.
  connectorId?: string;
  expiresAt: number;
}

// Pending consents are in-memory by design: nothing secret is stored (PKCE
// verifier + state only — no tokens exist yet), the app is single-process,
// and an abandoned consent self-cleans; a restart mid-consent just fails the
// exchange with "expired" and the user retries. No collection, so the
// factory-reset sweep is untouched.
const pending = new Map<string, PendingOAuth>();

const prunePending = (now = Date.now()): void => {
  for (const [key, entry] of pending) if (entry.expiresAt <= now) pending.delete(key);
};

export class ConnectorOAuthError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ConnectorOAuthError';
    this.status = status;
  }
}

export interface ConnectorOAuthProbe {
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  // The RFC 9728 doc when the endpoint served one. Its `resource` is the
  // canonical RFC 8707 indicator and its `scopes_supported` the per-server
  // scope set — both must ride the authorization request or multi-product
  // authorization servers (Atlassian) cannot route consent to the right
  // product (Trello consent came back as the Rovo site picker without it,
  // #330 verification pass).
  resourceMetadata?: OAuthProtectedResourceMetadata;
}

// SSRF posture parity with the connector url itself (https-only, #36): the
// discovery hops (RFC 9728 authorization_servers, then the AS metadata's
// endpoints) are fetched server-side from user-supplied input, so each must
// clear the same bar. Loopback/private hosts are rejected too — the private
// address spaces are not legitimate public authorization servers.
const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i;

const assertPublicHttpsUrl = (raw: string | URL, what: string): URL => {
  let parsed: URL;
  try {
    parsed = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw new ConnectorOAuthError(`The ${what} is not a valid URL.`, 422);
  }
  if (parsed.protocol !== 'https:' || PRIVATE_HOST.test(parsed.hostname)) {
    throw new ConnectorOAuthError(`The ${what} must be a public https URL.`, 422);
  }
  return parsed;
};

/*
 * Probe an MCP endpoint for OAuth per the MCP auth spec: protected-resource
 * metadata (RFC 9728) names the authorization servers; fall back to treating
 * the endpoint origin itself as the authorization server (the pre-9728
 * shape). Returns null when nothing advertises OAuth — the endpoint stays a
 * token-form (mcp.pat) candidate.
 */
export const probeConnectorOAuth = async (url: string): Promise<ConnectorOAuthProbe | null> => {
  let authorizationServerUrl: string | undefined;
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  try {
    const resource = await discoverOAuthProtectedResourceMetadata(url);
    authorizationServerUrl = resource?.authorization_servers?.[0];
    resourceMetadata = resource;
  } catch {
    // No RFC 9728 document: fall through to the origin-as-issuer attempt.
  }
  if (!authorizationServerUrl) {
    const parsed = new URL(url);
    authorizationServerUrl = `${parsed.protocol}//${parsed.host}`;
  }
  // The discovered issuer is untrusted input from the endpoint's own doc.
  assertPublicHttpsUrl(authorizationServerUrl, 'OAuth authorization server');
  try {
    const metadata = await discoverAuthorizationServerMetadata(authorizationServerUrl);
    // An authorization endpoint is the one thing a usable AS metadata must
    // carry; anything less is not an OAuth server we can drive.
    if (!metadata?.authorization_endpoint) return null;
    // Same bar for the endpoints discovery asks Tova to contact.
    assertPublicHttpsUrl(metadata.authorization_endpoint, 'OAuth authorization endpoint');
    if (metadata.token_endpoint)
      assertPublicHttpsUrl(metadata.token_endpoint, 'OAuth token endpoint');
    if (metadata.registration_endpoint)
      assertPublicHttpsUrl(metadata.registration_endpoint, 'OAuth registration endpoint');
    return { authorizationServerUrl, metadata, resourceMetadata };
  } catch (err) {
    // A discovery doc pointing Tova at private/http endpoints is not "no
    // OAuth" — surface why, so the failure is diagnosable.
    if (err instanceof ConnectorOAuthError) throw err;
    return null;
  }
};

// Redirect URI: the app origin the consent redirect must land on. The app is
// same-origin in dev (Vite proxy) and prod (static build), so the start
// request's own Origin (POST) / Referer is the correct base; the env
// override covers non-standard deployments.
export const redirectOriginFrom = (headers: {
  origin?: string | string[];
  referer?: string | string[];
}): string | undefined => {
  const raw =
    (Array.isArray(headers.origin) ? headers.origin[0] : headers.origin) ??
    (Array.isArray(headers.referer) ? headers.referer[0] : headers.referer);
  if (!raw) return process.env.CONNECTORS_OAUTH_ORIGIN;
  try {
    return new URL(raw).origin;
  } catch {
    return process.env.CONNECTORS_OAUTH_ORIGIN;
  }
};

const clientMetadata = (redirectUri: string): OAuthClientMetadata => ({
  redirect_uris: [redirectUri],
  client_name: 'Tova',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
});

export interface StartConnectorOAuthOptions {
  url: string;
  name: string;
  redirectOrigin: string | undefined;
  userId: string;
  // Existing connector being re-authed; its vault client registration (if
  // any) is reused instead of a fresh DCR.
  connectorId?: string;
  existingVault?: ConnectorOAuthVault | null;
}

export const startConnectorOAuth = async (
  options: StartConnectorOAuthOptions,
): Promise<{ authorizationUrl: string }> => {
  const probe = await probeConnectorOAuth(options.url);
  if (!probe) {
    throw new ConnectorOAuthError(
      'This endpoint does not advertise OAuth sign-in. Connect it with a token instead.',
      422,
    );
  }

  const redirectUri = options.redirectOrigin
    ? `${options.redirectOrigin}/connectors/callback`
    : undefined;
  if (!redirectUri) {
    throw new ConnectorOAuthError(
      'Could not determine the app origin for the OAuth redirect.',
      500,
    );
  }

  // A vault registration is only reusable against the AS that issued it; a
  // provider that moved its authorization_servers gets a fresh DCR.
  const reusableClient =
    options.existingVault?.authorizationServerUrl === probe.authorizationServerUrl
      ? options.existingVault?.clientInformation
      : undefined;
  let clientInformation: OAuthClientInformationMixed;
  try {
    clientInformation =
      reusableClient ??
      (await registerClient(probe.authorizationServerUrl, {
        metadata: probe.metadata,
        clientMetadata: clientMetadata(redirectUri),
      }));
  } catch (err) {
    if (err instanceof ConnectorOAuthError) throw err;
    console.error('connector oauth client registration failed:', String(err));
    throw new ConnectorOAuthError(
      /dynamic client registration/i.test(String(err))
        ? 'This provider does not support automatic app registration — one-click sign-in is not available yet.'
        : 'Could not start sign-in with this provider. Try again shortly.',
      422,
    );
  }

  // RFC 8707 resource indicator + the per-server scope set, verbatim from
  // the endpoint's protected-resource doc. Without them a multi-product
  // authorization server cannot tell which product is being authorized —
  // Atlassian served its Rovo/Jira site picker for a Trello-only account.
  const resource = probe.resourceMetadata?.resource;
  const scope = probe.resourceMetadata?.scopes_supported?.join(' ');

  // State is generated here (not by the SDK): it keys the pending record the
  // callback matches against, binding the consent to this start call.
  const state = randomBytes(32).toString('base64url');
  const started = await startAuthorization(probe.authorizationServerUrl, {
    metadata: probe.metadata,
    clientInformation,
    redirectUrl: redirectUri,
    state,
    resource,
    scope,
  });

  prunePending();
  pending.set(state, {
    userId: options.userId,
    name: options.name,
    url: options.url,
    redirectUri,
    authorizationServerUrl: probe.authorizationServerUrl,
    metadata: probe.metadata,
    clientInformation,
    resource,
    codeVerifier: started.codeVerifier,
    connectorId: options.connectorId,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });

  return { authorizationUrl: started.authorizationUrl.toString() };
};

export interface CompleteConnectorOAuthOptions {
  code: string;
  state: string;
  // Caller identity: a pending record is bound to the session that started
  // it, so a different cookie landing on the callback cannot complete it.
  userId: string;
}

const readConnectorVault = (connector: ConnectorDocument): ConnectorOAuthVault | null => {
  if (!connector.oauth) return null;
  try {
    return JSON.parse(decryptEnvelope(connector.oauth)) as ConnectorOAuthVault;
  } catch {
    return null;
  }
};

// Read of the encrypted vault; also used by the re-auth path in the routes
// to hand the stored DCR client registration back to startConnectorOAuth.
export { readConnectorVault };

const vaultFromTokens = (
  tokens: OAuthTokens,
  authorizationServerUrl: string,
  metadata: AuthorizationServerMetadata | undefined,
  clientInformation: OAuthClientInformationMixed | undefined,
  resource?: string,
  previous?: ConnectorOAuthVault | null,
): ConnectorOAuthVault => ({
  accessToken: tokens.access_token,
  // Providers may omit refresh_token on re-issue; keep the previous one
  // rather than dropping the grant's only refresh credential.
  refreshToken: tokens.refresh_token ?? previous?.refreshToken,
  expiresAt:
    typeof tokens.expires_in === 'number'
      ? Date.now() + tokens.expires_in * 1000
      : previous?.expiresAt,
  tokenType: tokens.token_type,
  scope: tokens.scope,
  resource: resource ?? previous?.resource,
  authorizationServerUrl,
  metadata,
  clientInformation,
});

const vaultPayload = (vault: ConnectorOAuthVault): string => JSON.stringify(vault);

/*
 * Complete a consent: match the pending record, exchange the code, and
 * create (fresh connect) or update (re-auth) the connector. Returns the
 * saved document.
 */
export const completeConnectorOAuth = async ({
  code,
  state,
  userId,
}: CompleteConnectorOAuthOptions): Promise<ConnectorDocument> => {
  prunePending();
  const record = pending.get(state);
  if (!record) {
    throw new ConnectorOAuthError(
      'This sign-in attempt expired or is not recognised. Start again.',
      400,
    );
  }
  if (record.userId !== userId) {
    throw new ConnectorOAuthError('This sign-in attempt belongs to a different session', 404);
  }

  // The record is kept until the exchange settles: the client callback page
  // can legitimately race itself (React StrictMode double-fires the effect
  // in dev), and the provider's code is single-use — a replay is answered
  // with the provider's error, not a confusing "state not recognised".
  let tokens: OAuthTokens;
  try {
    tokens = await exchangeAuthorization(record.authorizationServerUrl, {
      metadata: record.metadata,
      clientInformation: record.clientInformation,
      authorizationCode: code,
      codeVerifier: record.codeVerifier,
      redirectUri: record.redirectUri,
      resource: record.resource,
    });
  } catch (err) {
    pending.delete(state);
    // No provider detail is echoed (it can embed response bodies); the
    // server log carries the specifics.
    console.error('connector oauth exchange failed:', String(err));
    throw new ConnectorOAuthError(
      'Sign-in could not be completed. Start again from settings.',
      422,
    );
  }
  pending.delete(state);

  const vault = vaultFromTokens(
    tokens,
    record.authorizationServerUrl,
    record.metadata,
    record.clientInformation,
    record.resource,
  );

  if (record.connectorId) {
    const doc = await Connector.findOne({
      _id: record.connectorId,
      scope: 'user',
      userId: record.userId,
      type: 'mcp.oauth',
    });
    if (!doc) throw new ConnectorOAuthError('Connector not found for re-auth', 404);
    doc.oauth = encryptEnvelope(vaultPayload(vault));
    doc.authState = 'ok';
    doc.name = record.name;
    doc.url = record.url;
    await doc.save();
    return doc;
  }

  const doc = new Connector({
    type: 'mcp.oauth',
    scope: 'user',
    userId: record.userId,
    name: record.name,
    url: record.url,
    status: 'never-tested',
    authState: 'ok',
  });
  doc.oauth = encryptEnvelope(vaultPayload(vault));
  await doc.save();
  return doc;
};

// Single-flight refresh per connector: concurrent chat turns must not race a
// rotating refresh token (many providers invalidate a refresh token once
// used). Keyed by connector id; the loser awaits the winner's promise.
const refreshInFlight = new Map<string, Promise<ConnectorOAuthVault | null>>();

const refreshVault = async (
  connector: ConnectorDocument,
  vault: ConnectorOAuthVault,
): Promise<ConnectorOAuthVault | null> => {
  const key = String(connector._id);
  const existing = refreshInFlight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    // Both a refresh token and the DCR client identity are needed to
    // refresh; missing either means the grant cannot be renewed — the same
    // terminal state as a rejected refresh: re-consent required.
    if (!vault.refreshToken || !vault.clientInformation) {
      connector.authState = 'needs-reauth';
      await connector.save().catch(() => undefined);
      return null;
    }
    try {
      const tokens = await refreshAuthorization(vault.authorizationServerUrl, {
        metadata: vault.metadata,
        clientInformation: vault.clientInformation,
        refreshToken: vault.refreshToken,
        resource: vault.resource,
      });
      const next = vaultFromTokens(
        tokens,
        vault.authorizationServerUrl,
        vault.metadata,
        vault.clientInformation,
        vault.resource,
        vault,
      );
      connector.oauth = encryptEnvelope(vaultPayload(next));
      connector.authState = 'ok';
      await connector.save();
      return next;
    } catch {
      // Revoked or expired grant: mark for re-auth; the doc-level marker is
      // what the UI reads ("re-connect"), no tokens are returned.
      connector.authState = 'needs-reauth';
      await connector.save().catch(() => undefined);
      return null;
    }
  })();
  refreshInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    refreshInFlight.delete(key);
  }
};

const needsRefresh = (vault: ConnectorOAuthVault): boolean =>
  typeof vault.expiresAt === 'number' && vault.expiresAt <= Date.now() + REFRESH_SKEW_MS;

/*
 * mcp.oauth branch of the auth seam (connectorService.authFor): a bearer
 * header from the vault, refreshed proactively when inside the skew window.
 * Returns undefined (anonymous) when the grant is dead — the connector then
 * fails its handshake and drops out of the toolsets, chat proceeds degraded,
 * and the UI shows re-connect.
 */
export const oauthAuthHeaders = async (
  connector: ConnectorDocument,
): Promise<Record<string, string> | undefined> => {
  // A grant already marked dead is only revived by re-auth (which clears
  // the marker); keep hammering a revoked refresh token per chat turn is a
  // doomed provider round-trip some providers lock out.
  if (connector.authState === 'needs-reauth') return undefined;
  const vault = readConnectorVault(connector);
  if (!vault?.accessToken) return undefined;
  const current = needsRefresh(vault) ? await refreshVault(connector, vault) : vault;
  if (!current?.accessToken) return undefined;
  return { Authorization: `Bearer ${current.accessToken}` };
};

// Type-agnostic auth flag for the wire serializer (pat headers or oauth vault).
export const hasVaultedAuth = (connector: ConnectorDocument): boolean =>
  Boolean(connector.oauth) || Boolean(connector.headersConfigured);

// Re-export so route tests (and only tests) can clear the pending map.
export const clearOauthStateForTests = (): void => {
  pending.clear();
  refreshInFlight.clear();
};
