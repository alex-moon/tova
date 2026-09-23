/*
 * #112 deterministic eval runner: seeds the temporary Mongo source, drives
 * the real agent (streaming connector) over the golden cases, grades every
 * run deterministically for pass/partial/fail, and — when a
 * LANGSMITH_API_KEY is present — pushes the cases and graded runs into the
 * `tova-evals` dataset in LangSmith so scores and debugging traces are
 * visible over time. Tracing of the underlying agent calls rides on the
 * Mastra LangSmithExporter (#5) via `trace.sessionId`.
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
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import type { Client } from 'langsmith';
import { buildMongoUri } from '../src/server/mongoUri';
import { gradeRun } from '../src/server/evals/graders';
import { CASES, resolveExpectedContent, type EvalCase } from '../src/server/evals/cases';
import { clearEvalSource, seedEvalSource, evalUserId } from '../src/server/evals/mongoSource';
import { runCase } from '../src/server/evals/runCase';
import type { Assertion } from '../src/server/evals/types';
import { groqConnector, deepinfraConnector } from '../src/server/services/mastraService';
import { sweepModels, type ProviderName } from '../src/server/services/modelConfigService';

const repoRoot = path.resolve(path.dirname(import.meta.filename), '..');
type WiredProvider = Extract<ProviderName, keyof typeof connectorsByProvider>;

/**
 * `@repo:<path>` markers resolve against this repository at grading time, so
 * the golden content expectation moves with the file (README) instead of
 * being duplicated inside the case data.
 */
const resolveAssertions = (testCase: EvalCase): Assertion[] =>
  testCase.assertions.map((assertion) =>
    assertion.type === 'content_equals'
      ? {
          ...assertion,
          expected: resolveExpectedContent(assertion.expected, (p) =>
            fs.readFileSync(path.join(repoRoot, p), 'utf8'),
          ),
        }
      : assertion,
  );

const connectorsByProvider = { groq: groqConnector, deepinfra: deepinfraConnector } as const;

/* Best-effort LangSmith export: the `tova-evals` dataset is created when
 * absent and re-used otherwise (score-over-time stays on one dataset), each
 * case becomes an example, each graded run becomes a run on that example
 * with a 1 (pass) / 0.5 (partial) / 0 (fail) feedback score and the
 * assertion report as the comment. Failures degrade to a warning — the
 * local grading result is unchanged. */
const SCORES = { pass: 1, partial: 0.5, fail: 0, error: 0 } as const;
const DATASET_NAME = 'tova-evals';

type EvalResult = {
  testCase: EvalCase;
  model: string;
  provider: ProviderName;
  score: string;
  report: string;
};

const pushToLangSmith = async (client: Client, results: EvalResult[]): Promise<void> => {
  const ls = client as unknown as {
    hasDataset: (params: { datasetName: string }) => Promise<boolean>;
    createDataset: (name: string) => Promise<{ id: string }>;
    createExample: (
      input: unknown,
      output: unknown,
      opts?: { datasetName: string },
    ) => Promise<unknown>;
  };
  if (!(await ls.hasDataset({ datasetName: DATASET_NAME }))) await ls.createDataset(DATASET_NAME);
  // Examples address the dataset by name; re-runs append the fresh results.
  // The returned example id becomes each run's reference example.
  const examples: Record<string, string> = {};
  for (const result of results) {
    const example = (await ls.createExample(
      { prompt: result.testCase.prompt, model: `${result.provider}:${result.model}` },
      { score: result.score },
      { datasetName: DATASET_NAME },
    )) as { id: string } | undefined;
    if (example?.id)
      examples[`${result.provider}:${result.model}/${result.testCase.id}`] = example.id;
  }
  // RunTree is the supported run-submission path in langsmith@0.8 (createRun
  // queues server-side and returns nothing); posting with a
  // reference_example_id is what links each graded run to its dataset row.
  // `model`/`provider` ride in the run metadata so per-model scores
  // accumulate across sweeps (#158's growing evidence base).
  const { RunTree } = await import('langsmith');
  const end = new Date();
  for (const result of results) {
    const exampleKey = `${result.provider}:${result.model}/${result.testCase.id}`;
    const tree = new RunTree({
      name: result.testCase.id,
      run_type: 'chain',
      inputs: { prompt: result.testCase.prompt },
      outputs: { score: result.score },
      reference_example_id: examples[exampleKey],
      metadata: { model: result.model, provider: result.provider },
      start_time: end.getTime() - 60_000,
      end_time: end.getTime(),
      client,
    });
    await tree.postRun();
    await tree.end({ outputs: { score: result.score } });
    await tree.patchRun();
    await client.createFeedback(tree.id, 'golden-set-assertions', {
      score: SCORES[result.score as keyof typeof SCORES] ?? 0,
      comment: `${result.provider}:${result.model}\n${result.report.slice(0, 4000)}`,
    });
  }
};

