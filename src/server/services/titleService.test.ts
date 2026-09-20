import { generateChatTitle } from './titleService';
import { muteConsoleError } from '../test/muteConsole';
/*
 * Issues #41 and #117: title generation is a tool-free aux call. It must go
 * through `createToolFreeCompletion` (never the tool-attached streaming path
 * that carries the built-in toolset / tool-use instructions), and it must
 * degrade to the truncated fallback when the call fails or returns nothing.
 */

const mockCreateToolFree = jest.fn();
const mockCreateCompletion = jest.fn();

jest.mock('./inferenceService', () => ({
  inferenceService: {
    createToolFreeCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
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
      choices: [{ message: { content: 'Restaurant ideas near Bandra' } }],
    });
    const title = await generateChatTitle('Give me restaurant ideas near Bandra in Mumbai');
    expect(title).toBe('Restaurant ideas near Bandra');
    expect(mockCreateCompletion).not.toHaveBeenCalled();
    const options = mockCreateToolFree.mock.calls[0][0];
    expect(options.provider).toBe('groq');
    expect(options.model).toBe(process.env.ROUTER_SMALL_MODEL || 'openai/gpt-oss-20b');
    // No tool payload of any kind on an aux call (#117 operator confirmation).
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
