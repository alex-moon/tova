import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../index';
import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { UserSettings, User } from '../models/User';
import { Asset } from '../models/Asset';

const mockAgentStream = jest.fn();
const mockPlainGenerate = jest.fn();
const mockDeleteObject = jest.fn();

jest.mock('../services/inferenceService', () => ({
  inferenceService: {
    createCompletion: (...args: unknown[]) => mockPlainGenerate(...args),
    createToolFreeCompletion: (...args: unknown[]) => mockPlainGenerate(...args),
    createStreamingCompletion: async (opts: unknown) => mockAgentStream(opts),
  },
}));

jest.mock('../services/metricsService', () => ({
  classifyAndPersistPromptDimensions: jest.fn().mockResolvedValue(undefined),
  isTriviallyNeutral: (content: string) => content.trim().length === 0,
}));

jest.mock('../services/followupService', () => ({
  generateFollowups: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/storageService', () => ({
  ...jest.requireActual('../services/storageService'),
  isStorageConfigured: jest.fn().mockReturnValue(true),
  presignPutUrl: jest.fn().mockResolvedValue('https://spaces.example/put'),
  headObject: jest.fn().mockResolvedValue({ size: 12, contentType: 'text/csv' }),
  getObjectBuffer: jest.fn().mockResolvedValue(Buffer.from('NAME,AGE')),
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
}));

const MOCK_ROUTING = { model: 'mock-small-model', provider: 'deepinfra', reason: 'roster-pick' };

// #233: routing runs through the fixed-roster racing path. Drive it with
// `mockRacingState`; the mock delegates back through the (mocked)
// `inferenceService` so the existing completion/stream mocks stay the seam.
const mockRacingState: {
  routing: typeof MOCK_ROUTING | null;
  error?: unknown;
} = { routing: MOCK_ROUTING };

jest.mock('../services/racingService', () => {
  const { inferenceService } = jest.requireMock('../services/inferenceService');
  const failIfSet = () => {
    if (mockRacingState.error) throw mockRacingState.error;
  };
  return {
    pickRosterRoute: async () => {
      failIfSet();
      return mockRacingState.routing;
    },
    routeAndComplete: async (opts: Record<string, unknown>) => {
      failIfSet();
      const routing = mockRacingState.routing;
      const completion = await inferenceService.createCompletion({
        ...opts,
        model: routing?.model,
        provider: routing?.provider,
      });
      return { routing, outcome: { result: { completion } } };
    },
    routeAndStream: async (opts: Record<string, unknown>) => {
      failIfSet();
      const routing = mockRacingState.routing;
      const stream = await inferenceService.createStreamingCompletion({
        ...opts,
        model: routing?.model,
        provider: routing?.provider,
      });
      return { routing, outcome: { result: { stream } } };
    },
  };
});

jest.mock('../services/titleService', () => ({
  generateChatTitle: jest.fn().mockResolvedValue('Hello'),
}));

// #238: stub the enrichment aux call so it does not occupy the mocked
// inference-call slots the route tests inspect.
jest.mock('../services/enrichmentService', () => ({
  enrichmentVotes: jest.fn().mockResolvedValue({ files: false, workspace: false }),
  libraryIndexFor: jest.fn().mockResolvedValue(''),
  isEnrichmentEnabled: () => false,
}));

const fullStreamFrom = (chunks: string[]) =>
  (async function* () {
    for (const chunk of chunks) {
      yield { delta: chunk };
    }
  })();

const app = createApp();

const registerUser = async (email: string): Promise<string[]> => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  await User.updateOne({ email }, { permissions: ['routing'] });
  const cookies = response.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies : [cookies];
};

// The "incognito by default" profile option (issue #144) reuses the settings.zdr
// slot; at rest the flag is bridged per the ticket's decide-once semantics.
const setIncognitoByDefault = async (email: string) => {
  const doc = await User.findOne({ email });
  if (!doc) throw new Error('user not found');
  doc.settings = {
    customInstructions: null,
    zdr: true,
  } as UserSettings;
  await doc.save();
};

