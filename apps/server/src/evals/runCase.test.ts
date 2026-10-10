import { runCase } from './runCase';
import type { EvalCase } from './cases';
import type { NeutralChunkStream, NeutralStreamChunk } from '../services/llmTypes';

const caseFor = (prompt = 'p'): EvalCase => ({
  id: 't',
  prompt,
  description: 'd',
  assertions: [],
});

/* Minimal fake connector: yields the given chunks once. */
const fakeStream = async (chunks: NeutralStreamChunk[]): Promise<NeutralChunkStream> => {
  const copy = [...chunks];
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of copy) yield chunk;
    },
  };
};

describe('runCase (#158 finalText capture)', () => {
  it('accumulates chunk.delta in order into finalText', async () => {
    const { run } = await runCase(
      async () =>
        fakeStream([
          { delta: 'I found ' },
          { toolCall: { name: 'web_search', args: { query: 'benchmaxxed' } } },
          { delta: 'no sources available.' },
          { delta: ' Sorry.' },
        ]),
      { provider: 'deepinfra', model: 'm', messages: [] },
      caseFor(),
    );
    expect(run.finalText).toBe('I found no sources available. Sorry.');
    expect(run.toolCalls.map((c) => c.name)).toEqual(['web_search']);
    // Tool-call chunks must not leak into the text (their potential .delta
    // payload, if any, is a separate concern; here there is none).
  });

  it('handles runs with tool calls but no text (no finalText key at all)', async () => {
    const { run } = await runCase(
      async () => fakeStream([{ toolCall: { name: 'list_files' } }]),
      { provider: 'groq', model: 'm', messages: [] },
      caseFor(),
    );
    expect(run.finalText).toBeUndefined();
    expect(run.toolCalls.map((c) => c.name)).toEqual(['list_files']);
  });

  it('collapses null/empty deltas without inserting separators', async () => {
    const { run } = await runCase(
      async () => fakeStream([{ delta: 'a' }, { delta: null }, { delta: 'b' }]),
      { provider: 'groq', model: 'm', messages: [] },
      caseFor(),
    );
    expect(run.finalText).toBe('ab');
  });

  it('extracts generated_content from generate_file args', async () => {
    const { run } = await runCase(
      async () => fakeStream([{ toolCall: { name: 'generate_file', args: { content: '# hi' } } }]),
      { provider: 'groq', model: 'm', messages: [] },
      caseFor(),
    );
    expect(run.generatedContent).toBe('# hi');
  });

  it('throws when the connector has no stream', async () => {
    await expect(
      runCase(async () => null, { provider: 'groq', model: 'm', messages: [] }, caseFor()),
    ).rejects.toThrow('no connector for provider groq');
  });
});
