import type { ConnectorDocument } from '../../main/models/Connector';
import { Connector } from '../../main/models/Connector';
import { MCP_ENCRYPTION_KEY_ENV_VAR } from '../../main/services/crypto';
import {
  clearOauthStateForTests,
  completeConnectorOAuth,
  ConnectorOAuthError,
  oauthAuthHeaders,
  probeConnectorOAuth,
  redirectOriginFrom,
  startConnectorOAuth,
} from '../../main/services/oauthConnectors';

/* OAuth engine tests: the MCP SDK's auth module is mocked at the module boundary (what we own is the orchestration, the vault, and the refresh policy); flow: probe → DCR → PKCE start → exchange → encrypted vault. */
// @see #327
jest.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  discoverOAuthProtectedResourceMetadata: jest.fn(),
  discoverAuthorizationServerMetadata: jest.fn(),
  registerClient: jest.fn(),
  startAuthorization: jest.fn(),
  exchangeAuthorization: jest.fn(),
  refreshAuthorization: jest.fn(),
}));

const {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
} = jest.requireMock('@modelcontextprotocol/sdk/client/auth.js') as Record<string, jest.Mock>;

const AS_METADATA = {
  authorization_endpoint: 'https://as.example.com/authorize',
  token_endpoint: 'https://as.example.com/token',
  registration_endpoint: 'https://as.example.com/register',
  response_types_supported: ['code'],
};

beforeAll(() => {
  process.env[MCP_ENCRYPTION_KEY_ENV_VAR] = 'oauth-test-key';
});

beforeEach(() => {
  clearOauthStateForTests();
  jest.clearAllMocks();
  discoverOAuthProtectedResourceMetadata.mockResolvedValue({
    authorization_servers: ['https://as.example.com'],
    resource: 'https://mcp.example.com/mcp',
    scopes_supported: ['read:things', 'write:things'],
  });
  discoverAuthorizationServerMetadata.mockResolvedValue(AS_METADATA);
  registerClient.mockResolvedValue({ client_id: 'dcr-client', client_secret: 'dcr-secret' });
  startAuthorization.mockResolvedValue({
    authorizationUrl: new URL('https://as.example.com/authorize?state=xyz'),
    codeVerifier: 'verifier-abc',
  });
  exchangeAuthorization.mockResolvedValue({
    access_token: 'at-1',
    refresh_token: 'rt-1',
    expires_in: 3600,
    token_type: 'Bearer',
  });
  refreshAuthorization.mockResolvedValue({
    access_token: 'at-2',
    refresh_token: 'rt-2',
    expires_in: 3600,
    token_type: 'Bearer',
  });
});

describe('probeConnectorOAuth', () => {
  it('follows RFC 9728 discovery to the authorization server', async () => {
    discoverOAuthProtectedResourceMetadata.mockResolvedValue({
      authorization_servers: ['https://as.example.com'],
      resource: 'https://mcp.example.com/mcp',
      scopes_supported: ['read:things', 'write:things'],
    });
    const probe = await probeConnectorOAuth('https://mcp.example.com/mcp');
    expect(probe).toEqual({
      authorizationServerUrl: 'https://as.example.com',
      metadata: AS_METADATA,
      resourceMetadata: {
        authorization_servers: ['https://as.example.com'],
        resource: 'https://mcp.example.com/mcp',
        scopes_supported: ['read:things', 'write:things'],
      },
    });
  });

  it('falls back to the endpoint origin as the issuer (pre-9728 shape)', async () => {
    discoverOAuthProtectedResourceMetadata.mockRejectedValue(new Error('404'));
    const probe = await probeConnectorOAuth('https://mcp.example.com/mcp');
    expect(discoverAuthorizationServerMetadata).toHaveBeenCalledWith('https://mcp.example.com');
    expect(probe?.authorizationServerUrl).toBe('https://mcp.example.com');
  });

  it('refuses discovery that points Tova at private or non-https endpoints (SSRF guard)', async () => {
    for (const bad of ['http://as.example.com', 'https://localhost', 'https://127.0.0.1/x']) {
      discoverOAuthProtectedResourceMetadata.mockResolvedValue({
        authorization_servers: [bad],
      });
      const err = await probeConnectorOAuth('https://mcp.example.com/mcp').catch(
        (e: ConnectorOAuthError) => e,
      );
      expect(err).toBeInstanceOf(ConnectorOAuthError);
      expect(err.status).toBe(422);
    }
    // An AS whose token endpoint is plain http is equally refused.
    discoverOAuthProtectedResourceMetadata.mockResolvedValue({
      authorization_servers: ['https://as.example.com'],
    });
    discoverAuthorizationServerMetadata.mockResolvedValue({
      ...AS_METADATA,
      token_endpoint: 'http://as.example.com/token',
    });
    await expect(probeConnectorOAuth('https://mcp.example.com/mcp')).rejects.toThrow(
      /public https/u,
    );
  });

  it('returns null when nothing usable advertises OAuth', async () => {
    discoverOAuthProtectedResourceMetadata.mockRejectedValue(new Error('404'));
    discoverAuthorizationServerMetadata.mockRejectedValue(new Error('404'));
    await expect(probeConnectorOAuth('https://mcp.example.com/mcp')).resolves.toBeNull();

    // An AS metadata without an authorization endpoint is not drivable.
    discoverAuthorizationServerMetadata.mockResolvedValue({ token_endpoint: 'https://x' });
    await expect(probeConnectorOAuth('https://mcp.example.com/mcp')).resolves.toBeNull();
  });
});

