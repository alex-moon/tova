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

/* OAuth engine for mcp.oauth connectors; SDK handles RFC plumbing. */
// @see #327 #328

const PENDING_TTL_MS = 10 * 60 * 1000;
// Proactive refresh skew: keeps mid-turn expiry rare.
const REFRESH_SKEW_MS = 60 * 1000;

export interface ConnectorOAuthVault {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
  // RFC 8707 resource indicator the grant was issued for; re-sent on refresh.
  resource?: string;
  // The issuing AS: refreshAuthorization does NOT re-discover metadata.
  authorizationServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  // DCR client, reused on re-auth; persist the full SDK shape.
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
  // RFC 8707 resource indicator; echoed on the token exchange.
  resource?: string;
  codeVerifier: string;
  // Set by re-auth: the callback updates this row, not create.
  connectorId?: string;
  expiresAt: number;
}

// Pending consents are in-memory by design: self-cleaning, nothing secret.
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
  // RFC 9728 doc when served; its resource/scope must ride the request.
  // @see #330
  resourceMetadata?: OAuthProtectedResourceMetadata;
}

// SSRF parity with the connector url: discovery hops clear the same bar.
// @see #36
const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i;

// Literal checks close what the name regex misses (0.0.0.0, IPv6 forms the
// URL parser canonicalizes, e.g. [::ffff:7f00:1] reaching loopback). Hostname
// inputs are WHATWG-canonical, so v4 is dotted and v6 hex hextets.
// @see #397
const blockedIpv4 = (hostname: string): boolean => {
  const octets = hostname.split('.');
  if (octets.length !== 4) return false;
  const n = octets.map((o) => Number(o));
  if (n.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return false;
  const [a, b] = n;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
};

const ipv6Hextets = (hostname: string): number[] | null => {
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) return null;
  const halves = hostname.slice(1, -1).split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  const values = groups.map((g) => (/^[0-9A-Fa-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : NaN));
  return values.some(Number.isNaN) ? null : values;
};

const blockedIpv6 = (hostname: string): boolean => {
  const g = ipv6Hextets(hostname);
  if (!g) return false;
  if (g.every((h) => h === 0)) return true; // ::
  if (g[0] === 1 && g.slice(1).every((h) => h === 0)) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  // v4-mapped ::ffff:x.x.x.x: judge the embedded v4 the same as a literal.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const v4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
    return blockedIpv4(v4);
  }
  return false;
};

export const assertPublicHttpsUrl = (raw: string | URL, what: string): URL => {
  let parsed: URL;
  try {
    parsed = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw new ConnectorOAuthError(`The ${what} is not a valid URL.`, 422);
  }
  if (parsed.protocol !== 'https:') {
    throw new ConnectorOAuthError(`The ${what} must be a public https URL.`, 422);
  }
  if (
    PRIVATE_HOST.test(parsed.hostname) ||
    blockedIpv4(parsed.hostname) ||
    blockedIpv6(parsed.hostname)
  ) {
    throw new ConnectorOAuthError(`The ${what} must be a public https URL.`, 422);
  }
  return parsed;
};

/* Probe an endpoint for OAuth: metadata names the AS, else the origin. */
// @see #327
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
    // An authorization endpoint is the one required metadata field.
    if (!metadata?.authorization_endpoint) return null;
    // Same bar for the endpoints discovery asks Tova to contact.
    assertPublicHttpsUrl(metadata.authorization_endpoint, 'OAuth authorization endpoint');
    if (metadata.token_endpoint)
      assertPublicHttpsUrl(metadata.token_endpoint, 'OAuth token endpoint');
    if (metadata.registration_endpoint)
      assertPublicHttpsUrl(metadata.registration_endpoint, 'OAuth registration endpoint');
    return { authorizationServerUrl, metadata, resourceMetadata };
  } catch (err) {
    // Private/http discovery targets are a diagnosable failure, not none.
    if (err instanceof ConnectorOAuthError) throw err;
    return null;
  }
};

