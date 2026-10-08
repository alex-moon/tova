import { MigrationInterface } from 'mongo-migrate-ts';
import { Db } from 'mongodb';

/*
 * #232: seed the fixed model roster into a new `modelroster` collection.
 *
 * The roster replaces the tier-shaped `providerroutings` rows for the racing
 * path: one document per MODEL with a nested `providers[]` list carrying both
 * serverless backends. The tier collection is deliberately untouched — its
 * deletion is #233, and app-level seeding (`rosterConfig.ensureSeed`) only
 * recovers an EMPTY collection, so upgrades need this migration.
 *
 * Row content mirrors `ROSTER_SEED` in `src/server/services/rosterConfig.ts`
 * exactly (drift is pinned by a test). Owner-locked roster, verified live on
 * DeepInfra and Fireworks serverless, 2026-10-08:
 *   - DeepSeek V4.1 Flash  → deepinfra `deepseek-ai/DeepSeek-V4.1-Flash`,
 *                            fireworks `accounts/fireworks/models/deepseek-v4p1-flash`
 *   - GLM 5.3 Flash        → deepinfra `zai-org/GLM-5.3-Flash`,
 *                            fireworks `accounts/fireworks/models/glm-5p3-flash`
 *   - MiniMax M3           → deepinfra `MiniMaxAI/MiniMax-M3`,
 *                            fireworks `accounts/fireworks/models/minimax-m3`
 *
 * `$setOnInsert` on purpose: an admin edit to an existing roster document
 * (eligibility, enabled providers, TTFT history) must never be clobbered by a
 * re-run.
 */
const ROWS = [
  {
    modelId: 'deepseek-ai/DeepSeek-V4.1-Flash',
    label: 'DeepSeek V4.1 Flash',
    tools: true,
    vision: true,
    contextLength: 1048576,
    inputPrice: 0.2,
    outputPrice: 0.6,
    eligible: true,
    providers: [
      {
        provider: 'deepinfra',
        modelId: 'deepseek-ai/DeepSeek-V4.1-Flash',
        inputPrice: 0.2,
        outputPrice: 0.6,
        enabled: true,
        disabledUntil: null,
      },
      {
        provider: 'fireworks',
        modelId: 'accounts/fireworks/models/deepseek-v4p1-flash',
        inputPrice: 0.3,
        outputPrice: 1.2,
        enabled: true,
        disabledUntil: null,
      },
    ],
  },
  {
    modelId: 'zai-org/GLM-5.3-Flash',
    label: 'GLM 5.3 Flash',
    tools: true,
    vision: true,
    contextLength: 1048576,
    inputPrice: 0.15,
    outputPrice: 0.5,
    eligible: true,
    providers: [
      {
        provider: 'deepinfra',
        modelId: 'zai-org/GLM-5.3-Flash',
        inputPrice: 0.15,
        outputPrice: 0.5,
        enabled: true,
        disabledUntil: null,
      },
      {
        provider: 'fireworks',
        modelId: 'accounts/fireworks/models/glm-5p3-flash',
        inputPrice: 0.15,
        outputPrice: 0.5,
        enabled: true,
        disabledUntil: null,
      },
    ],
  },
  {
    modelId: 'MiniMaxAI/MiniMax-M3',
    label: 'MiniMax M3',
    tools: true,
    // Text-only: Fireworks reports supports_image_input false; excluded from
    // image turns (owner decision).
    vision: false,
    contextLength: 524288,
    inputPrice: 0.28,
    outputPrice: 1.1,
    eligible: true,
    providers: [
      {
        provider: 'deepinfra',
        modelId: 'MiniMaxAI/MiniMax-M3',
        inputPrice: 0.28,
        outputPrice: 1.1,
        enabled: true,
        disabledUntil: null,
      },
      {
        provider: 'fireworks',
        modelId: 'accounts/fireworks/models/minimax-m3',
        inputPrice: 0.3,
        outputPrice: 1.2,
        enabled: true,
        disabledUntil: null,
      },
    ],
  },
];

export class SeedModelRoster implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const row of ROWS) {
      await db
        .collection('modelrosters')
        .updateOne({ modelId: row.modelId }, { $setOnInsert: row }, { upsert: true });
    }
  }

  async down(db: Db): Promise<void> {
    for (const row of ROWS) {
      await db.collection('modelrosters').deleteOne({ modelId: row.modelId });
    }
  }
}
