import { groqConnector } from '../../main/services/mastraService';
import type { CompletionOptions, NeutralStreamChunk } from '../../main/services/llmTypes';

/* Token usage must survive the neutral LLM boundary: non-streaming `totalUsage ?? usage` normalised, streaming as a single trailing usage chunk, absent/NaN dropped (unknown ≠ 0). */
// @see #224

const mockGenerate = jest.fn();
const mockStream = jest.fn();

jest.mock('@mastra/core/agent', () => ({
  Agent: jest.fn().mockImplementation(() => ({
    generate: (...args: unknown[]) => mockGenerate(...args),
    stream: (...args: unknown[]) => mockStream(...args),
  })),
}));

const options: CompletionOptions = {
  model: 'Qwen/Qwen3.5-397B-A17B',
  messages: [{ role: 'user', content: 'hello' }],
};

const collect = async (stream: AsyncIterable<NeutralStreamChunk>) => {
  const chunks: NeutralStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

describe('mastraService token usage (#224)', () => {
  beforeEach(() => {
    mockGenerate.mockReset().mockResolvedValue({ text: 'ok' });
    mockStream.mockReset();
  });

  it('surfaces totalUsage on the non-streaming completion', async () => {
    mockGenerate.mockResolvedValueOnce({
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      totalUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
    const result = await groqConnector.createCompletion(options);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });

  it('falls back to usage when totalUsage is absent', async () => {
    mockGenerate.mockResolvedValueOnce({
      text: 'ok',
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    });
    const result = await groqConnector.createCompletion(options);
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 5, totalTokens: 9 });
  });

  it('omits usage entirely when the provider reports nothing', async () => {
    mockGenerate.mockResolvedValueOnce({ text: 'ok' });
    const result = await groqConnector.createCompletion(options);
    expect(result).not.toHaveProperty('usage');
  });

  it('drops absent/NaN split fields but keeps the reported ones', async () => {
    mockGenerate.mockResolvedValueOnce({
      text: 'ok',
      totalUsage: { inputTokens: 7, outputTokens: undefined, totalTokens: NaN },
    });
    const result = await groqConnector.createCompletion(options);
    expect(result.usage).toEqual({ inputTokens: 7 });
  });

  it('emits a single trailing usage chunk on the streaming path', async () => {
    mockStream.mockResolvedValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', payload: { text: 'hi' } };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 11, outputTokens: 22, totalTokens: 33 }),
    });
    const chunks = await collect(await groqConnector.createStreamingCompletion(options));
    expect(chunks).toEqual([
      { delta: 'hi' },
      { usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 } },
    ]);
  });

  it('emits no usage chunk when the stream reports nothing', async () => {
    mockStream.mockResolvedValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', payload: { text: 'hi' } };
      })(),
      totalUsage: Promise.resolve(undefined),
    });
    const chunks = await collect(await groqConnector.createStreamingCompletion(options));
    expect(chunks).toEqual([{ delta: 'hi' }]);
  });
});
