/* Eval runner: seeds fixtures, drives the real agent, grades, exports. */
// @see #112 #5 #225 #94 #236 #158
import 'dotenv/config';
import mongoose from 'mongoose';
import { buildMongoUri } from '../apps/shared/src/main/mongoUri';
import {
  langsmithClientFromEnv,
  parseModelsFlag,
  resolveScheduledModels,
  runEvalSuite,
  type EvalResult,
  type WiredProvider,
} from '../apps/server/src/main/services/evalRunService';

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
  // Default to the cheapest roster model; guard model is retired.
  // @see #236
  const fallback = resolveScheduledModels({});
  const model = process.env.TOVA_EVAL_MODEL ?? fallback[0].model;
  const provider = (
    process.env.TOVA_EVAL_PROVIDER === 'groq' ? 'groq' : fallback[0].provider
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
    if (p === 'fireworks' && !process.env.FIREWORKS_API_KEY) {
      console.error(`FIREWORKS_API_KEY must be set to run ${p} models.`);
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
