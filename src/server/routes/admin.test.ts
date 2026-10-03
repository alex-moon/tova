import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../index';
import { User } from '../models/User';
import { ProviderRouting } from '../models/ProviderRouting';
import { ModelMetricStat } from '../models/ModelMetricStat';
import { ModelRouteError } from '../models/ModelRouteError';
import { Entity } from '../models/Entity';
import { EntityEdge } from '../models/EntityEdge';
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
      const rows = res.body.models.filter(
        (m: { model: string }) => m.model === 'test-large',
      ) as Record<string, unknown>[];
      expect(rows).toHaveLength(2);
      const byTier = new Map(rows.map((r) => [r.tier, r]));
      expect(byTier.get('guard')).toMatchObject({
        eligible: false,
        stats: [{ band: 'short|prose', up: 3, down: 1 }],
        disabledUntil: null,
      });
      expect(byTier.get('large')).toMatchObject({ eligible: true, contextLength: 131072 });
      for (const row of rows) {
        expect(typeof row.id).toBe('string');
        expect(row.id).not.toBe('groq/test-large'); // per-row Mongo ids, #104
      }
    });

    // #168: the cool-off expiry and the per-model error diagnostics ride
    // the same payload — the badge and the errors table read them.
    it('surfaces disabledUntil and per-model error tallies in the payload', async () => {
      const app = createApp();
      const cookie = await registerAdmin(app, 'models-cooloff@example.com');

      const until = new Date(Date.now() + 3 * 60 * 60 * 1000);
      await ProviderRouting.create({
        provider: 'deepinfra',
        model: 'test-cooling',
        tier: 'large',
        eligible: true,
        disabledUntil: until,
      });
      await ProviderRouting.create({
        provider: 'groq',
        model: 'test-healthy',
        tier: 'guard',
        eligible: true,
      });
      // #175 tally rows (modelrouteerrors) are the single diagnostics
      // mechanism — the admin table reads them (OQ-7 lean consolidation).
      await ModelRouteError.create({
        provider: 'deepinfra',
        model: 'test-cooling',
        status: 502,
        category: 'server_error',
        count: 2,
        lastMessage: 'Error: bad gateway',
        lastSeenAt: new Date(),
      });
      await ModelRouteError.create({
        provider: 'deepinfra',
        model: 'test-cooling',
        status: null,
        category: 'network',
        count: 1,
        lastMessage: 'Error: connection reset',
        lastSeenAt: new Date(),
      });

      const res = await request(app).get('/api/admin/models').set('Cookie', cookie);
      expect(res.status).toBe(200);
      const cooling = res.body.models.find((m: { model: string }) => m.model === 'test-cooling');
      const healthy = res.body.models.find((m: { model: string }) => m.model === 'test-healthy');
      expect(cooling.disabledUntil).toBe(until.toISOString());
      expect(healthy.disabledUntil).toBeNull();

      const errors: Record<string, unknown>[] = res.body.errors.filter(
        (e: { model: string }) => e.model === 'test-cooling',
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

      // #199: prices are admin-editable config; the list surfaces them and
      // the cap reads them. Non-negative finite numbers only (sub-cent rates
      // like 0.085 are legal, so not integers).
      it('creates, updates, lists and clears model prices', async () => {
        const created = await request(app)
          .post('/api/admin/models')
          .send({
            provider: 'deepinfra',
            model: 'org/test-crud',
            tier: 'large',
            inputPrice: 0.085,
            outputPrice: 0.4,
          })
          .set('Cookie', cookie);
        expect(created.status).toBe(201);
        const id = created.body.id as string;

        let rows = await ProviderRouting.find({ model: 'org/test-crud' }).lean();
        expect(rows[0]).toMatchObject({ inputPrice: 0.085, outputPrice: 0.4 });

        const listed = await request(app).get('/api/admin/models').set('Cookie', cookie);
        const row = listed.body.models.find((m: { model: string }) => m.model === 'org/test-crud');
        expect(row).toMatchObject({ inputPrice: 0.085, outputPrice: 0.4 });

        const updated = await request(app)
          .put(`/api/admin/models/${id}`)
          .send({ inputPrice: 0.15, outputPrice: 0.5 })
          .set('Cookie', cookie);
        expect(updated.status).toBe(200);
        rows = await ProviderRouting.find({ model: 'org/test-crud' }).lean();
        expect(rows[0]).toMatchObject({ inputPrice: 0.15, outputPrice: 0.5 });

        // `null` clears back to "unknown" (admitted by the cap, flagged in UI).
        await request(app)
          .put(`/api/admin/models/${id}`)
          .send({ inputPrice: null, outputPrice: '' })
          .set('Cookie', cookie);
        rows = await ProviderRouting.find({ model: 'org/test-crud' }).lean();
        expect(rows[0].inputPrice).toBeNull();
        expect(rows[0].outputPrice).toBeNull();
      });

      it('rejects negative, non-numeric and boolean prices', async () => {
        for (const payload of [
          { inputPrice: -0.1 },
          { outputPrice: -1 },
          { inputPrice: 'free' },
          { outputPrice: 'NaN' },
          { inputPrice: true },
        ]) {
          const res = await request(app)
            .post('/api/admin/models')
            .send({ provider: 'deepinfra', model: 'org/test-crud', tier: 'large', ...payload })
            .set('Cookie', cookie);
          expect(res.status).toBe(400);
        }
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

/*
 * GET /api/admin/graph/* (issue #138 plan task 5): read-only per-user entity
 * graph for the admin Graph tab. Seeding uses Entity/EntityEdge directly —
 * extraction is unit-tested in its own service suite.
 */
describe('GET /api/admin/graph (issue #138)', () => {
  it('rejects the unauthenticated and non-admin', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'nograph@example.com');
    expect((await request(app).get('/api/admin/graph/entities')).status).toBe(401);
    const res = await request(app)
      .get('/api/admin/graph/entities?userId=507f1f77bcf86cd799439011')
      .set('Cookie', cookie);
    expect(res.status).toBe(403);
  });

  it('validates userId and pagination params', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'graphadmin@example.com');
    expect((await request(app).get('/api/admin/graph/entities').set('Cookie', cookie)).status).toBe(
      400,
    );
    const badId = await request(app)
      .get('/api/admin/graph/entities?userId=not-an-id')
      .set('Cookie', cookie);
    expect(badId.status).toBe(400);
    const badPage = await request(app)
      .get('/api/admin/graph/entities?userId=507f1f77bcf86cd799439011&page=-2')
      .set('Cookie', cookie);
    expect(badPage.status).toBe(200);
    expect(badPage.body.page).toBe(1);
  });

  it('lists a user entities paginated, most recent first, without other users data', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'graphadmin2@example.com');
    const member = await request(app)
      .post('/api/auth/register')
      .send({ email: 'graphmember@example.com', password: 'password123' });
    const userId = new mongoose.Types.ObjectId(member.body.user.id);
    const other = new mongoose.Types.ObjectId();
    const old = new Date(Date.now() - 60_000);
    const session = new mongoose.Types.ObjectId();
    const message = new mongoose.Types.ObjectId();
    await Entity.create([
      {
        userId,
        name: 'Taj Hotel',
        normalizedName: 'taj hotel',
        kind: 'place',
        sourceRefs: [{ sessionId: session, messageId: message }],
      },
      {
        userId,
        name: 'Priya',
        normalizedName: 'priya',
        kind: 'person',
        summary: 'daughter',
        mentionCount: 2,
        sourceRefs: [{ sessionId: session }],
      },
      { userId, name: 'Old', normalizedName: 'old', kind: 'project', lastMentionedAt: old },
      { userId: other, name: 'Other', normalizedName: 'other', kind: 'place' },
    ]);
    const res = await request(app)
      .get(`/api/admin/graph/entities?userId=${userId}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.limit).toBe(20);
    expect(res.body.page).toBe(1);
    const names = res.body.entities.map((e: { name: string }) => e.name);
    expect(names).toEqual(['Priya', 'Taj Hotel', 'Old']);
    expect(res.body.entities[0]).not.toHaveProperty('passwordHash');
    const taj = res.body.entities[1];
    expect(taj.sourceRefs[0].sessionId).toBeTruthy();
    // Pagination: limit=1&page=2 returns the second most recent only.
    const page2 = await request(app)
      .get(`/api/admin/graph/entities?userId=${userId}&limit=1&page=2`)
      .set('Cookie', cookie);
    expect(page2.body.entities.map((e: { name: string }) => e.name)).toEqual(['Taj Hotel']);
    expect(page2.body.total).toBe(3);
    // Never leaks the other user's node.
    expect(names.join()).not.toContain('Other');
  });

  it('returns entity detail with resolved edge names for edges on either side', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'graphadmin3@example.com');
    const a = await Entity.create({
      userId: new mongoose.Types.ObjectId(),
      name: 'Priya',
      normalizedName: 'priya',
      kind: 'person',
    });
    const b = await Entity.create({
      userId: a.userId,
      name: 'Taj Hotel',
      normalizedName: 'taj hotel',
      kind: 'place',
    });
    const c = await Entity.create({
      userId: a.userId,
      name: 'Booking',
      normalizedName: 'booking',
      kind: 'commitment',
    });
    await EntityEdge.create([
      {
        userId: a.userId,
        fromEntityId: b._id,
        toEntityId: a._id,
        kind: 'located-near',
        summary: 'places near the hotel',
      },
      { userId: a.userId, fromEntityId: a._id, toEntityId: c._id, kind: 'committed-to' },
    ]);
    const res = await request(app).get(`/api/admin/graph/entities/${a.id}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.entity.name).toBe('Priya');
    expect(res.body.edges).toHaveLength(2);
    const kinds = res.body.edges.map((e: { kind: string }) => e.kind).sort();
    expect(kinds).toEqual(['committed-to', 'located-near']);
    for (const edge of res.body.edges) {
      const { fromName, toName } = edge;
      expect([fromName, toName]).toContain('Priya');
    }
    expect(res.body.edges.find((e: { kind: string }) => e.kind === 'located-near').fromName).toBe(
      'Taj Hotel',
    );
    // Unknown / malformed id → 404.
    expect(
      (await request(app).get('/api/admin/graph/entities/not-an-id').set('Cookie', cookie)).status,
    ).toBe(404);
    const missing = await request(app)
      .get('/api/admin/graph/entities/507f1f77bcf86cd799439011')
      .set('Cookie', cookie);
    expect(missing.status).toBe(404);
  });
});
