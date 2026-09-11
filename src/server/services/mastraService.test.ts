import { groqConnector, deepinfraConnector } from './mastraService';

/*
 * Tests the Mastra→neutral mapping boundary directly. All transport is
 * mocked at the `@mastra/core` module level: the mocked `Agent` returns
 * AI-SDK-style shapes (generate → `{ text }`, stream →
 * `{ fullStream }` of typed chunks), while the real connector code in
 * `mastraService` maps them to the neutral types consumed by callers.
 */

const mockGenerate = jest.fn();
const mockStream = jest.fn();

jest.mock('@mastra/core/agent', () => {
  return {
    Agent: jest.fn().mockImplementation(() => ({
      generate: (...args: unknown[]) => mockGenerate(...args),
      stream: (...args: unknown[]) => mockStream(...args),
    })),
  };
});

const agentCtor = jest.requireMock('@mastra/core/agent').Agent as jest.Mock;

describe('Mastra service neutral mapping', () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    mockStream.mockReset();
    agentCtor.mockClear();
  });

  describe('createCompletion (blocking mapping)', () => {
    it('maps generate result text to the neutral shape', async () => {
      mockGenerate.mockResolvedValueOnce({ text: 'hello' });
      const completion = await groqConnector.createCompletion({ model: 'x', messages: [] });
      expect(completion).toEqual({ choices: [{ message: { content: 'hello' } }] });
    });

    it('maps missing text to null content', async () => {
      mockGenerate.mockResolvedValueOnce({});
      const completion = await deepinfraConnector.createCompletion({ model: 'x', messages: [] });
      expect(completion).toEqual({ choices: [{ message: { content: null } }] });
    });

    it('builds an agent aimed at the provider router id', async () => {
      mockGenerate.mockResolvedValueOnce({ text: 'x' });
      await groqConnector.createCompletion({ model: 'm', messages: [] });
      expect(agentCtor.mock.calls[0][0]).toEqual({
        id: 'tova-groq',
        name: 'tova-groq',
        instructions: '',
        model: 'groq/m',
      });
    });

    it('forwards temperature and max_tokens as model settings and caps maxSteps at 1', async () => {
      mockGenerate.mockResolvedValueOnce({ text: 'x' });
      await groqConnector.createCompletion({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        temperature: 0,
        max_tokens: 10,
      });
      expect(mockGenerate).toHaveBeenCalledWith(
        [{ role: 'user', content: 'q' }],
        expect.objectContaining({
          maxSteps: 1,
          modelSettings: { temperature: 0, maxOutputTokens: 10 },
        }),
      );
    });

    it('propagates transport errors to callers', async () => {
      mockGenerate.mockRejectedValueOnce(new Error('boom'));
      await expect(groqConnector.createCompletion({ model: 'x', messages: [] })).rejects.toThrow(
        'boom',
      );
    });
  });

  describe('createStreamingCompletion (delta mapping)', () => {
    const fullStreamFrom = (chunks: unknown[]) =>
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })();

    it('maps text-delta chunks to { delta: <text> } and filters lifecycle chunks', async () => {
      mockStream.mockResolvedValueOnce({
        fullStream: fullStreamFrom([
          { type: 'start' },
          { type: 'step-start' },
          { type: 'text-delta', delta: 'hi' },
          { type: 'text-end' },
          { type: 'step-finish' },
          { type: 'finish' },
        ]),
      });
      const stream = await groqConnector.createStreamingCompletion({ model: 'x', messages: [] });
      const chunks: Array<{ delta?: string | null }> = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks).toEqual([{ delta: 'hi' }]);
    });

    it('maps a malformed text-delta (missing delta) to { delta: null } instead of throwing', async () => {
      mockStream.mockResolvedValueOnce({ fullStream: fullStreamFrom([{ type: 'text-delta' }]) });
      const stream = await deepinfraConnector.createStreamingCompletion({
        model: 'x',
        messages: [],
      });
      const chunks: Array<{ delta?: string | null }> = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks).toEqual([{ delta: null }]);
    });

    it('yields nothing (not an error) for a stream with no content chunks', async () => {
      mockStream.mockResolvedValueOnce({ fullStream: fullStreamFrom([]) });
      const stream = await groqConnector.createStreamingCompletion({ model: 'x', messages: [] });
      const chunks: Array<{ delta?: string | null }> = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks).toEqual([]);
    });

    it('propagates mid-stream transport errors via the async iterator', async () => {
      mockStream.mockResolvedValueOnce({
        fullStream: (async function* () {
          yield { type: 'text-delta', delta: 'a' };
          throw new Error('stream died');
        })(),
      });
      const stream = await groqConnector.createStreamingCompletion({ model: 'x', messages: [] });
      const chunks: Array<{ delta?: string | null }> = [];
      await expect(async () => {
        for await (const chunk of stream) chunks.push(chunk);
      }).rejects.toThrow('stream died');
      expect(chunks).toEqual([{ delta: 'a' }]);
    });

    it('builds an agent aimed at the provider router id for streaming', async () => {
      mockStream.mockResolvedValueOnce({ fullStream: fullStreamFrom([]) });
      await deepinfraConnector.createStreamingCompletion({ model: 'm', messages: [] });
      expect(agentCtor.mock.calls[0][0]).toEqual({
        id: 'tova-deepinfra',
        name: 'tova-deepinfra',
        instructions: '',
        model: 'deepinfra/m',
      });
    });
  });
});
