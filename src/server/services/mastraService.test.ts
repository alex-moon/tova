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

    it('keeps slash-containing model ids intact after the provider prefix', async () => {
      // Env-default ids legitimately contain slashes (e.g. Groq's public id
      // `openai/gpt-oss-20b`); Mastra's router parses on the first slash
      // only, so the rest must pass through unsplit.
      mockGenerate.mockResolvedValueOnce({ text: 'x' });
      await groqConnector.createCompletion({ model: 'openai/gpt-oss-20b', messages: [] });
      const ctorCall = agentCtor.mock.calls[agentCtor.mock.calls.length - 1] as unknown as [
        { model: string },
      ];
      expect((ctorCall?.[0] ?? {}).model).toBe('groq/openai/gpt-oss-20b');
    });

    it('forwards an abort signal into the call options when supplied', async () => {
      mockGenerate.mockResolvedValueOnce({ text: 'x' });
      const controller = new AbortController();
      await groqConnector.createCompletion({
        model: 'm',
        messages: [],
        abortSignal: controller.signal,
      });
      expect(mockGenerate.mock.calls[0][1]).toMatchObject({ abortSignal: controller.signal });
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

    it('omits unset settings from modelSettings instead of forwarding undefined', async () => {
      mockGenerate.mockResolvedValueOnce({ text: 'x' });
      await groqConnector.createCompletion({ model: 'm', messages: [] });
      expect(mockGenerate.mock.calls[0][1]).toEqual({
        maxSteps: 1,
        modelSettings: {},
      });
    });

    it('propagates transport errors to callers', async () => {
      mockGenerate.mockRejectedValueOnce(new Error('boom'));
      await expect(groqConnector.createCompletion({ model: 'x', messages: [] })).rejects.toThrow(
        'boom',
      );
    });

    it('attaches trace tags and metadata to the call options when supplied', async () => {
      mockGenerate.mockResolvedValueOnce({ text: 'x' });
      await groqConnector.createCompletion({
        model: 'm',
        messages: [],
        trace: { sessionId: 's1', tags: ['model:m', 'reason:test'], metadata: { userId: 'u1' } },
      });
      expect(mockGenerate.mock.calls[0][1]).toMatchObject({
        tags: ['model:m', 'reason:test'],
        metadata: { userId: 'u1' },
      });
    });

    it('forwards nothing trace-related when no trace context is supplied', async () => {
      mockGenerate.mockResolvedValueOnce({ text: 'x' });
      await groqConnector.createCompletion({ model: 'm', messages: [] });
      const callOptions = mockGenerate.mock.calls[0][1] as Record<string, unknown>;
      expect('tags' in callOptions).toBe(false);
      expect('metadata' in callOptions).toBe(false);
      expect('tracingOptions' in callOptions).toBe(false);
    });
  });

  /*
   * Chunk shapes mirror what real endpoints produce on `@mastra/core@1.66.0`
   * (verified live 2026-09-12): content nested in `payload`, errors as chunks.
   */

  const deltaChunk = (text: string) => ({ type: 'text-delta', payload: { text } });
  const errorChunk = (message: string) => ({
    type: 'error',
    payload: { error: new Error(message) },
  });

  const fullStreamFrom = (chunks: unknown[]) =>
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })();

  describe('createStreamingCompletion (delta mapping)', () => {
    it('maps text-delta chunks to { delta: <text> } and filters lifecycle chunks', async () => {
      mockStream.mockResolvedValueOnce({
        fullStream: fullStreamFrom([
          { type: 'start' },
          { type: 'step-start' },
          deltaChunk('hi'),
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

    it('maps a malformed text-delta (missing payload text) to { delta: null } instead of throwing', async () => {
      mockStream.mockResolvedValueOnce({
        fullStream: fullStreamFrom([{ type: 'text-delta', payload: {} }]),
      });
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

    it('throws on an error chunk so upstream provider failures fail loudly', async () => {
      mockStream.mockResolvedValueOnce({
        fullStream: fullStreamFrom([
          { type: 'start' },
          errorChunk('The model `x` does not exist'),
          { type: 'finish' },
        ]),
      });
      const stream = await groqConnector.createStreamingCompletion({ model: 'x', messages: [] });
      await expect(async () => {
        for await (const _chunk of stream) {
          /* consume */
        }
      }).rejects.toThrow('The model `x` does not exist');
    });

    it('surfaces an error-chunk message even when payload.error is not an Error', async () => {
      mockStream.mockResolvedValueOnce({
        fullStream: fullStreamFrom([
          { type: 'error', payload: { error: { message: 'plain shape' } } },
        ]),
      });
      const stream = await groqConnector.createStreamingCompletion({ model: 'x', messages: [] });
      await expect(async () => {
        for await (const _chunk of stream) {
          /* consume */
        }
      }).rejects.toThrow('plain shape');
    });

    it('propagates mid-stream transport errors via the async iterator', async () => {
      mockStream.mockResolvedValueOnce({
        fullStream: (async function* () {
          yield deltaChunk('a');
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

    it('forwards an abort signal into the streaming call options when supplied', async () => {
      mockStream.mockResolvedValueOnce({ fullStream: fullStreamFrom([]) });
      const controller = new AbortController();
      await deepinfraConnector.createStreamingCompletion({
        model: 'm',
        messages: [],
        abortSignal: controller.signal,
      });
      expect(mockStream.mock.calls[0][1]).toMatchObject({ abortSignal: controller.signal });
    });
  });
});
