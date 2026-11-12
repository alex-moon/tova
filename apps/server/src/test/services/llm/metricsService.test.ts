import {
  classifyPromptDimensions,
  isTriviallyNeutral,
} from '../../../main/services/llm/metricsService';

const mockDecide = jest.fn();
const mockGenerate = jest.fn();

jest.mock('../../../main/services/llm/systemOneClient', () => ({
  ...jest.requireActual('../../../main/services/llm/systemOneClient'),
  systemOneDecide: (...args: unknown[]) => mockDecide(...args),
}));

jest.mock('@mastra/core/agent', () => {
  return {
    Agent: jest.fn().mockImplementation(() => ({
      generate: (...args: unknown[]) => mockGenerate(...args),
    })),
  };
});

const mockAgentCtor = jest.requireMock('@mastra/core/agent').Agent as jest.Mock;

const NULL_LLM = {
  emotional: null,
  technical: null,
  abstract: null,
  sentiment: null,
  openEnded: null,
};

describe('metricsService', () => {
  beforeEach(() => {
    mockDecide.mockReset().mockResolvedValue(null);
    mockGenerate.mockReset();
    delete process.env.DECISION_CLASSIFIER_ENABLED;
  });

  describe('classifyPromptDimensions', () => {
    it('surfaces the schema-validated object', async () => {
      mockGenerate.mockResolvedValueOnce({
        text: '{"emotional": true, "technical": false, "abstract": false, "sentiment": "positive", "openEnded": true}',
        object: {
          emotional: true,
          technical: false,
          abstract: false,
          sentiment: 'positive',
          openEnded: true,
        },
      });
      expect(await classifyPromptDimensions('hello')).toEqual({
        llm: {
          emotional: true,
          technical: false,
          abstract: false,
          sentiment: 'positive',
          openEnded: true,
        },
        skipReason: null,
      });
    });

    it('reports skipReason error when the Groq call throws', async () => {
      mockGenerate.mockRejectedValueOnce(new Error('boom'));
      expect(await classifyPromptDimensions('hello')).toEqual({
        llm: NULL_LLM,
        skipReason: 'error',
      });
    });

    it('#77: builds the classifier from a tool-free agent', async () => {
      mockGenerate.mockResolvedValueOnce({ text: 'definitely emotional, very technical' });
      await classifyPromptDimensions('hello');
      const ctorArgs = mockAgentCtor.mock.calls[mockAgentCtor.mock.calls.length - 1] as unknown[];
      const ctorCall = (ctorArgs?.[0] ?? {}) as { model: string; tools?: unknown };
      // Tool-rejecting guard models: no `tools` argument at all.
      // @see #41 #77
      expect('tools' in ctorCall).toBe(false);
      expect(ctorCall.model).toBe('groq/openai/gpt-oss-20b');
    });

    it('#368: passes the flags schema with fallback and auto injection on the generate options', async () => {
      mockGenerate.mockResolvedValueOnce({ text: 'x', object: NULL_LLM });
      await classifyPromptDimensions('hello');
      const options = mockGenerate.mock.calls[mockGenerate.mock.calls.length - 1][1] as {
        structuredOutput?: { errorStrategy?: string; jsonPromptInjection?: unknown };
      };
      expect(options.structuredOutput?.errorStrategy).toBe('fallback');
      expect(options.structuredOutput?.jsonPromptInjection).toBe('auto');
    });

    it('reports skipReason parse when the object degrades to the all-null fallback', async () => {
      mockGenerate.mockResolvedValueOnce({});
      expect(await classifyPromptDimensions('hello')).toEqual({
        llm: NULL_LLM,
        skipReason: 'parse',
      });
    });

    it('#426: maps decision answers to flags without touching the aux LLM', async () => {
      mockDecide.mockResolvedValueOnce({
        emotional: { type: 'noul', noul: 0.9729 },
        technical: { type: 'noul', noul: 0.0128 },
        abstract: { type: 'noul', noul: 0.7417 },
        sentiment: {
          type: 'choice',
          choice: 'negative',
          confidence: 0.7814,
          probabilities: { positive: 0.0146, negative: 0.922, neutral: 0.0634 },
        },
        openEnded: { type: 'noul', noul: 0.8026 },
      });
      expect(await classifyPromptDimensions('I feel overwhelmed')).toEqual({
        llm: {
          emotional: true,
          technical: false,
          abstract: true,
          sentiment: 'negative',
          openEnded: true,
        },
        skipReason: null,
      });
      expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('#426: an unknown sentiment choice degrades that flag to null, not the call', async () => {
      mockDecide.mockResolvedValueOnce({
        emotional: { type: 'noul', noul: 0.99 },
        technical: { type: 'noul', noul: 0.01 },
        abstract: { type: 'noul', noul: 0.2 },
        sentiment: { type: 'choice', choice: 'joyful' },
        openEnded: { type: 'noul', noul: 0.1 },
      });
      const { llm, skipReason } = await classifyPromptDimensions('hello');
      expect(llm.sentiment).toBeNull();
      expect(llm.emotional).toBe(true);
      expect(skipReason).toBeNull();
    });

    it('#426: all-null decision answers retry through the aux LLM path', async () => {
      mockDecide.mockResolvedValueOnce({});
      mockGenerate.mockResolvedValueOnce({
        text: 'x',
        object: {
          emotional: true,
          technical: false,
          abstract: false,
          sentiment: 'neutral',
          openEnded: true,
        },
      });
      expect(await classifyPromptDimensions('hello')).toEqual({
        llm: {
          emotional: true,
          technical: false,
          abstract: false,
          sentiment: 'neutral',
          openEnded: true,
        },
        skipReason: null,
      });
      expect(mockGenerate).toHaveBeenCalled();
    });

    it('#426: DECISION_CLASSIFIER_ENABLED=0 skips the decision path entirely', async () => {
      process.env.DECISION_CLASSIFIER_ENABLED = '0';
      mockGenerate.mockResolvedValueOnce({
        text: 'x',
        object: {
          emotional: false,
          technical: true,
          abstract: false,
          sentiment: 'neutral',
          openEnded: false,
        },
      });
      await classifyPromptDimensions('hello');
      expect(mockDecide).not.toHaveBeenCalled();
      expect(mockGenerate).toHaveBeenCalled();
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
