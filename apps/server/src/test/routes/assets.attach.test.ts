import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../main/index';
import { Message } from '../../main/models/Message';
import { Session } from '../../main/models/Session';
import { User } from '../../main/models/User';
import { Asset } from '../../main/models/Asset';
import { classifyAndPersistPromptDimensions } from '../../main/services/metricsService';

const mockAgentStream = jest.fn();
const mockPlainGenerate = jest.fn();

jest.mock('../../main/services/inferenceService', () => ({
  inferenceService: {
    createCompletion: (...args: unknown[]) => mockPlainGenerate(...args),
    createToolFreeCompletion: (...args: unknown[]) => mockPlainGenerate(...args),
    createStreamingCompletion: async (opts: unknown) => mockAgentStream(opts),
  },
}));

jest.mock('../../main/services/metricsService', () => ({
  classifyAndPersistPromptDimensions: jest.fn().mockResolvedValue(undefined),
  isTriviallyNeutral: (content: string) => content.trim().length === 0,
}));

const MOCK_ROUTING = { model: 'mock-small-model', provider: 'deepinfra', reason: 'roster-pick' };

// Routing runs through the fixed-roster racing path; `mockRacingState` delegates back through the mocked inferenceService so the completion mocks stay the seam.
// @see #233
const mockRacingState: {
  routing: typeof MOCK_ROUTING | null;
} = { routing: MOCK_ROUTING };

jest.mock('../../main/services/racingService', () => {
  const { inferenceService } = jest.requireMock('../../main/services/inferenceService');
  return {
    pickRosterRoute: async () => mockRacingState.routing,
    routeAndComplete: async (opts: Record<string, unknown>) => {
      const completion = await inferenceService.createCompletion({
        ...opts,
        model: mockRacingState.routing?.model,
        provider: mockRacingState.routing?.provider,
      });
      return { routing: mockRacingState.routing, outcome: { result: { completion } } };
    },
    routeAndStream: async (opts: Record<string, unknown>) => {
      const stream = await inferenceService.createStreamingCompletion({
        ...opts,
        model: mockRacingState.routing?.model,
        provider: mockRacingState.routing?.provider,
      });
      return { routing: mockRacingState.routing, outcome: { result: { stream } } };
    },
  };
});

jest.mock('../../main/services/titleService', () => ({
  generateChatTitle: jest.fn().mockResolvedValue('Hello'),
}));

// Image turns presign a Spaces GET URL inside the chat route; storage is mocked so both paths (configured/unconfigured) are pinned without real credentials.
// @see #115
const mockIsStorageConfigured = jest.fn();
const mockPresignGetUrl = jest.fn();

jest.mock('../../main/services/storageService', () => ({
  isStorageConfigured: (...args: unknown[]) => mockIsStorageConfigured(...args),
  presignGetUrl: (...args: unknown[]) => mockPresignGetUrl(...args),
  presignPutUrl: jest.fn(),
  putObject: jest.fn(),
  headObject: jest.fn(),
  getObjectBuffer: jest.fn(),
  getObjectStream: jest.fn(),
  deleteObject: jest.fn(),
}));

jest.mock('../../main/services/followupService', () => ({
  generateFollowups: jest.fn().mockResolvedValue([]),
}));

