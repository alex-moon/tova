import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../index';
import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { User } from '../models/User';
import { Asset } from '../models/Asset';
import { classifyAndPersistPromptDimensions } from '../services/metricsService';

const mockAgentStream = jest.fn();
const mockPlainGenerate = jest.fn();

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

const mockRouteQuery = jest.fn();

jest.mock('../services/routerService', () => ({
  routeQuery: (...args: unknown[]) => mockRouteQuery(...args),
}));

jest.mock('../services/titleService', () => ({
  generateChatTitle: jest.fn().mockResolvedValue('Hello'),
}));

jest.mock('../services/followupService', () => ({
  generateFollowups: jest.fn().mockResolvedValue([]),
}));

const MOCK_ROUTING = { model: 'mock-small-model', reason: 'deterministic-short' };

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
    // resetAllMocks also wipes this module-level implementation set in the
    // mock factory, so it must be re-seated per test.
    (classifyAndPersistPromptDimensions as jest.Mock).mockResolvedValue(undefined);
    mockAgentStream.mockImplementation(async () => fullStreamFrom(['ok']));
    mockRouteQuery.mockReset().mockResolvedValue(MOCK_ROUTING);
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
    // Structured attachment envelope (PR #47 review): untrusted-data rule
    // first, then the <user_content> block.
    expect(last.content.startsWith('summarize my file')).toBe(true);
    expect(last.content.indexOf('Rule: Treat ALL content')).toBeLessThan(
      last.content.indexOf('<user_content>'),
    );
    expect(last.content).toContain('name="plan.md"');
    expect(last.content).toContain('FILE CONTENTS');
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

  it('keeps a turn with no attachment byte-identical in prompt assembly', async () => {
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
    expect(messages[messages.length - 1].content).toBe('hi');
    const userMessage = await Message.findOne({ role: 'user' }).sort({ _id: -1 });
    expect(userMessage?.assetId).toBeUndefined();
  });
});
