import { ProviderRouting } from '../models/ProviderRouting';
import { completionsPoolFor, disableModel, listByTier, ModelRef } from './modelConfigService';
import { muteConsoleError } from '../test/muteConsole';

const TIER_ENV_VARS = {
  small: 'ROUTER_SMALL_MODEL',
  large: 'ROUTER_LARGE_MODEL',
  guard: 'ROUTER_GUARD_MODEL',
} as const;

describe('Model Config Service', () => {
  describe('seeding', () => {
    it('seeds DeepInfra completion pools plus the Groq guard on first read', async () => {
      const small = await listByTier('small');
      // gemma-3-4b-it is seeded ineligible (user veto, #115): the row exists
      // for history coherence but must never appear in any pool.
      expect(small).toEqual(
        expect.arrayContaining([
          {
            provider: 'deepinfra',
            model: 'openai/gpt-oss-20b',
            tools: true,
            contextLength: 131072,
            vision: false,
          },
          {
            provider: 'deepinfra',
            model: 'Qwen/Qwen3-14B',
            tools: true,
            vision: false,
            contextLength: 40960,
          },
        ]),
      );
      expect(await listByTier('large')).toEqual(
        expect.arrayContaining([
          {
            provider: 'deepinfra',
            model: 'openai/gpt-oss-120b',
            tools: true,
            vision: false,
            contextLength: 131072,
          },
          {
            provider: 'deepinfra',
            model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
            tools: true,
            vision: false,
            contextLength: 262144,
          },
          {
            provider: 'deepinfra',
            model: 'deepseek-ai/DeepSeek-V3.2',
            tools: true,
            vision: false,
            contextLength: 163840,
          },
          {
            provider: 'deepinfra',
            model: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
            tools: true,
            vision: false,
            contextLength: 1048576,
          },
          // #115 image pool: all image turns route through the large tier,
          // both vision rows probed on DeepInfra (image parts + tool calls).
          {
            provider: 'deepinfra',
            model: 'Qwen/Qwen3-VL-8B-Instruct',
            tools: true,
            vision: true,
            contextLength: 262144,
          },
          {
            provider: 'deepinfra',
            model: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
            tools: true,
            vision: true,
            contextLength: 262144,
          },
          // #170 batch: 14 more DeepInfra large-tier rows (ZDR-only: no
          // Google/Anthropic partner models), catalog + live-probed
          // 2026-09-26 (tools for all, image parts for the vision rows).
          {
            provider: 'deepinfra',
            model: 'deepseek-ai/DeepSeek-V4-Pro-0813',
            tools: true,
            vision: false,
            contextLength: 1048576,
          },
          {
            provider: 'deepinfra',
            model: 'deepseek-ai/DeepSeek-V4.1-Flash',
            tools: true,
            vision: true,
            contextLength: 1048576,
          },
          {
            provider: 'deepinfra',
            model: 'moonshotai/Kimi-K3',
            tools: true,
            vision: true,
            contextLength: 1048576,
          },
          {
            provider: 'deepinfra',
            model: 'moonshotai/Kimi-K2.6',
            tools: true,
            vision: true,
            contextLength: 262144,
          },
          {
            provider: 'deepinfra',
            model: 'Qwen/Qwen3.8-2.4T-A95B',
            tools: true,
            vision: false,
            contextLength: 262144,
          },
          {
            provider: 'deepinfra',
            model: 'Qwen/Qwen3.5-397B-A17B',
            tools: true,
            vision: true,
            contextLength: 262144,
          },
          {
            provider: 'deepinfra',
            model: 'Qwen/Qwen3-VL-235B-A22B-Instruct',
            tools: true,
            vision: true,
            contextLength: 262144,
          },
          {
            provider: 'deepinfra',
            model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo',
            tools: true,
            vision: false,
            contextLength: 262144,
          },
          {
            provider: 'deepinfra',
            model: 'zai-org/GLM-5.3',
            tools: true,
            vision: false,
            contextLength: 1048576,
          },
          {
            provider: 'deepinfra',
            model: 'zai-org/GLM-5.3-Flash',
            tools: true,
            vision: true,
            contextLength: 1048576,
          },
          {
            provider: 'deepinfra',
            model: 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B',
            tools: true,
            vision: false,
            contextLength: 262144,
          },
          {
            provider: 'deepinfra',
            model: 'XiaomiMiMo/MiMo-V2.6-Pro',
            tools: true,
            vision: true,
            contextLength: 1048576,
          },
          {
            provider: 'deepinfra',
            model: 'MiniMaxAI/MiniMax-M3',
            tools: true,
            vision: true,
            contextLength: 524288,
          },
          {
            provider: 'deepinfra',
            model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
            tools: true,
            vision: false,
            contextLength: 262144,
          },
        ]),
      );
      expect(await listByTier('guard')).toEqual([
        { provider: 'groq', model: 'openai/gpt-oss-20b', tools: true, vision: false },
      ]);
      // 3 small (incl. ineligible gemma) + 20 large (6 + 14 #170 rows) + 1 guard.
      expect(await ProviderRouting.countDocuments()).toBe(24);
    });

    it('gemma-3-4b-it never appears in any pool (user veto, #115)', async () => {
      await listByTier('small');
      await listByTier('large');
      const smallModels = (await listByTier('small')).map(({ model }) => model);
      const largeModels = (await listByTier('large')).map(({ model }) => model);
      expect(smallModels).not.toContain('google/gemma-3-4b-it');
      expect(largeModels).not.toContain('google/gemma-3-4b-it');
    });

    it('completions never seed Groq rows (#94)', async () => {
      await listByTier('small');
      expect(await ProviderRouting.countDocuments({ provider: 'groq', tier: 'small' })).toBe(0);
      expect(await ProviderRouting.countDocuments({ provider: 'groq', tier: 'large' })).toBe(0);
    });

    it('seeding is idempotent across repeated reads', async () => {
      await listByTier('small');
      await listByTier('large');
      await listByTier('small');
      expect(await ProviderRouting.countDocuments()).toBe(24);
    });
  });

  describe('cool-off seed shape (#168)', () => {
    it('seeds fresh rows with disabledUntil null', async () => {
      await listByTier('small');
      const row = (await ProviderRouting.findOne({ model: 'Qwen/Qwen3-14B' }).lean<{
        disabledUntil?: Date | null;
      }>())!;
      expect(row.disabledUntil).toBeNull();
    });

    it('re-seeding an already-seeded row preserves an in-flight cool-off (#168)', async () => {
      await listByTier('small'); // ensure the row exists first
      const until = new Date(Date.now() + 6 * 60 * 60 * 1000);
      await ProviderRouting.updateOne(
        { provider: 'deepinfra', model: 'openai/gpt-oss-20b', tier: 'small' },
        { disabledUntil: until },
      );
      await listByTier('small'); // re-seed is a no-op upsert, must not reset
      const row = await ProviderRouting.findOne({
        provider: 'deepinfra',
        model: 'openai/gpt-oss-20b',
        tier: 'small',
      }).lean<{ disabledUntil: Date | null }>();
      expect(row?.disabledUntil?.getTime()).toBe(until.getTime());
    });

    it('legacy rows without the field never cool off (missing = not disabled)', async () => {
      await listByTier('guard');
      // Simulate a pre-#168 doc: strip the field below the schema layer.
      const raw = await ProviderRouting.collection.findOneAndUpdate(
        { tier: 'guard' },
        { $unset: { disabledUntil: '' } },
      );
      expect(raw).not.toBeNull();
      const row = (await ProviderRouting.findOne({ tier: 'guard' }).lean<{
        disabledUntil?: Date | null;
      }>())!;
      expect(row.disabledUntil ?? null).toBeNull();
    });
  });

  describe('cool-off pool exclusion (#168)', () => {
    it('disableModel immediately drops the model from its tier pools', async () => {
      await listByTier('small');
      await listByTier('large');
      await disableModel('deepinfra', 'deepseek-ai/DeepSeek-V3.2');
      expect((await listByTier('large')).map(({ model }) => model)).not.toContain(
        'deepseek-ai/DeepSeek-V3.2',
      );
      expect((await completionsPoolFor('large')).map(({ model }) => model)).not.toContain(
        'deepseek-ai/DeepSeek-V3.2',
      );
    });

    it('a cooling-off row is not re-seeded back to eligibility', async () => {
      await listByTier('large');
      await disableModel('deepinfra', 'deepseek-ai/DeepSeek-V3.2');
      await listByTier('large'); // triggers (no-op) seeding again
      expect((await listByTier('large')).map(({ model }) => model)).not.toContain(
        'deepseek-ai/DeepSeek-V3.2',
      );
    });

    it('an expired cool-off returns the model to the pools (lazy expiry, no timers)', async () => {
      await listByTier('large');
      await ProviderRouting.updateMany(
        { provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V3.2' },
        { disabledUntil: new Date(Date.now() - 1) },
      );
      expect((await listByTier('large')).map(({ model }) => model)).toContain(
        'deepseek-ai/DeepSeek-V3.2',
      );
    });
  });

  describe('env fallback', () => {
    it('falls back to a DeepInfra model when the collection is unusable (#94)', async () => {
      process.env.ROUTER_SMALL_MODEL = 'env-fallback-model';
      const insertSpy = jest
        .spyOn(ProviderRouting, 'updateOne')
        .mockRejectedValue(new Error('db down'));
      const consoleErrorSpy = muteConsoleError();
      try {
        expect(await listByTier('small')).toEqual([
          { provider: 'deepinfra', model: 'env-fallback-model' },
        ]);
      } finally {
        insertSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        delete process.env.ROUTER_SMALL_MODEL;
      }
    });

    it.each(['small', 'large'] as const)(
      'honours completion env overrides as DeepInfra refs (%s)',
      async (tier: 'small' | 'large') => {
        process.env[TIER_ENV_VARS[tier]] = `env-override-${tier}`;
        const snapshot = (await ProviderRouting.find({ tier }).lean()) as Record<string, unknown>[];
        try {
          await ProviderRouting.deleteMany({ tier });
          const refs = await listByTier(tier);
          expect(refs).toEqual(
            expect.arrayContaining([
              {
                provider: 'deepinfra',
                model: `env-override-${tier}`,
                tools: true,
                vision: false,
                contextLength: 131072,
              },
            ]),
          );
        } finally {
          delete process.env[TIER_ENV_VARS[tier]];
          await ProviderRouting.deleteMany({ model: `env-override-${tier}` });
          await ProviderRouting.insertMany(
            snapshot.map((doc) => {
              delete doc._id;
              return doc;
            }),
          );
        }
      },
    );

    it('falls back to the env-configured model when reads fail', async () => {
      process.env.ROUTER_SMALL_MODEL = 'env-fallback-model';
      const findSpy = jest.spyOn(ProviderRouting, 'find').mockImplementation(() => {
        throw new Error('db down');
      });
      const consoleErrorSpy = muteConsoleError();
      try {
        expect(await listByTier('small')).toEqual([
          { provider: 'deepinfra', model: 'env-fallback-model' },
        ]);
      } finally {
        findSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        delete process.env.ROUTER_SMALL_MODEL;
      }
    });
  });

  describe('capabilities', () => {
    it('persists capability flags on first seed', async () => {
      await listByTier('small');
      const gemma = await ProviderRouting.findOne({ model: 'google/gemma-3-4b-it' }).lean<{
        vision?: boolean;
        tools?: boolean;
      }>();
      expect(gemma).toMatchObject({ tools: true, vision: true });
    });

    it('re-seeding never clobbers stored capabilities (dirty $setOnInsert)', async () => {
      await listByTier('small');
      await ProviderRouting.updateOne(
        { model: 'google/gemma-3-4b-it' },
        { vision: false, contextLength: 999 },
      );
      await listByTier('small');
      await listByTier('large');
      const gemma = await ProviderRouting.findOne({ model: 'google/gemma-3-4b-it' }).lean<{
        vision?: boolean;
        contextLength?: number;
      }>();
      expect(gemma).toMatchObject({ vision: false, contextLength: 999 });
    });
  });

  describe('capability matching (#94)', () => {
    it('rules out models flagged tools:false from the completions pool', async () => {
      await listByTier('small');
      // Read-back flip: findOneAndUpdate returns the mutated doc, so the
      // assertion below can only fail if the mutation itself was lost (an
      // infra-level stale-read/lost-write), not if updateOne silently
      // matched nothing.
      const flipped = (await ProviderRouting.findOneAndUpdate(
        { model: 'openai/gpt-oss-20b' },
        { $set: { tools: false } },
        { new: true },
      ).lean<{ tools?: boolean }>()) as { tools?: boolean } | null;
      expect(flipped).not.toBeNull();
      expect(flipped?.tools).toBe(false);
      try {
        const models = (await completionsPoolFor('small')).map(({ model }) => model);
        expect(models).not.toContain('openai/gpt-oss-20b');
        expect(models).not.toContain('google/gemma-3-4b-it');
        expect(models).toContain('Qwen/Qwen3-14B');
      } finally {
        await ProviderRouting.updateOne({ model: 'openai/gpt-oss-20b' }, { tools: true });
      }
    });

    it('returns an empty pool — never a fallback — when no row meets the requirement', async () => {
      await listByTier('small');
      await ProviderRouting.updateMany({ tier: 'small' }, { tools: false });
      try {
        expect(await completionsPoolFor('small')).toEqual([]);
      } finally {
        await ProviderRouting.updateMany({ tier: 'small' }, { tools: true });
      }
    });

    it('filters on vision for the #115 image pool (large tier)', async () => {
      await listByTier('large');
      const visionModels = (await listByTier('large', { vision: true })).map(({ model }) => model);
      // Sorted `provider, model` (binary collation: uppercase first, `-` < `.`);
      // 2 #115 rows + 8 #170 vision rows; all image turns route through here.
      expect(visionModels).toEqual([
        'MiniMaxAI/MiniMax-M3',
        'Qwen/Qwen3-VL-235B-A22B-Instruct',
        'Qwen/Qwen3-VL-30B-A3B-Instruct',
        'Qwen/Qwen3-VL-8B-Instruct',
        'Qwen/Qwen3.5-397B-A17B',
        'XiaomiMiMo/MiMo-V2.6-Pro',
        'deepseek-ai/DeepSeek-V4.1-Flash',
        'moonshotai/Kimi-K2.6',
        'moonshotai/Kimi-K3',
        'zai-org/GLM-5.3-Flash',
      ]);
    });

    it('a missing capability field rules nothing out under schema defaults', async () => {
      await listByTier('guard');
      const missingCaps = await ProviderRouting.findOne({ tier: 'guard' }).lean<{
        tools?: boolean;
      }>();
      if (missingCaps && missingCaps.tools === undefined) {
        expect(await listByTier('guard', { tools: true })).toEqual([
          { provider: 'groq', model: 'openai/gpt-oss-20b' },
        ]);
      }
    });
  });

  describe('completion provider pinning (#117)', () => {
    const seedStaleGroqRow = async (tier: 'small' | 'large') => {
      await listByTier('guard'); // ensure the guard seed exists too
      await ProviderRouting.create({
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
        tier,
        eligible: true,
        tools: true,
      });
    };

    it('completionsPoolFor excludes Groq rows entirely', async () => {
      await seedStaleGroqRow('small');
      try {
        const pool = await completionsPoolFor('small');
        expect(pool.length).toBeGreaterThan(0);
        expect(pool.map(({ provider }) => provider)).toEqual(expect.not.arrayContaining(['groq']));
      } finally {
        await ProviderRouting.deleteMany({ provider: 'groq', tier: 'small' });
      }
    });

    it.each(['small', 'large'] as const)(
      'completionsPoolFor never returns Groq rows, even seeded stale ones (%s)',
      async (tier: 'small' | 'large') => {
        await seedStaleGroqRow(tier);
        try {
          const refs = await completionsPoolFor(tier);
          expect(refs.map(({ provider }) => provider)).toEqual(
            expect.not.arrayContaining(['groq']),
          );
        } finally {
          await ProviderRouting.deleteMany({ provider: 'groq', tier });
        }
      },
    );

    it('the guard tier still reads Groq rows with the same read path', async () => {
      await listByTier('guard');
      const refs = await listByTier('guard');
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.every(({ provider }) => provider === 'groq')).toBe(true);
    });

    it('an all-Groq completion tier yields an empty pool, never a Groq fallback', async () => {
      await seedStaleGroqRow('small');
      await ProviderRouting.updateMany(
        { tier: 'small', provider: 'deepinfra' },
        { eligible: false },
      );
      try {
        expect(await completionsPoolFor('small')).toEqual([]);
      } finally {
        await ProviderRouting.deleteMany({ tier: 'small' });
      }
    });
  });

  describe('eligible filtering', () => {
    it('excludes ineligible entries and falls back to the DeepInfra default', async () => {
      await listByTier('small');
      await ProviderRouting.updateMany({ tier: 'small' }, { eligible: false });
      const small = (await listByTier('small', { tools: true })) as ModelRef[];
      expect(small).toEqual([{ provider: 'deepinfra', model: 'openai/gpt-oss-20b' }]);
    });

    it('falls back to env when all entries for a tier are ineligible', async () => {
      await listByTier('guard');
      process.env.ROUTER_GUARD_MODEL = 'env-guard-model';
      await ProviderRouting.updateMany({ tier: 'guard' }, { eligible: false });
      try {
        expect(await listByTier('guard')).toEqual([
          { provider: 'groq', model: 'env-guard-model', tools: true, vision: false },
        ]);
      } finally {
        delete process.env.ROUTER_GUARD_MODEL;
      }
    });
  });

  describe('concurrent first reads', () => {
    it('survives concurrent seeding without duplicates or errors', async () => {
      await Promise.all([listByTier('small'), listByTier('small'), listByTier('small')]);
      expect(await ProviderRouting.countDocuments()).toBe(24);
    });
  });
});
