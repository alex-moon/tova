import { groqConnector } from './mastraService';
import type { CompletionOptions } from './llmTypes';

/*
 * #254 (epic #251): the task sequencer consumes the non-streaming connector's
 * `toolResults` to build #196 tool chips and replay its own tool usage as
 * history. Mastra's `FullOutput.toolResults` is an array of `ToolResultChunk`s
 * shaped `{ type, runId, from, payload: { toolName, args, result, toolCallId } }`
 * — the fields live under `payload`, not on the entry. Reading the entry itself
 * yielded `name: ''`, no `result`, and no `args`, which silently broke the
 * sequencer's chips and its replay (the model re-ran tool calls blind until the
 * step budget ran out).
 *
 * These tests pin the unwrap against the real Mastra shape (captured from a
 * live run), with an entry-level fallback so a bare payload still maps.
 */

const mockGenerate = jest.fn();

jest.mock('@mastra/core/agent', () => ({
  Agent: jest.fn().mockImplementation(() => ({
    generate: (...args: unknown[]) => mockGenerate(...args),
    stream: jest.fn(),
  })),
}));

const options: CompletionOptions = {
  model: 'deepseek-ai/DeepSeek-V4.1-Flash',
  messages: [{ role: 'user', content: 'list my files' }],
};

describe('mastraService toolResults unwrap (#254)', () => {
  beforeEach(() => {
    mockGenerate.mockReset().mockResolvedValue({ text: 'ok' });
  });

  it('reads toolName/args/result from the nested payload', async () => {
    mockGenerate.mockResolvedValueOnce({
      text: '',
      toolResults: [
        {
          type: 'tool-result',
          runId: 'r1',
          from: 'AGENT',
          payload: {
            toolCallId: 'call-1',
            toolName: 'list_files',
            args: { query: 'notes' },
            result: { files: [{ filename: 'a.md' }] },
          },
        },
      ],
    });

    const result = await groqConnector.createCompletion(options);

    expect(result.toolResults).toEqual([
      { name: 'list_files', args: { query: 'notes' }, result: { files: [{ filename: 'a.md' }] } },
    ]);
  });

  it('falls back to entry-level fields when there is no payload wrapper', async () => {
    mockGenerate.mockResolvedValueOnce({
      text: '',
      toolResults: [{ name: 'fetch_url', result: { title: 'x' } }],
    });

    const result = await groqConnector.createCompletion(options);

    expect(result.toolResults).toEqual([{ name: 'fetch_url', result: { title: 'x' } }]);
  });
});
