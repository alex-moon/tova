import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../main/index';
import { MCP_ENCRYPTION_KEY_ENV_VAR } from '../../main/services/crypto';
import { Connector } from '../../main/models/Connector';
import { User } from '../../main/models/User';
import { ConnectorOAuthError } from '../../main/services/oauthConnectors';

jest.mock('../../main/services/connectorService', () => ({
  listMcpTools: jest.fn(),
  callMcpTool: jest.fn(),
  connectorToolsetsForUser: jest.fn(),
  clearConnectorCachesForTests: jest.fn(),
}));

// OAuth engine mocked; pure helpers stay real so routes' use is exercised.
jest.mock('../../main/services/oauthConnectors', () => ({
  ...jest.requireActual('../../main/services/oauthConnectors'),
  startConnectorOAuth: jest.fn(),
  completeConnectorOAuth: jest.fn(),
  probeConnectorOAuth: jest.fn(),
}));

const mockStartConnectorOAuth = jest.requireMock('../../main/services/oauthConnectors')
  .startConnectorOAuth as jest.Mock;
const mockCompleteConnectorOAuth = jest.requireMock('../../main/services/oauthConnectors')
  .completeConnectorOAuth as jest.Mock;
const mockProbeConnectorOAuth = jest.requireMock('../../main/services/oauthConnectors')
  .probeConnectorOAuth as jest.Mock;

// The mock registry resolves lazily; read the jest.fn from the mock itself.
const mockListMcpTools = jest.requireMock('../../main/services/connectorService')
  .listMcpTools as jest.Mock;

const registerUser = async (email: string) => {
  const app = createApp();
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  return { app, cookie: response.headers['set-cookie'] };
};

beforeAll(() => {
  process.env[MCP_ENCRYPTION_KEY_ENV_VAR] = 'route-test-key';
});

beforeEach(() => {
  mockListMcpTools
    .mockReset()
    .mockResolvedValue([
      { name: 'weather', description: 'Get weather', inputSchema: { type: 'object' } },
    ]);
  mockStartConnectorOAuth.mockReset().mockResolvedValue({
    authorizationUrl: 'https://as.example.com/authorize?client_id=dcr',
  });
  mockCompleteConnectorOAuth.mockReset();
  // Add-time OAuth probe defaults to "no OAuth advertised"; tests override.
  // @see #333
  mockProbeConnectorOAuth.mockReset().mockResolvedValue(null);
});

