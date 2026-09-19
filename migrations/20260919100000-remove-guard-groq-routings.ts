import { MigrationInterface, Db } from 'mongo-migrate-ts';

/*
 * #109 (phase 2): with the owner's 2026-09-19 decisions the guard model
 * configuration leaves the DB entirely. The tier was inexpressible without
 * Groq (models are model-provider pairs, #109), completions route only to
 * DeepInfra since #94, and the tool-free aux calls (guard classifier, chat
 * titles, followups) resolve their model from `ROUTER_GUARD_MODEL` env plus
 * the `inferenceService` provider fallback (`deepinfra` since #109) — the
 * DB-side `guard` / `groq` rows serve nothing. Remove every `tier: 'guard'`
 * row and every remaining `provider: 'groq'` row.
 */
export class RemoveGuardGroqRoutings implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const routings = db.collection('providerroutings');
    await routings.deleteMany({ tier: 'guard' });
    await routings.deleteMany({ provider: 'groq' });
  }

  async down(db: Db): Promise<void> {
    const routings = db.collection('providerroutings');
    await routings.insertMany([
      { provider: 'groq', model: 'openai/gpt-oss-20b', tier: 'guard', eligible: true },
    ]);
  }
}
