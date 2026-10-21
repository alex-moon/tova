import request from 'supertest';
import { createApp } from '../../main/index';
import { User } from '../../main/models/User';
import { ModelRouteError } from '../../main/models/ModelRouteError';
import { queryRetainedLogs } from '../../main/services/lokiLogs';
import { CHAT_MODEL, TASK_MODEL } from '../../main/services/model/modelDefaults';

jest.mock('../../main/services/lokiLogs', () => ({
  queryRetainedLogs: jest.fn(),
}));

const mockedQueryRetainedLogs = queryRetainedLogs as jest.MockedFunction<typeof queryRetainedLogs>;

const cookieOf = (res: request.Response) => {
  const cookie = res.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie : [cookie];
};

const registerAdmin = async (app: ReturnType<typeof createApp>, email: string) => {
  await request(app).post('/api/auth/register').send({ email, password: 'password123' });
  await User.updateOne({ email }, { role: 'admin' });
  const res = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
  return cookieOf(res);
};

const registerUser = async (app: ReturnType<typeof createApp>, email: string) => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  return cookieOf(res);
};

describe('admin routes', () => {
  it('returns 401 without a cookie and 403 for non-admins', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'plain@example.com');

    const unauth = await request(app).get('/api/admin/users');
    expect(unauth.status).toBe(401);

    const nonAdmin = await request(app).get('/api/admin/users').set('Cookie', cookie);
    expect(nonAdmin.status).toBe(403);
    expect(nonAdmin.body.message).toBe('Forbidden');

    const nonAdminPut = await request(app)
      .put('/api/admin/users/nonexistent/permissions')
      .set('Cookie', cookie)
      .send({ permissions: [] });
    expect(nonAdminPut.status).toBe(403);
  });

  it('lists users without passwordHash or googleId for admins', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'admin1@example.com');
    await registerUser(app, 'member@example.com');

    const res = await request(app).get('/api/admin/users').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const emails = res.body.map((u: { email: string }) => u.email).sort();
    expect(emails).toEqual(['admin1@example.com', 'member@example.com']);
    const listed = res.body[0];
    expect(listed.passwordHash).toBeUndefined();
    expect(listed.googleId).toBeUndefined();
    expect(listed.hasGoogle).toBe(false);
    expect(listed.createdAt).toBeDefined();
  });

  it('updates permissions with validation', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'admin2@example.com');
    const target = await User.create({ email: 'target@example.com', passwordHash: 'secret123' });

    const bad = await request(app)
      .put(`/api/admin/users/${target._id}/permissions`)
      .set('Cookie', cookie)
      .send({ permissions: ['not-a-thing'] });
    expect(bad.status).toBe(400);

    const ok = await request(app)
      .put(`/api/admin/users/${target._id}/permissions`)
      .set('Cookie', cookie)
      .send({ permissions: ['routing'] });
    expect(ok.status).toBe(200);
    expect(ok.body.permissions).toEqual(['routing']);

    const targetAfter = await User.findById(target._id);
    expect(targetAfter?.permissions).toEqual(['routing']);
  });

  it('toggles role both ways and still demotes a sole non-owner admin', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'admin3@example.com');
    const target = await User.create({ email: 'toggle@example.com', passwordHash: 'secret123' });

    const promoteRes = await request(app)
      .put(`/api/admin/users/${target._id}/role`)
      .set('Cookie', cookie)
      .send({ role: 'admin' });
    expect(promoteRes.status).toBe(200);
    expect(promoteRes.body.role).toBe('admin');

    // second admin exists now, so demoting admin3 is allowed
    const adminId = (await User.findOne({ email: 'admin3@example.com' }))!._id.toString();
    const demoteRes = await request(app)
      .put(`/api/admin/users/${adminId}/role`)
      .set('Cookie', cookie)
      .send({ role: 'user' });
    expect(demoteRes.status).toBe(200);

    // only formsatz@gmail.com is protected; sole non-owner admin can go
    const lastAdminRes = await request(app)
      .put(`/api/admin/users/${target._id}/role`)
      .set('Cookie', cookie)
      .send({ role: 'user' });
    expect(lastAdminRes.status).toBe(200);
    expect(lastAdminRes.body.role).toBe('user');
  });

  it('refuses to demote the protected owner account even with other admins', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'admin-protect@example.com');
    const owner = await User.create({
      email: 'formsatz@gmail.com',
      passwordHash: 'secret123',
      role: 'admin',
    });

    const res = await request(app)
      .put(`/api/admin/users/${owner._id}/role`)
      .set('Cookie', cookie)
      .send({ role: 'user' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('This account cannot be demoted');

    const after = await User.findById(owner._id);
    expect(after?.role).toBe('admin');
  });

  it('still allows demoting a second admin while the owner account stays admin', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'admin-second@example.com');
    await User.create({
      email: 'formsatz@gmail.com',
      passwordHash: 'secret123',
      role: 'admin',
    });

    const id = (await User.findOne({ email: 'admin-second@example.com' }))!._id.toString();
    const res = await request(app)
      .put(`/api/admin/users/${id}/role`)
      .set('Cookie', cookie)
      .send({ role: 'user' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('user');
  });

  it('rejects invalid role values and unknown ids with 404', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'admin4@example.com');

    const badRole = await request(app)
      .put('/api/admin/users/whatever/role')
      .set('Cookie', cookie)
      .send({ role: 'superadmin' });
    expect(badRole.status).toBe(400);

    const missing = await request(app)
      .put('/api/admin/users/aaaaaaaaaaaaaaaaaaaaaaaa/role')
      .set('Cookie', cookie)
      .send({ role: 'user' });
    expect(missing.status).toBe(404);

    const casted = await request(app)
      .put('/api/admin/users/not-an-objectid/permissions')
      .set('Cookie', cookie)
      .send({ permissions: [] });
    expect(casted.status).toBe(404);
  });

  it('reflects live role and permissions on /api/auth/me after admin change', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'me@example.com');

    const before = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(before.status).toBe(200);
    expect(before.body.user.role).toBe('user');
    expect(before.body.user.permissions).toEqual([]);

    await User.updateOne({ email: 'me@example.com' }, { role: 'admin', permissions: ['routing'] });
    const after = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(after.body.user.role).toBe('admin');
    expect(after.body.user.permissions).toEqual(['routing']);
  });

  it('returns 401 from /api/auth/me when the token owns a deleted user', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'ghost@example.com');
    await User.deleteOne({ email: 'ghost@example.com' });

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });

  // Drift test: GET /api/admin/users must type-match AdminUser exactly.
  // @see #20
  it('returns user payloads matching the shared AdminUser contract', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'contract-admin@example.com');
    await registerUser(app, 'contract-member@example.com');

    const res = await request(app).get('/api/admin/users').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const listed: Record<string, unknown>[] = res.body;
    expect(listed.length).toBeGreaterThan(0);

    for (const user of listed) {
      expect(Object.keys(user).sort()).toEqual(
        ['id', 'email', 'role', 'permissions', 'hasGoogle', 'createdAt', 'updatedAt'].sort(),
      );
      expect(typeof user.id).toBe('string');
      expect(typeof user.email).toBe('string');
      expect(['user', 'admin']).toContain(user.role);
      expect(Array.isArray(user.permissions)).toBe(true);
      expect(typeof user.hasGoogle).toBe('boolean');
      expect(typeof user.createdAt).toBe('string');
      expect(isNaN(Date.parse(user.createdAt as string))).toBe(false);
      expect(typeof user.updatedAt).toBe('string');
      expect(isNaN(Date.parse(user.updatedAt as string))).toBe(false);
    }
  });

  describe('GET /api/admin/models (#387)', () => {
    it('returns 401 without a cookie and 403 for non-admins', async () => {
      const app = createApp();
      const cookie = await registerUser(app, 'models-plain@example.com');

      const unauth = await request(app).get('/api/admin/models');
      expect(unauth.status).toBe(401);

      const nonAdmin = await request(app).get('/api/admin/models').set('Cookie', cookie);
      expect(nonAdmin.status).toBe(403);
    });

    it('lists the fixed serving models read-only', async () => {
      const app = createApp();
      const cookie = await registerAdmin(app, 'models-admin@example.com');

      const res = await request(app).get('/api/admin/models').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.models).toEqual([
        { model: CHAT_MODEL, provider: 'deepinfra', contextLength: 1048576 },
        { model: TASK_MODEL, provider: 'deepinfra', contextLength: 1048576 },
      ]);
    });

    // Tally rows are the single diagnostics mechanism the table reads.
    // @see #175 #168
    it('surfaces per-model error tallies in the payload', async () => {
      const app = createApp();
      const cookie = await registerAdmin(app, 'models-errors@example.com');

      await ModelRouteError.create({
        provider: 'deepinfra',
        model: 'tally/model',
        status: 502,
        category: 'server_error',
        count: 2,
        lastMessage: 'Error: bad gateway',
        lastSeenAt: new Date(),
      });
      await ModelRouteError.create({
        provider: 'deepinfra',
        model: 'tally/model',
        status: null,
        category: 'network',
        count: 1,
        lastMessage: 'Error: connection reset',
        lastSeenAt: new Date(),
      });

      const res = await request(app).get('/api/admin/models').set('Cookie', cookie);
      expect(res.status).toBe(200);
      const errors: Record<string, unknown>[] = res.body.errors.filter(
        (e: { model: string }) => e.model === 'tally/model',
      );
      expect(errors).toHaveLength(2);
      const byCategory = new Map(errors.map((e) => [e.category as string, e]));
      expect(byCategory.get('server_error')).toMatchObject({
        provider: 'deepinfra',
        count: 2,
        status: 502,
        lastMessage: 'Error: bad gateway',
      });
      expect(byCategory.get('network')).toMatchObject({
        status: null,
        count: 1,
        lastMessage: 'Error: connection reset',
      });
      for (const e of errors) {
        expect(isNaN(Date.parse(e.lastSeenAt as string))).toBe(false);
      }
    });
  });
});

