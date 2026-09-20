import { MigrationInterface } from 'mongo-migrate-ts';
import { Db } from 'mongodb';

/*
 * #115 pass 4 (user decision 2026-09-20 09:27): all image turns route through
 * the large tier, and the two vision models the ticket asks for live there —
 * Qwen3-VL-8B-Instruct (retiered from small) and Qwen3-VL-30B-A3B-Instruct
 * (new; live-probed on DeepInfra: accepts image_url parts and tool calls).
 * gemma-3-4b-it is vetoed for everything ("too small to be useful for
 * anything at all") and is disabled rather than deleted so upgraded
 * deployments keep a coherent row; eligibility filtering removes it from all
 * pools.
 *
 * Row content mirrors SEED_ENTRIES in `modelConfigService.ts` exactly. The
 * migrations for this branch are sequenced after
 * `20260920000000-seed-qwen3-vl-routing`, whose insert-only upsert cannot
 * change rows that existing deployments already hold — hence the
 * re-tier/retire updates here.
 */
const VL_8B_LARGE = {
  provider: 'deepinfra',
  model: 'Qwen/Qwen3-VL-8B-Instruct',
  tier: 'large',
  eligible: true,
  tools: true,
  vision: true,
  contextLength: 262144,
};

const VL_30B_LARGE = {
  provider: 'deepinfra',
  model: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
  tier: 'large',
  eligible: true,
  tools: true,
  vision: true,
  contextLength: 262144,
};

export class ReviseVisionPoolRouting implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const routings = db.collection('providerroutings');
    // Retire gemma for every purpose (row kept for history coherence).
    await routings.updateOne(
      {
        provider: 'deepinfra',
        model: 'google/gemma-3-4b-it',
        tier: 'small',
      },
      { $set: { eligible: false } },
    );
    // Move the VL-8B row to the large tier (delete the stale small row only
    // when the large one now exists).
    await routings.deleteOne({
      provider: VL_8B_LARGE.provider,
      model: VL_8B_LARGE.model,
      tier: 'small',
    });
    await routings.updateOne(
      {
        provider: VL_8B_LARGE.provider,
        model: VL_8B_LARGE.model,
        tier: VL_8B_LARGE.tier,
      },
      { $setOnInsert: VL_8B_LARGE },
      { upsert: true },
    );
    await routings.updateOne(
      {
        provider: VL_30B_LARGE.provider,
        model: VL_30B_LARGE.model,
        tier: VL_30B_LARGE.tier,
      },
      { $setOnInsert: VL_30B_LARGE },
      { upsert: true },
    );
  }

  async down(db: Db): Promise<void> {
    const routings = db.collection('providerroutings');
    await routings.deleteOne({
      provider: VL_30B_LARGE.provider,
      model: VL_30B_LARGE.model,
      tier: VL_30B_LARGE.tier,
    });
    await routings.deleteOne({
      provider: VL_8B_LARGE.provider,
      model: VL_8B_LARGE.model,
      tier: VL_8B_LARGE.tier,
    });
    await routings.updateOne(
      {
        provider: VL_8B_LARGE.provider,
        model: VL_8B_LARGE.model,
        tier: 'small',
      },
      { $setOnInsert: { ...VL_8B_LARGE, tier: 'small' } },
      { upsert: true },
    );
    await routings.updateOne(
      {
        provider: 'deepinfra',
        model: 'google/gemma-3-4b-it',
        tier: 'small',
      },
      { $set: { eligible: true } },
    );
  }
}
