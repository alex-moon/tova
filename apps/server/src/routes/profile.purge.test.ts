import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../index';
import { User } from '../models/User';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { Asset } from '../models/Asset';
import { AssetJob } from '../models/AssetJob';
import { Connector } from '../models/Connector';
import { FACTORY_RESET_CONFIRM } from '../validation';

// Route-level coverage for the factory reset (issue #143), superseding the
// old purgeUserChats coverage (plan 136, T5): typed confirmation is required,
// nothing PII-bearing survives the POST (sessions hard-deleted, messages,
// assets, job rows all swept), the user's settings and account survive, other
// users are untouched — and the removed ZDR first-enable auto-purge truly no
// longer fires.

const registerUser = async (email: string) => {
  const app = createApp();
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  return {
    app,
    userId: await User.findOne({ email }).then((u) => u?._id as mongoose.Types.ObjectId),
    cookie: response.headers['set-cookie'],
  };
};

const seedUserWorkspace = async (uid: mongoose.Types.ObjectId, count = 2) => {
  for (let i = 0; i < count; i++) {
    const session = await Session.create({ userId: uid, title: `Chat ${i}` });
    await Message.create([
      { sessionId: session._id, role: 'user', content: `question ${i}` },
      { sessionId: session._id, role: 'assistant', content: `answer ${i}` },
    ]);
  }
  const asset = await Asset.create({
    userId: uid,
    filename: 'notes.md',
    key: `${uid}/asset-1/notes.md`,
    contentType: 'text/markdown',
    size: 10,
    status: 'ready',
  });
  await AssetJob.create({ assetId: asset._id });
  await Connector.create({
    scope: 'user',
    userId: uid,
    name: 'remote-tools',
    url: `https://${uid}.example.com/sse`,
    headers: { iv: 'iv', tag: 'tag', ciphertext: 'cipher' },
    headersConfigured: true,
  });
  return { assetId: asset._id };
};

const expectNothingPIIBearingRemains = async (
  uid: mongoose.Types.ObjectId,
  sessionIds: mongoose.Types.ObjectId[] = [],
  assetId?: mongoose.Types.ObjectId,
) => {
  expect(await Session.countDocuments({ userId: uid })).toBe(0);
  expect(await Message.countDocuments({ sessionId: { $in: sessionIds } })).toBe(0);
  expect(await Asset.countDocuments({ userId: uid })).toBe(0);
  // AssetJob has no userId — it must have been swept via the user's asset ids.
  if (assetId) expect(await AssetJob.countDocuments({ assetId })).toBe(0);
  // User-scoped connector configs carry urls + encrypted auth headers —
  // secret material at rest — so they must be swept too.
  expect(await Connector.countDocuments({ scope: 'user', userId: uid })).toBe(0);
};

describe('POST /api/profile/factory-reset (issue #143)', () => {
  it('rejects a wrong confirmation string with 400 and touches no data', async () => {
    const { app, userId, cookie } = await registerUser('reset-wrong@example.com');
    await seedUserWorkspace(userId);

    const res = await request(app)
      .post('/api/profile/factory-reset')
      .set('Cookie', cookie)
      .send({ confirm: 'reset' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Type RESET to confirm the factory reset');

    expect(await Session.countDocuments({ userId })).toBe(2);
    expect(await Message.countDocuments()).toBe(4);
    expect(await Asset.countDocuments({ userId })).toBe(1);
  });

  it('rejects a missing/unknown body and unauthenticated calls before any wipe', async () => {
    const { app, cookie } = await registerUser('reset-guard@example.com');

    const noBody = await request(app)
      .post('/api/profile/factory-reset')
      .set('Cookie', cookie)
      .send({});
    expect(noBody.status).toBe(400);

    const noAuth = await request(app)
      .post('/api/profile/factory-reset')
      .send({ confirm: FACTORY_RESET_CONFIRM });
    expect(noAuth.status).toBe(401);
  });

  it('executes on the exact confirm string: nothing PII-bearing survives; user B untouched', async () => {
    const { app, userId, cookie } = await registerUser('reset-ok@example.com');
    const seeded = await seedUserWorkspace(userId);
    const other = (await registerUser('reset-other@example.com')).userId;
    await seedUserWorkspace(other);

    const preReadIds = await Session.find({ userId }).select('_id').lean();
    const res = await request(app)
      .post('/api/profile/factory-reset')
      .set('Cookie', cookie)
      .send({ confirm: FACTORY_RESET_CONFIRM });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reset: true, failedObjects: [] });

    await expectNothingPIIBearingRemains(
      userId,
      preReadIds.map((s) => s._id),
      seeded.assetId,
    );
    // The account itself and its preferences survive — the user can stay
    // signed in and keep using Tova from a clean state.
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('reset-ok@example.com');

    // Other user: nothing changed.
    expect(await Session.countDocuments({ userId: other })).toBe(2);
    expect(await Asset.countDocuments({ userId: other })).toBe(1);
    // Their AssetJob (no userId on it) must not have been collateral damage.
    expect(await AssetJob.countDocuments()).toBe(1);
  }, 15000);

  it('hard-deletes soft-deleted (unlisted) sessions too', async () => {
    const { app, userId, cookie } = await registerUser('reset-orphan@example.com');
    const orphanId = (await Session.create({ userId, title: 'unlisted', deletedAt: new Date() }))
      ._id;

    const res = await request(app)
      .post('/api/profile/factory-reset')
      .set('Cookie', cookie)
      .send({ confirm: FACTORY_RESET_CONFIRM });
    expect(res.status).toBe(200);

    await expectNothingPIIBearingRemains(userId, [orphanId]);
  });

  it('is idempotent-safe for a user with no data at all', async () => {
    const { app, cookie } = await registerUser('reset-empty@example.com');
    const res = await request(app)
      .post('/api/profile/factory-reset')
      .set('Cookie', cookie)
      .send({ confirm: FACTORY_RESET_CONFIRM });
    expect(res.status).toBe(200);
    expect(res.body.reset).toBe(true);
  });

  it('the zdr toggle no longer purges as a side effect (issue #143)', async () => {
    const { app, userId, cookie } = await registerUser('reset-zdr@example.com');
    await seedUserWorkspace(userId);

    const res = await request(app).patch('/api/profile').set('Cookie', cookie).send({ zdr: true });
    expect(res.status).toBe(200);
    expect(res.body.user.zdr).toBe(true);

    expect(await Session.countDocuments({ userId })).toBe(2);
    expect(await Message.countDocuments()).toBe(4);
    expect(await Asset.countDocuments({ userId })).toBe(1);
  });
});
