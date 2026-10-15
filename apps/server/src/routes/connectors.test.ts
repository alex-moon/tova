import request from 'supertest';
import { createApp } from '../index';
import { MCP_ENCRYPTION_KEY_ENV_VAR } from '../services/crypto';
import { Connector } from '../models/Connector';

jest.mock('../services/connectorService', () => ({
  listMcpTools: jest.fn(),
  callMcpTool: jest.fn(),
  connectorToolsetsForUser: jest.fn(),
  clearConnectorCachesForTests: jest.fn(),
}));

// The mocked module registry, resolved lazily (after jest.mock hoisting), so
// the shared jest.fn instances are read from the mock, not typed imports.
const mockListMcpTools = jest.requireMock('../services/connectorService').listMcpTools as jest.Mock;

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
});

describe('POST /api/connectors (issues #36, #329)', () => {
  it('requires and validates the connector type', async () => {
    const { app, cookie } = await registerUser('conn-type@example.com');

    // Missing type (#329): rejected.
    const missing = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ name: 'no-type', url: 'https://t.example.com/mcp' });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/type is required/u);

    // Unknown type (#329): rejected before any handshake.
    const unknown = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'carrier-pigeon', name: 'typo', url: 'https://t.example.com/mcp' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toMatch(/unknown connector type/iu);

    // Reserved-but-known types (#329): a clear not-supported-yet message,
    // distinct from the unknown-type rejection.
    for (const type of ['mcp.oauth', 'api', 'sdk']) {
      const reserved = await request(app)
        .post('/api/connectors')
        .set('Cookie', cookie)
        .send({ type, name: 'future', url: 'https://t.example.com/mcp' });
      expect(reserved.status).toBe(400);
      expect(reserved.body.message).toMatch(/not supported yet/u);
    }
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

  it('rejects a connector whose handshake fails with the connection error', async () => {
    const { app, cookie } = await registerUser('conn-dead@example.com');
    mockListMcpTools.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'mcp.pat', name: 'dead', url: 'https://dead.example.com/mcp' });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/not reachable.*ECONNREFUSED/u);
  });

  it('rejects non-https URLs and old-style header payloads', async () => {
    const { app, cookie } = await registerUser('conn-bad@example.com');

    const httpRes = await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'mcp.pat', name: 'x', url: 'http://mcp.example.com/mcp' });
    expect(httpRes.status).toBe(400);

    // issue #80: 'authHeader' payloads are no longer a valid key — a raw
    // token must be submitted as 'authToken' instead.
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

  it('stores the header value encrypted at rest and not in plaintext form', async () => {
    const { app, cookie } = await registerUser('conn-enc@example.com');
    const res = await request(app).post('/api/connectors').set('Cookie', cookie).send({
      type: 'mcp.pat',
      name: 'enc',
      url: 'https://enc.example.com/mcp',
      // tokens may legally contain colons; the schema no longer splits on one
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
    // #329: every row reports the generic authConfigured wire field, and the
    // legacy headersConfigured name is gone from the wire.
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

  it('keeps the deprecated /api/mcp-servers alias working (#329)', async () => {
    const { app, cookie } = await registerUser('conn-alias@example.com');
    await request(app)
      .post('/api/connectors')
      .set('Cookie', cookie)
      .send({ type: 'mcp.pat', name: 'alias', url: 'https://alias.example.com/mcp' });

    const res = await request(app).get('/api/mcp-servers').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.connectors.map((s: { name: string }) => s.name)).toContain('alias');
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