const streamMessage = (cookie: string[], body: Record<string, unknown>) =>
  request(app).post('/api/chat/stream').set('Cookie', cookie).send(body);

const plainMessage = (cookie: string[], body: Record<string, unknown>) =>
  request(app).post('/api/chat').set('Cookie', cookie).send(body);

const eventsFrom = (text: string) =>
  text
    .split('\n\n')
    .filter((part) => part.trim().length > 0)
    .map((part) => {
      const eventLine = part.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
      return {
        event: eventLine?.slice(7),
        data: dataLine ? JSON.parse(dataLine.slice(6)) : undefined,
      };
    });

describe('Per-chat incognito flag (issue #144)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentStream.mockImplementation(async () => fullStreamFrom(['Ephemeral answer']));
    mockPlainGenerate.mockReturnValue(
      Promise.resolve({ choices: [{ message: { content: 'Ephemeral answer' } }] }),
    );
    mockRacingState.routing = MOCK_ROUTING;
    mockRacingState.error = undefined;
    mockDeleteObject.mockResolvedValue(true);
  });

  it('keeps the exact frozen 409 conflict copy unchanged', async () => {
    const email = 'incognito-409-copy@example.com';
    const cookies = await registerUser(email);
    await setIncognitoByDefault(email);

    const response = await streamMessage(cookies, {
      sessionId: new Types.ObjectId().toString(),
      content: 'continue this',
    });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe(
      'Zero-data-retention is on — new turns are never stored, so they cannot continue a saved chat. Start a new chat instead.',
    );
  });

  it('streams a non-incognito user’s toggled-on new chat without persisting anything', async () => {
    const email = 'incognito-toggle-on@example.com';
    const cookies = await registerUser(email);

    const response = await streamMessage(cookies, {
      content: 'remember nothing',
      zdr: true,
      history: [{ role: 'user', content: 'first question' }],
    });

    expect(response.status).toBe(200);
    const events = eventsFrom(response.text);
    const meta = events.find((e) => e.event === 'meta');
    expect(meta?.data.sessionId).toBeUndefined();
    const done = events.find((e) => e.event === 'done');
    expect(done?.data.message.content).toBe('Ephemeral answer');
    expect(await Session.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('serves a non-incognito user’s toggled-on new chat without persisting anything', async () => {
    const email = 'incognito-plain-toggle-on@example.com';
    const cookies = await registerUser(email);

    const response = await plainMessage(cookies, { content: 'remember nothing', zdr: true });

    expect(response.status).toBe(200);
    expect(response.body.message.content).toBe('Ephemeral answer');
    expect(response.body.sessionId).toBeUndefined();
    expect(await Session.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('an incognito-by-default user can opt a new chat back into persistence with zdr: false', async () => {
    const email = 'incognito-off@example.com';
    const cookies = await registerUser(email);
    await setIncognitoByDefault(email);

    const response = await streamMessage(cookies, { content: 'remember this', zdr: false });

    expect(response.status).toBe(200);
    const events = eventsFrom(response.text);
    const meta = events.find((e) => e.event === 'meta');
    const sessionId = meta?.data.sessionId as string;
    expect(sessionId).toBeDefined();
    const session = await Session.findById(sessionId);
    expect(session?.incognito).toBe(false);
    expect(await Message.countDocuments()).toBe(2);
  });

  it('an incognito-by-default user without the body flag starts incognito chats (nothing persisted)', async () => {
    const email = 'incognito-default-on@example.com';
    const cookies = await registerUser(email);
    await setIncognitoByDefault(email);

    const response = await plainMessage(cookies, { content: 'remember nothing' });

    expect(response.status).toBe(200);
    expect(await Session.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('a non-incognito user without the body flag persists the new chat as today', async () => {
    const email = 'incognito-default-off@example.com';
    const cookies = await registerUser(email);

    const response = await plainMessage(cookies, { content: 'remember this' });

    expect(response.status).toBe(200);
    const session = await Session.findOne({});
    expect(session?.incognito).toBe(false);
    expect(await Message.countDocuments()).toBe(2);
  });

  it('a sessionId turn of a non-incognito session persists normally', async () => {
    const email = 'incognito-continue@example.com';
    const cookies = await registerUser(email);
    const first = await plainMessage(cookies, { content: 'first turn' });
    const sessionId = first.body.sessionId as string;

    const response = await plainMessage(cookies, { sessionId, content: 'second turn' });

    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBe(sessionId);
    expect(await Message.countDocuments()).toBe(4);
  });

  it('ignores a toggled-on body intent on a sessionId continuation (both routes persist)', async () => {
    const email = 'incognito-intent-continuation@example.com';
    const cookies = await registerUser(email);
    const first = await plainMessage(cookies, { content: 'first turn' });
    const sessionId = first.body.sessionId as string;

    const plain = await plainMessage(cookies, { sessionId, content: 'toggle on', zdr: true });
    const stream = await streamMessage(cookies, { sessionId, content: 'stream', zdr: true });

    expect(plain.status).toBe(200);
    expect(stream.status).toBe(200);
    expect(plain.body.sessionId).toBe(sessionId);
    expect(await Session.countDocuments()).toBe(1);
    expect(await Message.countDocuments()).toBe(6);
  });

  it('rejects continuation of a stored incognito session on both routes (409)', async () => {
    const email = 'incognito-leftover-session@example.com';
    const cookies = await registerUser(email);
    const user = await User.findOne({ email });
    // No incognito session is ever created by the routes (write-nothing), so
    // construct one directly to pin the stored-flag reject path (e.g. left
    // over from a migration or a future temp-chat shell).
    const session = await Session.create({
      userId: user?._id,
      title: 'leftover',
      incognito: true,
    });

    const plain = await plainMessage(cookies, {
      sessionId: String(session._id),
      content: 'continue',
    });
    const stream = await streamMessage(cookies, {
      sessionId: String(session._id),
      content: 'continue',
    });

    // Frozen #144/#116 copy: pinned by chat.zdr.test.ts, not renamed here.
    expect(plain.status).toBe(409);
    expect(plain.body.message).toContain('Zero-data-retention is on');
    expect(stream.status).toBe(409);
    expect(stream.body.message).toContain('Zero-data-retention is on');
    expect(mockPlainGenerate).not.toHaveBeenCalled();
    expect(mockAgentStream).not.toHaveBeenCalled();
  });

  it('rejects a malformed sessionId with 400 for a non-incognito user', async () => {
    const email = 'incognito-bad-id@example.com';
    const cookies = await registerUser(email);

    const response = await streamMessage(cookies, { sessionId: 'not-an-objectid', content: 'hi' });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Invalid session id');
    expect(mockAgentStream).not.toHaveBeenCalled();
    expect(await Session.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('erases the incidental attachment on the invalid-sessionId exit path', async () => {
    const email = 'incognito-bad-id-asset@example.com';
    const cookies = await registerUser(email);
    const user = await User.findOne({ email });
    const asset = await Asset.create({
      userId: user?._id,
      filename: 'notes.csv',
      key: `${String(user?._id)}/x/notes.csv`,
      contentType: 'text/csv',
      size: 12,
      status: 'ready',
      textExtracted: 'PROJECT,MOOD',
      ephemeral: true,
    });

    const response = await streamMessage(cookies, {
      sessionId: 'not-an-objectid',
      content: 'hi',
      assetId: String(asset._id),
    });

    expect(response.status).toBe(400);
    expect(await Asset.countDocuments({ _id: asset._id })).toBe(0);
    expect(mockDeleteObject).toHaveBeenCalled();
  });

  describe('ephemeral upload tagging follows the per-chat flag', () => {
    const presign = (cookie: string[], body: Record<string, unknown>) =>
      request(app).post('/api/assets/presign').set('Cookie', cookie).send(body);

    const assetDoc = async (id: string) => Asset.findById(id).lean();

    const makeSession = async (email: string, incognito: boolean): Promise<string> => {
      const doc = await User.findOne({ email });
      if (!doc) throw new Error('user not found');
      const session = await Session.create({
        userId: doc._id,
        title: 'chat',
        incognito,
        messages: [],
      });
      return String(session._id);
    };

    it('marks chat-scope uploads ephemeral for a toggled-on new chat (intent only)', async () => {
      const email = 'incognito-asset-intent@example.com';
      const cookies = await registerUser(email);

      const created = await presign(cookies, {
        filename: 'chat.csv',
        contentType: 'text/csv',
        size: 10,
        scope: 'chat',
        zdr: true,
      });
      expect(created.status).toBe(201);
      expect((await assetDoc(created.body.asset.id))?.ephemeral).toBe(true);
    });

    it('never marks chat-scope uploads ephemeral when the composer is off (opt-in false)', async () => {
      const email = 'incognito-asset-optout@example.com';
      const cookies = await registerUser(email);

      const created = await presign(cookies, {
        filename: 'chat.csv',
        contentType: 'text/csv',
        size: 10,
        scope: 'chat',
        zdr: false,
      });
      expect(created.status).toBe(201);
      expect((await assetDoc(created.body.asset.id))?.ephemeral).toBe(false);
    });

    it('marks chat-scope uploads ephemeral for an incognito-by-default user (no intent)', async () => {
      const email = 'incognito-asset-default@example.com';
      const cookies = await registerUser(email);
      await setIncognitoByDefault(email);

      const created = await presign(cookies, {
        filename: 'chat.csv',
        contentType: 'text/csv',
        size: 10,
        scope: 'chat',
      });
      expect(created.status).toBe(201);
      expect((await assetDoc(created.body.asset.id))?.ephemeral).toBe(true);
    });

    it('decides off the stored session flag when chatId is present (session wins over intent)', async () => {
      const email = 'incognito-asset-chatid@example.com';
      const cookies = await registerUser(email);
      const incognitoChat = await makeSession(email, true);
      const plainChat = await makeSession(email, false);

      const ephemeralCreated = await presign(cookies, {
        filename: 'a.csv',
        contentType: 'text/csv',
        size: 10,
        scope: 'chat',
        chatId: incognitoChat,
      });
      expect(ephemeralCreated.status).toBe(201);
      expect((await assetDoc(ephemeralCreated.body.asset.id))?.ephemeral).toBe(true);

      const durableCreated = await presign(cookies, {
        filename: 'b.csv',
        contentType: 'text/csv',
        size: 10,
        scope: 'chat',
        chatId: plainChat,
        zdr: true,
      });
      expect(durableCreated.status).toBe(201);
      expect((await assetDoc(durableCreated.body.asset.id))?.ephemeral).toBe(false);
    });

    it('never sets ephemeral for an Assets-page upload even with a toggled-on chat', async () => {
      const email = 'incognito-asset-library@example.com';
      const cookies = await registerUser(email);

      const created = await presign(cookies, {
        filename: 'library.csv',
        contentType: 'text/csv',
        size: 10,
        zdr: true,
      });
      expect(created.status).toBe(201);
      expect((await assetDoc(created.body.asset.id))?.ephemeral).toBe(false);
    });

    it('rejects a chatId that belongs to another user', async () => {
      const ownerEmail = 'incognito-asset-owner@example.com';
      await registerUser(ownerEmail);
      const incognitoChat = await makeSession(ownerEmail, true);

      const otherEmail = 'incognito-asset-foreign@example.com';
      const otherCookies = await registerUser(otherEmail);

      const created = await presign(otherCookies, {
        filename: 'chat.csv',
        contentType: 'text/csv',
        size: 10,
        scope: 'chat',
        chatId: incognitoChat,
      });
      expect(created.status).toBe(404);
    });

    it('rejects a malformed chatId with 400', async () => {
      const email = 'incognito-asset-badid@example.com';
      const cookies = await registerUser(email);

      const created = await presign(cookies, {
        filename: 'chat.csv',
        contentType: 'text/csv',
        size: 10,
        scope: 'chat',
        chatId: 'not-an-objectid',
      });
      expect(created.status).toBe(400);
    });
  });
});
