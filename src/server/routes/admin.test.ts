import request from 'supertest';
import mongoose from 'mongoose';
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
    beforeEach(async () => {
      // The DB is shared across runs — clear leftover test models.
      await ProviderRouting.deleteMany({ model: /^test-/ });
    });

    it('returns 401 without a cookie and 403 for non-admins', async () => {
      const app = createApp();
      const cookie = await registerUser(app, 'models-plain@example.com');

      const unauth = await request(app).get('/api/admin/models');
      expect(unauth.status).toBe(401);

      const nonAdmin = await request(app).get('/api/admin/models').set('Cookie', cookie);
      expect(nonAdmin.status).toBe(403);
    });

    it('lists configured models row-per-routing with eligibility and per-band feedback tallies', async () => {
      const app = createApp();
      const cookie = await registerAdmin(app, 'models-admin@example.com');

      await ProviderRouting.create({
        provider: 'groq',
        model: 'test-large',
        tier: 'large',
        eligible: true,
        contextLength: 131072,
      });
      await ProviderRouting.create({
        provider: 'groq',
        model: 'test-large',
        tier: 'guard',
        eligible: false,
      });
      await ModelMetricStat.findOneAndUpdate(
        { band: 'short|prose', modelName: 'test-large' },
        { up: 3, down: 1 },
        { upsert: true },
      );

      const res = await request(app).get('/api/admin/models').set('Cookie', cookie);
      expect(res.status).toBe(200);
      const rows = res.body.filter((m: { model: string }) => m.model === 'test-large') as Record<
        string,
        unknown
      >[];
      expect(rows).toHaveLength(2);
      const byTier = new Map(rows.map((r) => [r.tier, r]));
      expect(byTier.get('guard')).toMatchObject({
        eligible: false,
        stats: [{ band: 'short|prose', up: 3, down: 1 }],
      });
      expect(byTier.get('large')).toMatchObject({ eligible: true, contextLength: 131072 });
      for (const row of rows) {
        expect(typeof row.id).toBe('string');
        expect(row.id).not.toBe('groq/test-large'); // per-row Mongo ids, #104
      }
    });

    describe('CRUD (issue #104)', () => {
      let app: ReturnType<typeof createApp>;
      let cookie: string[];

      beforeEach(async () => {
        app = createApp();
        cookie = await registerAdmin(app, 'models-crud@example.com');
        await ProviderRouting.deleteMany({ model: { $in: ['org/test-crud', 'dup-model', 'upd'] } });
      });

      it('rejects unauthenticated/non-admin users for every mutating endpoint', async () => {
        const plain = await request(app)
          .post('/api/auth/register')
          .send({ email: 'models-crud2@example.com', password: 'password123' })
          .then((r) =>
            Array.isArray(r.headers['set-cookie'])
              ? r.headers['set-cookie']
              : [r.headers['set-cookie']],
          );
        expect((await request(app).post('/api/admin/models').send({})).status).toBe(401);
        expect(
          (await request(app).post('/api/admin/models').send({}).set('Cookie', plain)).status,
        ).toBe(403);
        expect((await request(app).put('/api/admin/models/abc').send({})).status).toBe(401);
        expect((await request(app).delete('/api/admin/models/abc')).status).toBe(401);
      });

      it('requires provider/model/tier on create and rejects invalid values', async () => {
        const bad = await request(app)
          .post('/api/admin/models')
          .send({ provider: 'groq', model: 'm' })
          .set('Cookie', cookie);
        expect(bad.status).toBe(400);
        expect(bad.body.message).toMatch(/tier/);

        const invalidProvider = await request(app)
          .post('/api/admin/models')
          .send({ provider: 'openai', model: 'm', tier: 'small' })
          .set('Cookie', cookie);
        expect(invalidProvider.status).toBe(400);

        const invalidTier = await request(app)
          .post('/api/admin/models')
          .send({ provider: 'groq', model: 'm', tier: 'huge' })
          .set('Cookie', cookie);
        expect(invalidTier.status).toBe(400);

        const invalidContext = await request(app)
          .post('/api/admin/models')
          .send({ provider: 'groq', model: 'm', tier: 'small', contextLength: -5 })
          .set('Cookie', cookie);
        expect(invalidContext.status).toBe(400);
      });

      it('creates, edits, disables and deletes a routing row', async () => {
        const created = await request(app)
          .post('/api/admin/models')
          .send({
            provider: 'deepinfra',
            model: 'org/test-crud',
            tier: 'small',
            contextLength: 32768,
            tools: true,
            vision: true,
          })
          .set('Cookie', cookie);
        expect(created.status).toBe(201);
        expect(typeof created.body.id).toBe('string');
        const id = created.body.id as string;

        let rows = await ProviderRouting.find({ model: 'org/test-crud' }).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          tier: 'small',
          eligible: true,
          contextLength: 32768,
          vision: true,
        });

        const updated = await request(app)
          .put(`/api/admin/models/${id}`)
          .send({ tier: 'large', eligible: false, contextLength: null })
          .set('Cookie', cookie);
        expect(updated.status).toBe(200);
        rows = await ProviderRouting.find({ model: 'org/test-crud' }).lean();
        expect(rows[0]).toMatchObject({ tier: 'large', eligible: false, contextLength: null });

        const deleted = await request(app).delete(`/api/admin/models/${id}`).set('Cookie', cookie);
        expect(deleted.status).toBe(204);
        expect(await ProviderRouting.countDocuments({ model: 'org/test-crud' })).toBe(0);

        const missing = await request(app).delete(`/api/admin/models/${id}`).set('Cookie', cookie);
        expect(missing.status).toBe(404);
      });

      it('returns 409 on a duplicate (provider, model, tier) row', async () => {
        await ProviderRouting.create({
          provider: 'groq',
          model: 'dup-model',
          tier: 'small',
        });
        const created = await request(app)
          .post('/api/admin/models')
          .send({ provider: 'groq', model: 'dup-model', tier: 'small' })
          .set('Cookie', cookie);
        expect(created.status).toBe(409);
      });

      it('rejects unknown and malformed fields on update', async () => {
        await ProviderRouting.create({ provider: 'groq', model: 'upd', tier: 'small' });
        const row = (await ProviderRouting.findOne({ model: 'upd' }))!;

        const unknown = await request(app)
          .put(`/api/admin/models/${row.id}`)
          .send({ tools: true, bogus: 1 })
          .set('Cookie', cookie);
        expect(unknown.status).toBe(400);
        expect(unknown.body.message).toMatch(/[Uu]nknown/);

        const malformed = await request(app)
          .put(`/api/admin/models/${row.id}`)
          .send({ eligible: 'yes' })
          .set('Cookie', cookie);
        expect(malformed.status).toBe(400);

        const missing = await request(app)
          .put(`/api/admin/models/${new mongoose.Types.ObjectId().toString()}`)
          .send({ eligible: false })
          .set('Cookie', cookie);
        expect(missing.status).toBe(404);
      });
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

/*
 * POST /api/admin/model-compare (issue #129): shared-core direct model
 * comparison behind the admin guard. Only validation is asserted here —
 * the runner itself (connectors, agent path) is unit-tested in
 * services/modelCompare.test.ts, so this suite never pays for a real
 * completion call.
 */
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
