import { classifyPromptDimensions, parseLlmFlags } from './metricsService';

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
});
