import request from 'supertest';
import { createApp } from '../index';
import { User } from '../models/User';
import { Pat } from '../models/Pat';

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

// #184 route-level coverage: PAT CRUD, the bearer middleware on the admin
// guard, one-time plaintext, revocation, live-role inheritance and expiry.
describe('admin pats (#184)', () => {
  it('guards the endpoints like the rest of admin', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'plain-pat@example.com');

    const unauth = await request(app).get('/api/admin/pats');
    expect(unauth.status).toBe(401);

    const forbidden = await request(app).get('/api/admin/pats').set('Cookie', cookie);
    expect(forbidden.status).toBe(403);

    const badBearer = await request(app)
      .get('/api/admin/pats')
      .set('Authorization', 'Bearer nope');
    expect(badBearer.status).toBe(401);
  });

  it('creates a token whose plaintext exists only in the response', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'patmaker@example.com');

    const res = await request(app)
      .post('/api/admin/pats')
      .set('Cookie', cookie)
      .send({ name: 'agent laptop' });
    expect(res.status).toBe(201);
    expect(res.body.pat.name).toBe('agent laptop');
    expect(res.body.pat.token).toMatch(/^tova_pat_[A-Za-z0-9_-]{43}$/);

    // At rest: only the sha256 digest — the plaintext never touches Mongo.
    const doc = await Pat.findOne({});
    expect(doc).not.toBeNull();
    const { createHash } = await import('crypto');
    expect(doc?.tokenHash).toBe(createHash('sha256').update(res.body.pat.token).digest('hex'));
    expect(doc?.name).toBe('agent laptop');
    expect(doc?.lastUsedAt).toBeUndefined();
  });

  it('rejects an empty name', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'patnames@example.com');
    const res = await request(app).post('/api/admin/pats').set('Cookie', cookie).send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Name is required');
  });

  it('authorizes admin routes over Bearer and stamps lastUsedAt', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'beareradmin@example.com');
    const created = await request(app)
      .post('/api/admin/pats')
      .set('Cookie', cookie)
      .send({ name: 'agent' });
    const token: string = created.body.pat.token;

    const users = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`);
    expect(users.status).toBe(200);
    expect(Array.isArray(users.body)).toBe(true);

    const list = await request(app).get('/api/admin/pats').set('Cookie', cookie);
    expect(list.status).toBe(200);
    const listed = list.body.pats[0] as { lastUsedAt: string | null };
    expect(listed.lastUsedAt).not.toBeNull();
  });

  it('lists tokens with creator email and never the token or hash', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'patlister@example.com');
    await request(app).post('/api/admin/pats').set('Cookie', cookie).send({ name: 'one' });

    const res = await request(app).get('/api/admin/pats').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.pats).toHaveLength(1);
    const pat = res.body.pats[0];
    expect(pat.creatorEmail).toBe('patlister@example.com');
    expect(pat.token).toBeUndefined();
    expect(pat.tokenHash).toBeUndefined();
    expect(pat.createdAt).toBeDefined();
    expect(pat.expiresAt).toBeNull();
  });

  it('revokes immediately: the next request with the token 401s', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'revoker@example.com');
    const created = await request(app)
      .post('/api/admin/pats')
      .set('Cookie', cookie)
      .send({ name: 'shortlived' });
    const token: string = created.body.pat.token;
    const id: string = created.body.pat.id;

    const ok = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);

    const revoked = await request(app).delete(`/api/admin/pats/${id}`).set('Cookie', cookie);
    expect(revoked.status).toBe(200);

    const after = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);

    const again = await request(app).delete(`/api/admin/pats/${id}`).set('Cookie', cookie);
    expect(again.status).toBe(404);

    const bogus = await request(app).delete('/api/admin/pats/not-an-id').set('Cookie', cookie);
    expect(bogus.status).toBe(404);
  });

  it('demoting the creator demotes the token (live role lookup)', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'soon-demoted@example.com');
    const created = await request(app)
      .post('/api/admin/pats')
      .set('Cookie', cookie)
      .send({ name: 'inherits-role' });
    const token: string = created.body.pat.token;

    const before = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);

    await User.updateOne({ email: 'soon-demoted@example.com' }, { role: 'user' });

    // Bearer auth succeeds (the token is valid) but requireRole now 403s —
    // the role came from the creator's live document, not the token.
    const after = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(403);
  });

  it('refuses an expired token', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'expiry@example.com');
    const created = await request(app)
      .post('/api/admin/pats')
      .set('Cookie', cookie)
      .send({ name: 'will expire' });
    const token: string = created.body.pat.token;

    await Pat.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 60_000) } });

    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('does not open non-admin routes: Bearer is scoped to the admin guard', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'scoped@example.com');
    const created = await request(app)
      .post('/api/admin/pats')
      .set('Cookie', cookie)
      .send({ name: 'scoped' });
    const token: string = created.body.pat.token;

    // /api/auth/me uses plain authenticate (cookie-only): a PAT grants no
    // session there.
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
