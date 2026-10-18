import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../../main/index';
import { User } from '../../main/models/User';
import { ModelRoster } from '../../main/models/ModelRoster';
import { ModelRouteError } from '../../main/models/ModelRouteError';
import { queryRetainedLogs } from '../../main/services/lokiLogs';

jest.mock('../../main/services/lokiLogs', () => ({
  queryRetainedLogs: jest.fn(),
}));

// Provider catalog mocked; the suite pins guard, validation and error mapping.
// @see #217
jest.mock('../../main/services/providerModelLookup', () => ({
  lookupProviderModel: jest.fn(),
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

  describe('GET /api/admin/models (issue #33)', () => {
    beforeEach(async () => {
      // The DB is shared across runs — clear leftover test models.
      await ModelRoster.deleteMany({ modelId: /^test-/ });
    });

    it('returns 401 without a cookie and 403 for non-admins', async () => {
      const app = createApp();
      const cookie = await registerUser(app, 'models-plain@example.com');

      const unauth = await request(app).get('/api/admin/models');
      expect(unauth.status).toBe(401);

      const nonAdmin = await request(app).get('/api/admin/models').set('Cookie', cookie);
      expect(nonAdmin.status).toBe(403);
    });

    // One row per model with providers nested; tier column is gone.
    // @see #234
    it('lists one roster row per model with nested providers and TTFT', async () => {
      const app = createApp();
      const cookie = await registerAdmin(app, 'models-admin@example.com');

      const updatedAt = new Date();
      await ModelRoster.create({
        modelId: 'test-large',
        label: 'Test Large',
        eligible: true,
        contextLength: 131072,
        providers: [
          {
            provider: 'deepinfra',
            modelId: 'test-large',
            ttftMs: 420,
            ttftSamples: 12,
            ttftUpdatedAt: updatedAt,
          },
          {
            provider: 'fireworks',
            modelId: 'accounts/fireworks/models/test-large',
            enabled: false,
          },
        ],
      });

      const res = await request(app).get('/api/admin/models').set('Cookie', cookie);
      expect(res.status).toBe(200);
      const row = res.body.models.find((m: { modelId: string }) => m.modelId === 'test-large');
      expect(row).toMatchObject({
        modelId: 'test-large',
        label: 'Test Large',
        eligible: true,
        contextLength: 131072,
      });
      expect(row.tier).toBeUndefined();
      expect(row.stats).toBeUndefined();
      expect(typeof row.id).toBe('string');
      expect(row.providers).toHaveLength(2);
      const byProvider = new Map(
        (row.providers as { provider: string }[]).map((p) => [p.provider, p]),
      );
      expect(byProvider.get('deepinfra')).toMatchObject({
        modelId: 'test-large',
        enabled: true,
        ttftMs: 420,
        ttftSamples: 12,
        ttftUpdatedAt: updatedAt.toISOString(),
        disabledUntil: null,
      });
      expect(byProvider.get('fireworks')).toMatchObject({
        enabled: false,
      });
    });

    // The cool-off is per provider now; tallies stay keyed provider+model.
    // @see #168 #213
    it('surfaces per-provider disabledUntil and per-model error tallies in the payload', async () => {
      const app = createApp();
      const cookie = await registerAdmin(app, 'models-cooloff@example.com');

      const until = new Date(Date.now() + 3 * 60 * 60 * 1000);
      await ModelRoster.create({
        modelId: 'test-cooling',
        label: 'Test Cooling',
        eligible: true,
        providers: [{ provider: 'deepinfra', modelId: 'test-cooling', disabledUntil: until }],
      });
      await ModelRoster.create({
        modelId: 'test-healthy',
        label: 'Test Healthy',
        eligible: true,
        providers: [{ provider: 'fireworks', modelId: 'accounts/fireworks/models/test-healthy' }],
      });
      // Tally rows are the single diagnostics mechanism the table reads.
      // @see #175
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
      const cooling = res.body.models.find(
        (m: { modelId: string }) => m.modelId === 'test-cooling',
      );
      const healthy = res.body.models.find(
        (m: { modelId: string }) => m.modelId === 'test-healthy',
      );
      expect(cooling.providers[0].disabledUntil).toBe(until.toISOString());
      expect(healthy.providers[0].disabledUntil).toBeNull();

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
        await ModelRoster.deleteMany({ modelId: { $in: ['org/test-crud', 'dup-model', 'upd'] } });
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

      it('requires modelId/providers on create and rejects invalid values', async () => {
        const bad = await request(app)
          .post('/api/admin/models')
          .send({ label: 'm' })
          .set('Cookie', cookie);
        expect(bad.status).toBe(400);
        expect(bad.body.message).toMatch(/modelId/);

        const noProviders = await request(app)
          .post('/api/admin/models')
          .send({ modelId: 'm' })
          .set('Cookie', cookie);
        expect(noProviders.status).toBe(400);
        expect(noProviders.body.message).toMatch(/providers/);

        const invalidProvider = await request(app)
          .post('/api/admin/models')
          .send({
            modelId: 'm',
            providers: [{ provider: 'groq', modelId: 'm' }],
          })
          .set('Cookie', cookie);
        expect(invalidProvider.status).toBe(400);
        expect(invalidProvider.body.message).toMatch(/deepinfra/);

        const duplicateProvider = await request(app)
          .post('/api/admin/models')
          .send({
            modelId: 'm',
            providers: [
              { provider: 'deepinfra', modelId: 'm' },
              { provider: 'deepinfra', modelId: 'm2' },
            ],
          })
          .set('Cookie', cookie);
        expect(duplicateProvider.status).toBe(400);
        expect(duplicateProvider.body.message).toMatch(/[Dd]uplicate/);

        const invalidContext = await request(app)
          .post('/api/admin/models')
          .send({
            modelId: 'm',
            providers: [{ provider: 'deepinfra', modelId: 'm' }],
            contextLength: -5,
          })
          .set('Cookie', cookie);
        expect(invalidContext.status).toBe(400);
      });

      it('creates, edits, disables a provider and deletes a roster model', async () => {
        const created = await request(app)
          .post('/api/admin/models')
          .send({
            modelId: 'org/test-crud',
            label: 'Test CRUD',
            providers: [
              { provider: 'deepinfra', modelId: 'org/test-crud' },
              { provider: 'fireworks', modelId: 'accounts/fireworks/models/test-crud' },
            ],
            contextLength: 32768,
            tools: true,
            vision: true,
          })
          .set('Cookie', cookie);
        expect(created.status).toBe(201);
        expect(typeof created.body.id).toBe('string');
        const id = created.body.id as string;

        let rows = await ModelRoster.find({ modelId: 'org/test-crud' }).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          label: 'Test CRUD',
          eligible: true,
          contextLength: 32768,
          vision: true,
        });
        expect(rows[0].providers).toHaveLength(2);
        expect(rows[0].providers?.[0]).toMatchObject({ enabled: true, disabledUntil: null });

        // Update eligibility/context and disable one provider.
        const updated = await request(app)
          .put(`/api/admin/models/${id}`)
          .send({
            eligible: false,
            contextLength: null,
            providers: [
              { provider: 'deepinfra', modelId: 'org/test-crud', enabled: false },
              { provider: 'fireworks', modelId: 'accounts/fireworks/models/test-crud' },
            ],
          })
          .set('Cookie', cookie);
        expect(updated.status).toBe(200);
        rows = await ModelRoster.find({ modelId: 'org/test-crud' }).lean();
        expect(rows[0]).toMatchObject({ eligible: false, contextLength: null });
        const byProvider = new Map((rows[0].providers ?? []).map((p) => [p.provider, p]));
        expect(byProvider.get('deepinfra')?.enabled).toBe(false);
        expect(byProvider.get('fireworks')?.enabled).toBe(true);

        const deleted = await request(app).delete(`/api/admin/models/${id}`).set('Cookie', cookie);
        expect(deleted.status).toBe(204);
        expect(await ModelRoster.countDocuments({ modelId: 'org/test-crud' })).toBe(0);

        const missing = await request(app).delete(`/api/admin/models/${id}`).set('Cookie', cookie);
        expect(missing.status).toBe(404);
      });

      // An edit preserves TTFT/cool-off; modelId/enabled are operator-owned.
      // @see #234
      it('preserves provider TTFT and cool-off across an edit', async () => {
        const until = new Date(Date.now() + 60 * 60 * 1000);
        const doc = await ModelRoster.create({
          modelId: 'org/test-crud',
          label: 'Test CRUD',
          providers: [
            {
              provider: 'deepinfra',
              modelId: 'org/test-crud',
              ttftMs: 310,
              ttftSamples: 7,
              disabledUntil: until,
            },
            { provider: 'fireworks', modelId: 'accounts/fireworks/models/test-crud' },
          ],
        });

        const updated = await request(app)
          .put(`/api/admin/models/${doc.id}`)
          .send({
            providers: [
              { provider: 'deepinfra', modelId: 'org/test-crud' },
              {
                provider: 'fireworks',
                modelId: 'accounts/fireworks/models/test-crud',
                enabled: false,
              },
            ],
          })
          .set('Cookie', cookie);
        expect(updated.status).toBe(200);

        const after = await ModelRoster.findById(doc.id).lean();
        const byProvider = new Map((after?.providers ?? []).map((p) => [p.provider, p]));
        expect(byProvider.get('deepinfra')).toMatchObject({
          ttftMs: 310,
          ttftSamples: 7,
          enabled: true,
        });
        expect(byProvider.get('deepinfra')?.disabledUntil?.toISOString()).toBe(until.toISOString());
        expect(byProvider.get('fireworks')?.enabled).toBe(false);
      });

      it('returns 409 on a duplicate modelId', async () => {
        await ModelRoster.create({
          modelId: 'dup-model',
          label: 'Dup',
          providers: [{ provider: 'deepinfra', modelId: 'dup-model' }],
        });
        const created = await request(app)
          .post('/api/admin/models')
          .send({
            modelId: 'dup-model',
            providers: [{ provider: 'deepinfra', modelId: 'dup-model' }],
          })
          .set('Cookie', cookie);
        expect(created.status).toBe(409);
      });

      // Prices are admin-editable config; non-negative finite numbers only.
      // @see #199
      it('creates, updates, lists and clears model prices', async () => {
        const created = await request(app)
          .post('/api/admin/models')
          .send({
            modelId: 'org/test-crud',
            providers: [{ provider: 'deepinfra', modelId: 'org/test-crud' }],
            inputPrice: 0.085,
            outputPrice: 0.4,
          })
          .set('Cookie', cookie);
        expect(created.status).toBe(201);
        const id = created.body.id as string;

        let rows = await ModelRoster.find({ modelId: 'org/test-crud' }).lean();
        expect(rows[0]).toMatchObject({ inputPrice: 0.085, outputPrice: 0.4 });

        const listed = await request(app).get('/api/admin/models').set('Cookie', cookie);
        const row = listed.body.models.find(
          (m: { modelId: string }) => m.modelId === 'org/test-crud',
        );
        expect(row).toMatchObject({ inputPrice: 0.085, outputPrice: 0.4 });

        const updated = await request(app)
          .put(`/api/admin/models/${id}`)
          .send({ inputPrice: 0.15, outputPrice: 0.5 })
          .set('Cookie', cookie);
        expect(updated.status).toBe(200);
        rows = await ModelRoster.find({ modelId: 'org/test-crud' }).lean();
        expect(rows[0]).toMatchObject({ inputPrice: 0.15, outputPrice: 0.5 });

        // `null` clears back to "unknown" (neutral in the weighted score).
        await request(app)
          .put(`/api/admin/models/${id}`)
          .send({ inputPrice: null, outputPrice: '' })
          .set('Cookie', cookie);
        rows = await ModelRoster.find({ modelId: 'org/test-crud' }).lean();
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
            .send({
              modelId: 'org/test-crud',
              providers: [{ provider: 'deepinfra', modelId: 'org/test-crud' }],
              ...payload,
            })
            .set('Cookie', cookie);
          expect(res.status).toBe(400);
        }
      });

      it('rejects unknown and malformed fields on update', async () => {
        await ModelRoster.create({
          modelId: 'upd',
          label: 'Upd',
          providers: [{ provider: 'deepinfra', modelId: 'upd' }],
        });
        const row = (await ModelRoster.findOne({ modelId: 'upd' }))!;

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

/* Model-lookup route: service mocked; the contract under test is the route. */
// @see #217
describe('GET /api/admin/model-lookup (#217)', () => {
  const lookupProviderModel = jest.requireMock('../../main/services/providerModelLookup')
    .lookupProviderModel as jest.Mock;

  beforeEach(() => {
    lookupProviderModel.mockReset();
    lookupProviderModel.mockResolvedValue(null);
  });

  it('rejects the unauthenticated and non-admin', async () => {
    const app = createApp();
    const user = await registerUser(app, 'nolookup@example.com');
    expect(
      (await request(app).get('/api/admin/model-lookup?provider=deepinfra&model=x')).status,
    ).toBe(401);
    const res = await request(app)
      .get('/api/admin/model-lookup?provider=deepinfra&model=x')
      .set('Cookie', user);
    expect(res.status).toBe(403);
  });

  it('validates the provider and model params', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'lookupadmin@example.com');

    const badProvider = await request(app)
      .get('/api/admin/model-lookup?provider=openai&model=x')
      .set('Cookie', cookie);
    expect(badProvider.status).toBe(400);
    expect(badProvider.body.message).toMatch(/deepinfra/);
    expect(badProvider.body.message).toMatch(/fireworks/);

    const missingModel = await request(app)
      .get('/api/admin/model-lookup?provider=deepinfra&model=')
      .set('Cookie', cookie);
    expect(missingModel.status).toBe(400);

    expect(lookupProviderModel).not.toHaveBeenCalled();
  });

  it('returns found details and a not-found miss as 200s', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'lookupfound@example.com');

    lookupProviderModel.mockResolvedValueOnce({
      provider: 'deepinfra',
      model: 'XiaomiMiMo/MiMo-V2.6-Flash',
      contextLength: 1048576,
      inputPrice: 0.14,
      outputPrice: 0.28,
      vision: true,
    });
    const found = await request(app)
      .get('/api/admin/model-lookup?provider=deepinfra&model=XiaomiMiMo%2FMiMo-V2.6-Flash')
      .set('Cookie', cookie);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({
      found: true,
      provider: 'deepinfra',
      model: 'XiaomiMiMo/MiMo-V2.6-Flash',
      contextLength: 1048576,
      inputPrice: 0.14,
      outputPrice: 0.28,
      vision: true,
    });
    expect(lookupProviderModel).toHaveBeenCalledWith('deepinfra', 'XiaomiMiMo/MiMo-V2.6-Flash');

    lookupProviderModel.mockResolvedValueOnce(null);
    const miss = await request(app)
      .get('/api/admin/model-lookup?provider=deepinfra&model=org/absent')
      .set('Cookie', cookie);
    expect(miss.status).toBe(200);
    expect(miss.body).toEqual({ found: false });
  });

  // Fireworks reports context/vision but no prices (absent, never 0).
  // @see #234
  it('resolves a fireworks catalog entry without prices', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'lookupfw@example.com');
    lookupProviderModel.mockResolvedValueOnce({
      provider: 'fireworks',
      model: 'accounts/fireworks/models/deepseek-v4p1-flash',
      contextLength: 1048576,
      vision: true,
    });

    const res = await request(app)
      .get(
        '/api/admin/model-lookup?provider=fireworks&model=accounts%2Ffireworks%2Fmodels%2Fdeepseek-v4p1-flash',
      )
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      found: true,
      provider: 'fireworks',
      model: 'accounts/fireworks/models/deepseek-v4p1-flash',
      contextLength: 1048576,
      vision: true,
    });
    expect(res.body.inputPrice).toBeUndefined();
    expect(res.body.outputPrice).toBeUndefined();
    expect(lookupProviderModel).toHaveBeenCalledWith(
      'fireworks',
      'accounts/fireworks/models/deepseek-v4p1-flash',
    );
  });

  it('maps a provider failure to 502 with the message surfaced', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'lookupfail@example.com');
    lookupProviderModel.mockRejectedValueOnce(new Error('DeepInfra catalog returned HTTP 503'));

    const res = await request(app)
      .get('/api/admin/model-lookup?provider=deepinfra&model=x')
      .set('Cookie', cookie);
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/HTTP 503/);
    // The API key must never appear in an error body.
    expect(JSON.stringify(res.body)).not.toMatch(/Bearer|API_KEY/);
  });
});
