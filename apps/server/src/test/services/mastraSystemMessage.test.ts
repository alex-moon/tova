import { groqConnector, deepinfraConnector } from '../../main/services/mastraService';
import { runModelComparison } from '../../main/services/modelCompare';
import type { CompletionOptions } from '../../main/services/llmTypes';

/* Strict OpenAI-compatible servers reject a system message not at index 0, so the connector collapses the caller's leading system message(s) into a per-call instructions override; these tests pin the connector-level contract with the agent module mocked. */
// @see #198

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

  /* The compare/eval caller passes an explicit system message and needs no separate change — the shared connector path collapses it. */
  // @see #198
  it('collapses the model-compare path through the shared connector', async () => {
    await runModelComparison('compare this', [
      { provider: 'deepinfra', model: 'Qwen/Qwen3.5-397B-A17B' },
    ]);
    const { messages, instructions } = capturedGenerate();
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(0);
    expect(instructions as string).toContain(TOOL_INSTRUCTIONS_FRAGMENT);
    expect(messages).toEqual([{ role: 'user', content: 'compare this' }]);
  });

  /* `rest` must still flow through the image mapping unchanged, and a leading system message carried as content parts must collapse just the same. */
  // @see #198
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
    // The image part still maps to AI-SDK `image`.
    // @see #115
    const user = messages.find((m) => m.role === 'user') as { content: unknown[] };
    expect(user.content).toEqual([
      { type: 'text', text: 'what is in this image?' },
      { type: 'image', image: new URL('https://spaces.example.com/presigned.png') },
    ]);
  });
});