describe('admin retained logs endpoint (#179)', () => {
  const adminCookieOf = async (app: ReturnType<typeof createApp>) => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'logsadmin@example.com', password: 'password123' });
    await User.updateOne({ email: 'logsadmin@example.com' }, { role: 'admin' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'logsadmin@example.com', password: 'password123' });
    return Array.isArray(res.headers['set-cookie'])
      ? res.headers['set-cookie']
      : [res.headers['set-cookie']];
  };

  beforeEach(() => {
    mockedQueryRetainedLogs.mockReset();
    mockedQueryRetainedLogs.mockResolvedValue({ logs: [], configured: true });
  });

  it('is admin-only', async () => {
    const app = createApp();
    const nonAdmin = await request(app)
      .post('/api/auth/register')
      .send({ email: 'logsplain@example.com', password: 'password123' })
      .then((res) =>
        Array.isArray(res.headers['set-cookie'])
          ? res.headers['set-cookie']
          : [res.headers['set-cookie']],
      );

    const unauth = await request(app).get('/api/admin/logs');
    expect(unauth.status).toBe(401);

    const forbidden = await request(app).get('/api/admin/logs').set('Cookie', nonAdmin);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.message).toBe('Forbidden');
  });

  it('rejects an unknown level with 400', async () => {
    const app = createApp();
    const cookie = await adminCookieOf(app);
    const res = await request(app).get('/api/admin/logs?level=bogus').set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/level/);
    expect(mockedQueryRetainedLogs).not.toHaveBeenCalled();
  });

  it('passes level, q, hours and limit through to the Loki service', async () => {
    const app = createApp();
    const cookie = await adminCookieOf(app);
    const res = await request(app)
      .get('/api/admin/logs?level=error&q=boom&hours=6&limit=50')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(mockedQueryRetainedLogs).toHaveBeenCalledWith({
      level: 'error',
      q: 'boom',
      hours: 6,
      limit: 50,
    });
  });

  it('ignores garbage hours/limit rather than 500-ing', async () => {
    const app = createApp();
    const cookie = await adminCookieOf(app);
    const res = await request(app)
      .get('/api/admin/logs?hours=nope&limit=nope')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(mockedQueryRetainedLogs).toHaveBeenCalledWith({
      level: undefined,
      q: undefined,
      hours: undefined,
      limit: undefined,
    });
  });

  it('returns the retained shape including configured and error', async () => {
    mockedQueryRetainedLogs.mockResolvedValue({
      logs: [
        { id: '1700000000000000000', ts: '2026-10-03T10:00:00.000Z', level: 'info', msg: 'hello' },
      ],
      configured: true,
    });
    const app = createApp();
    const cookie = await adminCookieOf(app);
    const res = await request(app).get('/api/admin/logs').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0]).toMatchObject({ level: 'info', msg: 'hello' });
  });

  it('surfaces graceful degradation (unconfigured / error) without a 500', async () => {
    mockedQueryRetainedLogs.mockResolvedValue({
      logs: [],
      configured: false,
      error: 'Loki unreachable',
    });
    const app = createApp();
    const cookie = await adminCookieOf(app);
    const res = await request(app).get('/api/admin/logs').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ logs: [], configured: false, error: 'Loki unreachable' });
  });
});

