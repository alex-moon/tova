import {
  classifyPrompt,
  guardVerdictFromReply,
  parseGuardVotes,
  pickModelRef,
  routeQuery,
} from './routerService';
import { ModelRef } from './modelConfigService';
import { FitWeight } from './modelMetricsStatsService';
import { muteConsoleError } from '../test/muteConsole';

const groqSmall: ModelRef = { provider: 'groq', model: 'test-small-model' };
const groqSmallAlt: ModelRef = { provider: 'groq', model: 'test-small-model-2' };
const groqLarge: ModelRef = { provider: 'groq', model: 'test-large-model' };

const TEST_CONFIG = {
  small: [groqSmall],
  large: [groqLarge],
  guardModel: 'test-guard-model',
};

const routeQueryWithCfg = (query: string) => routeQuery(query, TEST_CONFIG);

const mockGenerate = jest.fn();

jest.mock('@mastra/core/agent', () => ({
  Agent: jest.fn().mockImplementation(() => ({
    generate: (...args: unknown[]) => mockGenerate(...args),
  })),
}));

jest.mock('./modelConfigService', () => ({
  listByTier: jest.fn(),
  completionsPoolFor: jest.fn(),
}));
const mockCompletionsPoolFor = jest.requireMock('./modelConfigService')
  .completionsPoolFor as jest.Mock;

const mockAgentCtor = jest.requireMock('@mastra/core/agent').Agent as jest.Mock;

type Routing = Awaited<ReturnType<typeof routeQuery>>;

// The error-path tests intentionally break the mocked classifier; keep that
// expected fallback error out of the test output.
let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  consoleErrorSpy = muteConsoleError();
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.ROUTER_GUARD_CONTEXT_MESSAGES;
});

// Raw guard-reply setter: the mocked generate returns exactly this reply
// text (createToolFreeCompletion maps generate().text onto
// choices[0].message.content, so this is the content routeQuery parses).
const guardReplies = (content: string, error = false) => {
  mockGenerate.mockReset();
  if (error) {
    mockGenerate.mockRejectedValueOnce(new Error('classifier down'));
  } else {
    mockGenerate.mockResolvedValueOnce({ text: content });
  }
};

// Semantic shortcut: a well-formed category vote object for the verdict —
// any "yes" (complex) vs all "no" (simple), the #169 phase-2 contract.
const classifyAs = (verdict: 'complex' | 'simple') =>
  guardReplies(
    verdict === 'complex'
      ? '{"reasoning":"yes","code":"no","emotional":"no","creative":"no"}'
      : '{"reasoning":"no","code":"no","emotional":"no","creative":"no"}',
  );

const lastGuardPrompt = (): string => {
  const [messages] = mockGenerate.mock.calls[0] as unknown as [{ role: string; content: string }[]];
  return messages[0].content;
};

