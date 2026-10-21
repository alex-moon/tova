import { groqConnector } from '../../main/services/llm/mastraService';
import type { CompletionOptions } from '../../main/services/llm/llmTypes';

/* `toolResults` nests under `payload`; pin the unwrap against the shape. */
// @see #254 #251 #196

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
