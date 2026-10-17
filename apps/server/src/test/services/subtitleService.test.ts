import { reviseSessionSubtitle } from '../../main/services/subtitleService';
import { muteConsoleError } from '../muteConsole';
/* Subtitle revision is a tool-free aux call; it must degrade to the current subtitle (or null) on failure — a failed revision never destroys what is already there. */
// @see #359
const mockCreateToolFree = jest.fn();

jest.mock('../../main/services/inferenceService', () => ({
  inferenceService: {
    createToolFreeCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
  },
}));

describe('reviseSessionSubtitle', () => {
  beforeEach(() => {
    mockCreateToolFree.mockReset();
  });

  it('uses the tool-free path on the aux model with the current subtitle in context', async () => {
    mockCreateToolFree.mockResolvedValueOnce({
      choices: [{ message: { content: 'Predictive processing reading thread' } }],
    });
    const next = await reviseSessionSubtitle('Old summary', [
      { role: 'user', content: 'back to the predictive processing thread' },
      { role: 'assistant', content: 'Happy to pick that up again.' },
    ]);
    expect(next).toBe('Predictive processing reading thread');
    const options = mockCreateToolFree.mock.calls[0][0];
    expect(options.provider).toBe('groq');
    expect(options.model).toBe(process.env.AUX_MODEL || 'openai/gpt-oss-20b');
    expect(options.messages?.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(JSON.stringify(options)).not.toMatch(/web_search|tools|tool_choice/);
    const userContent = options.messages[1].content as string;
    expect(userContent).toContain('"Old summary"');
    expect(userContent).toContain('user: back to the predictive processing thread');
  });

  it('marks a first revision when no subtitle exists yet', async () => {
    mockCreateToolFree.mockResolvedValueOnce({
      choices: [{ message: { content: 'Move planning' } }],
    });
    await reviseSessionSubtitle(null, [{ role: 'user', content: 'let us plan the move' }]);
    expect(mockCreateToolFree.mock.calls[0][0].messages[1].content).toContain('(none yet)');
  });

  it('caps a rambling reply at 80 chars with an ellipsis', async () => {
    mockCreateToolFree.mockResolvedValueOnce({
      choices: [{ message: { content: 'x'.repeat(120) } }],
    });
    const next = await reviseSessionSubtitle(null, [{ role: 'user', content: 'hello' }]);
    expect(next).toHaveLength(81);
    expect((next as string).endsWith('…')).toBe(true);
  });

  it('keeps the current subtitle when the model returns nothing', async () => {
    mockCreateToolFree.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    expect(await reviseSessionSubtitle('Still here', [{ role: 'user', content: 'hello' }])).toBe(
      'Still here',
    );
  });

  it('keeps the current subtitle and logs on completion error', async () => {
    const mute = muteConsoleError();
    try {
      mockCreateToolFree.mockRejectedValueOnce(new Error('429 TPM'));
      expect(await reviseSessionSubtitle('Still here', [{ role: 'user', content: 'hello' }])).toBe(
        'Still here',
      );
    } finally {
      mute.mockRestore();
    }
  });
});
