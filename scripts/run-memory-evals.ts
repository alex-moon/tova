/*
 * #289 memory-eval runner. Seeds the corpus into the reserved eval user's
 * workspace, scores the two deterministic stages (gate precision/recall,
 * retrieval hit-rate by slice ID), prints the metrics, and — when
 * LANGSMITH_API_KEY is present — loads the corpus into the `tova-memory-evals`
 * dataset (best-effort). Not part of CI.
 *
 *   npx tsx scripts/run-memory-evals.ts
 *   npm run evals:memory
 *
 * Needs: local MongoDB (fixtures). The gate stage needs GROQ_API_KEY (the aux
 * model); the retrieval stage is Mongo-only. Stage 3 (helpfulness judge) is a
 * follow-up — see docs/plan-289-gate-evals.md.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { buildMongoUri } from '../apps/shared/src/mongoUri';
import { langsmithClientFromEnv } from '../apps/server/src/services/evalRunService';
import {
  pushMemoryCorpusToLangSmith,
  runMemoryEvals,
} from '../apps/server/src/evals/memory/memoryEvalService';

const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;

const main = async (): Promise<void> => {
  const langsmithClient = await langsmithClientFromEnv(process.env.LANGSMITH_API_KEY);
  await mongoose.connect(buildMongoUri());
  try {
    const { gate, retrieval } = await runMemoryEvals();

    console.log('\nStage 1 — gate precision/recall (workspace vote vs hand label):');
    for (const r of gate.results) {
      console.log(
        `  ${r.pass ? 'ok  ' : 'MISS'} ${r.caseId} expected=${r.expected} observed=${r.observed}`,
      );
    }
    console.log(
      `  precision=${pct(gate.metrics.precision)} recall=${pct(gate.metrics.recall)} ` +
        `fireRate=${pct(gate.metrics.fireRate)} (n=${gate.metrics.total})`,
    );

    console.log(
      `\nStage 2 — retrieval hit-rate (expected slice surfaced)` +
        ` [vector stage ${retrieval.vectorEnabled ? 'enabled' : 'off (BM25 baseline)'}]:`,
    );
    for (const r of retrieval.results) {
      console.log(
        `  ${r.pass ? 'ok  ' : 'MISS'} [${r.category}] ${r.scenarioId} ` +
          `expected=${r.expected} surfaced=${r.surfaced}`,
      );
    }
    console.log(
      `  expectedMet=${pct(retrieval.metrics.expectedMetRate)} ` +
        `surfacedRate=${pct(retrieval.metrics.surfacedRate)} (n=${retrieval.metrics.total})`,
    );
    for (const [category, m] of Object.entries(retrieval.metrics.byCategory)) {
      console.log(`    ${category}: surfaced ${m.surfaced}/${m.total}`);
    }

    if (langsmithClient) {
      try {
        await pushMemoryCorpusToLangSmith(langsmithClient);
        console.log('\nLangSmith: corpus pushed to `tova-memory-evals`.');
      } catch (error) {
        console.warn(`LangSmith export failed (keeping local metrics): ${String(error)}`);
      }
    }
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
