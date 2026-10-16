import { groqConnector, deepinfraConnector } from '../../main/services/mastraService';
import { runModelComparison } from '../../main/services/modelCompare';
import type { CompletionOptions } from '../../main/services/llmTypes';

/*
 * #198: Qwen3.5 on DeepInfra (and other strict OpenAI-compatible servers)
 * reject any `role: 'system'` message that is not at index 0, including a
 * second one sitting at index 1. Tova was sending two leading system messages
 * on the full-tools path: Mastra injected the agent's `TOOL_INSTRUCTIONS` at
 * index 0, and the caller's `buildSystemContent(...)` rode in at index 1, so a
 * Qwen3.5-routed turn 400'd with "System message must be at the beginning.".
 *
 * The fix (mastraService.ts) collapses the caller's leading system message(s)
 * into a per-call `instructions` override, merged with the agent's tool
 * instructions, and passes the remaining messages with no system message. The
 * effective provider payload therefore has exactly one leading system message.
 *
 * These tests pin the **connector-level** contract (not the route-level
 * array, which legitimately still starts with a system message — see
 * chat.test.ts / chat.stream.test.ts). The agent module is mocked the way the
 * other suites do, recording the exact `instructions` override and `messages`
 * the connector hands to Mastra.
 */

const mockGenerate = jest.fn();
const mockStream = jest.fn();

jest.mock('@mastra/core/agent', () => ({
  Agent: jest.fn().mockImplementation(() => ({
    generate: (...args: unknown[]) => mockGenerate(...args),
    stream: (...args: unknown[]) => mockStream(...args),
  })),
}));

type Captured = {
  messages: Array<{ role: string; content: unknown }>;
  instructions: unknown;
};

const capturedGenerate = (callIndex = 0): Captured => {
  const call = mockGenerate.mock.calls[callIndex] as unknown[];
  const messages = call[0] as Captured['messages'];
  const options = call[1] as { instructions?: unknown };
  return { messages, instructions: options.instructions };
};

const TOOL_INSTRUCTIONS_FRAGMENT = '`web_search`';
const CALLER_SYSTEM = 'You are Tova, a helpful assistant.';
const CALLER_MESSAGES: CompletionOptions['messages'] = [
  { role: 'system', content: CALLER_SYSTEM },
  { role: 'user', content: 'hello' },
];

const fullToolsOptions = (messages: CompletionOptions['messages']): CompletionOptions => ({
  model: 'Qwen/Qwen3.5-397B-A17B',
  messages,
});

describe('mastraService single leading system message (#198)', () => {
  beforeEach(() => {
    mockGenerate.mockReset().mockResolvedValue({ text: 'ok' });
    mockStream.mockReset().mockResolvedValue({ fullStream: (async function* () {})() });
  });

  it('collapses caller system + tool instructions into one leading override (deepinfra generate)', async () => {
    await deepinfraConnector.createCompletion(fullToolsOptions(CALLER_MESSAGES));
    const { messages, instructions } = capturedGenerate();

    // Exactly one system message reaches the provider: the per-call override.
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(0);
    expect(typeof instructions).toBe('string');
    // It carries both halves — tool guidance (D3) and the caller's content.
    expect(instructions as string).toContain(TOOL_INSTRUCTIONS_FRAGMENT);
    expect(instructions as string).toContain(CALLER_SYSTEM);
    // Non-system messages pass through untouched.
    expect(messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('collapses the same way on the streaming path', async () => {
    await deepinfraConnector.createStreamingCompletion(fullToolsOptions(CALLER_MESSAGES));
    const call = mockStream.mock.calls[0] as unknown[];
    const messages = call[0] as Captured['messages'];
    const options = call[1] as { instructions?: unknown };

    expect(messages.filter((m) => m.role === 'system')).toHaveLength(0);
    expect(options.instructions as string).toContain(TOOL_INSTRUCTIONS_FRAGMENT);
    expect(options.instructions as string).toContain(CALLER_SYSTEM);
  });

  it('still yields tool instructions when the caller passes no system message', async () => {
    await groqConnector.createCompletion(fullToolsOptions([{ role: 'user', content: 'hello' }]));
    const { messages, instructions } = capturedGenerate();
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(0);
    expect(instructions as string).toContain(TOOL_INSTRUCTIONS_FRAGMENT);
  });

  it('leaves the tool-free path with a single leading system message', async () => {
    await groqConnector.createToolFreeCompletion({
      model: 'm',
      messages: [
        { role: 'system', content: 'Summarise the title.' },
        { role: 'user', content: 'a long text' },
      ],
    });
    const { messages, instructions } = capturedGenerate();
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(0);
    expect(instructions as string).toContain('Summarise the title.');
    // No tool guidance leaks into the tool-free path.
    expect(instructions as string).not.toContain(TOOL_INSTRUCTIONS_FRAGMENT);
  });

  it('throws on a system message placed after a non-system message (T5 guard)', async () => {
    await expect(
      groqConnector.createCompletion({
        model: 'm',
        messages: [
          { role: 'system', content: CALLER_SYSTEM },
          { role: 'user', content: 'hello' },
          { role: 'system', content: 'late system message' },
        ],
      }),
    ).rejects.toThrow('Non-leading system message in completion request (#198)');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  /*
   * T3 (#198): the admin Compare tab / CLI eval (`runModelComparison`) passes
   * an explicit system message to `createCompletion`. It needs no separate
   * change — the shared connector path collapses it — so this pins that the
   * compare caller also lands on exactly one leading system message.
   */
  it('collapses the model-compare path through the shared connector', async () => {
    await runModelComparison('compare this', [
      { provider: 'deepinfra', model: 'Qwen/Qwen3.5-397B-A17B' },
    ]);
    const { messages, instructions } = capturedGenerate();
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(0);
    expect(instructions as string).toContain(TOOL_INSTRUCTIONS_FRAGMENT);
    expect(messages).toEqual([{ role: 'user', content: 'compare this' }]);
  });

  /*
   * T4 (#198): `rest` (the messages left after pulling the leading system
   * out) must still flow through `mastraMessagesFor`'s image mapping
   * unchanged, and a leading system message carried as content *parts* (not a
   * bare string) must collapse just the same.
   */
  it('collapses part-array system content and preserves image mapping in rest', async () => {
    await deepinfraConnector.createCompletion(
      fullToolsOptions([
        {
          role: 'system',
          content: [
            { type: 'text', text: 'System part one.' },
            { type: 'text', text: 'System part two.' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is in this image?' },
            { type: 'image_url', image_url: { url: 'https://spaces.example.com/presigned.png' } },
          ],
        },
      ]),
    );
    const { messages, instructions } = capturedGenerate();
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(0);
    expect(instructions as string).toContain('System part one.');
    expect(instructions as string).toContain('System part two.');
    // The image part still maps to AI-SDK `image` (issue #115).
    const user = messages.find((m) => m.role === 'user') as { content: unknown[] };
    expect(user.content).toEqual([
      { type: 'text', text: 'what is in this image?' },
      { type: 'image', image: new URL('https://spaces.example.com/presigned.png') },
    ]);
  });
});
