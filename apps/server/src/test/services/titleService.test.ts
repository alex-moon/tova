import { generateChatTitle } from '../../main/services/titleService';
import { muteConsoleError } from '../muteConsole';
/* Title generation is a tool-free aux call; it degrades on failure. */
// @see #41 #117
const mockCreateToolFree = jest.fn();
const mockCreateCompletion = jest.fn();

jest.mock('../../main/services/inferenceService', () => ({
  inferenceService: {
    createToolFreeCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
    createStructuredCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
    createCompletion: (...args: unknown[]) => mockCreateCompletion(...args),
  },
}));

describe('generateChatTitle', () => {
  beforeEach(() => {
    mockCreateToolFree.mockReset();
    mockCreateCompletion.mockReset();
  });

  it('uses the tool-free path, pinned to groq with the small model', async () => {
    mockCreateToolFree.mockResolvedValueOnce({
      object: { title: 'Restaurant ideas near Bandra' },
    });
    const title = await generateChatTitle('Give me restaurant ideas near Bandra in Mumbai');
    expect(title).toBe('Restaurant ideas near Bandra');
    expect(mockCreateCompletion).not.toHaveBeenCalled();
    const options = mockCreateToolFree.mock.calls[0][0];
    expect(options.provider).toBe('groq');
    expect(options.model).toBe(process.env.AUX_MODEL || 'openai/gpt-oss-20b');
    // No tool payload of any kind on an aux call (operator confirmation).
    // @see #117
    expect(options.messages?.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(JSON.stringify(options)).not.toMatch(/web_search|tools|tool_choice/);
  });

  it('falls back to the truncated first sentence on empty content', async () => {
    mockCreateToolFree.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    expect(await generateChatTitle('hello world')).toBe('hello world');
  });

  it('falls back and logs on completion error', async () => {
    const mute = muteConsoleError();
    try {
      mockCreateToolFree.mockRejectedValueOnce(new Error('429 TPM'));
      expect(await generateChatTitle('A long title that is definitely over thirty chars')).toBe(
        'A long title that is definitel…',
      );
    } finally {
      mute.mockRestore();
    }
  });
});
