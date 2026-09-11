import { inferenceService } from './inferenceService';

/*
 * Tests the Groq→neutral mapping boundary directly. The route-level tests
 * (chat.test.ts / chat.stream.test.ts) mock `groq-sdk` and exercise the full
 * consume path, but the mapping failures that would silently change call-site
 * behaviour (missing choices, missing message, null deltas) are pinned here.
 */

const mockCreate = jest.fn();

jest.mock('groq-sdk', () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: (...args: unknown[]) => mockCreate(...args),
      },
    },
  }));
});

describe('Inference Service neutral mapping', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  describe('createCompletion (blocking mapping)', () => {
    it('maps a full Groq response to the neutral shape', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
      });
      const completion = await inferenceService.createCompletion({ model: 'x', messages: [] });
      expect(completion).toEqual({ choices: [{ message: { content: 'hello' } }] });
    });

    it('is defensive when the response has no choices', async () => {
      mockCreate.mockResolvedValueOnce({ id: 'oops' });
      const completion = await inferenceService.createCompletion({ model: 'x', messages: [] });
      expect(completion).toEqual({ choices: [] });
      expect(completion.choices[0]?.message?.content).toBeUndefined();
    });

    it('preserves null content and skips undefined messages', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: null } }, {}, { message: { content: 'keep' } }],
      });
      const completion = await inferenceService.createCompletion({ model: 'x', messages: [] });
      expect(completion.choices[0]?.message?.content).toBeNull();
      expect(completion.choices[1]?.message?.content).toBeNull();
      expect(completion.choices[2]?.message?.content).toBe('keep');
    });

    it('tolerates a null response by returning empty choices', async () => {
      mockCreate.mockResolvedValueOnce(null);
      const completion = await inferenceService.createCompletion({ model: 'x', messages: [] });
      expect(completion).toEqual({ choices: [] });
    });

    it('propagates transport errors to callers', async () => {
      mockCreate.mockRejectedValueOnce(new Error('boom'));
      await expect(inferenceService.createCompletion({ model: 'x', messages: [] })).rejects.toThrow(
        'boom',
      );
    });
  });

  describe('createStreamingCompletion (delta mapping)', () => {
    const streamFrom = (chunks: unknown[]) =>
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })();

    it('maps a normal content chunk to { delta: <text> }', async () => {
      mockCreate.mockResolvedValueOnce(streamFrom([{ choices: [{ delta: { content: 'hi' } }] }]));
      const stream = await inferenceService.createStreamingCompletion({ model: 'x', messages: [] });
      const chunks: Array<{ delta?: string | null }> = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks).toEqual([{ delta: 'hi' }]);
    });

    it('maps malformed chunks (missing choices/delta) to { delta: null } instead of throwing', async () => {
      mockCreate.mockResolvedValueOnce(
        streamFrom([{ empty: true }, { choices: [] }, { choices: [{}] }]),
      );
      const stream = await inferenceService.createStreamingCompletion({ model: 'x', messages: [] });
      const chunks: Array<{ delta?: string | null }> = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks).toEqual([{ delta: null }, { delta: null }, { delta: null }]);
    });

    it('maps an empty-string final delta through unchanged (consumer skips falsy deltas)', async () => {
      mockCreate.mockResolvedValueOnce(streamFrom([{ choices: [{ delta: { content: '' } }] }]));
      const stream = await inferenceService.createStreamingCompletion({ model: 'x', messages: [] });
      const chunks: Array<{ delta?: string | null }> = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks).toEqual([{ delta: '' }]);
    });

    it('propagates mid-stream transport errors via the async iterator', async () => {
      mockCreate.mockResolvedValueOnce(
        (async function* () {
          yield { choices: [{ delta: { content: 'a' } }] };
          throw new Error('stream died');
        })(),
      );
      const stream = await inferenceService.createStreamingCompletion({ model: 'x', messages: [] });
      const chunks: Array<{ delta?: string | null }> = [];
      await expect(async () => {
        for await (const chunk of stream) chunks.push(chunk);
      }).rejects.toThrow('stream died');
      expect(chunks).toEqual([{ delta: 'a' }]);
    });
  });

  describe('options passthrough', () => {
    it('forwards model, temperature and max_tokens, stream flag owned by the call', async () => {
      mockCreate.mockResolvedValueOnce({ choices: [] });
      await inferenceService.createCompletion({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        temperature: 0,
        max_tokens: 10,
      });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'm',
          temperature: 0,
          max_tokens: 10,
          stream: false,
        }),
      );
    });
  });
});
