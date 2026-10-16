import { groqConnector } from '../../main/services/mastraService';
import type { CompletionOptions } from '../../main/services/llmTypes';

/*
 * #254 (epic #251) connector seam: the task sequencer pins one roster call to
 * `maxSteps: 1` so a single call is one driver-observable step (spike decision
 * (c), `docs/done/plan-254-task-entity.md`). Two contracts are pinned here:
 *
 * 1. `CompletionOptions.maxSteps` is forwarded verbatim onto Mastra's call
 *    options; absent keeps the existing mode default (12 full / 1 plain), so
 *    every chat call site is byte-identical (no regression).
 * 2. The non-streaming completion surfaces each executed call's `args`
 *    (Mastra's `ToolResultPayload` carries `toolName` + `args`), so the
 *    sequencer can rebuild a step's tool chips and replay its own calls as
 *    history — the args the streaming path already exposes.
 */

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
