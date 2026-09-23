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
 * Needs: DEEPINFRA_API_KEY (agent; completions are DeepInfra, #94), local
 * MongoDB (fixtures), optional LANGSMITH_API_KEY (export), BRAVE_API_KEY
 * (web_search case). Model: TOVA_EVAL_MODEL (+TOVA_EVAL_PROVIDER
 * groq|deepinfra), default openai/gpt-oss-20b (the completion pool's small
 * default, tool-capable).
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
import type { Assertion, EvalRun } from '../src/server/evals/types';
import { groqConnector, deepinfraConnector } from '../src/server/services/mastraService';
import type { CompletionOptions } from '../src/server/services/llmTypes';

const repoRoot = path.resolve(path.dirname(import.meta.filename), '..');

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

/** Only assistant text deltas count as answer material (null = tool-only gap). */
const hasText = (value: string): boolean => value.trim().length > 0;

/**
 * One graded run: stream the agent's answer for the case prompt and record
 * tool calls in order from the neutral stream (#16). The `generate_file`
 * content rides in the call's scalar args, which is what `gradedContent`
 * extracts for the `content_equals` case; the assembled prompt is simply the
 * runner's own message list.
 */
const runCase = async (
  options: CompletionOptions,
  testCase: EvalCase,
): Promise<{ run: EvalRun; evidence: string }> => {
  const stream =
    await connectorsByProvider[options.provider ?? 'groq']?.createStreamingCompletion(options);
  if (!stream) throw new Error(`no connector for provider ${options.provider ?? 'groq'}`);
  const toolCalls: EvalRun['toolCalls'] = [];
  const deltas: string[] = [];
  for await (const chunk of stream) {
    if (chunk.delta) deltas.push(chunk.delta);
    if (chunk.toolCall)
      toolCalls.push({
        name: chunk.toolCall.name,
        ...(chunk.toolCall.args ? { args: chunk.toolCall.args } : {}),
      });
  }
  const generateCall = toolCalls.find((call) => call.name === 'generate_file');
  const generatedContent =
    typeof generateCall?.args?.content === 'string' ? generateCall.args.content : undefined;
  // #159 cases grade the assistant's final answer and possibly several
  // generated files, so both are captured alongside the tool calls.
  const generatedFiles = toolCalls
    .filter((call) => call.name === 'generate_file' && typeof call.args?.content === 'string')
    .map((call) => ({ filename: call.args?.filename ?? '', content: call.args?.content ?? '' }));
  const answer = deltas.join('');
  const run: EvalRun = {
    toolCalls,
    prompt: testCase.prompt,
    ...(!hasText(answer) ? {} : { answer }),
    ...(!generatedFiles.length ? {} : { generatedFiles }),
    ...(generatedContent !== undefined ? { generatedContent } : {}),
  };
  const evidence = toolCalls
    .map((call) => `${call.name}${call.args ? ` ${JSON.stringify(call.args).slice(0, 120)}` : ''}`)
    .join(' | ');
  return { run, evidence };
};

/* Best-effort LangSmith export: the `tova-evals` dataset is created when
 * absent and re-used otherwise (score-over-time stays on one dataset), each
 * case becomes an example, each graded run becomes a run on that example
 * with a 1 (pass) / 0.5 (partial) / 0 (fail) feedback score and the
 * assertion report as the comment. Failures degrade to a warning — the
 * local grading result is unchanged. */
const SCORES = { pass: 1, partial: 0.5, fail: 0 } as const;
const DATASET_NAME = 'tova-evals';

const pushToLangSmith = async (
  client: Client,
  results: { testCase: EvalCase; score: string; report: string }[],
): Promise<void> => {
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
      { prompt: result.testCase.prompt },
      { score: result.score },
      { datasetName: DATASET_NAME },
    )) as { id: string } | undefined;
    if (example?.id) examples[result.testCase.id] = example.id;
  }
  // RunTree is the supported run-submission path in langsmith@0.8 (createRun
  // queues server-side and returns nothing); posting with a
  // reference_example_id is what links each graded run to its dataset row.
  const { RunTree } = await import('langsmith');
  const end = new Date();
  for (const result of results) {
    const tree = new RunTree({
      name: result.testCase.id,
      run_type: 'chain',
      inputs: { prompt: result.testCase.prompt },
      outputs: { score: result.score },
      reference_example_id: examples[result.testCase.id],
      start_time: end.getTime() - 60_000,
      end_time: end.getTime(),
      client,
    });
    await tree.postRun();
    await tree.end({ outputs: { score: result.score } });
    await tree.patchRun();
    await client.createFeedback(tree.id, 'golden-set-assertions', {
      score: SCORES[result.score as keyof typeof SCORES],
      comment: result.report.slice(0, 4000),
    });
  }
};

const main = async (): Promise<void> => {
  const model = process.env.TOVA_EVAL_MODEL ?? 'openai/gpt-oss-20b';
  const provider = process.env.TOVA_EVAL_PROVIDER === 'groq' ? 'groq' : 'deepinfra';
  const keepFixtures = process.argv.includes('--keep-fixtures');
  if (provider === 'deepinfra' && !process.env.DEEPINFRA_API_KEY) {
    console.error('DEEPINFRA_API_KEY must be set to drive the agent.');
    process.exit(1);
  }
  if (provider === 'groq' && !process.env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY must be set when TOVA_EVAL_PROVIDER=groq.');
    process.exit(1);
  }

  await mongoose.connect(buildMongoUri());
  await seedEvalSource();
  const results: { testCase: EvalCase; score: string; report: string }[] = [];
  try {
    for (const testCase of CASES) {
      const assertions = resolveAssertions(testCase);
      process.stdout.write(`${testCase.id} …`);
      try {
        const { run, evidence } = await runCase(
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
        results.push({ testCase, score, report: `${report}\n${evidence}` });
      } catch (error) {
        const report = `ungraded: ${error instanceof Error ? error.message : String(error)}`;
        console.log(` fail | ${report}`);
        results.push({ testCase, score: 'fail', report });
      }
    }
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
