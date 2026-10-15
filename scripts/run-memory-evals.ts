/*
 * #289 memory-eval runner. Seeds the corpus into the reserved eval user's
 * workspace, scores the deterministic retrieval stage (hit-rate by slice ID),
 * retrieval hit-rate by slice ID), prints the metrics, and — when
 * LANGSMITH_API_KEY is present — loads the corpus into the `tova-memory-evals`
 * dataset (best-effort). Not part of CI.
 *
 *   npx tsx scripts/run-memory-evals.ts
 *   npx tsx scripts/run-memory-evals.ts --helpfulness
 *   npx tsx scripts/run-memory-evals.ts --preflight-judge
 *   npx tsx scripts/run-memory-evals.ts --validate-judge
 *   npm run evals:memory
 *
 * Needs: local MongoDB (fixtures); the retrieval stage is Mongo-only. Stage 3
 * (helpfulness) runs only with `--helpfulness` and needs the responder + judge
 * providers. See docs/plan-289-gate-evals.md.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { buildMongoUri } from '../apps/shared/src/mongoUri';
import { langsmithClientFromEnv } from '../apps/server/src/services/evalRunService';
import {
  pushMemoryCorpusToLangSmith,
  runMemoryEvals,
} from '../apps/server/src/evals/memory/memoryEvalService';
import {
  defaultJudge,
  runHelpfulnessEval,
  runJudgePreflight,
} from '../apps/server/src/evals/memory/helpfulnessEval';
import {
  constructedJudgeLabels,
  handJudgeLabels,
  judgeAgreement,
  type JudgeLabel,
} from '../apps/server/src/evals/memory/judgeValidation';
import { config } from '../apps/server/src/config';

const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;

/*
 * Stage 3 makes live responder + judge calls (Groq for the judge), so it is
 * manual-only: it runs when `--helpfulness` is passed, never on the default
 * deterministic path. The ticket leaves the unattended schedule as an open
 * question (OQ6).
 */
const wantsHelpfulness = (): boolean => process.argv.slice(2).includes('--helpfulness');

/*
 * `--preflight-judge` (T14d) issues one judge call in both orders and requires a
 * parseable verdict, so a truncated/unavailable judge fails loudly here rather
 * than silently degrading every stage-3 verdict. It needs no Mongo, so it runs
 * before the connection.
 */
const wantsPreflight = (): boolean => process.argv.slice(2).includes('--preflight-judge');

/*
 * `--validate-judge` (T5) scores the judge against the constructed set (always)
 * and the checked-in hand-labelled seed, printing accuracy and Cohen's kappa with
 * each set's provenance. The constructed number is a smoke test (the judge is
 * callable and not position-biased), not evidence; the hand number is the
 * non-circular one, and is `agent-authored` until the owner confirms it (OQ1).
 * It needs no Mongo, so it runs before the connection.
 */
const wantsValidateJudge = (): boolean => process.argv.slice(2).includes('--validate-judge');

const printAgreement = async (
  title: string,
  provenance: string,
  labels: JudgeLabel[],
): Promise<void> => {
  const { n, errors, accuracy, kappa } = await judgeAgreement(labels, defaultJudge);
  console.log(
    `\n${title} (${provenance}): n=${n} errors=${errors} ` +
      `accuracy=${pct(accuracy)} kappa=${kappa === null ? 'n/a' : kappa.toFixed(3)}`,
  );
};

const main = async (): Promise<void> => {
  if (wantsPreflight()) {
    const { first, second } = await runJudgePreflight();
    console.log(
      `\nJudge preflight ok: first=${first} second=${second} ` +
        `(model=${config.memoryEval.judgeModel} provider=${config.memoryEval.judgeProvider})`,
    );
    return;
  }

  if (wantsValidateJudge()) {
    console.log(
      `\nJudge validation (model=${config.memoryEval.judgeModel} ` +
        `provider=${config.memoryEval.judgeProvider}):`,
    );
    await printAgreement(
      'Constructed set — smoke test only, not evidence',
      'constructed',
      constructedJudgeLabels(),
    );
    await printAgreement(
      'Hand-labelled set',
      'agent-authored, not independent evidence until owner-confirmed (OQ1)',
      handJudgeLabels,
    );
    return;
  }

  const langsmithClient = await langsmithClientFromEnv(process.env.LANGSMITH_API_KEY);
  await mongoose.connect(buildMongoUri());
  try {
    // #310: the gate stage is retired — retrieval is the only deterministic stage.
    const { retrieval } = await runMemoryEvals();
    if (!retrieval) throw new Error('memory eval did not run the retrieval stage');

    console.log(
      `\nRetrieval hit-rate (expected slice surfaced)` +
        ` [vector stage ${retrieval.vectorEnabled ? 'enabled' : 'off (BM25 baseline)'}]:`,
    );
    for (const r of retrieval.results) {
      console.log(
        `  ${r.pass ? 'ok  ' : 'MISS'} [${r.category}] ${r.scenarioId} ` +
          `expected=${r.expected} surfaced=${r.surfaced}${r.cutEmpty ? ' cut-empty' : ''}`,
      );
    }
    console.log(
      `  expectedMet=${pct(retrieval.metrics.expectedMetRate)} ` +
        `surfacedRate=${pct(retrieval.metrics.surfacedRate)} (n=${retrieval.metrics.total})` +
        ` · empty-after-cut=${retrieval.metrics.cutEmpty}`,
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
            `counterfactual=${r.counterfactualHit} verdicts=${r.verdicts?.join('/') ?? '-'} ` +
            `finish=${r.finishReasons?.with ?? '-'}${r.finishReasons ? '/' : ''}${r.finishReasons?.without ?? ''}`,
        );
      }
      console.log(
        `  winRate=${pct(metrics.winRate)} (wins=${metrics.wins} losses=${metrics.losses} ` +
          `ties=${metrics.ties} errors=${metrics.errors} n=${metrics.judged}) ` +
          `factHitRate=${pct(metrics.factHitRate)} blockIdRate=${pct(metrics.blockIdRate)} ` +
          `counterfactual=${metrics.counterfactualHits} truncated=${metrics.truncated}`,
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
