import request from 'supertest';
import { createApp } from '../index';
import { User } from '../models/User';
import { ProviderRouting } from '../models/ProviderRouting';
import { ModelMetricStat } from '../models/ModelMetricStat';
import { clearLogs, pushLog } from '../services/logService';

const cookieOf = (res: request.Response) => {
  const cookie = res.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie : [cookie];
};

// registers the user, promotes them in Mongo, then re-logs in so the JWT
// carries the admin role (the guard reads role from the token)
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

    // only formsatz@gmail.com is protected; a sole non-owner admin can be demoted
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

  // Drift test for the shared contract (issue #20): the wire payload of
  // GET /api/admin/users must type-match AdminUser field-for-field.
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

  describe('GET /api/admin/models (issue #33)', () => {
    it('returns 401 without a cookie and 403 for non-admins', async () => {
      const app = createApp();
      const cookie = await registerUser(app, 'models-plain@example.com');

      const unauth = await request(app).get('/api/admin/models');
      expect(unauth.status).toBe(401);

      const nonAdmin = await request(app).get('/api/admin/models').set('Cookie', cookie);
      expect(nonAdmin.status).toBe(403);
    });

    it('lists configured models grouped with tiers and per-band feedback tallies', async () => {
      const app = createApp();
      const cookie = await registerAdmin(app, 'models-admin@example.com');

      await ProviderRouting.create({
        provider: 'deepinfra',
        model: 'test-large',
        tier: 'small',
        eligible: true,
      });
      await ProviderRouting.create({
        provider: 'deepinfra',
        model: 'test-large',
        tier: 'large',
        eligible: true,
      });
      await ModelMetricStat.findOneAndUpdate(
        { band: 'short|prose', modelName: 'test-large' },
        { up: 3, down: 1 },
        { upsert: true },
      );

      const res = await request(app).get('/api/admin/models').set('Cookie', cookie);
      expect(res.status).toBe(200);
      const large = res.body.find((m: { model: string }) => m.model === 'test-large') as
        Record<string, unknown> | undefined;
      expect(large).toMatchObject({ provider: 'deepinfra', tiers: ['small', 'large'] });
      expect(large?.stats).toEqual([{ band: 'short|prose', up: 3, down: 1 }]);
    });
  });
});

describe('admin logs endpoint (issue #76)', () => {
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
    clearLogs();
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
  });

  it('filters by level and q, paginates by cursor, and ignores garbage cursor/limit', async () => {
    const app = createApp();
    const cookie = await adminCookieOf(app);
    const seed = pushLog('info', 'noise alpha');
    const warn = pushLog('warn', 'needle alert');
    const boom = pushLog('error', 'alpha boom');

    const filtered = await request(app).get('/api/admin/logs?q=alpha').set('Cookie', cookie);
    expect(filtered.status).toBe(200);
    expect(filtered.body.logs.map((l: { msg: string }) => l.msg)).toEqual([
      'noise alpha',
      'alpha boom',
    ]);
    expect(filtered.body.nextCursor).toBe(boom.id);

    const level = await request(app)
      .get('/api/admin/logs?level=warn&cursor=' + seed.id)
      .set('Cookie', cookie);
    expect(level.body.logs.map((l: { msg: string }) => l.msg)).toEqual(['needle alert']);

    const fromSecond = await request(app)
      .get('/api/admin/logs?cursor=' + warn.id)
      .set('Cookie', cookie);
    const msgAfterWarn = fromSecond.body.logs.map((l: { msg: string }) => l.msg);
    expect(msgAfterWarn).toContain('alpha boom');
    expect(msgAfterWarn).not.toContain('needle alert');

    const empty = await request(app).get('/api/admin/logs?cursor=999999').set('Cookie', cookie);
    expect(empty.body.logs).toEqual([]);
    expect(empty.body.nextCursor).toBe(999999);

    // garbage pagination values fall back to defaults rather than 500-ing
    const garbage = await request(app)
      .get('/api/admin/logs?cursor=nope&limit=nope')
      .set('Cookie', cookie);
    expect(garbage.status).toBe(200);
    expect(garbage.body.logs.map((l: { msg: string }) => l.msg)).toContain('alpha boom');
  });

  it('honours valid limits and clamps oversized ones to the sane range', async () => {
    const app = createApp();
    const cookie = await adminCookieOf(app);
    pushLog('info', 'one');
    pushLog('warn', 'two');

    const limited = await request(app).get('/api/admin/logs?limit=1').set('Cookie', cookie);
    expect(limited.body.logs).toHaveLength(1);
    // >=400 request lines land as warn, so level filtering spans sources
    const warnOnly = await request(app).get('/api/admin/logs?level=warn').set('Cookie', cookie);
    expect(warnOnly.body.logs.map((l: { msg: string }) => l.msg)).toContain('two');

    const oversized = await request(app)
      .get('/api/admin/logs?limit=99999999')
      .set('Cookie', cookie);
    expect(oversized.status).toBe(200);
    expect(oversized.body.logs.length).toBeGreaterThanOrEqual(2);
  });

  it('returns logs with cursor pagination shape', async () => {
    const app = createApp();
    const cookie = await adminCookieOf(app);
    const first = await request(app).get('/api/admin/logs').set('Cookie', cookie);
    expect(first.status).toBe(200);
    expect(first.body).toHaveProperty('logs');
    expect(first.body).toHaveProperty('nextCursor');
    expect(Array.isArray(first.body.logs)).toBe(true);
    if (first.body.logs.length > 0) {
      const entry = first.body.logs[0];
      expect(typeof entry.id).toBe('number');
      expect(typeof entry.ts).toBe('string');
      expect(['info', 'warn', 'error']).toContain(entry.level);
      expect(typeof entry.msg).toBe('string');
    }
    expect(Number(first.body.nextCursor)).toBeGreaterThanOrEqual(0);
  });
});
