import request from 'supertest';
import { createApp } from '../index';
import { User } from '../models/User';
import { ProviderRouting } from '../models/ProviderRouting';
import { ModelMetricStat } from '../models/ModelMetricStat';

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
        provider: 'groq',
        model: 'test-large',
        tier: 'large',
        eligible: true,
      });
      await ProviderRouting.create({
        provider: 'groq',
        model: 'test-large',
        tier: 'guard',
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
      expect(large).toMatchObject({ provider: 'groq', tiers: ['large', 'guard'] });
      expect(large?.stats).toEqual([{ band: 'short|prose', up: 3, down: 1 }]);
    });
  });
});
