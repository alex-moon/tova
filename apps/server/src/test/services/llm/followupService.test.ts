import { generateFollowups, parseSuggestions } from '../../../main/services/llm/followupService';
import { muteConsoleError } from '../../muteConsole';

const mockCreateToolFree = jest.fn();
const mockCreateCompletion = jest.fn();

jest.mock('../../../main/services/llm/inferenceService', () => ({
  inferenceService: {
    createToolFreeCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
    createStructuredCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
    createCompletion: (...args: unknown[]) => mockCreateCompletion(...args),
  },
}));

describe('parseSuggestions (sanitisation of model-supplied strings)', () => {
  it('trims, strips wrapping quotes, and keeps phraselike strings', () => {
    expect(parseSuggestions(['  "What next?"  ', '', 'ok'])).toEqual(['What next?', 'ok']);
  });

  it('applies the old post-filters (length cap, non-string entries)', () => {
    expect(
      parseSuggestions([
        'x'.repeat(80),
        42 as unknown as string,
        null as unknown as string,
        'keep me',
      ]),
    ).toEqual(['keep me']);
  });

  it('caps results at MAX_SUGGESTIONS and drops duplicates', () => {
    expect(parseSuggestions(['a', 'a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c']);
  });
});

describe('generateFollowups', () => {
  beforeEach(() => {
    mockCreateToolFree.mockReset();
    mockCreateCompletion.mockReset();
    muteConsoleError();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls the structured tool-free path, never the tools-attached path', async () => {
    mockCreateToolFree.mockResolvedValueOnce({
      choices: [{ message: { content: '["a","b"]' } }],
      object: { suggestions: ['a', 'b'] },
    });
    await expect(generateFollowups('u', 'a')).resolves.toEqual(['a', 'b']);
    expect(mockCreateCompletion).not.toHaveBeenCalled();
  });

  it('sanitises model-supplied suggestions (quotes, duplicates, cap)', async () => {
    mockCreateToolFree.mockResolvedValueOnce({
      object: { suggestions: ['  "What next?"  ', 'What next?', 'and another?'] },
    });
    await expect(generateFollowups('u', 'a')).resolves.toEqual(['What next?', 'and another?']);
  });

  it('#368: passes the suggestions schema with fallback and auto injection', async () => {
    mockCreateToolFree.mockResolvedValueOnce({ object: { suggestions: [] } });
    await generateFollowups('u', 'a');
    const options = mockCreateToolFree.mock.calls[0][0] as {
      structuredOutput?: { errorStrategy?: string; jsonPromptInjection?: unknown };
    };
    expect(options.structuredOutput?.errorStrategy).toBe('fallback');
    expect(options.structuredOutput?.jsonPromptInjection).toBe('auto');
  });

  it('returns [] when the transport call throws (never fails the request)', async () => {
    mockCreateToolFree.mockRejectedValueOnce(new Error('boom'));
    await expect(generateFollowups('u', 'a')).resolves.toEqual([]);
  });

  it('returns [] when the object degrades to the empty fallback', async () => {
    mockCreateToolFree.mockResolvedValueOnce({ object: { suggestions: [] } });
    await expect(generateFollowups('u', 'a')).resolves.toEqual([]);
  });

  it('trims and compresses the prompt payload', async () => {
    mockCreateToolFree.mockResolvedValueOnce({ object: { suggestions: [] } });
    await generateFollowups('users   question', 'assistants    reply');
    expect(mockCreateToolFree.mock.calls[0][0]).toMatchObject({
      messages: [
        { role: 'system' },
        {
          role: 'user',
          content: 'users question Assistant replied: assistants reply',
        },
      ],
    });
  });
});
