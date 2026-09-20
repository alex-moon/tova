import { MigrationInterface } from 'mongo-migrate-ts';
import { Db } from 'mongodb';

/*
 * #115: seed the vision-capable completion row for the small tier. App-level
 * seeding is an empty-pool recovery (`ensureSeed` only fires when the
 * collection is empty), so upgraded deployments — whose pools are non-empty
 * after `remove-groq-completions-routings` — never receive new featured
 * rows without a migration.
 *
 * Row content mirrors SEED_ENTRIES in `modelConfigService.ts` exactly
 * (live-probed on DeepInfra: accepts image_url parts and tool calls; the
 * alias is served by the Qwen3-VL-235B backend, hence the context length).
 */
const VISION_ROW = {
  provider: 'deepinfra',
  model: 'Qwen/Qwen3-VL-8B-Instruct',
  tier: 'small',
  eligible: true,
  tools: true,
  vision: true,
  contextLength: 262144,
};

export class SeedQwen3VlRouting implements MigrationInterface {
  async up(db: Db): Promise<void> {
    await db.collection('providerroutings').updateOne(
      {
        provider: VISION_ROW.provider,
        model: VISION_ROW.model,
        tier: VISION_ROW.tier,
      },
      { $setOnInsert: VISION_ROW },
      {
        upsert: true,
      },
    );
  }

  async down(db: Db): Promise<void> {
    await db.collection('providerroutings').deleteOne({
      provider: VISION_ROW.provider,
      model: VISION_ROW.model,
      tier: VISION_ROW.tier,
    });
  }
}
