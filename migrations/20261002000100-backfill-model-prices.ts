import { MigrationInterface } from 'mongo-migrate-ts';
import { Db } from 'mongodb';

/*
 * #199: backfill input/output prices onto the 14 #170 DeepInfra large-tier
 * rows. Rows already exist (seeded by the #170 migration or the app), so this
 * is a backfill, not a seed — hence `$set` on the two price fields rather
 * than `$setOnInsert`. Touching only `inputPrice`/`outputPrice` means a re-run
 * still never clobbers an admin edit to eligibility/capabilities, and rows
 * with no tabulated price (pre-#170) are left untouched ("unknown", not
 * zero — see #199 OQ-3).
 *
 * Prices are USD per 1M tokens from the #170 catalog table
 * (docs/done/plan-170-more-models.md:200-215), which was dumped from
 * DeepInfra's live catalog on 2026-09-26. They mirror SEED_ENTRIES in
 * `modelConfigService.ts` exactly; the drift test pins the two together.
 */
const PRICES: Array<{
  provider: 'deepinfra';
  model: string;
  tier: 'large';
  inputPrice: number;
  outputPrice: number;
}> = [
  {
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    tier: 'large',
    inputPrice: 1.3,
    outputPrice: 2.6,
  },
  {
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash',
    tier: 'large',
    inputPrice: 0.2,
    outputPrice: 0.6,
  },
  {
    provider: 'deepinfra',
    model: 'moonshotai/Kimi-K3',
    tier: 'large',
    inputPrice: 2.85,
    outputPrice: 14.25,
  },
  {
    provider: 'deepinfra',
    model: 'moonshotai/Kimi-K2.6',
    tier: 'large',
    inputPrice: 0.75,
    outputPrice: 3.5,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3.8-2.4T-A95B',
    tier: 'large',
    inputPrice: 2,
    outputPrice: 6,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3.5-397B-A17B',
    tier: 'large',
    inputPrice: 0.45,
    outputPrice: 3,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-VL-235B-A22B-Instruct',
    tier: 'large',
    inputPrice: 0.2,
    outputPrice: 0.88,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo',
    tier: 'large',
    inputPrice: 0.3,
    outputPrice: 1,
  },
  {
    provider: 'deepinfra',
    model: 'zai-org/GLM-5.3',
    tier: 'large',
    inputPrice: 0.9,
    outputPrice: 4,
  },
  {
    provider: 'deepinfra',
    model: 'zai-org/GLM-5.3-Flash',
    tier: 'large',
    inputPrice: 0.15,
    outputPrice: 0.5,
  },
  {
    provider: 'deepinfra',
    model: 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B',
    tier: 'large',
    inputPrice: 0.5,
    outputPrice: 2.2,
  },
  {
    provider: 'deepinfra',
    model: 'XiaomiMiMo/MiMo-V2.6-Pro',
    tier: 'large',
    inputPrice: 0.435,
    outputPrice: 0.87,
  },
  {
    provider: 'deepinfra',
    model: 'MiniMaxAI/MiniMax-M3',
    tier: 'large',
    inputPrice: 0.28,
    outputPrice: 1.1,
  },
  {
    provider: 'deepinfra',
    model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    tier: 'large',
    inputPrice: 0.085,
    outputPrice: 0.4,
  },
];

export class BackfillModelPrices implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const { provider, model, tier, inputPrice, outputPrice } of PRICES) {
      await db
        .collection('providerroutings')
        .updateOne({ provider, model, tier }, { $set: { inputPrice, outputPrice } });
    }
  }

  async down(db: Db): Promise<void> {
    for (const { provider, model, tier } of PRICES) {
      await db
        .collection('providerroutings')
        .updateOne({ provider, model, tier }, { $unset: { inputPrice: '', outputPrice: '' } });
    }
  }
}