describe('Router Service', () => {
  describe('Guard-only routing (#169 phase 2: no deterministic rules)', () => {
    // Every text turn reaches the guard now — the old key-phrase rules
    // ('hi'/'hello' regexes, code keywords) are deleted; a mocked vote
    // decides each case, so these pin the PLUMBING, not the guard's
    // judgment (live judgment is evidenced by the #169 spot-check runs).
    it('routes greetings only when the guard votes all-no', async () => {
      classifyAs('simple');
      const result = await routeQueryWithCfg('thanks');
      expect(result.model).toBe('test-small-model');
      expect(result.reason).toBe('classifier-simple');
    });

    it('routes a greeting the guard votes substantive to the LARGE tier', async () => {
      classifyAs('complex');
      const result = await routeQueryWithCfg('Hello');
      expect(result.model).toBe('test-large-model');
      expect(result.reason).toBe('classifier-complex');
    });

    it('sends explicit code requests through the guard, vote decides', async () => {
      for (const query of [
        'hi, write code',
        'ok script',
        'Write a Python function to sort a list',
      ]) {
        classifyAs('complex');
        const result = await routeQueryWithCfg(query);
        expect(result.reason).toBe('classifier-complex');
        expect(result.model).toBe('test-large-model');
      }
    });

    it('sends short confirmations and prefix-lookalikes through the guard', async () => {
      // The deleted deterministic-short regex used to decide these before
      // the guard ever saw them ('OK', 'Okay', 'high tier please', 'hit me').
      for (const query of [
        'OK',
        'Okay',
        'okay!',
        'hi!',
        'no, use postgres',
        'high tier please',
        'hit me',
      ]) {
        classifyAs('simple');
        const result = await routeQueryWithCfg(query);
        expect(result.reason).toBe('classifier-simple');
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        mockGenerate.mockClear();
      }
    });

    it('routes the canonical greeting-plus-substance prompt by its vote', async () => {
      // The user's #169 example: a greeting prefix must never drag a
      // substantive request into the exception tier.
      classifyAs('complex');
      const result = await routeQueryWithCfg('Hello! Please explain quantum tunneling to me.');
      expect(result.model).toBe('test-large-model');
      expect(result.reason).toBe('classifier-complex');
    });
  });

  describe('Vote parsing (the #169 phase-2 reply contract)', () => {
    it('extracts the last vote object from reasoning-clad replies', () => {
      // Reasoning models emit chain-of-thought ahead of the answer (#129):
      // an earlier worked-example object must not win over the final vote.
      const reply =
        'Considering the request, e.g. {"reasoning":"yes","code":"no","emotional":"no","creative":"no"} would be wrong here, so: {"reasoning":"no","code":"no","emotional":"no","creative":"no"}';
      expect(guardVerdictFromReply(reply)).toBe('simple');
    });

    it('skips decoy objects with no category keys', () => {
      expect(parseGuardVotes('{"foo":"bar"}')).toBeNull();
      expect(parseGuardVotes('prose {"note":"hi"} tail {"reasoning":"no"} end')).toEqual({
        reasoning: 'no',
      });
    });

    it('tolerates markdown fences and trailing punctuation around the object', () => {
      expect(
        guardVerdictFromReply(
          '```json\n{"reasoning":"no","code":"no","emotional":"no","creative":"no"}\n```',
        ),
      ).toBe('simple');
      expect(
        guardVerdictFromReply('{"reasoning":"yes","code":"no","emotional":"no","creative":"no"}.'),
      ).toBe('complex');
    });

    it('finds a vote nested inside a wrapper object', () => {
      expect(
        guardVerdictFromReply(
          '{"votes":{"reasoning":"no","code":"no","emotional":"no","creative":"no"}}',
        ),
      ).toBe('simple');
    });

    it('treats a missing category as a yes vote (doubt routes large)', () => {
      expect(guardVerdictFromReply('{"reasoning":"no","code":"no","emotional":"no"}')).toBe(
        'complex',
      );
    });

    it('treats any non-"no" value as a yes vote', () => {
      expect(
        guardVerdictFromReply('{"reasoning":"maybe","code":"no","emotional":"no","creative":"no"}'),
      ).toBe('complex');
      // Booleans are not the contract's yes/no strings — doubt routes large.
      expect(
        guardVerdictFromReply(
          '{"reasoning":false,"code":false,"emotional":false,"creative":false}',
        ),
      ).toBe('complex');
    });

    it('normalizes value case and surrounding whitespace', () => {
      expect(
        guardVerdictFromReply('{"reasoning":"NO","code":" No ","emotional":"no","creative":"no"}'),
      ).toBe('simple');
      expect(
        guardVerdictFromReply('{"reasoning":"YES","code":"no","emotional":"no","creative":"no"}'),
      ).toBe('complex');
    });

    it('returns null for empty or vote-less replies', () => {
      expect(guardVerdictFromReply('')).toBeNull();
      expect(guardVerdictFromReply('unsure')).toBeNull();
      // Truncated JSON (no closing brace) — the max_tokens failure shape.
      expect(guardVerdictFromReply('{"reasoning":"no","code":"no","emot')).toBeNull();
    });
  });

  describe('Classifier Routing', () => {
    it('should route any-yes votes to the larger model', async () => {
      classifyAs('complex');
      const result = await routeQueryWithCfg(
        'Explain the tradeoffs of event sourcing in distributed systems',
      );
      expect(mockGenerate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        model: 'test-large-model',
        reason: 'classifier-complex',
        provider: 'groq',
      });
    });

    it('should route all-no votes to the smaller model', async () => {
      classifyAs('simple');
      const result = await routeQueryWithCfg('Give me a one-line haiku about rain');
      expect(result).toEqual({
        model: 'test-small-model',
        reason: 'classifier-simple',
        provider: 'groq',
      });
    });

    it('should route a vote carried by reasoning prose to the larger model', async () => {
      guardReplies(
        'thinking... example {"reasoning":"no","code":"no","emotional":"no","creative":"no"} then final: {"reasoning":"yes","code":"no","emotional":"no","creative":"no"}',
      );
      const result = await routeQueryWithCfg('Advise a go-to-market plan for a new SaaS product');
      expect(result.reason).toBe('classifier-complex');
    });

    it('should fall back to the larger model when the classifier errors', async () => {
      guardReplies('', true);
      const result = await routeQueryWithCfg('Should I buy this car or that car?');
      expect(result).toEqual({
        model: 'test-large-model',
        reason: 'classifier-error',
        provider: 'groq',
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Classifier error:',
        expect.stringContaining('classifier down'),
      );
    });

    it('should fall back to the larger model on an unparseable reply', async () => {
      // A verdict-less reply is the exact LangSmith-observed failure that
      // routed the #129 conversation to the small tier: never default small.
      guardReplies('unsure');
      const result = await routeQueryWithCfg('Tell me about classic cars');
      expect(result).toEqual({
        model: 'test-large-model',
        reason: 'classifier-unparseable',
        provider: 'groq',
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith('Classifier unparseable reply:', 'unsure');
    });

    it('should fall back to the larger model on an empty reply', async () => {
      // #129: the guard model consumed its whole token budget on reasoning
      // and returned empty text on every retained trace.
      guardReplies('');
      const result = await routeQueryWithCfg('Hello there, how are you doing today?');
      expect(result).toEqual({
        model: 'test-large-model',
        reason: 'classifier-unparseable',
        provider: 'groq',
      });
    });

    it('sends the query and the vote contract to the guard classifier', async () => {
      classifyAs('simple');
      await routeQueryWithCfg('Give me investment advice');
      const [messages, options] = mockGenerate.mock.calls[0] as unknown as [
        { role: string; content: string }[],
        { modelSettings: { temperature: number } },
      ];
      const ctorArgs = mockAgentCtor.mock.calls[mockAgentCtor.mock.calls.length - 1] as unknown[];
      const ctorCall = (ctorArgs?.[0] ?? {}) as { model: string };
      expect(ctorCall.model).toBe('groq/test-guard-model');
      expect(options.modelSettings.temperature).toBe(0);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toContain('"reasoning"');
      expect(messages[0].content).toContain('"code"');
      expect(messages[0].content).toContain('Current request: Give me investment advice');
    });

    it('frames the categories and the small exception in the prompt (#129/#169)', async () => {
      classifyAs('simple');
      await routeQueryWithCfg(
        `Hello! We are going to Ad Gefrin this morning - last time I went it was literally just a plaque, now they have a whole museum. While we're up that way are there any other super cool historical sites we should swing past? That's the Cheviots if I'm not mistaken?`,
      );
      const prompt = lastGuardPrompt();
      expect(prompt).toContain('ONLY one JSON object');
      expect(prompt).toContain('explanation, analysis, multi-step reasoning');
      expect(prompt).toContain('writing, debugging, reviewing, or discussing code');
      expect(prompt).toContain('emotional support, comfort, or weighty personal talk');
      expect(prompt).toContain('creative writing');
      // The #169 asymmetry survives phase 2: greetings/thanks are named as
      // the all-no exception, and short factual one-liners stay small.
      expect(prompt).toContain('Greetings, thanks, and yes/no confirmations');
      expect(prompt).toContain('what is the capital of Australia?');
      expect(prompt).toContain('Ad Gefrin');
    });

    it('gives reasoning guard models room for the vote object (#129)', async () => {
      classifyAs('simple');
      await routeQueryWithCfg('Give me investment advice');
      const [, options] = mockGenerate.mock.calls[0] as unknown as [
        { role: string; content: string }[],
        { modelSettings: { temperature: number; maxOutputTokens: number } },
      ];
      // LangSmith evidence (#129): the reasoning guard model returned an
      // EMPTY answer at the old 10-token budget. #169 phase 2 raised the
      // default 256 → 512: with a conversation transcript in the prompt,
      // 256 truncated the vote JSON (budget-probe artifact).
      expect(options.modelSettings.maxOutputTokens).not.toBe(10);
      expect(options.modelSettings.maxOutputTokens).toBe(512);
      expect(options.modelSettings.temperature).toBe(0);
    });

    it('honors ROUTER_GUARD_MAX_TOKENS when set', async () => {
      process.env.ROUTER_GUARD_MAX_TOKENS = '64';
      classifyAs('simple');
      try {
        await routeQueryWithCfg('Give me investment advice');
        const [, options] = mockGenerate.mock.calls[0] as unknown as [
          { role: string; content: string }[],
          { modelSettings: { maxOutputTokens: number } },
        ];
        expect(options.modelSettings.maxOutputTokens).toBe(64);
      } finally {
        delete process.env.ROUTER_GUARD_MAX_TOKENS;
      }
    });

    it('#77: builds the classifier from a tool-free agent', async () => {
      classifyAs('simple');
      await routeQueryWithCfg('Give me investment advice');
      const ctorArgs = mockAgentCtor.mock.calls[mockAgentCtor.mock.calls.length - 1] as unknown[];
      const ctorCall = (ctorArgs?.[0] ?? {}) as { model: string; tools?: unknown };
      // The guard model rejects tool-carrying requests, so the agent must be
      // constructed without any `tools` argument at all.
      expect('tools' in ctorCall).toBe(false);
      expect(ctorCall.model).toBe('groq/test-guard-model');
    });
  });

  describe('Conversation context (#169 phase 2)', () => {
    const heavyWorkHistory = [
      { role: 'user' as const, content: 'help me design a postgres schema for our bookings app' },
      {
        role: 'assistant' as const,
        content: 'sure, here is a normalized schema with bookings and guests tables...',
      },
      { role: 'user' as const, content: 'the migrations keep failing on the foreign keys' },
      { role: 'assistant' as const, content: 'lets look at the constraint order then...' },
    ];
    const trivialHistory = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi! how can I help?' },
    ];

    it('shows the transcript to the guard, oldest first, without the current turn', async () => {
      classifyAs('complex');
      await routeQuery('no, use psql', TEST_CONFIG, undefined, { history: heavyWorkHistory });
      const prompt = lastGuardPrompt();
      expect(prompt).toContain('Conversation so far, oldest first:');
      expect(prompt.indexOf('bookings app')).toBeLessThan(prompt.indexOf('constraint order'));
      expect(prompt).toContain('user: help me design a postgres schema');
      expect(prompt).toContain('Current request: no, use psql');
    });

    it('bounds the transcript to the last ROUTER_GUARD_CONTEXT_MESSAGES (default 10)', async () => {
      const longHistory = Array.from({ length: 13 }, (_, i) => ({
        role: 'user' as const,
        content: `turn ${i}`,
      }));
      classifyAs('simple');
      await routeQuery('next', TEST_CONFIG, undefined, { history: longHistory });
      const prompt = lastGuardPrompt();
      expect(prompt).toContain('turn 3');
      expect(prompt).not.toContain('turn 0');
      expect(prompt).not.toContain('turn 2');
    });

    it('honors ROUTER_GUARD_CONTEXT_MESSAGES when set', async () => {
      process.env.ROUTER_GUARD_CONTEXT_MESSAGES = '3';
      const history = Array.from({ length: 6 }, (_, i) => ({
        role: 'user' as const,
        content: `turn ${i}`,
      }));
      classifyAs('simple');
      await routeQuery('next', TEST_CONFIG, undefined, { history });
      const prompt = lastGuardPrompt();
      expect(prompt).toContain('turn 3');
      expect(prompt).toContain('turn 5');
      expect(prompt).not.toContain('turn 2');
    });

    it('omits the transcript block entirely when history is absent', () => {
      expect(classifyPrompt('bare question')).not.toContain('Conversation so far');
      expect(classifyPrompt('bare question', [])).not.toContain('Conversation so far');
      expect(classifyPrompt('bare question', [])).toContain('Current request: bare question');
    });

    it('pins the context-sensitivity plumbing: same text, history decides', async () => {
      // The mocked votes stand in for the guard's context-sensitive
      // judgment (evidenced live by the spot-check); these pins prove the
      // history actually reaches the decision path.
      classifyAs('complex');
      const atWork = await routeQuery('no, use psql', TEST_CONFIG, undefined, {
        history: heavyWorkHistory,
      });
      expect(atWork.reason).toBe('classifier-complex');

      classifyAs('simple');
      const atChitChat = await routeQuery('no, use psql', TEST_CONFIG, undefined, {
        history: trivialHistory,
      });
      expect(atChitChat.reason).toBe('classifier-simple');
    });
  });

  describe('ε-random tier pools (#4 task 7)', () => {
    const pool = (
      models: ModelRef[],
    ): { small: ModelRef[]; large: ModelRef[]; guardModel: string } => ({
      small: models,
      large: models,
      guardModel: 'test-guard-model',
    });

    it('uses the single qualifying model deterministically', () => {
      expect(pickModelRef([groqSmall], 'small', 1, () => 0)).toBe(groqSmall);
      expect(pickModelRef([groqSmall], 'small', 1, () => 0.999)).toBe(groqSmall);
    });

    it('throws loudly when a tier has no eligible models (#4 G)', () => {
      expect(() => pickModelRef([], 'small', 1, () => 0)).toThrow(
        'No eligible models configured for tier: small',
      );
    });

    it('picks uniformly at random within a multi-model pool (eps default 1)', () => {
      const models = [groqSmall, groqLarge];
      const a = pickModelRef(models, 'small', 1, () => 0);
      const b = pickModelRef(models, 'small', 1, () => 0.49);
      const c = pickModelRef(models, 'small', 1, () => 0.51);
      expect(a).toBe(groqSmall);
      expect(b).toBe(groqSmall);
      expect(c).toBe(groqLarge);
    });

    it('exploits the first entry when the draw beats epsilon (eps < 1)', () => {
      const models = [groqSmall, groqLarge];
      // draw >= eps → exploit (first entry); draw < eps → explore (uniform,
      // from an independent draw so the explore/index probabilities decouple).
      expect(pickModelRef(models, 'small', 0.3, () => 0.31)).toBe(groqSmall);
      // First draw 0.2 < eps=0.3 explores; second draw selects the second entry.
      const draws = [0.2, 0.6];
      let i = 0;
      expect(pickModelRef(models, 'small', 0.3, () => draws[i++] ?? 0)).toBe(groqLarge);
    });

    it('is deterministic across eps=0', () => {
      const models = [groqSmall, groqLarge];
      expect(pickModelRef(models, 'small', 0, () => 0.99)).toBe(groqSmall);
    });

    it('routes a multi-model tier through the pool for a guard vote', async () => {
      classifyAs('complex');
      const result = await routeQuery(
        'Hello',
        pool([{ ...groqSmall }, { ...groqLarge }]),
        () => 0.9,
      );
      expect(result).toEqual({
        model: 'test-large-model',
        reason: 'classifier-complex',
        provider: 'groq',
      });
    });

    it('records the picked provider from the pool, not a hard-coded groq', async () => {
      // Non-trivial pool with a DeepInfra entry selected by the injected PRNG.
      classifyAs('complex');
      const result = await routeQuery(
        'Hello',
        pool([groqSmall, { provider: 'deepinfra', model: 'gemma-test' }]),
        () => 0.9,
      );
      expect(result.model).toBe('gemma-test');
      expect(result.provider).toBe('deepinfra');
    });
  });

  describe('Vision-aware routing (#115)', () => {
    const vlSmall: ModelRef = { provider: 'deepinfra', model: 'vl-small', vision: true };
    const vlLarge: ModelRef = { provider: 'deepinfra', model: 'vl-large', vision: true };
    const vlConfig = {
      small: [groqSmall, vlSmall],
      large: [groqLarge, vlLarge],
      guardModel: 'test-guard-model',
    };

    it('routes an image turn into the large vision pool only', async () => {
      const result = await routeQuery('what is in this picture?', vlConfig, () => 0, {
        hasImage: true,
      });
      expect(result).toEqual({
        model: 'vl-large',
        reason: 'image-attachment',
        provider: 'deepinfra',
      });
    });

    it('never calls the text-only classifier for an image turn', async () => {
      mockGenerate.mockClear();
      await routeQuery('a long detailed question about the diagram', vlConfig, () => 0.1, {
        hasImage: true,
      });
      expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('never falls back to a small vision model even when it is the only one', async () => {
      const smallOnlyConfig = { small: [vlSmall], large: [groqLarge], guardModel: 'x' };
      await expect(
        routeQuery('what is this?', smallOnlyConfig, () => 0, { hasImage: true }),
      ).rejects.toThrow('No vision-capable models configured for image attachments');
    });

    it('fails the turn loudly when no vision-capable model exists anywhere', async () => {
      const noVisionConfig = {
        small: [groqSmall],
        large: [groqLarge],
        guardModel: 'test-guard-model',
      };
      await expect(
        routeQuery('what is this?', noVisionConfig, () => 0, { hasImage: true }),
      ).rejects.toThrow('No vision-capable models configured for image attachments');
    });

    it('keeps guard behaviour for text-only turns', async () => {
      classifyAs('simple');
      const result = await routeQuery('Hello', vlConfig, () => 0.1);
      expect(result.model).toBe(groqSmall.model);
      expect(result.reason).toBe('classifier-simple');
    });
  });

  describe('contextLength propagation (#104)', () => {
    // #104: the chat routes size `max_tokens` against the routed model's
    // window, so every RoutingResult must carry (or omit) `contextLength`
    // exactly as its pool ref does.

    const pool = (small: ModelRef[], large: ModelRef[]) => ({
      small,
      large,
      guardModel: 'test-guard-model',
    });

    it('carries contextLength from the pool ref on a guard small pick', async () => {
      classifyAs('simple');
      const result = await routeQuery(
        'Hello',
        pool([{ provider: 'deepinfra', model: 'qwen', contextLength: 40960 }], [groqLarge]),
        () => 0.1,
      );
      expect(result).toMatchObject({ model: 'qwen', provider: 'deepinfra', contextLength: 40960 });
    });

    it('omits the key entirely when the ref has no contextLength (env fallback)', async () => {
      classifyAs('simple');
      const result = await routeQuery('Hello', pool([groqSmall], [groqLarge]), () => 0.1);
      expect('contextLength' in result).toBe(false);
      expect('reason' in result).toBe(true);
    });

    it('carries contextLength on the classifier-simple pool pick', async () => {
      classifyAs('simple');
      const result = await routeQuery(
        'Give me a summary of this document',
        pool([{ provider: 'groq', model: 'test-small-model', contextLength: 131072 }], [groqLarge]),
        () => 0.9,
      );
      expect(result.reason).toContain('classifier-simple');
      expect(result.contextLength).toBe(131072);
    });

    it('carries contextLength on the forced feedback pick and the classifier-error fallback', async () => {
      classifyAs('complex');
      const forced = await routeQuery(
        'Design a schema migration plan',
        pool(
          [groqSmall],
          [groqLarge, { provider: 'groq', model: 'test-small-model-2', contextLength: 8192 }],
        ),
        () => 0.9,
        {
          band: 'long|code',
          getFitWeight: async (_b, m) =>
            // FitWeight shape: weight=(ups+1)/(ups+downs+2) — see stat() below.
            m === 'test-large-model'
              ? { weight: 1 / 11, ups: 0, downs: 10 }
              : { weight: 1, ups: 10, downs: 0 },
        },
      );
      expect(forced.model).toBe('test-small-model-2');
      expect(forced.contextLength).toBe(8192);

      guardReplies('', true);
      const errored = await routeQuery(
        'Design a schema migration plan',
        pool([groqSmall], [{ provider: 'groq', model: 'test-large-model', contextLength: 55000 }]),
        () => 0.9,
      );
      expect(errored.reason).toContain('classifier-error');
      expect(errored.contextLength).toBe(55000);
    });
  });

  describe('Feedback weighting (#18, re-implemented on tier pools)', () => {
    const twoPool = (
      small: ModelRef[] = [groqSmall],
      large: ModelRef[] = [groqLarge, groqSmallAlt],
    ): { small: ModelRef[]; large: ModelRef[]; guardModel: string } => ({
      small,
      large,
      guardModel: 'test-guard-model',
    });

    const emptyStat = (): FitWeight => ({ weight: 1, ups: 0, downs: 0 });
    const stat = (ups: number, downs: number): FitWeight => ({
      weight: (ups + 1) / (ups + downs + 2),
      ups,
      downs,
    });

    const randomAt = (value: number) => () => value;

    it('is a pure perturbation: no tallies anywhere keeps ε behavior and no suffix', async () => {
      classifyAs('complex');
      const result = await routeQuery('Design a caching strategy', twoPool(), randomAt(0.1), {
        band: 'medium|code',
        getFitWeight: async () => emptyStat(),
      });
      expect(result.model).toBe('test-large-model');
      expect(result.reason).toBe('classifier-complex');
    });

    it('forces the best-fit pool entry when the leader ratio clears the flip ratio', async () => {
      classifyAs('complex');
      // Large pool: classifier-pick candidate has heavily negative data, the
      // rival cell is strongly positive → forced onto the rival.
      const result = await routeQuery(
        'Explain event sourcing tradeoffs',
        twoPool([groqSmall], [groqLarge, groqSmallAlt]),
        randomAt(0.9),
        {
          band: 'long|prose',
          getFitWeight: async (_band, model) =>
            model === 'test-small-model-2' ? stat(12, 2) : stat(0, 12),
        },
      );
      expect(result.model).toBe('test-small-model-2');
      expect(result.reason).toContain('classifier-complex');
      expect(result.reason).toContain(';feedback-weight:');
    });

    it('does not force a flip when the evidence is under the ratio', async () => {
      classifyAs('complex');
      // Leader (neutral empty cell, weight 1) vs 3/0 fit (weight 0.67):
      // ratio 1.5 ≥ 1.25 would force — set the leader score lower instead.
      const result = await routeQuery('Design a caching strategy', twoPool(), randomAt(0.9), {
        band: 'medium|code',
        getFitWeight: async (_band, model) =>
          model === 'test-small-model-2' ? stat(3, 0) : emptyStat(),
      });
      expect(result.model).toBe('test-large-model');
      // No flip, but the leader's tallies still surface in the reason.
      expect(result.reason).toContain('classifier-complex');
      expect(result.reason).toContain(';feedback-weight:1.00:0/0');
    });

    it('leaves the classifier-error fallback untouched by feedback', async () => {
      guardReplies('', true);
      const errored = await routeQuery(
        'Should I buy this or that car?',
        twoPool([groqSmall], [groqLarge, groqSmallAlt]),
        randomAt(0.9),
        { band: 'medium|prose', getFitWeight: async () => stat(20, 0) },
      );
      expect(errored.reason).toBe('classifier-error');
    });

    it('still works when no band is supplied', async () => {
      classifyAs('simple');
      const result = await routeQuery('Give me investment advice now', TEST_CONFIG, randomAt(0.5), {
        getFitWeight: async () => emptyStat(),
      });
      expect(result).toEqual({
        model: 'test-small-model',
        reason: 'classifier-simple',
        provider: 'groq',
      });
    });
  });

  describe('DB-config routing (#4 task 7)', () => {
    it('resolves tier pools from modelConfigService when no config is passed', async () => {
      mockCompletionsPoolFor.mockImplementation(async (tier: string) =>
        tier === 'small'
          ? [groqSmall, { provider: 'deepinfra', model: 'gemma-test' }]
          : [groqLarge],
      );
      classifyAs('simple');
      const result = await routeQuery('Tell me about classic cars', null, () => 0.9);
      expect(mockCompletionsPoolFor).toHaveBeenCalledWith('small');
      expect(mockCompletionsPoolFor).toHaveBeenCalledWith('large');
      expect(result.model).toBe('gemma-test');
      expect(result.reason).toBe('classifier-simple');
      expect(result.provider).toBe('deepinfra');
    });

    it('fails loudly when the completions pool resolves empty (#4 G, #94)', async () => {
      mockCompletionsPoolFor.mockResolvedValue([]);
      classifyAs('simple');
      await expect(routeQuery('Hello')).rejects.toThrow('No eligible models configured for tier');
    });
  });

  describe('Routing metadata contract', () => {
    it('always returns a model and a human-readable reason', async () => {
      const cases: Promise<Routing>[] = [
        (async () => {
          classifyAs('simple');
          return routeQueryWithCfg('Hello');
        })(),
        (async () => {
          classifyAs('complex');
          return routeQueryWithCfg('write code');
        })(),
        (async () => {
          classifyAs('complex');
          return routeQueryWithCfg('Design a caching strategy');
        })(),
        (async () => {
          guardReplies('', true);
          return routeQueryWithCfg('Pick a color for me out of two options');
        })(),
      ];
      const results = await Promise.all(cases);
      for (const { model, reason, provider } of results) {
        expect(model).toMatch(/^test-(small|large)-model(-2)?$/);
        expect(typeof reason).toBe('string');
        expect(reason.length).toBeGreaterThan(0);
        expect(provider).toBe('groq');
      }
    });
  });
});