/* Model-compare route: only validation; runner is unit-tested elsewhere. */
// @see #129
describe('POST /api/admin/model-compare (issue #129)', () => {
  it('rejects the unauthenticated and non-admin', async () => {
    const app = createApp();
    const user = await registerUser(app, 'nocmp@example.com');
    expect((await request(app).post('/api/admin/model-compare').send({})).status).toBe(401);
    const res = await request(app)
      .post('/api/admin/model-compare')
      .set('Cookie', user)
      .send({ prompt: 'hi', models: [{ provider: 'deepinfra', model: 'x' }] });
    expect(res.status).toBe(403);
  });

  it('validates prompt and model rows before running anything', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'cmpadmin@example.com');
    const call = (body: object) =>
      request(app).post('/api/admin/model-compare').set('Cookie', cookie).send(body);

    const noPrompt = await call({ models: [{ provider: 'deepinfra', model: 'x' }] });
    expect(noPrompt.status).toBe(400);

    const emptyModels = await call({ prompt: 'hi', models: [] });
    expect(emptyModels.status).toBe(400);

    const badProvider = await call({
      prompt: 'hi',
      models: [{ provider: 'openai', model: 'x' }],
    });
    expect(badProvider.status).toBe(400);

    const blankModel = await call({ prompt: 'hi', models: [{ provider: 'groq', model: ' ' }] });
    expect(blankModel.status).toBe(400);

    const badContext = await call({
      prompt: 'hi',
      models: [{ provider: 'groq', model: 'x', contextLength: 0 }],
    });
    expect(badContext.status).toBe(400);

    const tooManyRows = await call({
      prompt: 'hi',
      models: Array.from({ length: 7 }, () => ({ provider: 'groq', model: 'x' })),
    });
    expect(tooManyRows.status).toBe(400);
  });
});