// Redirect base: the request's own Origin/Referer; env override exists.
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

/* Static OAuth clients for providers without RFC 7591 DCR support. */
// @see #342
interface StaticOAuthClient {
  clientId: string;
  clientSecret: string;
}

export const staticClientFor = (authorizationServerUrl: string): StaticOAuthClient | undefined => {
  const raw = process.env.CONNECTORS_OAUTH_CLIENTS;
  if (!raw) return undefined;
  let parsed: Record<string, StaticOAuthClient>;
  try {
    parsed = JSON.parse(raw) as Record<string, StaticOAuthClient>;
  } catch {
    console.error('CONNECTORS_OAUTH_CLIENTS is not valid JSON — ignoring static OAuth clients');
    return undefined;
  }
  try {
    return parsed[new URL(authorizationServerUrl).origin];
  } catch {
    return undefined;
  }
};

export interface StartConnectorOAuthOptions {
  url: string;
  name: string;
  redirectOrigin: string | undefined;
  userId: string;
  // Existing connector re-authed; vault registration is reused, not fresh DCR.
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

  // Client selection, most-stable first: static, vaulted DCR, fresh DCR.
  // @see #342
  const staticClient = staticClientFor(probe.authorizationServerUrl);
  const reusableClient =
    options.existingVault?.authorizationServerUrl === probe.authorizationServerUrl
      ? options.existingVault?.clientInformation
      : undefined;
  let clientInformation: OAuthClientInformationMixed;
  if (staticClient) {
    clientInformation = {
      client_id: staticClient.clientId,
      client_secret: staticClient.clientSecret,
    };
  } else if (reusableClient) {
    clientInformation = reusableClient;
  } else {
    try {
      clientInformation = await registerClient(probe.authorizationServerUrl, {
        metadata: probe.metadata,
        clientMetadata: clientMetadata(redirectUri),
      });
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
  }

  // Resource indicator + scopes, verbatim from the protected-resource doc.
  // @see #330
  const resource = probe.resourceMetadata?.resource;
  const scope = probe.resourceMetadata?.scopes_supported?.join(' ');

  // State generated here: it keys the pending record the callback matches.
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
  // A pending record is bound to the session that started it.
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

// Read of the encrypted vault; re-auth hands back the DCR registration.
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
  // Keep the previous refresh token when re-issue omits one.
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

/* Complete a consent: match the pending record and exchange the code. */
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

  // Kept until the exchange settles: StrictMode replays get a clean error.
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
    // No provider detail echoed; the server log carries the specifics.
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

// Single-flight refresh per connector: no race on rotating refresh tokens.
const refreshInFlight = new Map<string, Promise<ConnectorOAuthVault | null>>();

const refreshVault = async (
  connector: ConnectorDocument,
  vault: ConnectorOAuthVault,
): Promise<ConnectorOAuthVault | null> => {
  const key = String(connector._id);
  const existing = refreshInFlight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    // Missing refresh token or client identity means re-consent required.
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
      // Revoked/expired grant: mark for re-auth; no tokens returned.
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

/* oauth branch of the auth seam: bearer from vault, refreshed proactively. */
export const oauthAuthHeaders = async (
  connector: ConnectorDocument,
): Promise<Record<string, string> | undefined> => {
  // A dead grant revives only via re-auth; never hammer a revoked token.
  if (connector.authState === 'needs-reauth') return undefined;
  const vault = readConnectorVault(connector);
  if (!vault?.accessToken) return undefined;
  const current = needsRefresh(vault) ? await refreshVault(connector, vault) : vault;
  if (!current?.accessToken) return undefined;
  return { Authorization: `Bearer ${current.accessToken}` };
};

// Type-agnostic auth flag for the wire serializer.
export const hasVaultedAuth = (connector: ConnectorDocument): boolean =>
  Boolean(connector.oauth) || Boolean(connector.headersConfigured);

// Re-export so route tests (and only tests) can clear the pending map.
export const clearOauthStateForTests = (): void => {
  pending.clear();
  refreshInFlight.clear();
};
