import { classifyPromptDimensions, isTriviallyNeutral, parseLlmFlags } from './metricsService';

const mockCreate = jest.fn();

jest.mock('groq-sdk', () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: (...args: unknown[]) => mockCreate(...args),
      },
    },
  }));
});

describe('metricsService', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  describe('parseLlmFlags', () => {
    it('parses a clean JSON object', () => {
      expect(
        parseLlmFlags(
          '{"emotional": true, "technical": false, "abstract": false, "sentiment": "negative", "openEnded": true}',
        ),
      ).toEqual({
        emotional: true,
        technical: false,
        abstract: false,
        sentiment: 'negative',
        openEnded: true,
      });
    });

    it('tolerates markdown fences and surrounding prose', () => {
      expect(
        parseLlmFlags(
          'Here you go:\n```json\n{"emotional": false, "technical": true, "abstract": true, "sentiment": "neutral", "openEnded": false}\n```\nDone.',
        ),
      ).toEqual({
        emotional: false,
        technical: true,
        abstract: true,
        sentiment: 'neutral',
        openEnded: false,
      });
    });

    it('degrades each flag independently on unknown values', () => {
      expect(
        parseLlmFlags(
          '{"emotional": "yes", "technical": 1, "sentiment": "angry", "openEnded": null}',
        ),
      ).toEqual({
        emotional: null,
        technical: null,
        abstract: null,
        sentiment: null,
        openEnded: null,
      });
    });

    it('skips a decoy JSON object and recovers the real flags after it', () => {
      expect(
        parseLlmFlags(
          'Use the format {"example": {"x": 1}} when replying. Answer: {"emotional": true, "technical": false, "abstract": true, "sentiment": "neutral", "openEnded": false}',
        ),
      ).toEqual({
        emotional: true,
        technical: false,
        abstract: true,
        sentiment: 'neutral',
        openEnded: false,
      });
    });

    it('does not skip a partially decoy object that carries at least one valid flag', () => {
      expect(parseLlmFlags('{"x": 1, "emotional": false}')).toEqual({
        emotional: false,
        technical: null,
        abstract: null,
        sentiment: null,
        openEnded: null,
      });
    });

    it('returns nulls for non-JSON output', () => {
      expect(parseLlmFlags('definitely emotional, very technical')).toEqual(parseLlmFlags(null));
      expect(parseLlmFlags('no braces at all')).toEqual(parseLlmFlags(''));
      expect(parseLlmFlags(undefined)).toEqual(parseLlmFlags(null));
      // Unterminated object
      expect(parseLlmFlags('{"emotional": true')).toEqual(parseLlmFlags(null));
    });
  });

  describe('classifyPromptDimensions', () => {
    it('parses the model response', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content:
                '{"emotional": true, "technical": false, "abstract": false, "sentiment": "positive", "openEnded": true}',
            },
          },
        ],
      });
      const flags = await classifyPromptDimensions('hello');
      expect(flags).toEqual({
        emotional: true,
        technical: false,
        abstract: false,
        sentiment: 'positive',
        openEnded: true,
      });
    });

    it('returns all nulls when the Groq call throws', async () => {
      mockCreate.mockRejectedValueOnce(new Error('boom'));
      expect(await classifyPromptDimensions('hello')).toEqual(parseLlmFlags(null));
    });

    it('returns all nulls when the response shape is unexpected', async () => {
      mockCreate.mockResolvedValueOnce({});
      expect(await classifyPromptDimensions('hello')).toEqual(parseLlmFlags(null));
    });
  });

  describe('isTriviallyNeutral', () => {
    it('skips short confirmations and continuations', () => {
      expect(isTriviallyNeutral('yes')).toBe(true);
      expect(isTriviallyNeutral('ok thanks')).toBe(true);
      expect(isTriviallyNeutral('Thank you!')).toBe(true);
      expect(isTriviallyNeutral('tell me more')).toBe(true);
      expect(isTriviallyNeutral('Please continue.')).toBe(true);
      expect(isTriviallyNeutral('Go on')).toBe(true);
      expect(isTriviallyNeutral('Yeah, sure')).toBe(true);
      expect(isTriviallyNeutral('Perfect, thanks')).toBe(true);
    });

    it('does not skip a continuation that carries real content', () => {
      expect(isTriviallyNeutral('please continue writing the debate section')).toBe(false);
    });

    it('does not skip questions, code, or substantive prompts (fail closed)', () => {
      expect(isTriviallyNeutral('ok?')).toBe(false);
      expect(isTriviallyNeutral('thanks — can you show `await db.count()`?')).toBe(false);
      expect(isTriviallyNeutral('write a function that sorts users')).toBe(false);
      expect(isTriviallyNeutral('explain how the router picks a model for this prompt')).toBe(
        false,
      );
    });

    it('handles empty and unicode-only content', () => {
      expect(isTriviallyNeutral('')).toBe(false);
      expect(isTriviallyNeutral('   ')).toBe(false);
      expect(isTriviallyNeutral('はい')).toBe(false);
    });

    it('does not skip prompts over the word-count bound', () => {
      expect(isTriviallyNeutral('yes yes yes yes yes yes yes yes')).toBe(false);
    });
  });
});
