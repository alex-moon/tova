import { generateFollowups, parseSuggestions } from '../../main/services/followupService';
import { muteConsoleError } from '../muteConsole';

/* Follow-up generation must go through the tool-free completion path (the suggestion model rejects tool-carrying requests), and parsing must degrade gracefully on malformed outputs. */
// @see #41

const mockCreateToolFree = jest.fn();
const mockCreateCompletion = jest.fn();

jest.mock('../../main/services/inferenceService', () => ({
  inferenceService: {
    createToolFreeCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
    createCompletion: (...args: unknown[]) => mockCreateCompletion(...args),
  },
}));

/* JSON-array shapes: passthrough (clean), slice, prose-wrapped spans. */
describe('parseSuggestions', () => {
  it('parses a clean JSON array string', () => {
    expect(parseSuggestions('["How do you know?","What next?","Why?"]')).toEqual([
      'How do you know?',
      'What next?',
      'Why?',
    ]);
  });

  it('parses whitespace-padded arrays (metadata around the array)', () => {
    expect(parseSuggestions('  ["a","b"]  ')).toEqual(['a', 'b']);
  });

  it('scavenges the first JSON array from surrounding prose', () => {
    expect(parseSuggestions('Here are ideas:\n["ask about APIs","go deeper"]\nEnjoy!')).toEqual([
      'ask about APIs',
      'go deeper',
    ]);
  });

  it('still parses an array whose strings contain brackets/braces', () => {
    expect(parseSuggestions('["what molds into `object` shape?"]')).toEqual([
      'what molds into `object` shape?',
    ]);
  });

  it('recovers items from a non-JSON set literal, e.g. the live failure', () => {
    expect(parseSuggestions("{'German', 'English', 'Spanish'}")).toEqual([
      'German',
      'English',
      'Spanish',
    ]);
  });

  it('recovers items from a bulleted multiline response', () => {
    expect(parseSuggestions('* One thing?\n* Another thing?\n- Third thing?')).toEqual([
      'One thing?',
      'Another thing?',
      'Third thing?',
    ]);
  });

  it('recovers numbered lines', () => {
    expect(parseSuggestions('1. First thing\n2. Second thing')).toEqual([
      'First thing',
      'Second thing',
    ]);
  });

  it('applies the old post-filters (length cap, non-string entries)', () => {
    expect(
      parseSuggestions(
        '["ok",[1,2],null,' +
          JSON.stringify('x'.repeat(61)) +
          ',' +
          JSON.stringify('y'.repeat(60)) +
          ']',
      ),
    ).toEqual(['ok', 'y'.repeat(60)]);
  });

  it('caps results at MAX_SUGGESTIONS', () => {
    expect(parseSuggestions('["a","b","c","d","e"]')).toEqual(['a', 'b', 'c']);
  });

  it('strips symmetric wrapping quotes', () => {
    expect(parseSuggestions('["\'What?\'"]')).toEqual(['What?']);
  });

  it('drops duplicate items from a JSON array', () => {
    expect(parseSuggestions('["a","a","b"]')).toEqual(['a', 'b']);
  });

  it('drops duplicate items recovered via the set-literal fallback', () => {
    expect(parseSuggestions("{'German', 'German', 'English'}")).toEqual(['German', 'English']);
  });

  it('discards an unbalanced bracket tail rather than swallowing the slice', () => {
    expect(parseSuggestions('x ["a","b"] y [trailing')).toEqual(['a', 'b']);
  });

  it('degrades to [] on unrecognisable output (needs ≥2 items to count as a list)', () => {
    expect(parseSuggestions('no advice to be found')).toEqual([]);
  });

  it('degrades to [] on empty input', () => {
    expect(parseSuggestions('')).toEqual([]);
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

  it('calls createToolFreeCompletion, never the tools-attached path', async () => {
    mockCreateToolFree.mockResolvedValueOnce({ choices: [{ message: { content: '["a","b"]' } }] });
    await expect(generateFollowups('u', 'a')).resolves.toEqual(['a', 'b']);
    expect(mockCreateCompletion).not.toHaveBeenCalled();
  });

  it('returns [] when the transport call throws (never fails the request)', async () => {
    mockCreateToolFree.mockRejectedValueOnce(new Error('boom'));
    await expect(generateFollowups('u', 'a')).resolves.toEqual([]);
  });

  it('returns [] when the model returns no content', async () => {
    mockCreateToolFree.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    await expect(generateFollowups('u', 'a')).resolves.toEqual([]);
  });

  it('salvages usable suggestions from non-JSON model output', async () => {
    mockCreateToolFree.mockResolvedValueOnce({
      choices: [{ message: { content: "{'What changed?','When will it re-open?'}" } }],
    });
    await expect(generateFollowups('u', 'a')).resolves.toEqual([
      'What changed?',
      'When will it re-open?',
    ]);
  });

  it('trims and compresses the prompt payload', async () => {
    mockCreateToolFree.mockResolvedValueOnce({ choices: [{ message: { content: '[]' } }] });
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
