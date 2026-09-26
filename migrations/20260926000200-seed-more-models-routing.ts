import { MigrationInterface } from 'mongo-migrate-ts';
import { Db } from 'mongodb';

/*
 * #170: seed 14 more DeepInfra large-tier completion rows into upgraded
 * deployments (app-level seeding is empty-pool recovery only, so non-empty
 * pools need the migration). Row content mirrors SEED_ENTRIES in
 * `modelConfigService.ts` exactly — ZDR-only (no Google/Anthropic partner
 * models), catalog + live-probed on DeepInfra 2026-09-26 (tools for all;
 * image parts for the `vision: true` rows).
 *
 * `$setOnInsert` on purpose (never `$set`): admin edits to existing rows —
 * e.g. a model deleted in the Models admin — must never be clobbered by a
 * re-run. Two deliberate divergences from the Qwen3Vl migration precedent,
 * both because this writes through the raw driver and bypasses mongoose
 * schema defaults: every row carries `disabledUntil: null` (#168 seed shape,
 * field present-on-insert) and text rows carry `vision: false` explicitly.
 */
const ROWS: Array<{
  provider: 'deepinfra';
  model: string;
  tier: 'large';
  eligible: boolean;
  tools: boolean;
  vision: boolean;
  contextLength: number;
  disabledUntil: null;
}> = [
  {
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 1048576,
    disabledUntil: null,
  },
  {
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 1048576,
    disabledUntil: null,
  },
  {
    provider: 'deepinfra',
    model: 'moonshotai/Kimi-K3',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 1048576,
    disabledUntil: null,
  },
  {
    provider: 'deepinfra',
    model: 'moonshotai/Kimi-K2.6',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 262144,
    disabledUntil: null,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3.8-2.4T-A95B',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 262144,
    disabledUntil: null,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3.5-397B-A17B',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 262144,
    disabledUntil: null,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-VL-235B-A22B-Instruct',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 262144,
    disabledUntil: null,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 262144,
    disabledUntil: null,
  },
  {
    provider: 'deepinfra',
    model: 'zai-org/GLM-5.3',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 1048576,
    disabledUntil: null,
  },
  {
    provider: 'deepinfra',
    model: 'zai-org/GLM-5.3-Flash',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 1048576,
    disabledUntil: null,
  },
  {
    provider: 'deepinfra',
    model: 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 262144,
    disabledUntil: null,
  },
  {
    provider: 'deepinfra',
    model: 'XiaomiMiMo/MiMo-V2.6-Pro',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 1048576,
    disabledUntil: null,
  },
  {
    provider: 'deepinfra',
    model: 'MiniMaxAI/MiniMax-M3',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 524288,
    disabledUntil: null,
  },
  {
    provider: 'deepinfra',
    model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: false,
    contextLength: 262144,
    disabledUntil: null,
  },
];

export class SeedMoreModelsRouting implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const row of ROWS) {
      await db
        .collection('providerroutings')
        .updateOne(
          { provider: row.provider, model: row.model, tier: row.tier },
          { $setOnInsert: row },
          { upsert: true },
        );
    }
  }

  async down(db: Db): Promise<void> {
    for (const row of ROWS) {
      await db.collection('providerroutings').deleteOne({
        provider: row.provider,
        model: row.model,
        tier: row.tier,
      });
    }
  }
}