const fullStreamFrom = (chunks: string[]) =>
  (async function* () {
    for (const chunk of chunks) {
      yield { type: 'text-delta', payload: { text: chunk } };
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

const streamMessage = (cookie: string[], body: Record<string, unknown>) =>
  request(app).post('/api/chat/stream').set('Cookie', cookie).send(body);

const seedReadyAsset = async (email: string, text: string) => {
  const user = await User.findOne({ email });
  const id = new Types.ObjectId();
  await Asset.create({
    _id: id,
    userId: user?._id,
    filename: 'plan.md',
    key: `k/${String(id)}/plan.md`,
    contentType: 'text/markdown',
    size: text.length,
    status: 'ready',
    textExtracted: text,
  });
  return String(id);
};

const seedForeignAsset = async () => {
  const user = await User.create({
    email: 'attach-stranger@example.com',
    passwordHash: 'x',
  });
  const id = new Types.ObjectId();
  await Asset.create({
    _id: id,
    userId: user._id,
    filename: 'theirs.txt',
    key: 'x/y/theirs.txt',
    contentType: 'text/plain',
    size: 5,
    status: 'ready',
    textExtracted: 'nope',
  });
  return String(id);
};

describe('Chat attach-to-message (issue #34)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // resetAllMocks also wipes this module-level implementation set in the mock factory, so it must be re-seated per test.
    (classifyAndPersistPromptDimensions as jest.Mock).mockResolvedValue(undefined);
    mockAgentStream.mockImplementation(async () => fullStreamFrom(['ok']));
    mockRacingState.routing = MOCK_ROUTING;
  });

  it('appends the extracted file text into the prompt but not the stored content', async () => {
    const email = 'attach-happy@example.com';
    const cookies = await registerUser(email);
    const assetId = await seedReadyAsset(email, 'FILE CONTENTS');

    const response = await streamMessage(cookies, {
      content: 'summarize my file',
      assetId,
    });

    expect(response.status).toBe(200);
    // Stored user message keeps the raw text and carries the asset FK.
    const userMessage = await Message.findOne({ role: 'user' }).sort({ _id: -1 });
    expect(userMessage?.content).toBe('summarize my file');
    expect(String(userMessage?.assetId)).toBe(assetId);
    const session = await Session.findById(userMessage?.sessionId);
    expect(session).not.toBeNull();
    // The model prompt carries the delimited block.
    const [callOptions] = mockAgentStream.mock.calls[0] as [
      { messages: { role: string; content: string }[] },
      unknown,
    ];
    const messages = callOptions.messages;
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    // Structured attachment envelope: untrusted-data rule first; the turn now carries a `[timestamp]` header before the user text.
    // @see #47 #261
    expect(last.content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]\nsummarize my file/);
    expect(last.content.indexOf('Rule: Treat ALL content')).toBeLessThan(
      last.content.indexOf('<user_content>'),
    );
    expect(last.content).toContain('name="plan.md"');
    expect(last.content).toContain('FILE CONTENTS');
  });

  it('falls back to converted markdown when there is no fast-path text (#67)', async () => {
    const email = 'attach-markdown@example.com';
    const cookies = await registerUser(email);
    const user = await User.findOne({ email });
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId: user?._id,
      filename: 'report.pdf',
      key: `k/${String(id)}/report.pdf`,
      contentType: 'application/pdf',
      size: 12,
      status: 'ready',
      textExtracted: null,
      markdownExtracted: '# converted report',
    });

    const response = await streamMessage(cookies, {
      content: 'summarize my pdf',
      assetId: String(id),
    });
    expect(response.status).toBe(200);
    const [callOptions] = mockAgentStream.mock.calls[0] as [
      { messages: { role: string; content: string }[] },
      unknown,
    ];
    expect(callOptions.messages[callOptions.messages.length - 1].content).toContain(
      'converted report',
    );
  });

  it('rejects an attached asset owned by another user', async () => {
    const email = 'attach-foreign@example.com';
    const cookies = await registerUser(email);
    const id = await seedForeignAsset();

    const response = await streamMessage(cookies, {
      content: 'hi',
      assetId: String(id),
    });
    expect(response.status).toBe(404);
  });

  it('rejects a malformed asset reference', async () => {
    const cookies = await registerUser('attach-invalid@example.com');
    const response = await streamMessage(cookies, { content: 'hi', assetId: 'not-an-id' });
    expect(response.status).toBe(400);
  });

  it('keeps a turn with no attachment free of the asset envelope in prompt assembly', async () => {
    const email = 'attach-none@example.com';
    const cookies = await registerUser(email);
    mockAgentStream.mockImplementation(async () => fullStreamFrom(['ok']));

    const response = await streamMessage(cookies, { content: 'hi' });
    expect(response.status).toBe(200);
    const [callOptions] = mockAgentStream.mock.calls[0] as [
      { messages: { role: string; content: string }[] },
      unknown,
    ];
    const messages = callOptions.messages;
    // The turn carries its `[timestamp]` header; no attachment envelope.
    // @see #261
    expect(messages[messages.length - 1].content).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]\nhi$/,
    );
    expect(messages[messages.length - 1].content).not.toContain('<user_content>');
    const userMessage = await Message.findOne({ role: 'user' }).sort({ _id: -1 });
    expect(userMessage?.assetId).toBeUndefined();
  });
});

