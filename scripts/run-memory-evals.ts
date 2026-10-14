/*
 * #289 memory-eval runner. Seeds the corpus into the reserved eval user's
 * workspace, scores the two deterministic stages (gate precision/recall,
 * retrieval hit-rate by slice ID), prints the metrics, and — when
 * LANGSMITH_API_KEY is present — loads the corpus into the `tova-memory-evals`
 * dataset (best-effort). Not part of CI.
 *
 *   npx tsx scripts/run-memory-evals.ts
 *   npx tsx scripts/run-memory-evals.ts --helpfulness
 *   npm run evals:memory
 *
 * Needs: local MongoDB (fixtures). The gate stage needs GROQ_API_KEY (the aux
 * model); the retrieval stage is Mongo-only. Stage 3 (helpfulness) runs only
 * with `--helpfulness` and needs the responder + judge providers. See
 * docs/plan-289-gate-evals.md.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { buildMongoUri } from '../apps/shared/src/mongoUri';
import { langsmithClientFromEnv } from '../apps/server/src/services/evalRunService';
import {
  pushMemoryCorpusToLangSmith,
  runMemoryEvals,
} from '../apps/server/src/evals/memory/memoryEvalService';
import { runHelpfulnessEval } from '../apps/server/src/evals/memory/helpfulnessEval';

const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;

/*
 * Stage 3 makes live responder + judge calls (Groq for the judge), so it is
 * manual-only: it runs when `--helpfulness` is passed, never on the default
 * deterministic path. The ticket leaves the unattended schedule as an open
 * question (OQ6).
 */
const wantsHelpfulness = (): boolean => process.argv.slice(2).includes('--helpfulness');

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

    console.log('\nStage 2 — retrieval hit-rate (expected slice surfaced):');
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

    if (wantsHelpfulness()) {
      console.log('\nStage 3 — injection helpfulness (with vs without block, blinded + swapped):');
      const { results, metrics } = await runHelpfulnessEval();
      for (const r of results) {
        console.log(
          `  ${r.outcome ?? 'skip'} [${r.category}] ${r.scenarioId} ` +
            `blockId=${r.blockCarriesId} factHit=${r.factHitWith} ` +
            `counterfactual=${r.counterfactualHit} verdicts=${r.verdicts?.join('/') ?? '-'}`,
        );
      }
      console.log(
        `  winRate=${pct(metrics.winRate)} (wins=${metrics.wins} losses=${metrics.losses} ` +
          `ties=${metrics.ties} n=${metrics.judged}) factHitRate=${pct(metrics.factHitRate)} ` +
          `blockIdRate=${pct(metrics.blockIdRate)} counterfactual=${metrics.counterfactualHits}`,
      );
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
