import { ProviderRouting } from '../models/ProviderRouting';
import { completionsPoolFor, listByTier, ModelRef } from './modelConfigService';
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
            model: 'google/gemma-3-4b-it',
            tools: true,
            vision: true,
            contextLength: 131072,
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
        ]),
      );
      expect(await listByTier('guard')).toEqual([
        { provider: 'groq', model: 'openai/gpt-oss-20b', tools: true, vision: false },
      ]);
      expect(await ProviderRouting.countDocuments()).toBe(8);
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
      expect(await ProviderRouting.countDocuments()).toBe(8);
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
      await ProviderRouting.updateOne({ model: 'openai/gpt-oss-20b' }, { tools: false });
      try {
        const models = (await completionsPoolFor('small')).map(({ model }) => model);
        expect(models).not.toContain('openai/gpt-oss-20b');
        expect(models).toContain('google/gemma-3-4b-it');
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

    it('filters on vision so future VLM routing can require image-capable rows', async () => {
      await listByTier('small');
      const visionModels = (await listByTier('small', { vision: true })).map(({ model }) => model);
      expect(visionModels).toEqual(['google/gemma-3-4b-it']);
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
      expect(await ProviderRouting.countDocuments()).toBe(8);
    });
  });
});