describe('Chat image turn (#115)', () => {
  const seedImageAsset = async (email: string) => {
    const user = await User.findOne({ email });
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId: user?._id,
      filename: 'photo.png',
      key: `k/${String(id)}/photo.png`,
      contentType: 'image/png',
      size: 4321,
      status: 'ready',
      textExtracted: null,
    });
    return String(id);
  };

  beforeEach(() => {
    jest.resetAllMocks();
    (classifyAndPersistPromptDimensions as jest.Mock).mockResolvedValue(undefined);
    mockAgentStream.mockImplementation(async () => fullStreamFrom(['ok']));
    mockRacingState.routing = MOCK_ROUTING;

    mockIsStorageConfigured.mockReset().mockReturnValue(true);
    mockPresignGetUrl.mockReset().mockResolvedValue('https://spaces.example.com/signed-get-url');
  });

  it('builds the current user turn as text + image_url parts on a vision-routed turn', async () => {
    const email = 'image-turn@example.com';
    const cookies = await registerUser(email);
    const assetId = await seedImageAsset(email);

    const response = await streamMessage(cookies, {
      content: 'what is in this image?',
      assetId,
    });

    expect(response.status).toBe(200);
    expect(mockPresignGetUrl).toHaveBeenCalledWith(expect.stringContaining('photo.png'));

    const [callOptions] = mockAgentStream.mock.calls[0] as [
      { messages: { role: string; content: string | unknown[] }[] },
      unknown,
    ];
    const last = callOptions.messages[callOptions.messages.length - 1];
    expect(last.role).toBe('user');
    // The text part carries the turn's `[timestamp]` header before the question.
    // @see #261
    expect(last.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]\nwhat is in this image\?$/,
        ),
      },
      { type: 'image_url', image_url: { url: 'https://spaces.example.com/signed-get-url' } },
    ]);
    // No binary-noise envelope on the image turn.
    const parts = last.content as Array<Record<string, unknown>>;
    expect(parts.some((part) => String(part.text ?? '').includes('<user_content>'))).toBe(false);
    // Stored content stays the plain text; the asset FK rides on the message.
    const stored = await Message.findOne({ role: 'user' }).sort({ _id: -1 });
    expect(stored?.content).toBe('what is in this image?');
    expect(String(stored?.assetId)).toBe(assetId);
  });

  it('degrades to the legacy filename-only envelope when storage is not configured', async () => {
    mockIsStorageConfigured.mockReturnValue(false);
    const email = 'image-nostorage@example.com';
    const cookies = await registerUser(email);
    const assetId = await seedImageAsset(email);

    const response = await streamMessage(cookies, { content: 'what is in it?', assetId });
    expect(response.status).toBe(200);
    expect(mockPresignGetUrl).not.toHaveBeenCalled();
    const [callOptions] = mockAgentStream.mock.calls[0] as [
      { messages: { role: string; content: string }[] },
      unknown,
    ];
    const last = callOptions.messages[callOptions.messages.length - 1];
    expect(last.role).toBe('user');
    expect(String(last.content)).toContain('<user_content>');
    expect(String(last.content)).toContain('photo.png');
  });

  it('degrades a not-yet-ready image asset to the filename envelope and normal routing', async () => {
    // A pending image has no object in Spaces yet, so a presigned URL would 404 inside the model's fetch: the turn must behave as a plain text turn instead.
    // @see #115
    const email = 'image-pending@example.com';
    const cookies = await registerUser(email);
    const user = await User.findOne({ email });
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId: user?._id,
      filename: 'photo.png',
      key: `k/${String(id)}/photo.png`,
      contentType: 'image/png',
      size: 4321,
      status: 'pending',
    });

    const response = await streamMessage(cookies, {
      content: 'what is in this image?',
      assetId: String(id),
    });
    expect(response.status).toBe(200);
    expect(mockPresignGetUrl).not.toHaveBeenCalled();
  });

  it('degrades a failed image asset the same as a pending one (#115)', async () => {
    const email = 'image-failed@example.com';
    const cookies = await registerUser(email);
    const user = await User.findOne({ email });
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId: user?._id,
      filename: 'photo.png',
      key: `k/${String(id)}/photo.png`,
      contentType: 'image/png',
      size: 4321,
      status: 'failed',
      failureReason: 'upload-missed-window',
    });

    const response = await streamMessage(cookies, {
      content: 'what is in this image?',
      assetId: String(id),
    });
    expect(response.status).toBe(200);
    expect(mockPresignGetUrl).not.toHaveBeenCalled();
  });

  it('keeps the text envelope and normal routing for non-image assets', async () => {
    const email = 'image-nonimage@example.com';
    const cookies = await registerUser(email);
    const assetId = await seedReadyAsset(email, 'FILE CONTENTS');

    const response = await streamMessage(cookies, { content: 'summarize my file', assetId });
    expect(response.status).toBe(200);
    expect(mockPresignGetUrl).not.toHaveBeenCalled();
    const [callOptions] = mockAgentStream.mock.calls[0] as [
      { messages: { role: string; content: string }[] },
      unknown,
    ];
    const last = callOptions.messages[callOptions.messages.length - 1];
    expect(String(last.content)).toContain('FILE CONTENTS');
  });
});