describe('POST /api/connectors (issues #36, #329)', () => {
  it('requires and validates the connector type', async () => {
    const { app, cookie } = await registerUser('conn-type@example.com');

    // Missing type: rejected.
    // @see #329
    const missing = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ name: 'no-type', url: 'https://t.example.com/mcp' });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/type is required/u);

    // Unknown type: rejected before any handshake.
    // @see #329
    const unknown = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'carrier-pigeon', name: 'typo', url: 'https://t.example.com/mcp' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toMatch(/unknown connector type/iu);

    // Reserved-but-known types: not-supported-yet, distinct from unknown-type.
    // @see #329
    for (const type of ['api', 'sdk']) {
      const reserved = await request(app)
        .post('/api/connectors')
        .set('Cookie', cookie)
        .send({ type, name: 'future', url: 'https://t.example.com/mcp' });
      expect(reserved.status).toBe(400);
      expect(reserved.body.message).toMatch(/not supported yet/u);
    }

    // mcp.oauth: a flow-specific pointer, not a token-form rejection.
    // @see #327
    const oauth = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'mcp.oauth', name: 'oauth', url: 'https://t.example.com/mcp' });
    expect(oauth.status).toBe(400);
    expect(oauth.body.message).toMatch(/OAuth sign-in/u);
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it('runs the handshake, stores the connector encrypted, and returns tools', async () => {
    const { app, cookie } = await registerUser('conn-add@example.com');

    const res = await request(app).post('/api/connectors').set('Cookie', cookie).send({
      type: 'mcp.pat',
      name: 'my-tools',
      url: 'https://mcp.example.com/mcp',
      authToken: 'sekrit',
    });

    expect(res.status).toBe(201);
    expect(res.body.connector).toMatchObject({
      scope: 'user',
      type: 'mcp.pat',
      name: 'my-tools',
      url: 'https://mcp.example.com/mcp',
      status: 'connected',
      authConfigured: true,
    });
    expect(res.body.connector).not.toHaveProperty('headers');
    expect(res.body.connector).not.toHaveProperty('headersConfigured');
    expect(res.body.connector.tools).toEqual([{ name: 'weather', description: 'Get weather' }]);
    expect(mockListMcpTools).toHaveBeenCalledWith('https://mcp.example.com/mcp', {
      Authorization: 'Bearer sekrit',
    });
  });

  it('handshakes exactly once per add (result reused, not re-fetched, #77)', async () => {
    const { app, cookie } = await registerUser('conn-once@example.com');
    await request(app).post('/api/connectors').set('Cookie', cookie).send({
      type: 'mcp.pat',
      name: 'once',
      url: 'https://once.example.com/mcp',
    });
    expect(mockListMcpTools).toHaveBeenCalledTimes(1);
  });

  it('rejects a connector whose handshake fails without leaking the upstream error (#397)', async () => {
    const { app, cookie } = await registerUser('conn-dead@example.com');
    mockListMcpTools.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.9:443'));

    const res = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'mcp.pat', name: 'dead', url: 'https://dead.example.com/mcp' });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/not reachable/u);
    expect(res.body.message).not.toContain('ECONNREFUSED');
    expect(res.body.message).not.toContain('10.0.0.9');
  });

  it('says an OAuth-only endpoint needs Connect, not a token (#333 wash-up)', async () => {
    const { app, cookie } = await registerUser('conn-oauthonly@example.com');
    mockListMcpTools.mockRejectedValue(new Error('MCP error 401: invalid_token'));
    mockProbeConnectorOAuth.mockResolvedValue({
      authorizationServerUrl: 'https://as.example.com',
      metadata: { authorization_endpoint: 'https://as.example.com/authorize' },
    });

    const res = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'mcp.pat', name: 'oauth-only', url: 'https://oauthonly.example.com/mcp' });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/requires OAuth sign-in/u);
    expect(res.body.message).toMatch(/Connect on the connector card/u);
    expect(res.body.message).not.toContain('invalid_token');
  });

  it('rejects non-https URLs and old-style header payloads', async () => {
    const { app, cookie } = await registerUser('conn-bad@example.com');

    const httpRes = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'mcp.pat', name: 'x', url: 'http://mcp.example.com/mcp' });
    expect(httpRes.status).toBe(400);

    // 'authHeader' is not valid — a raw token goes as 'authToken'.
    // @see #80
    const headerRes = await request(app).post('/api/connectors').set('Cookie', cookie).send({
      type: 'mcp.pat',
      name: 'x',
      url: 'https://mcp.example.com/mcp',
      authHeader: 'Bearer sekrit',
    });
    expect(headerRes.status).toBe(400);

    const unknownRes = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'mcp.pat', name: 'x', url: 'https://mcp.example.com/mcp', extra: 1 });
    expect(unknownRes.status).toBe(400);

    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it('strips a pasted Bearer scheme prefix so the header wraps once (#403)', async () => {
    const { app, cookie } = await registerUser('conn-bearer@example.com');
    for (const [i, pasted] of ['Bearer ttd_abc123', 'bearer ttd_abc123'].entries()) {
      const res = await request(app)
        .post('/api/connectors')
        .set('Cookie', cookie)
        .send({
          type: 'mcp.pat',
          name: 'pasted-header',
          url: `https://bearer-${i}.example.com/mcp`,
          authToken: pasted,
        });
      expect(res.status).toBe(201);
      expect(mockListMcpTools).toHaveBeenCalledWith(`https://bearer-${i}.example.com/mcp`, {
        Authorization: 'Bearer ttd_abc123',
      });
    }
  });

  it('stores the header value encrypted at rest and not in plaintext form', async () => {
    const { app, cookie } = await registerUser('conn-enc@example.com');
    const res = await request(app).post('/api/connectors').set('Cookie', cookie).send({
      type: 'mcp.pat',
      name: 'enc',
      url: 'https://enc.example.com/mcp',
      // tokens may legally contain colons; the schema must not split on one
      authToken: 'hunter2:extra',
    });
    expect(res.status).toBe(201);

    const raw = await request(app).get('/api/connectors').set('Cookie', cookie);
    expect(JSON.stringify(raw.body)).not.toContain('hunter2');
    expect(JSON.stringify(raw.body)).not.toContain('Bearer');

    const created = raw.body.connectors.find((s: { name: string }) => s.name === 'enc');
    expect(created.authConfigured).toBe(true);
  });

  it('rejects duplicate URLs per user with 409', async () => {
    const { app, cookie } = await registerUser('conn-dup@example.com');
    const body = { type: 'mcp.pat', name: 'first', url: 'https://dup.example.com/mcp' };
    await request(app).post('/api/connectors').set('Cookie', cookie).send(body);
    const res = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ ...body, name: 'second' });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/connectors (issues #36, #329)', () => {
  it('lists platform connectors read-only plus only the caller own connectors', async () => {
    await Connector.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://platform.example.com/mcp',
    });
    const { app, cookie } = await registerUser('conn-get-user-a@example.com');
    await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'mcp.pat', name: 'mine', url: 'https://a.example.com/mcp' });

    const other = await registerUser('conn-get-user-b@example.com');
    await request(other.app)
      .post('/api/connectors')
      .set('Cookie', other.cookie)
      .send({ type: 'mcp.pat', name: 'theirs', url: 'https://b.example.com/mcp' });

    const res = await request(app).get('/api/connectors').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const names = res.body.connectors.map((s: { name: string }) => s.name);
    expect(names).toContain('platform-tools');
    expect(names).toContain('mine');
    expect(names).not.toContain('theirs');
    // Every row reports authConfigured; the legacy headersConfigured is gone.
    // @see #329
    for (const row of res.body.connectors as Array<Record<string, unknown>>) {
      expect(row).toHaveProperty('authConfigured');
      expect(row).not.toHaveProperty('headersConfigured');
      expect(row).not.toHaveProperty('headers');
    }
  });

  it('requires authentication', async () => {
    const app = createApp();
    const res = await request(app).get('/api/connectors');
    expect(res.status).toBe(401);
  });

  it('retires the /api/mcp-servers alias with 404 (#333 wash-up)', async () => {
    const { app, cookie } = await registerUser('conn-alias@example.com');
    const res = await request(app).get('/api/mcp-servers').set('Cookie', cookie);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/connectors/:id (issues #36, #329)', () => {
  it('removes own personal connector and returns 204', async () => {
    const { app, cookie } = await registerUser('conn-del@example.com');
    const created = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'mcp.pat', name: 'gone', url: 'https://gone.example.com/mcp' });

    const res = await request(app)
      .delete(`/api/connectors/${created.body.connector.id}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(204);

    const afterEachGet = await request(app).get('/api/connectors').set('Cookie', cookie);
    expect(afterEachGet.body.connectors).toHaveLength(0);
  });

  it('cannot remove another user connector or the platform scope', async () => {
    const { app, cookie } = await registerUser('conn-del-a@example.com');
    const created = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'mcp.pat', name: 'theirs', url: 'https://t.example.com/mcp' });

    const other = await registerUser('conn-del-b@example.com');
    const res = await request(other.app)
      .delete(`/api/connectors/${created.body.connector.id}`)
      .set('Cookie', other.cookie);
    expect(res.status).toBe(404);

    const platform = await Connector.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://platform.example.com/mcp',
    });
    const resPlatform = await request(app)
      .delete(`/api/connectors/${platform.id}`)
      .set('Cookie', cookie);
    expect(resPlatform.status).toBe(404);
  });
});

describe('POST /api/connectors/oauth/start (#327)', () => {
  it('returns the consent URL and derives the redirect origin from the request', async () => {
    const { app, cookie } = await registerUser('oauth-start@example.com');
    const res = await request(app)
      .post('/api/connectors/oauth/start')
      .set('Cookie', cookie)
      .set('Origin', 'https://app.example.com')
      .send({ name: 'notion', url: 'https://mcp.notion.com/mcp' });

    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toContain('authorize');
    expect(mockStartConnectorOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'notion',
        url: 'https://mcp.notion.com/mcp',
        redirectOrigin: 'https://app.example.com',
        userId: expect.any(String),
      }),
    );
  });

  it('passes through the not-advertised-OAuth 422 so the token form stays the fallback', async () => {
    const { app, cookie } = await registerUser('oauth-422@example.com');
    mockStartConnectorOAuth.mockRejectedValue(
      new ConnectorOAuthError(
        'This endpoint does not advertise OAuth sign-in. Connect it with a token instead.',
        422,
      ),
    );
    const res = await request(app)
      .post('/api/connectors/oauth/start')
      .set('Cookie', cookie)
      .send({ name: 'x', url: 'https://noauth.example.com/mcp' });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/token instead/u);
  });

  it('409s when the URL is already connected for the account', async () => {
    const { app, cookie } = await registerUser('oauth-dup@example.com');
    await Connector.create({
      type: 'mcp.pat',
      scope: 'user',
      userId: '507f1f77bcf86cd799439011',
      name: 'mine',
      url: 'https://dup-oauth.example.com/mcp',
    });
    // Duplicate check keys on the caller; create via the API for owner match.
    await mockListMcpTools.mockResolvedValue([{ name: 'w', description: '', inputSchema: {} }]);
    await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'mcp.pat', name: 'mine', url: 'https://dup-oauth-2.example.com/mcp' });

    const res = await request(app)
      .post('/api/connectors/oauth/start')
      .set('Cookie', cookie)
      .send({ name: 'again', url: 'https://dup-oauth-2.example.com/mcp' });
    expect(res.status).toBe(409);
  });

  it('requires authentication and validates the body', async () => {
    const app = createApp();
    expect((await request(app).post('/api/connectors/oauth/start').send({})).status).toBe(401);

    const { cookie } = await registerUser('oauth-badbody@example.com');
    const res = await request(app)
      .post('/api/connectors/oauth/start')
      .set('Cookie', cookie)
      .send({ name: 'x', url: 'http://insecure.example.com/mcp' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/connectors/oauth/callback (#327)', () => {
  it('completes the flow and returns the created connector', async () => {
    const { app, cookie } = await registerUser('oauth-cb@example.com');
    const doc = await Connector.create({
      type: 'mcp.oauth',
      scope: 'user',
      userId: new Types.ObjectId('507f1f77bcf86cd799439011'),
      name: 'notion',
      url: 'https://mcp.notion.com/mcp',
      authState: 'ok',
    });
    mockCompleteConnectorOAuth.mockResolvedValue(doc);

    const res = await request(app)
      .post('/api/connectors/oauth/callback')
      .set('Cookie', cookie)
      .send({ code: 'auth-code', state: 'st@te' });

    expect(res.status).toBe(201);
    expect(res.body.connector).toMatchObject({ type: 'mcp.oauth', name: 'notion' });
    expect(res.body.connector.oauth).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('access_token');
  });

  it('maps engine errors to statuses (expired state 400, foreign session 404)', async () => {
    const { app, cookie } = await registerUser('oauth-cb-err@example.com');
    mockCompleteConnectorOAuth.mockRejectedValue(
      new ConnectorOAuthError(
        'This sign-in attempt expired or is not recognised. Start again.',
        400,
      ),
    );
    const expired = await request(app)
      .post('/api/connectors/oauth/callback')
      .set('Cookie', cookie)
      .send({ code: 'c', state: 's' });
    expect(expired.status).toBe(400);

    mockCompleteConnectorOAuth.mockRejectedValue(
      new ConnectorOAuthError('This sign-in attempt belongs to a different session', 404),
    );
    const foreign = await request(app)
      .post('/api/connectors/oauth/callback')
      .set('Cookie', cookie)
      .send({ code: 'c', state: 's' });
    expect(foreign.status).toBe(404);
  });

  it('validates the body (missing code or state)', async () => {
    const { app, cookie } = await registerUser('oauth-cb-bad@example.com');
    const res = await request(app)
      .post('/api/connectors/oauth/callback')
      .set('Cookie', cookie)
      .send({ code: 'c' });
    expect(res.status).toBe(400);
    expect(mockCompleteConnectorOAuth).not.toHaveBeenCalled();
  });

  it('handshakes with the fresh grant: lists tools and marks the row connected', async () => {
    const { encryptEnvelope } = await import('../../main/services/crypto');
    const { app, cookie } = await registerUser('oauth-cb-tools@example.com');
    const doc = await Connector.create({
      type: 'mcp.oauth',
      scope: 'user',
      userId: new Types.ObjectId('507f1f77bcf86cd799439011'),
      name: 'trello',
      url: 'https://mcp.trello.com/v1',
      authState: 'ok',
    });
    doc.oauth = encryptEnvelope(JSON.stringify({ accessToken: 'fresh-at' }));
    await doc.save();
    mockCompleteConnectorOAuth.mockResolvedValue(doc);
    mockListMcpTools.mockResolvedValue([{ name: 'get_board', description: 'Read a board' }]);

    const res = await request(app)
      .post('/api/connectors/oauth/callback')
      .set('Cookie', cookie)
      .send({ code: 'auth-code', state: 'st@te' });

    expect(res.status).toBe(201);
    expect(res.body.connector.status).toBe('connected');
    expect(res.body.connector.tools).toEqual([{ name: 'get_board', description: 'Read a board' }]);
  });

  it('keeps the grant on a failed handshake but marks the row unreachable', async () => {
    const { encryptEnvelope } = await import('../../main/services/crypto');
    const { app, cookie } = await registerUser('oauth-cb-dead@example.com');
    const doc = await Connector.create({
      type: 'mcp.oauth',
      scope: 'user',
      userId: new Types.ObjectId('507f1f77bcf86cd799439011'),
      name: 'trello',
      url: 'https://mcp.trello.com/v1',
      authState: 'ok',
    });
    doc.oauth = encryptEnvelope(JSON.stringify({ accessToken: 'fresh-at' }));
    await doc.save();
    mockCompleteConnectorOAuth.mockResolvedValue(doc);
    mockListMcpTools.mockRejectedValue(new Error('handshake boom'));

    const res = await request(app)
      .post('/api/connectors/oauth/callback')
      .set('Cookie', cookie)
      .send({ code: 'auth-code', state: 'st@te' });

    expect(res.status).toBe(201);
    expect(res.body.connector.status).toBe('unreachable');
    // The grant survived: still no token material in the response.
    expect(JSON.stringify(res.body)).not.toContain('fresh-at');
  });
});

describe('POST /api/connectors/:id/reauth (#327)', () => {
  it('restarts consent for an owned mcp.oauth connector, vault client reused', async () => {
    const { app, cookie } = await registerUser('oauth-reauth@example.com');
    const created = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'mcp.pat', name: 'pat-row', url: 'https://pat.example.com/mcp' });

    // A pat connector is not re-authable (no grant to renew).
    const patRes = await request(app)
      .post(`/api/connectors/${created.body.connector.id}/reauth`)
      .set('Cookie', cookie);
    expect(patRes.status).toBe(404);

    // An mcp.oauth row goes through the flow; the route re-checks ownership.
    // @see #327
    const caller = await User.findOne({ email: 'oauth-reauth@example.com' });
    const doc = await Connector.create({
      type: 'mcp.oauth',
      scope: 'user',
      userId: caller?._id,
      name: 'notion',
      url: 'https://mcp.notion.com/mcp',
    });
    const res = await request(app)
      .post(`/api/connectors/${doc._id}/reauth`)
      .set('Cookie', cookie)
      .set('Origin', 'https://app.example.com');
    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toContain('authorize');
    expect(mockStartConnectorOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: String(doc._id),
        url: 'https://mcp.notion.com/mcp',
        redirectOrigin: 'https://app.example.com',
      }),
    );
  });

  it('404s for another user’s connector', async () => {
    const a = await registerUser('oauth-ra-a@example.com');
    const b = await registerUser('oauth-ra-b@example.com');
    const doc = await Connector.create({
      type: 'mcp.oauth',
      scope: 'user',
      userId: new Types.ObjectId('507f1f77bcf86cd799439011'),
      name: 'notion',
      url: 'https://mcp.notion.com/mcp',
    });
    const res = await request(b.app)
      .post(`/api/connectors/${doc._id}/reauth`)
      .set('Cookie', a.cookie);
    expect(res.status).toBe(404);
  });
});