/*
 * `--models` csv parsing: entries are `<provider>:<model>` or bare `<model>`
 * (bare = deepinfra — completions are pinned there, #94). Returns null when
 * the flag is absent (single-model mode).
 */
const parseModelsFlag = (argv: string[]): { provider: WiredProvider; model: string }[] | null => {
  const index = argv.indexOf('--models');
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    console.error('--models requires a value: a csv list or `all`.');
    process.exit(1);
  }
  if (value === 'all') {
    // Wired providers only: typesafe models are excluded (no connector here)
    // and that exclusion is stated, not hidden (#158 plan).
    console.error(
      'sweep universe: eligible seed+env models on wired providers (groq, deepinfra); ' +
        'unwired providers (e.g. typesafe) are excluded.',
    );
    return sweepModels(Object.keys(connectorsByProvider) as WiredProvider[]).map(
      ({ provider, model }) => ({ provider, model }),
    );
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const sep = entry.indexOf(':');
      if (sep === -1) return { provider: 'deepinfra' as const, model: entry };
      if (!(entry.slice(0, sep) in connectorsByProvider)) {
        console.error(`Unknown provider in --models '${entry}' (wired: deepinfra, groq).`);
        process.exit(1);
      }
      return { provider: entry.slice(0, sep) as WiredProvider, model: entry.slice(sep + 1) };
    });
};

/*
 * In sweep mode a run-level crash is recorded as score `error` — visibly
 * distinct from a graded `fail`, which is a genuine assertion outcome and
 * not an infrastructure problem (#158 plan). Both score zero in LangSmith.
 */
const runSuite = async (
  results: EvalResult[],
  provider: WiredProvider,
  model: string,
  sweep: boolean,
): Promise<void> => {
  const connector = connectorsByProvider[provider];
  for (const testCase of CASES) {
    const assertions = resolveAssertions(testCase);
    process.stdout.write((sweep ? `${provider}:${model} ` : '') + `${testCase.id} …`);
    try {
      const { run, evidence } = await runCase(
        connector.createStreamingCompletion.bind(connector),
        {
          provider,
          model,
          messages: [{ role: 'user', content: testCase.prompt }],
          userId: evalUserId.toHexString(),
          trace: { sessionId: `tova-evals-${testCase.id}` },
        },
        testCase,
      );
      const { score, assertions: assertionResults } = gradeRun(run, assertions);
      const report = assertionResults
        .map((r) => `${JSON.stringify(r.assertion.type)}=${r.passed ? 'y' : 'n'}`)
        .join(' ');
      console.log(` ${score} | ${report || 'no assertions'} | ${evidence}`);
      results.push({ testCase, model, provider, score, report: `${report}\n${evidence}` });
    } catch (error) {
      const report = `ungraded: ${error instanceof Error ? error.message : String(error)}`;
      const score = sweep ? 'error' : 'fail';
      console.log(` ${score} | ${report}`);
      results.push({ testCase, model, provider, score, report });
    }
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
  const requested = parseModelsFlag(process.argv);
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

  const results: EvalResult[] = [];
  await mongoose.connect(buildMongoUri());
  await seedEvalSource();
  try {
    for (const { provider: p, model: m } of sweep) {
      await runSuite(results, p, m, isSweep);
    }
    if (isSweep) printSweepTable(results);
    if (process.env.LANGSMITH_API_KEY) {
      try {
        const { Client } = await import('langsmith');
        await pushToLangSmith(new Client({ apiKey: process.env.LANGSMITH_API_KEY }), results);
        console.log('LangSmith: dataset + runs pushed to `tova-evals`.');
      } catch (error) {
        console.warn(`LangSmith export failed (keeping local grading): ${String(error)}`);
      }
    }
  } finally {
    if (!keepFixtures) await clearEvalSource();
    await mongoose.disconnect();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
