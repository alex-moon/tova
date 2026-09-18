import { ProviderRouting } from '../models/ProviderRouting';
import { listByTier, type ModelRef } from './modelConfigService';
import { muteConsoleError } from '../test/muteConsole';

const TIER_ENV_VARS = {
  small: 'ROUTER_SMALL_MODEL',
  large: 'ROUTER_LARGE_MODEL',
  guard: 'ROUTER_GUARD_MODEL',
} as const;

describe('Model Config Service', () => {
  describe('seeding', () => {
    it('seeds Groq plus DeepInfra entries on first read and returns them', async () => {
      const small = await listByTier('small');
      expect(small).toEqual(
        expect.arrayContaining([
          { provider: 'groq', model: 'openai/gpt-oss-20b' },
          { provider: 'deepinfra', model: 'google/gemma-3-4b-it' },
        ]),
      );
      expect(await listByTier('large')).toEqual(
        expect.arrayContaining([
          { provider: 'groq', model: 'openai/gpt-oss-120b' },
          { provider: 'deepinfra', model: 'Qwen/Qwen2.5-72B-Instruct' },
        ]),
      );
      expect(await listByTier('guard')).toEqual([{ provider: 'groq', model: 'allam-2-7b' }]);
      expect(await ProviderRouting.countDocuments()).toBe(5);
    });

    it('seeding is idempotent across repeated reads', async () => {
      await listByTier('small');
      await listByTier('large');
      await listByTier('small');
      expect(await ProviderRouting.countDocuments()).toBe(5);
    });
  });

  describe('env fallback', () => {
    it('falls back to the env-configured model when the collection is unusable', async () => {
      process.env.ROUTER_SMALL_MODEL = 'env-fallback-model';
      const insertSpy = jest
        .spyOn(ProviderRouting, 'updateOne')
        .mockRejectedValue(new Error('db down'));
      const consoleErrorSpy = muteConsoleError();
      try {
        expect(await listByTier('small')).toEqual([
          { provider: 'groq', model: 'env-fallback-model' },
        ]);
      } finally {
        insertSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        delete process.env.ROUTER_SMALL_MODEL;
      }
    });

    it.each(['small', 'large', 'guard'] as const)(
      'reads env overrides into the seed (%s)',
      async (tier) => {
        process.env[TIER_ENV_VARS[tier]] = `seeded-env-${tier}`;
        try {
          const models = await listByTier(tier);
          expect(models).toContainEqual({ provider: 'groq', model: `seeded-env-${tier}` });
        } finally {
          delete process.env[TIER_ENV_VARS[tier]];
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
          { provider: 'groq', model: 'env-fallback-model' },
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

  describe('eligible filtering', () => {
    it('excludes ineligible entries from listByTier', async () => {
      await listByTier('small');
      await ProviderRouting.updateMany({ provider: 'deepinfra' }, { eligible: false });
      const small = (await listByTier('small')) as ModelRef[];
      expect(small).toEqual([{ provider: 'groq', model: 'openai/gpt-oss-20b' }]);
    });

    it('falls back to env when all entries for a tier are ineligible', async () => {
      await listByTier('guard');
      process.env.ROUTER_GUARD_MODEL = 'env-guard-model';
      await ProviderRouting.updateMany({ tier: 'guard' }, { eligible: false });
      try {
        expect(await listByTier('guard')).toEqual([{ provider: 'groq', model: 'env-guard-model' }]);
      } finally {
        delete process.env.ROUTER_GUARD_MODEL;
      }
    });
  });

  describe('concurrent first reads', () => {
    it('survives concurrent seeding without duplicates or errors', async () => {
      await Promise.all([listByTier('small'), listByTier('small'), listByTier('small')]);
      expect(await ProviderRouting.countDocuments()).toBe(5);
    });
  });
});
