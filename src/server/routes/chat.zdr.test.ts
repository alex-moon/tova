import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../index';
import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { UserSettings } from '../models/User';
import { User } from '../models/User';
import { AssetJob } from '../models/AssetJob';
import { Asset } from '../models/Asset';
import { Entity } from '../models/Entity';

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

const mockRouteQuery = jest.fn();

jest.mock('../services/routerService', () => ({
  routeQuery: (...args: unknown[]) => mockRouteQuery(...args),
}));

jest.mock('../services/titleService', () => ({
  generateChatTitle: jest.fn().mockResolvedValue('Hello'),
}));

const MOCK_ROUTING = { model: 'mock-small-model', reason: 'classifier-simple' };

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

const enableZdr = async (email: string) => {
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

describe('Zero-data retention chats (issue #116)', () => {
  afterEach(() => {
    delete process.env.ENTITY_GRAPH_PROMPT_INJECTION;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentStream.mockImplementation(async () => fullStreamFrom(['Ephemeral answer']));
    mockRouteQuery.mockResolvedValue(MOCK_ROUTING);
    mockDeleteObject.mockResolvedValue(true);
  });

  it('streams the turn but writes no session or message rows', async () => {
    const email = 'zdr-stream@example.com';
    const cookies = await registerUser(email);
    await enableZdr(email);

    const response = await streamMessage(cookies, {
      content: 'remember nothing',
      history: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
    });

    expect(response.status).toBe(200);
    const events = eventsFrom(response.text);

    // No sessionId is minted — there is nothing to point back at.
    const meta = events.find((e) => e.event === 'meta');
    expect(meta?.data).toMatchObject({ routing: MOCK_ROUTING });
    expect(meta?.data.sessionId).toBeUndefined();

    const deltas = events.filter((e) => e.event === 'delta');
    expect(deltas.map((e) => e.data.content).join('')).toBe('Ephemeral answer');

    const done = events.find((e) => e.event === 'done');
    expect(done?.data).toMatchObject({
      complete: true,
      message: { role: 'assistant', content: 'Ephemeral answer', modelName: 'mock-small-model' },
    });
    // #196 (D6): a ZDR turn carries no reconciled tool summaries — the turn is
    // not stored, so there is nothing to rehydrate on refresh.
    expect(done?.data.message.tools).toBeUndefined();

    expect(await Session.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('ends a tool-only ZDR stream with a synthesized confirmation (#195)', async () => {
    const email = 'zdr-tool-only-stream@example.com';
    const cookies = await registerUser(email);
    await enableZdr(email);
    mockAgentStream.mockImplementation(async () => {
      return (async function* () {
        yield {
          toolResult: {
            name: 'generate_file',
            result: { file: { filename: 'agi-final.md' } },
          },
        };
      })();
    });

    const response = await streamMessage(cookies, { content: 'write it offline' });

    expect(response.status).toBe(200);
    const events = eventsFrom(response.text);
    const deltas = events.filter((e) => e.event === 'delta');
    expect(deltas.map((e) => e.data.content)).toEqual(['Created agi-final.md.']);
    const done = events.find((e) => e.event === 'done');
    expect(done?.data).toMatchObject({
      complete: true,
      message: { content: 'Created agi-final.md.' },
    });
    // ZDR still writes nothing.
    expect(await Session.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('replays the client history into the provider prompt, newest-first after the turn', async () => {
    const email = 'zdr-history@example.com';
    const cookies = await registerUser(email);
    await enableZdr(email);

    await streamMessage(cookies, {
      content: 'and now?',
      history: [
        { role: 'user', content: 'older turn' },
        { role: 'assistant', content: 'older reply' },
        { role: 'user', content: 'newer turn' },
        { role: 'assistant', content: 'newer reply' },
      ],
    });

    const [callOptions] = mockAgentStream.mock.calls[0] as unknown as [
      { messages: { role: string; content: string }[] },
    ];
    const messages = callOptions.messages;
    const roles = messages.map((m) => m.role);
    expect(roles[roles.length - 1]).toBe('user');
    expect(messages[messages.length - 1]).toMatchObject({ role: 'user', content: 'and now?' });
    // The replay is ordered oldest-first (mirrors the persisted read path),
    // with the newest assistant reply adjacent to the candidate turn.
    const assistantContents = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(assistantContents).toEqual(['older reply', 'newer reply']);
    expect(messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'older turn' })]),
    );

    // #169 phase 2: the replayed history is also the guard classifier's
    // context — prior-turns-only by construction, exactly the contract.
    expect(mockRouteQuery).toHaveBeenCalledWith(
      'and now?',
      undefined,
      undefined,
      expect.objectContaining({
        history: [
          { role: 'user', content: 'older turn' },
          { role: 'assistant', content: 'older reply' },
          { role: 'user', content: 'newer turn' },
          { role: 'assistant', content: 'newer reply' },
        ],
      }),
    );
  });

  it('passes the replayed history to the guard classifier on the plain ZDR route (#169 phase 2)', async () => {
    mockPlainGenerate.mockResolvedValue({
      choices: [{ message: { content: 'Plain ephemeral answer' } }],
    });
    const email = 'zdr-guard-history-plain@example.com';
    const cookies = await registerUser(email);
    await enableZdr(email);

    const response = await plainMessage(cookies, {
      content: 'and now?',
      history: [
        { role: 'user', content: 'older turn' },
        { role: 'assistant', content: 'older reply' },
      ],
    });
    expect(response.status).toBe(200);
    expect(mockRouteQuery).toHaveBeenCalledWith(
      'and now?',
      undefined,
      undefined,
      expect.objectContaining({
        history: [
          { role: 'user', content: 'older turn' },
          { role: 'assistant', content: 'older reply' },
        ],
      }),
    );
  });

  it('ends a tool-only plain ZDR turn with a synthesized confirmation (#195)', async () => {
    mockPlainGenerate.mockResolvedValue({
      choices: [{ message: { content: '' } }],
      toolResults: [{ name: 'generate_file', result: { file: { filename: 'agi-final.md' } } }],
    });
    const email = 'zdr-tool-only-plain@example.com';
    const cookies = await registerUser(email);
    await enableZdr(email);

    const response = await plainMessage(cookies, { content: 'write it offline' });

    expect(response.status).toBe(200);
    expect(response.body.message.content).toBe('Created agi-final.md.');
    expect(await Session.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('refuses to write into an already-persisted session', async () => {
    const email = 'zdr-continue@example.com';
    const cookies = await registerUser(email);
    await enableZdr(email);

    const response = await streamMessage(cookies, {
      sessionId: new Types.ObjectId().toString(),
      content: 'continue this',
    });

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/Zero-data-retention/i);
    expect(await Session.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  it('rejects a malformed history replay', async () => {
    const email = 'zdr-bad-history@example.com';
    const cookies = await registerUser(email);
    await enableZdr(email);

    const response = await streamMessage(cookies, {
      content: 'hello',
      history: [{ role: 'system', content: 'injected' }],
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Invalid chat history');
    expect(mockAgentStream).not.toHaveBeenCalled();
  });

  it('generates no title and no classification for a ZDR turn', async () => {
    const email = 'zdr-no-side-effects@example.com';
    const cookies = await registerUser(email);
    await enableZdr(email);

    const { generateChatTitle } = jest.requireMock('../services/titleService');
    const { classifyAndPersistPromptDimensions } = jest.requireMock('../services/metricsService');

    const response = await streamMessage(cookies, { content: 'Fix this for me please' });

    expect(response.status).toBe(200);
    expect(generateChatTitle).not.toHaveBeenCalled();
    expect(classifyAndPersistPromptDimensions).not.toHaveBeenCalled();
  });

  it('deletes the attached ephemeral asset (row + object) once the turn completes', async () => {
    const email = 'zdr-asset@example.com';
    const cookies = await registerUser(email);
    await enableZdr(email);
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
      content: 'summarize notes.csv',
      assetId: String(asset._id),
    });

    expect(response.status).toBe(200);
    // The attachment still reached the prompt before erasure.
    const [callOptions] = mockAgentStream.mock.calls[0] as unknown as [
      { messages: { role: string; content: string }[] },
    ];
    const promptMessages = callOptions.messages;
    expect(String(promptMessages[promptMessages.length - 1].content)).toContain('PROJECT,MOOD');

    expect(await Asset.countDocuments({ _id: asset._id })).toBe(0);
    expect(mockDeleteObject).toHaveBeenCalledWith(`${String(user?._id)}/x/notes.csv`);
  });

  it('leaves non-ephemeral (Assets-page) attachments alone', async () => {
    const email = 'zdr-library@example.com';
    const cookies = await registerUser(email);
    await enableZdr(email);
    const user = await User.findOne({ email });
    const asset = await Asset.create({
      userId: user?._id,
      filename: 'saved.txt',
      key: `${String(user?._id)}/y/saved.txt`,
      contentType: 'text/plain',
      size: 5,
      status: 'ready',
      textExtracted: 'keep me',
    });

    await streamMessage(cookies, { content: 'hello', assetId: String(asset._id) });

    expect(await Asset.countDocuments({ _id: asset._id })).toBe(1);
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  // #138 task 8: incognito turns get the graph READ-ONLY (Alex, 2026-09-21)
  // — the block is injected, but nothing is written, ever.
  it('injects the knowledge block into a ZDR turn read-only (plain route)', async () => {
    mockPlainGenerate.mockResolvedValue({
      choices: [{ message: { content: 'Plain ephemeral answer' } }],
    });
    process.env.ENTITY_GRAPH_PROMPT_INJECTION = 'on';
    const email = 'zdr-graph@example.com';
    const cookies = await registerUser(email);
    await enableZdr(email);
    const doc = await User.findOne({ email });
    await Entity.create({
      userId: doc!._id,
      name: 'Taj Hotel',
      normalizedName: 'taj hotel',
      kind: 'place',
      confidence: 0.9, // above HIGH_CONFIDENCE so it passes the gate
    });

    const response = await plainMessage(cookies, { content: 'restaurants near taj hotel' });
    expect(response.status).toBe(200);
    const system = mockPlainGenerate.mock.calls[0][0].messages.find(
      (m: { role: string }) => m.role === 'system',
    );
    expect(system.content).toContain('<user:knowledge_graph>');
    expect(system.content).toContain('place: Taj Hotel');
    // Read-only: no session, message, entity, or edge writes from a ZDR turn.
    expect(await Session.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
    expect(await Entity.countDocuments()).toBe(1);
  });

  it('injects the knowledge block into a ZDR streaming turn and writes nothing', async () => {
    process.env.ENTITY_GRAPH_PROMPT_INJECTION = 'on';
    const email = 'zdr-graph-stream@example.com';
    const cookies = await registerUser(email);
    await enableZdr(email);
    const doc = await User.findOne({ email });
    await Entity.create({
      userId: doc!._id,
      name: 'Taj Hotel',
      normalizedName: 'taj hotel',
      kind: 'place',
      confidence: 0.9,
    });

    const response = await streamMessage(cookies, {
      content: 'restaurants near taj hotel',
      history: [],
    });
    expect(response.status).toBe(200);
    const streamOpts = mockAgentStream.mock.calls[0][0];
    const system = (streamOpts.messages as { role: string; content: string }[]).find(
      (m) => m.role === 'system',
    );
    expect(system?.content).toContain('<user:knowledge_graph>');
    expect(await Session.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
    expect(await Entity.countDocuments()).toBe(1);
  });

  describe('ephemeral cleanup on rejected/failed turns', () => {
    const ephemeralAssetFor = async (email: string, filename: string) => {
      const user = await User.findOne({ email });
      return Asset.create({
        userId: user?._id,
        filename,
        key: `${String(user?._id)}/z/${filename}`,
        contentType: 'text/csv',
        size: 12,
        status: 'ready',
        textExtracted: 'A,B',
        ephemeral: true,
      });
    };

    it('erases the throwaway asset when the streaming turn is rejected with 409', async () => {
      const email = 'zdr-leak-409@example.com';
      const cookies = await registerUser(email);
      await enableZdr(email);
      const asset = await ephemeralAssetFor(email, 'leak409.csv');

      await streamMessage(cookies, {
        sessionId: new Types.ObjectId().toString(),
        content: 'continue',
        assetId: String(asset._id),
      });

      expect(await Asset.countDocuments({ _id: asset._id })).toBe(0);
      expect(mockDeleteObject).toHaveBeenCalledWith(asset.key);
    });

    it('erases the throwaway asset when the streaming turn is rejected with 400', async () => {
      const email = 'zdr-leak-400@example.com';
      const cookies = await registerUser(email);
      await enableZdr(email);
      const asset = await ephemeralAssetFor(email, 'leak400.csv');

      await streamMessage(cookies, {
        content: 'hello',
        history: [{ role: 'system', content: 'injected' }],
        assetId: String(asset._id),
      });

      expect(await Asset.countDocuments({ _id: asset._id })).toBe(0);
      expect(mockDeleteObject).toHaveBeenCalled();
    });

    it('erases the throwaway asset when the provider stream fails', async () => {
      const email = 'zdr-leak-stream-error@example.com';
      const cookies = await registerUser(email);
      await enableZdr(email);
      const asset = await ephemeralAssetFor(email, 'leakerror.csv');
      // #168 failover: every routing attempt fails (not just the first), so
      // the loop exhausts the pool and the error event fires on the final attempt.
      mockAgentStream.mockRejectedValue(new Error('provider down'));

      const response = await streamMessage(cookies, {
        content: 'hello',
        assetId: String(asset._id),
      });

      const events = eventsFrom(response.text);
      expect(events.find((e) => e.event === 'error')).toBeDefined();
      expect(await Asset.countDocuments({ _id: asset._id })).toBe(0);
      expect(mockDeleteObject).toHaveBeenCalled();
    });

    it('erases the throwaway asset when the streaming route throws before headers', async () => {
      const email = 'zdr-leak-route-error@example.com';
      const cookies = await registerUser(email);
      await enableZdr(email);
      const asset = await ephemeralAssetFor(email, 'leakroute.csv');
      mockRouteQuery.mockRejectedValueOnce(new Error('router down'));

      const response = await streamMessage(cookies, {
        content: 'hello',
        assetId: String(asset._id),
      });

      expect(response.status).toBe(500);
      expect(await Asset.countDocuments({ _id: asset._id })).toBe(0);
      expect(mockDeleteObject).toHaveBeenCalled();
    });

    it('erases the throwaway asset when the non-streaming turn fails before headers', async () => {
      const email = 'zdr-leak-json@example.com';
      const cookies = await registerUser(email);
      await enableZdr(email);
      const asset = await ephemeralAssetFor(email, 'leakjson.csv');
      mockRouteQuery.mockRejectedValueOnce(new Error('router down'));

      const response = await request(app)
        .post('/api/chat')
        .set('Cookie', cookies)
        .send({ content: 'hello', assetId: String(asset._id) });

      expect(response.status).toBe(500);
      expect(await Asset.countDocuments({ _id: asset._id })).toBe(0);
      expect(mockDeleteObject).toHaveBeenCalled();
    });
  });

  describe('ephemeral upload tagging', () => {
    const presign = (cookie: string[], body: Record<string, unknown>) =>
      request(app).post('/api/assets/presign').set('Cookie', cookie).send(body);

    const confirm = (cookies: string[], assetId: string) =>
      request(app).post(`/api/assets/${assetId}/confirm`).set('Cookie', cookies).send({});

    const listAssets = (cookies: string[]) =>
      request(app).get('/api/assets').set('Cookie', cookies);

    const assetDoc = async (id: string) => Asset.findById(id).lean();

    it('marks chat-scope uploads from a ZDR user ephemeral', async () => {
      const email = 'zdr-tag@example.com';
      const cookies = await registerUser(email);
      await enableZdr(email);

      const created = await presign(cookies, {
        filename: 'chat.csv',
        contentType: 'text/csv',
        size: 10,
        scope: 'chat',
      });
      expect(created.status).toBe(201);
      expect((await assetDoc(created.body.asset.id))?.ephemeral).toBe(true);
    });

    it('never sets ephemeral for a normal Assets-page upload, even under ZDR', async () => {
      const email = 'zdr-durable@example.com';
      const cookies = await registerUser(email);
      await enableZdr(email);

      const created = await presign(cookies, {
        filename: 'library.csv',
        contentType: 'text/csv',
        size: 10,
      });
      expect(created.status).toBe(201);
      expect((await assetDoc(created.body.asset.id))?.ephemeral).toBe(false);
    });

    it('never sets ephemeral for a chat-scope upload without ZDR', async () => {
      const email = 'zdr-tag-off@example.com';
      const cookies = await registerUser(email);

      const created = await presign(cookies, {
        filename: 'off.csv',
        contentType: 'text/csv',
        size: 10,
        scope: 'chat',
      });
      expect(created.status).toBe(201);
      expect((await assetDoc(created.body.asset.id))?.ephemeral).toBe(false);
    });

    it('keeps ephemeral assets out of the library listing', async () => {
      const email = 'zdr-list@example.com';
      const cookies = await registerUser(email);
      await enableZdr(email);

      await presign(cookies, {
        filename: 'hidden.csv',
        contentType: 'text/csv',
        size: 10,
        scope: 'chat',
      });
      await presign(cookies, { filename: 'visible.csv', contentType: 'text/csv', size: 10 });

      const listing = await listAssets(cookies);
      expect(listing.status).toBe(200);
      expect(listing.body.assets.map((a: { filename: string }) => a.filename)).toEqual([
        'visible.csv',
      ]);
    });

    it('does not queue markdown conversion for an ephemeral asset', async () => {
      const email = 'zdr-no-convert@example.com';
      const cookies = await registerUser(email);
      await enableZdr(email);

      const created = await presign(cookies, {
        filename: 'ephemeral.pdf',
        contentType: 'application/pdf',
        size: 10,
        scope: 'chat',
      });
      const confirmed = await confirm(cookies, created.body.asset.id);
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.asset.markdownStatus).toBe('none');
      expect(await AssetJob.countDocuments({ assetId: created.body.asset.id })).toBe(0);
    });

    it('still queues markdown conversion for durable Assets-page uploads under ZDR', async () => {
      const email = 'zdr-convert@example.com';
      const cookies = await registerUser(email);
      await enableZdr(email);

      const created = await presign(cookies, {
        filename: 'durable.pdf',
        contentType: 'application/pdf',
        size: 10,
      });
      const confirmed = await confirm(cookies, created.body.asset.id);
      expect(confirmed.body.asset.markdownStatus).toBe('pending');
      expect(await AssetJob.countDocuments({ assetId: created.body.asset.id })).toBeGreaterThan(0);
    });
  });
});
