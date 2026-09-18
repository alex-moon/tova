import request from 'supertest';
import { createApp } from '../index';
import { MCP_ENCRYPTION_KEY_ENV_VAR } from '../services/crypto';
import { McpServer } from '../models/McpServer';

jest.mock('../services/mcpService', () => ({
  listMcpServerTools: jest.fn(),
  mcpToolsetsForUser: jest.fn(),
  clearMcpCachesForTests: jest.fn(),
}));

// The mocked module registry, resolved lazily (after jest.mock hoisting), so
// the shared jest.fn instances are read from the mock, not typed imports.
const mockListMcpServerTools = jest.requireMock('../services/mcpService')
  .listMcpServerTools as jest.Mock;

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
  mockListMcpServerTools
    .mockReset()
    .mockResolvedValue([
      { name: 'weather', description: 'Get weather', inputSchema: { type: 'object' } },
    ]);
});

describe('POST /api/mcp-servers (issue #36)', () => {
  it('runs the handshake, stores the server encrypted, and returns tools', async () => {
    const { app, cookie } = await registerUser('mcp-add@example.com');

    const res = await request(app).post('/api/mcp-servers').set('Cookie', cookie).send({
      name: 'my-tools',
      url: 'https://mcp.example.com/mcp',
      authToken: 'sekrit',
    });

    expect(res.status).toBe(201);
    expect(res.body.server).toMatchObject({
      scope: 'user',
      name: 'my-tools',
      url: 'https://mcp.example.com/mcp',
      status: 'connected',
      headersConfigured: true,
    });
    expect(res.body.server).not.toHaveProperty('headers');
    expect(res.body.server.tools).toEqual([{ name: 'weather', description: 'Get weather' }]);
    expect(mockListMcpServerTools).toHaveBeenCalledWith('https://mcp.example.com/mcp', {
      Authorization: 'Bearer sekrit',
    });
  });

  it('handshakes exactly once per add (result reused, not re-fetched, #77)', async () => {
    const { app, cookie } = await registerUser('mcp-once@example.com');
    await request(app).post('/api/mcp-servers').set('Cookie', cookie).send({
      name: 'once',
      url: 'https://once.example.com/mcp',
    });
    expect(mockListMcpServerTools).toHaveBeenCalledTimes(1);
  });

  it('rejects a server whose handshake fails with the connection error', async () => {
    const { app, cookie } = await registerUser('mcp-dead@example.com');
    mockListMcpServerTools.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(app)
      .post('/api/mcp-servers')
      .set('Cookie', cookie)
      .send({ name: 'dead', url: 'https://dead.example.com/mcp' });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/not reachable.*ECONNREFUSED/u);
  });

  it('rejects non-https URLs and old-style header payloads', async () => {
    const { app, cookie } = await registerUser('mcp-bad@example.com');

    const httpRes = await request(app)
      .post('/api/mcp-servers')
      .set('Cookie', cookie)
      .send({ name: 'x', url: 'http://mcp.example.com/mcp' });
    expect(httpRes.status).toBe(400);

    // issue #80: 'authHeader' payloads are no longer a valid key — a raw
    // token must be submitted as 'authToken' instead.
    const headerRes = await request(app)
      .post('/api/mcp-servers')
      .set('Cookie', cookie)
      .send({ name: 'x', url: 'https://mcp.example.com/mcp', authHeader: 'Bearer sekrit' });
    expect(headerRes.status).toBe(400);

    const unknownRes = await request(app)
      .post('/api/mcp-servers')
      .set('Cookie', cookie)
      .send({ name: 'x', url: 'https://mcp.example.com/mcp', extra: 1 });
    expect(unknownRes.status).toBe(400);

    expect(mockListMcpServerTools).not.toHaveBeenCalled();
  });

  it('stores the header value encrypted at rest and not in plaintext form', async () => {
    const { app, cookie } = await registerUser('mcp-enc@example.com');
    const res = await request(app).post('/api/mcp-servers').set('Cookie', cookie).send({
      name: 'enc',
      url: 'https://enc.example.com/mcp',
      // tokens may legally contain colons; the schema no longer splits on one
      authToken: 'hunter2:extra',
    });
    expect(res.status).toBe(201);

    const raw = await request(app).get('/api/mcp-servers').set('Cookie', cookie);
    expect(JSON.stringify(raw.body)).not.toContain('hunter2');
    expect(JSON.stringify(raw.body)).not.toContain('Bearer');

    const created = raw.body.servers.find((s: { name: string }) => s.name === 'enc');
    expect(created.headersConfigured).toBe(true);
  });

  it('rejects duplicate URLs per user with 409', async () => {
    const { app, cookie } = await registerUser('mcp-dup@example.com');
    const body = { name: 'first', url: 'https://dup.example.com/mcp' };
    await request(app).post('/api/mcp-servers').set('Cookie', cookie).send(body);
    const res = await request(app)
      .post('/api/mcp-servers')
      .set('Cookie', cookie)
      .send({ ...body, name: 'second' });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/mcp-servers (issue #36)', () => {
  it('lists platform servers read-only plus only the caller own servers', async () => {
    await McpServer.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://platform.example.com/mcp',
    });
    const { app, cookie } = await registerUser('mcp-get-user-a@example.com');
    await request(app)
      .post('/api/mcp-servers')
      .set('Cookie', cookie)
      .send({ name: 'mine', url: 'https://a.example.com/mcp' });

    const other = await registerUser('mcp-get-user-b@example.com');
    await request(other.app)
      .post('/api/mcp-servers')
      .set('Cookie', other.cookie)
      .send({ name: 'theirs', url: 'https://b.example.com/mcp' });

    const res = await request(app).get('/api/mcp-servers').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const names = res.body.servers.map((s: { name: string }) => s.name);
    expect(names).toContain('platform-tools');
    expect(names).toContain('mine');
    expect(names).not.toContain('theirs');
  });

  it('requires authentication', async () => {
    const app = createApp();
    const res = await request(app).get('/api/mcp-servers');
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/mcp-servers/:id (issue #36)', () => {
  it('removes own personal server and returns 204', async () => {
    const { app, cookie } = await registerUser('mcp-del@example.com');
    const created = await request(app)
      .post('/api/mcp-servers')
      .set('Cookie', cookie)
      .send({ name: 'gone', url: 'https://gone.example.com/mcp' });

    const res = await request(app)
      .delete(`/api/mcp-servers/${created.body.server.id}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(204);

    const afterEachGet = await request(app).get('/api/mcp-servers').set('Cookie', cookie);
    expect(afterEachGet.body.servers).toHaveLength(0);
  });

  it('cannot remove another user server or the platform scope', async () => {
    const { app, cookie } = await registerUser('mcp-del-a@example.com');
    const created = await request(app)
      .post('/api/mcp-servers')
      .set('Cookie', cookie)
      .send({ name: 'theirs', url: 'https://t.example.com/mcp' });

    const other = await registerUser('mcp-del-b@example.com');
    const res = await request(other.app)
      .delete(`/api/mcp-servers/${created.body.server.id}`)
      .set('Cookie', other.cookie);
    expect(res.status).toBe(404);

    const platform = await McpServer.create({
      scope: 'platform',
      name: 'platform-tools',
      url: 'https://platform.example.com/mcp',
    });
    const resPlatform = await request(app)
      .delete(`/api/mcp-servers/${platform.id}`)
      .set('Cookie', cookie);
    expect(resPlatform.status).toBe(404);
  });
});
