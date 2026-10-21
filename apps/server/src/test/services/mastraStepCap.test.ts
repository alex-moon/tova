import { groqConnector } from '../../main/services/llm/mastraService';
import type { CompletionOptions } from '../../main/services/llm/llmTypes';

/* Connector seam: maxSteps forwards verbatim; completions surface calls. */
// @see #254 #251

const mockGenerate = jest.fn();
const mockStream = jest.fn();

jest.mock('@mastra/core/agent', () => ({
  Agent: jest.fn().mockImplementation(() => ({
    generate: (...args: unknown[]) => mockGenerate(...args),
    stream: (...args: unknown[]) => mockStream(...args),
  })),
}));

const callOptions = (call: unknown) => (call as unknown[])[1] as { maxSteps?: number };

const options: CompletionOptions = {
  model: 'Qwen/Qwen3.5-397B-A17B',
  messages: [{ role: 'user', content: 'hello' }],
};

describe('mastraService per-call step cap (#254)', () => {
  beforeEach(() => {
    mockGenerate.mockReset().mockResolvedValue({ text: 'ok' });
    mockStream.mockReset().mockResolvedValue({ fullStream: (async function* () {})() });
  });

  it('defaults full mode to 12 when no maxSteps is supplied', async () => {
    await groqConnector.createCompletion(options);
    expect(callOptions(mockGenerate.mock.calls[0]).maxSteps).toBe(12);
  });

  it('forwards a caller-pinned maxSteps verbatim', async () => {
    await groqConnector.createCompletion({ ...options, maxSteps: 1 });
    expect(callOptions(mockGenerate.mock.calls[0]).maxSteps).toBe(1);
  });

  it('forwards maxSteps on the streaming path', async () => {
    await groqConnector.createStreamingCompletion({ ...options, maxSteps: 1 });
    expect(callOptions(mockStream.mock.calls[0]).maxSteps).toBe(1);
  });
});

describe('mastraService toolResults args (#254)', () => {
  beforeEach(() => {
    mockGenerate.mockReset();
  });

  it('carries toolName and args off Mastra tool-results payloads', async () => {
    mockGenerate.mockResolvedValueOnce({
      text: '',
      toolResults: [
        { toolName: 'read_file', args: { fileId: 'abc', unit: 2 }, result: { content: 'hi' } },
      ],
    });
    const result = await groqConnector.createCompletion(options);
    expect(result.toolResults).toEqual([
      { name: 'read_file', args: { fileId: 'abc', unit: 2 }, result: { content: 'hi' } },
    ]);
  });

  it('omits args when the payload carries none', async () => {
    mockGenerate.mockResolvedValueOnce({
      text: '',
      toolResults: [{ toolName: 'current_datetime', result: {} }],
    });
    const result = await groqConnector.createCompletion(options);
    expect(result.toolResults).toEqual([{ name: 'current_datetime', result: {} }]);
  });
});