describe('redirectOriginFrom', () => {
  it('prefers Origin, falls back to Referer, then the env override', () => {
    expect(redirectOriginFrom({ origin: 'https://app.example.com' })).toBe(
      'https://app.example.com',
    );
    expect(redirectOriginFrom({ referer: 'https://app.example.com/profile' })).toBe(
      'https://app.example.com',
    );
    const prev = process.env.CONNECTORS_OAUTH_ORIGIN;
    try {
      delete process.env.CONNECTORS_OAUTH_ORIGIN;
      expect(redirectOriginFrom({})).toBeUndefined();
      process.env.CONNECTORS_OAUTH_ORIGIN = 'https://override.example.com';
      expect(redirectOriginFrom({ origin: 'not a url' })).toBe('https://override.example.com');
    } finally {
      if (prev === undefined) delete process.env.CONNECTORS_OAUTH_ORIGIN;
      else process.env.CONNECTORS_OAUTH_ORIGIN = prev;
    }
  });
});

describe('startConnectorOAuth', () => {
  const base = {
    url: 'https://mcp.example.com/mcp',
    name: 'mine',
    redirectOrigin: 'https://app.example.com' as string | undefined,
    userId: '507f1f77bcf86cd799439011',
  };

  it('422s with guidance when the endpoint advertises no OAuth', async () => {
    discoverOAuthProtectedResourceMetadata.mockRejectedValue(new Error('404'));
    discoverAuthorizationServerMetadata.mockRejectedValue(new Error('404'));
    await expect(startConnectorOAuth(base)).rejects.toThrow(/does not advertise OAuth sign-in/u);
    await expect(
      startConnectorOAuth(base).catch((e: ConnectorOAuthError) => e.status),
    ).resolves.toBe(422);
  });

  it('requires a redirect origin (no app origin, no flow)', async () => {
    await expect(startConnectorOAuth({ ...base, redirectOrigin: undefined })).rejects.toThrow(
      /app origin/u,
    );
  });

  it('registers a client with our redirect URI and stores the pending consent', async () => {
    const { authorizationUrl } = await startConnectorOAuth(base);
    expect(registerClient).toHaveBeenCalledWith(
      'https://as.example.com',
      expect.objectContaining({
        clientMetadata: expect.objectContaining({
          redirect_uris: ['https://app.example.com/connectors/callback'],
          client_name: 'Tova',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      }),
    );
    expect(startAuthorization).toHaveBeenCalledWith(
      'https://as.example.com',
      expect.objectContaining({
        clientInformation: { client_id: 'dcr-client', client_secret: 'dcr-secret' },
        // RFC 8707 resource indicator + per-server scopes, verbatim from the endpoint's protected-resource doc.
        // @see #330
        resource: 'https://mcp.example.com/mcp',
        scope: 'read:things write:things',
      }),
    );
    expect(authorizationUrl).toContain('as.example.com/authorize');
  });

  it('wraps a DCR-incapable authorization server as a 422 with honest copy (#342)', async () => {
    registerClient.mockRejectedValue(
      new Error('Incompatible auth server: does not support dynamic client registration'),
    );
    const err = await startConnectorOAuth(base).catch((e: ConnectorOAuthError) => e);
    expect(err).toBeInstanceOf(ConnectorOAuthError);
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/automatic app registration/u);
    expect(err.message).not.toContain('dynamic client registration');
  });

  it('uses the operator static client instead of DCR when configured (#342)', async () => {
    process.env.CONNECTORS_OAUTH_CLIENTS = JSON.stringify({
      'https://as.example.com': { clientId: 'static-id', clientSecret: 'static-secret' },
    });
    try {
      await startConnectorOAuth(base);
      expect(registerClient).not.toHaveBeenCalled();
      expect(startAuthorization).toHaveBeenCalledWith(
        'https://as.example.com',
        expect.objectContaining({
          clientInformation: { client_id: 'static-id', client_secret: 'static-secret' },
        }),
      );
    } finally {
      delete process.env.CONNECTORS_OAUTH_CLIENTS;
    }
  });

  it('ignores a malformed CONNECTORS_OAUTH_CLIENTS and falls back to DCR (#342)', async () => {
    process.env.CONNECTORS_OAUTH_CLIENTS = 'not-json';
    try {
      await startConnectorOAuth(base);
      expect(registerClient).toHaveBeenCalled();
    } finally {
      delete process.env.CONNECTORS_OAUTH_CLIENTS;
    }
  });

  it('reuses the vaulted DCR registration on re-auth instead of re-registering', async () => {
    await startConnectorOAuth({
      ...base,
      connectorId: 'reauth-doc-id',
      existingVault: {
        accessToken: 'stale',
        authorizationServerUrl: 'https://as.example.com',
        clientInformation: { client_id: 'kept-client' },
      },
    });
    expect(registerClient).not.toHaveBeenCalled();
    expect(startAuthorization).toHaveBeenCalledWith(
      'https://as.example.com',
      expect.objectContaining({
        clientInformation: { client_id: 'kept-client' },
      }),
    );
  });
});

describe('completeConnectorOAuth', () => {
  const start = async () => {
    const userId = '507f1f77bcf86cd799439011';
    await startConnectorOAuth({
      url: 'https://mcp.example.com/mcp',
      name: 'mine',
      redirectOrigin: 'https://app.example.com',
      userId,
    });
    const state = startAuthorization.mock.calls.at(-1)?.[1]?.state as string;
    return { userId, state };
  };

  it('rejects an unknown or expired state with a start-again message', async () => {
    await expect(completeConnectorOAuth({ code: 'c', state: 'nope', userId: 'u' })).rejects.toThrow(
      /expired or is not recognised/u,
    );
  });

  it("refuses a different session completing someone else's consent", async () => {
    const { state, userId } = await start();
    await expect(
      completeConnectorOAuth({ code: 'c', state, userId: `other-${userId}` }),
    ).rejects.toThrow(/different session/u);
  });

  it('exchanges the code, stores the vault encrypted, and creates the connector', async () => {
    const { state, userId } = await start();
    const doc = await completeConnectorOAuth({ code: 'auth-code', state, userId });
    expect(exchangeAuthorization).toHaveBeenCalledWith(
      'https://as.example.com',
      expect.objectContaining({
        authorizationCode: 'auth-code',
        codeVerifier: 'verifier-abc',
        redirectUri: 'https://app.example.com/connectors/callback',
        resource: 'https://mcp.example.com/mcp',
      }),
    );
    expect(doc.type).toBe('mcp.oauth');
    expect(doc.scope).toBe('user');
    expect(doc.oauth).toBeTruthy();
    // The envelope never round-trips as plaintext on the doc or toJSON.
    expect(JSON.stringify(doc.toJSON())).not.toContain('at-1');
    expect(JSON.stringify(doc.toJSON())).not.toContain('rt-1');
    expect(doc.toJSON().oauth).toBeUndefined();
  });

  it('updates the existing row on the re-auth path and clears needs-reauth', async () => {
    const userId = '507f1f77bcf86cd799439011';
    const doc = await Connector.create({
      type: 'mcp.oauth',
      scope: 'user',
      userId,
      name: 'mine',
      url: 'https://mcp.example.com/mcp',
      authState: 'needs-reauth',
    });
    await startConnectorOAuth({
      url: doc.url,
      name: doc.name,
      redirectOrigin: 'https://app.example.com',
      userId,
      connectorId: String(doc._id),
      existingVault: {
        accessToken: 'stale',
        authorizationServerUrl: 'https://as.example.com',
        clientInformation: { client_id: 'kept-client' },
      },
    });
    const state = startAuthorization.mock.calls.at(-1)?.[1]?.state as string;
    const updated = await completeConnectorOAuth({ code: 'c2', state, userId });
    expect(String(updated._id)).toBe(String(doc._id));
    expect(updated.authState).toBe('ok');
    await expect(oauthAuthHeaders(updated)).resolves.toEqual({
      Authorization: 'Bearer at-1',
    });
  });

  it('wraps exchange failures as 422 without echoing provider detail', async () => {
    const { state, userId } = await start();
    // The SDK error can embed the raw response body — never echoed to the client (reflection guard).
    // @see #327
    exchangeAuthorization.mockRejectedValue(new Error('invalid_grant: Raw body: secret-thing'));
    const err = await completeConnectorOAuth({ code: 'c', state, userId }).catch(
      (e: ConnectorOAuthError) => e,
    );
    expect(err).toBeInstanceOf(ConnectorOAuthError);
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/start again/iu);
    expect(err.message).not.toContain('invalid_grant');
    expect(err.message).not.toContain('secret-thing');
  });

  it('expires a pending consent after the TTL window', async () => {
    const { state, userId } = await start();
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
    try {
      await expect(completeConnectorOAuth({ code: 'c', state, userId })).rejects.toThrow(
        /expired or is not recognised/u,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('oauthAuthHeaders (refresh policy)', () => {
  const userId = '507f1f77bcf86cd799439011';
  const createOauthConnector = async (vault: Record<string, unknown>) => {
    // Vault is written as an already-encrypted-looking envelope for the mocked decrypt path; with real crypto, encrypt via the module under test's sibling.
    const { encryptEnvelope } = await import('../../main/services/crypto');
    return Connector.create({
      type: 'mcp.oauth',
      scope: 'user',
      userId,
      name: 'vaulted',
      url: 'https://mcp.example.com/mcp',
      oauth: encryptEnvelope(JSON.stringify(vault)),
    }) as Promise<ConnectorDocument>;
  };

  it('returns the bearer header for a fresh token without refreshing', async () => {
    const doc = await createOauthConnector({
      accessToken: 'fresh',
      authorizationServerUrl: 'https://as.example.com',
      expiresAt: Date.now() + 3600_000,
    });
    await expect(oauthAuthHeaders(doc)).resolves.toEqual({ Authorization: 'Bearer fresh' });
    expect(refreshAuthorization).not.toHaveBeenCalled();
  });

  it('refreshes proactively inside the skew window and persists the rotated vault', async () => {
    const doc = await createOauthConnector({
      accessToken: 'stale',
      refreshToken: 'rt-old',
      authorizationServerUrl: 'https://as.example.com',
      expiresAt: Date.now() - 1,
      clientInformation: { client_id: 'dcr-client' },
    });
    await expect(oauthAuthHeaders(doc)).resolves.toEqual({ Authorization: 'Bearer at-2' });
    expect(refreshAuthorization).toHaveBeenCalledWith(
      'https://as.example.com',
      expect.objectContaining({ refreshToken: 'rt-old' }),
    );
    // The rotated vault is on the doc: a fresh read gets the new token.
    expect(doc.authState).toBe('ok');
    const { decryptEnvelope } = await import('../../main/services/crypto');
    const vault = JSON.parse(decryptEnvelope(doc.oauth)) as { accessToken: string };
    expect(vault.accessToken).toBe('at-2');
  });

  it('marks needs-reauth when the refresh fails (revoked grant)', async () => {
    const doc = await createOauthConnector({
      accessToken: 'stale',
      refreshToken: 'rt-old',
      authorizationServerUrl: 'https://as.example.com',
      expiresAt: Date.now() - 1,
      clientInformation: { client_id: 'dcr-client' },
    });
    refreshAuthorization.mockRejectedValue(new Error('invalid_grant'));
    await expect(oauthAuthHeaders(doc)).resolves.toBeUndefined();
    expect(doc.authState).toBe('needs-reauth');
  });

  it('short-circuits a grant already marked needs-reauth (no doomed refresh)', async () => {
    const doc = await createOauthConnector({
      accessToken: 'stale',
      refreshToken: 'rt-old',
      authorizationServerUrl: 'https://as.example.com',
      expiresAt: Date.now() - 1,
      clientInformation: { client_id: 'dcr-client' },
    });
    doc.authState = 'needs-reauth';
    await doc.save();
    await expect(oauthAuthHeaders(doc)).resolves.toBeUndefined();
    expect(refreshAuthorization).not.toHaveBeenCalled();
  });

  it('marks needs-reauth when the grant expired but nothing can refresh it', async () => {
    const doc = await createOauthConnector({
      accessToken: 'stale',
      authorizationServerUrl: 'https://as.example.com',
      expiresAt: Date.now() - 1,
    });
    await expect(oauthAuthHeaders(doc)).resolves.toBeUndefined();
    expect(doc.authState).toBe('needs-reauth');
    expect(refreshAuthorization).not.toHaveBeenCalled();
  });

  it('coalesces concurrent refreshes into one call (rotating refresh tokens)', async () => {
    const doc = await createOauthConnector({
      accessToken: 'stale',
      refreshToken: 'rt-old',
      authorizationServerUrl: 'https://as.example.com',
      expiresAt: Date.now() - 1,
      clientInformation: { client_id: 'dcr-client' },
    });
    refreshAuthorization.mockImplementation(
      async () => new Promise((resolve) => setTimeout(() => resolve({ access_token: 'at-2' }), 20)),
    );
    const [a, b] = await Promise.all([oauthAuthHeaders(doc), oauthAuthHeaders(doc)]);
    expect(a).toEqual({ Authorization: 'Bearer at-2' });
    expect(b).toEqual({ Authorization: 'Bearer at-2' });
    expect(refreshAuthorization).toHaveBeenCalledTimes(1);
  });
});
