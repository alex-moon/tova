/*
 * #112 deterministic eval runner: seeds the temporary Mongo source, drives
 * the real agent (streaming connector) over the golden cases, grades every
 * run deterministically for pass/partial/fail, and — when a
 * LANGSMITH_API_KEY is present — pushes the cases and graded runs into the
 * `tova-evals` dataset in LangSmith so scores and debugging traces are
 * visible over time. Tracing of the underlying agent calls rides on the
 * Mastra LangSmithExporter (#5) via `trace.sessionId`.
 *
 * #225: the grading core lives in `src/server/services/evalRunService.ts`,
 * shared with the scheduled admin path; this script keeps CLI parsing,
 * Mongo connect/disconnect, and stdout printing.
 *
 * Not part of CI (same stance as `scripts/eval-classify-models.ts`):
 *   npx tsx scripts/run-evals.ts [--keep-fixtures]
 *   npx tsx scripts/run-evals.ts --models all
 *   npx tsx scripts/run-evals.ts --models "groq:openai/gpt-oss-20b,deepinfra:Qwen/Qwen3-14B"
 * Needs: DEEPINFRA_API_KEY (agent; completions are DeepInfra, #94), local
 * MongoDB (fixtures), optional LANGSMITH_API_KEY (export), BRAVE_API_KEY
 * (web_search case). Model: TOVA_EVAL_MODEL (+TOVA_EVAL_PROVIDER
 * groq|deepinfra), default openai/gpt-oss-20b (the completion pool's small
 * default, tool-capable). `--models` sweeps every listed model through all
 * cases; `--models all` enumerates the eligible seed+env tier models
 * restricted to the wired providers (groq/deepinfra — `typesafe` models are
 * excluded because no connector is wired for them here). Bare entries in the
 * csv default to provider `deepinfra`. A `tova-evals-<model>` run over all
 * models builds a per-model evidence base in LangSmith (#158).
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { buildMongoUri } from '../src/server/mongoUri';
import {
  langsmithClientFromEnv,
  parseModelsFlag,
  runEvalSuite,
  type EvalResult,
  type WiredProvider,
} from '../src/server/services/evalRunService';

const parseModelsArg = (): { provider: WiredProvider; model: string }[] | null => {
  const index = process.argv.indexOf('--models');
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    console.error('--models requires a value: a csv list or `all`.');
    process.exit(1);
  }
  try {
    return parseModelsFlag(value, (message) => console.error(message));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

const printSweepTable = (results: EvalResult[]): void => {
  console.log('\nPer-model results (case × model):');
  const models: string[] = [];
  const byCase = new Map<string, Map<string, string>>();
  for (const { testCase, model, provider, score } of results) {
    const key = `${provider}:${model}`;
    if (!models.includes(key)) models.push(key);
    if (!byCase.has(testCase.id)) byCase.set(testCase.id, new Map());
    byCase.get(testCase.id)!.set(key, score);
  }
  console.log(['case'.padEnd(28), ...models.map((m) => m.padEnd(50))].join(''));
  for (const [caseId, row] of byCase) {
    console.log(
      [caseId.padEnd(28), ...models.map((m) => (row.get(m) ?? 'missing').padEnd(50))].join(''),
    );
  }
};

const main = async (): Promise<void> => {
  const model = process.env.TOVA_EVAL_MODEL ?? 'openai/gpt-oss-20b';
  const provider = (
    process.env.TOVA_EVAL_PROVIDER === 'groq' ? 'groq' : 'deepinfra'
  ) as WiredProvider;
  const keepFixtures = process.argv.includes('--keep-fixtures');
  const requested = parseModelsArg();
  const sweep = requested ?? [{ provider, model }];
  const isSweep = requested !== null;
  if (isSweep && sweep.length === 0) {
    console.error('--models sweep resolved to zero models; nothing to run.');
    process.exit(1);
  }
  for (const { provider: p } of sweep) {
    if (p === 'deepinfra' && !process.env.DEEPINFRA_API_KEY) {
      console.error(`DEEPINFRA_API_KEY must be set to run ${p} models.`);
      process.exit(1);
    }
    if (p === 'groq' && !process.env.GROQ_API_KEY) {
      console.error(`GROQ_API_KEY must be set to run ${p} models.`);
      process.exit(1);
    }
  }

  const langsmithClient = await langsmithClientFromEnv(process.env.LANGSMITH_API_KEY);
  let langsmithFailed = false;
  await mongoose.connect(buildMongoUri());
  try {
    const results = await runEvalSuite(
      { models: sweep, keepFixtures },
      {
        langsmithClient,
        onLangsmithError: (error) => {
          langsmithFailed = true;
          console.warn(`LangSmith export failed (keeping local grading): ${String(error)}`);
        },
        onCase: ({ provider: p, model: m, caseId, score, report, evidence }) => {
          process.stdout.write((isSweep ? `${p}:${m} ` : '') + `${caseId} …`);
          const tail = evidence ? `${report || 'no assertions'} | ${evidence}` : report;
          console.log(` ${score} | ${tail}`);
        },
      },
    );
    if (isSweep) printSweepTable(results);
    if (langsmithClient && !langsmithFailed)
      console.log('LangSmith: dataset + runs pushed to `tova-evals`.');
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
