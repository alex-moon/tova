<<<<<<< HEAD
import { MigrationInterface, Db } from 'mongo-migrate-ts';
=======
import { MigrationInterface } from 'mongo-migrate-ts';
import { Db } from 'mongodb';
>>>>>>> feat/94-better-model

/*
 * #94: Groq must never serve completions — free-tier token limits mean tool
 * use can never work there. Remove stale `groq` rows from the completion
 * tiers (small/large) and upsert the new DeepInfra pool rows so upgraded
 * deployments (whose pools are non-empty, so app-level seeding never fires)
 * actually receive the new featured models. `guard` is untouched: Groq still
 * serves the tool-free classifier and other aux tasks.
 *
 * Capabilities follow the DeepInfra /v1/openai/models metadata as reviewed
 * for #94: every pick is tool-capable, only gemma-3-4b-it is a VLM, context
 * lengths are the advertised limits. Model ids are pinned literal here (the
 * migration cannot read tier env overrides; a deployment overriding
 * ROUTER_SMALL_MODEL/ROUTER_LARGE_MODEL keeps its DB-side rows anyway).
<<<<<<< HEAD
=======
 *
 * The guard tier is swept too (#94 follow-up 2026-09-19): the pre-branch
 * default `groq/allam-2-7b` is deprecated (absent from Groq's production
 * list). Guard rows are only read, never updated at runtime, and the app
 * reseeds a tier from `ROUTER_GUARD_MODEL` when its pool becomes empty — so
 * deleting all guard rows here both removes the stale default and lets each
 * deployment's own env value re-enter through `ensureSeed` on first aux call.
>>>>>>> feat/94-better-model
 */
const DEEPINFRA_COMPLETIONS_ROWS: {
  model: string;
  tier: 'small' | 'large';
  vision?: boolean;
  contextLength: number;
}[] = [
  { model: 'openai/gpt-oss-20b', tier: 'small', contextLength: 131072 },
  { model: 'google/gemma-3-4b-it', tier: 'small', vision: true, contextLength: 131072 },
  { model: 'Qwen/Qwen3-14B', tier: 'small', contextLength: 40960 },
  { model: 'openai/gpt-oss-120b', tier: 'large', contextLength: 131072 },
  { model: 'Qwen/Qwen3-235B-A22B-Instruct-2507', tier: 'large', contextLength: 262144 },
  { model: 'deepseek-ai/DeepSeek-V3.2', tier: 'large', contextLength: 163840 },
  {
    model: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
    tier: 'large',
    contextLength: 1048576,
  },
];

export class RemoveGroqCompletionsRoutings implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const routings = db.collection('providerroutings');
    await routings.deleteMany({
      provider: 'groq',
<<<<<<< HEAD
      tier: { $in: ['small', 'large'] },
    });
=======
      tier: { $in: ['small', 'large', 'guard'] },
    });
    await routings.deleteMany({ tier: 'guard' });
>>>>>>> feat/94-better-model
    for (const { model, tier, vision, contextLength } of DEEPINFRA_COMPLETIONS_ROWS) {
      const row: Record<string, unknown> = {
        provider: 'deepinfra',
        model,
        tier,
        eligible: true,
        tools: true,
        contextLength,
      };
      if (vision !== undefined) row.vision = vision;
      await routings.updateOne(
        { provider: 'deepinfra', model, tier },
        { $setOnInsert: row },
        {
          upsert: true,
        },
      );
    }
  }

  async down(db: Db): Promise<void> {
    const routings = db.collection('providerroutings');
    await routings.deleteMany({
      provider: 'deepinfra',
      tier: { $in: ['small', 'large'] },
    });
<<<<<<< HEAD
    await routings.insertMany([
      { provider: 'groq', model: 'openai/gpt-oss-20b', tier: 'small', eligible: true },
      { provider: 'groq', model: 'openai/gpt-oss-120b', tier: 'large', eligible: true },
=======
    await routings.deleteMany({ tier: 'guard' });
    await routings.insertMany([
      { provider: 'groq', model: 'openai/gpt-oss-20b', tier: 'small', eligible: true },
      { provider: 'groq', model: 'openai/gpt-oss-120b', tier: 'large', eligible: true },
      {
        // Pre-branch guard default; runtime reseeding handles env overrides.
        provider: 'groq',
        model: 'allam-2-7b',
        tier: 'guard',
        eligible: true,
      },
>>>>>>> feat/94-better-model
    ]);
  }
}
