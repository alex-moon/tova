import request from 'supertest';
import { User } from '../models/User';
import { createApp } from '../index';
import { muteConsoleError } from '../test/muteConsole';

/*
 * Plan-138 task 9 failure-mode sweep, part (b): with injection enabled but
 * Mongo unreachable, the chat turn must still serve — the knowledge block
 * degrades to empty (never a throw), and the answer is not graph-flavoured.
 * The in-memory Mongo is up; the Entity read is stubbed to reject, which is
 * exactly the error wrapper's contract.
 */

const mockEntityFind = jest.fn();

jest.mock('../services/entityRetrievalService', () => ({
  isEntityInjectionEnabled: () => Boolean(process.env.ENTITY_GRAPH_PROMPT_INJECTION),
  retrieveKnowledgeBlock: (...args: unknown[]) => mockEntityFind(...args),
}));

const mockAgentStream = jest.fn();

jest.mock('../services/inferenceService', () => ({
  inferenceService: {
    createCompletion: (...args: unknown[]) => mockAgentStream(...args),
    createToolFreeCompletion: (...args: unknown[]) => mockAgentStream(...args),
    createStreamingCompletion: async (opts: unknown) => (mockAgentStream(opts) as unknown) || opts,
  },
}));

jest.mock('../services/metricsService', () => ({
  classifyAndPersistPromptDimensions: jest.fn().mockResolvedValue(undefined),
  isTriviallyNeutral: (content: string) => content.trim().length === 0,
}));

jest.mock('../services/followupService', () => ({
  generateFollowups: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/routerService', () => ({
  routeQuery: jest.fn().mockResolvedValue({ model: 'mock-small-model', reason: 't' }),
}));

jest.mock('../services/titleService', () => ({
  generateChatTitle: jest.fn().mockResolvedValue('Hello'),
}));

const app = createApp();

describe('knowledge block degrades to empty when Mongo is unreachable (plan-138 task 9)', () => {
  afterEach(() => {
    delete process.env.ENTITY_GRAPH_PROMPT_INJECTION;
  });

  it('serves a plain chat turn with no block and no error when the Entity read fails', async () => {
    const register = await request(app)
      .post('/api/auth/register')
      .send({ email: 'graphdown@example.com', password: 'password123' });
    const cookies = register.headers['set-cookie'];
    const cookie = Array.isArray(cookies) ? cookies : [cookies];
    await User.updateOne({ email: 'graphdown@example.com' }, { permissions: ['routing'] });

    mockEntityFind.mockRejectedValueOnce(new Error('mongod down'));
    mockAgentStream.mockResolvedValue({
      choices: [{ message: { content: 'Plain answer regardless' } }],
    });
    process.env.ENTITY_GRAPH_PROMPT_INJECTION = 'on';

    const mute = muteConsoleError();
    try {
      const response = await request(app)
        .post('/api/chat')
        .set('Cookie', cookie)
        .send({ content: 'restaurants near taj hotel' });

      expect(response.status).toBe(200);
      const system = mockAgentStream.mock.calls[0][0].messages.find(
        (m: { role: string }) => m.role === 'system',
      );
      expect(system.content).not.toContain('user:knowledge_graph');
      expect(system.content).not.toContain('Taj Hotel');
    } finally {
      mute.mockRestore();
      jest.restoreAllMocks();
    }
  });
});
