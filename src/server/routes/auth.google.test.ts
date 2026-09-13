import request from 'supertest';
import { createApp } from '../index';
import { User } from '../models/User';

const fetchMock = jest.fn();

const env = { ...process.env };

beforeAll(() => {
  jest.spyOn(global, 'fetch').mockImplementation(fetchMock);
});

afterAll(() => {
  (global.fetch as unknown as jest.SpyInstance).mockRestore();
  process.env = env;
});

const configureGoogle = () => {
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.GOOGLE_CALLBACK_URL = 'http://localhost:5000/api/auth/google/callback';
};

const loginViaGoogle = async (
  app: ReturnType<typeof createApp>,
  idTokenPayload: Record<string, unknown>,
  userInfo: Record<string, unknown> | { ok: false },
) => {
  const idToken = `header.${Buffer.from(JSON.stringify(idTokenPayload)).toString('base64url')}.sig`;
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ id_token: idToken, access_token: 'access-token' }),
  });
  fetchMock.mockResolvedValueOnce(
    'ok' in userInfo && userInfo.ok === false
      ? { ok: false, status: 500 }
      : { ok: true, json: async () => userInfo },
  );
  return request(app)
    .get('/api/auth/google/callback')
    .query({ code: 'auth-code', state: 'state-123' })
    .set('Cookie', ['google_state=state-123'])
    .redirects(0);
};

describe('Google OAuth', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    configureGoogle();
  });

  it('redirects to Google consent when configured', async () => {
    const app = createApp();
    const res = await request(app).get('/api/auth/google');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('accounts.google.com');
    expect(res.headers.location).toContain('client_id=client-id');
  });

  it('returns 503 when Google is not configured', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const app = createApp();
    const res = await request(app).get('/api/auth/google');
    expect(res.status).toBe(503);
  });

  it('rejects a callback with a mismatched state', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ code: 'auth-code', state: 'other' })
      .set('Cookie', ['google_state=state-123']);
    expect(res.status).toBe(400);
  });

  it('creates a new user with no permissions for an unseen email', async () => {
    const app = createApp();
    const res = await loginViaGoogle(
      app,
      {
        sub: 'google-sub-1',
        email: 'new-user@gmail.com',
        email_verified: true,
      },
      {},
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    const user = await User.findOne({ email: 'new-user@gmail.com' });
    expect(user).toBeTruthy();
    expect(user?.googleId).toBe('google-sub-1');
    expect(user?.permissions).toEqual([]);
  });

  it('resolves an existing email to that user and links the Google identity', async () => {
    const app = createApp();
    const existing = await User.create({
      email: 'existing@gmail.com',
      passwordHash: 'not-a-real-hash',
      permissions: ['routing'],
    });

    const res = await loginViaGoogle(
      app,
      {
        sub: 'google-sub-2',
        email: 'existing@gmail.com',
        email_verified: true,
      },
      {},
    );

    expect(res.status).toBe(302);

    const users = await User.find({ email: 'existing@gmail.com' });
    expect(users).toHaveLength(1);
    expect(users[0].googleId).toBe('google-sub-2');
    expect(users[0].permissions).toEqual(['routing']);
    expect(String(users[0]._id)).toBe(String(existing._id));
  });

  it('rejects unverified Google emails', async () => {
    const app = createApp();
    const res = await loginViaGoogle(
      app,
      {
        sub: 'google-sub-3',
        email: 'unverified@gmail.com',
        email_verified: false,
      },
      {},
    );
    expect(res.status).toBe(401);
    expect(await User.findOne({ email: 'unverified@gmail.com' })).toBeNull();
  });

  it('stores Google-provided name and avatarUrl on first login', async () => {
    const app = createApp();
    const res = await loginViaGoogle(
      app,
      { sub: 'google-sub-4', email: 'profiled@gmail.com', email_verified: true },
      { sub: 'google-sub-4', name: 'Ada Lovelace', picture: 'https://img.example/ada.png' },
    );

    expect(res.status).toBe(302);
    const user = await User.findOne({ email: 'profiled@gmail.com' });
    expect(user?.name).toBe('Ada Lovelace');
    expect(user?.avatarUrl).toBe('https://img.example/ada.png');
  });

  it('overwrites name and avatarUrl from Google on a later login and never touches preferredName', async () => {
    const app = createApp();
    await loginViaGoogle(
      app,
      { sub: 'google-sub-5', email: 'refresh@gmail.com', email_verified: true },
      { sub: 'google-sub-5', name: 'Old Name', picture: 'https://img.example/old.png' },
    );
    const user = await User.findOne({ email: 'refresh@gmail.com' });
    user!.preferredName = 'Ada';
    user!.name = 'User-Edited Name';
    user!.avatarUrl = 'https://img.example/user.png';
    await user!.save();

    fetchMock.mockClear();
    await loginViaGoogle(
      app,
      { sub: 'google-sub-5', email: 'refresh@gmail.com', email_verified: true },
      { sub: 'google-sub-5', name: 'New Name', picture: 'https://img.example/new.png' },
    );

    const refreshed = await User.findOne({ email: 'refresh@gmail.com' });
    expect(refreshed?.name).toBe('New Name');
    expect(refreshed?.avatarUrl).toBe('https://img.example/new.png');
    expect(refreshed?.preferredName).toBe('Ada');
  });

  it('still completes login when the userinfo request fails and stores no profile', async () => {
    const app = createApp();
    const res = await loginViaGoogle(
      app,
      { sub: 'google-sub-6', email: 'noprofile@gmail.com', email_verified: true },
      { ok: false },
    );

    expect(res.status).toBe(302);
    const user = await User.findOne({ email: 'noprofile@gmail.com' });
    expect(user?.googleId).toBe('google-sub-6');
    expect(user?.name).toBeNull();
    expect(user?.avatarUrl).toBeNull();
  });
});
