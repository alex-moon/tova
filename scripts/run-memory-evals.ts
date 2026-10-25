/* Memory-eval runner: seeds corpus, scores hit-rate, optional stages. */
// @see #289
import 'dotenv/config';
import mongoose from 'mongoose';
import { buildMongoUri } from '../apps/shared/src/main/mongoUri';
import { langsmithClientFromEnv } from '../apps/server/src/main/services/eval/evalRunService';
import {
  pushMemoryCorpusToLangSmith,
  runMemoryEvals,
} from '../apps/server/src/main/evals/memory/memoryEvalService';
import {
  defaultJudge,
  runHelpfulnessEval,
  runJudgePreflight,
} from '../apps/server/src/main/evals/memory/helpfulnessEval';
import {
  constructedJudgeLabels,
  handJudgeLabels,
  judgeAgreement,
  type JudgeLabel,
} from '../apps/server/src/main/evals/memory/judgeValidation';
import { config } from '../apps/server/src/main/config';

const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;

/* Stage 3 makes live calls; manual-only via --helpfulness. */
const wantsHelpfulness = (): boolean => process.argv.slice(2).includes('--helpfulness');

/* --preflight-judge: one judge call in both orders; fails pre-connection. */
const wantsPreflight = (): boolean => process.argv.slice(2).includes('--preflight-judge');

/* --validate-judge: judge accuracy + kappa on the hand-labelled seed. */
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
    // The gate stage is retired — retrieval is the only deterministic stage.
    // @see #310
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
