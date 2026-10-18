/* Eval grading core shared by the CLI and the scheduled path. */
// @see #225 #129
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from 'langsmith';
import { gradeRun } from '../evals/graders';
import { CASES, resolveExpectedContent, type EvalCase } from '../evals/cases';
import { clearEvalSource, seedEvalSource, evalUserId } from '../evals/mongoSource';
import { runCase } from '../evals/runCase';
import type { Assertion, AssertionResult } from '../evals/types';
import { groqConnector, deepinfraConnector, fireworksConnector } from './mastraService';
import { sweepModels, CHAT_MODEL } from './modelDefaults';
import { EvalRunRecord } from '../models/EvalRunRecord';

/* Wired providers; the sweep enumerates the fixed models' backends. */
// @see #233 #232 #236 #387
export type WiredProvider = 'groq' | 'deepinfra' | 'fireworks';

export const connectorsByProvider = {
  groq: groqConnector,
  deepinfra: deepinfraConnector,
  fireworks: fireworksConnector,
} as const;

/** Eval score as the runner produces it; `error` is a run-level crash. */
export type EvalScore = 'pass' | 'partial' | 'fail' | 'error';

/** One graded case result (the runner's module-local `EvalResult`). */
export interface EvalResult {
  testCase: EvalCase;
  model: string;
  provider: WiredProvider;
  score: EvalScore;
  report: string;
}

/** Emitted after each case so the CLI can keep its streaming stdout. */
export interface EvalCaseEvent {
  provider: WiredProvider;
  model: string;
  caseId: string;
  score: EvalScore;
  report: string;
  evidence?: string;
}

const SCORES: Record<EvalScore, number> = { pass: 1, partial: 0.5, fail: 0, error: 0 };
const DATASET_NAME = 'tova-evals';

/** `@repo:<path>` markers resolve against the repo at grading time. */
export const resolveAssertions = (
  testCase: EvalCase,
  readRepoFile: (path: string) => string,
): Assertion[] =>
  testCase.assertions.map((assertion) =>
    assertion.type === 'content_equals'
      ? {
          ...assertion,
          expected: resolveExpectedContent(assertion.expected, readRepoFile),
        }
      : assertion,
  );

/* Best-effort LangSmith export; failures degrade to a warning. */
export const pushToLangSmith = async (client: Client, results: EvalResult[]): Promise<void> => {
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
  // Examples address the dataset by name; re-runs append fresh results.
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
  // RunTree is the supported run-submission path in langsmith@0.8.
  // @see #158
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
      score: SCORES[result.score],
      comment: `${result.provider}:${result.model}\n${result.report.slice(0, 4000)}`,
    });
  }
};

/* `--models` csv: `<provider>:<model>` or bare model; null when absent. */
// @see #94
export const parseModelsFlag = (
  value: string | undefined,
  warned?: (message: string) => void,
): { provider: WiredProvider; model: string }[] | null => {
  if (value === undefined) return null;
  if (value === 'all') {
    // Wired fixed-model backends only; the rest are excluded, not hidden.
    // @see #158 #387
    warned?.(
      'sweep universe: the fixed models (CHAT_MODEL/TASK_MODEL) on wired providers ' +
        '(deepinfra, fireworks); other providers are excluded.',
    );
    return sweepModels().map(({ provider, model }) => ({
      provider: provider as WiredProvider,
      model,
    }));
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const sep = entry.indexOf(':');
      if (sep === -1) return { provider: 'deepinfra' as const, model: entry };
      if (!(entry.slice(0, sep) in connectorsByProvider)) {
        throw new Error(
          `Unknown provider in --models '${entry}' (wired: deepinfra, fireworks, groq).`,
        );
      }
      return { provider: entry.slice(0, sep) as WiredProvider, model: entry.slice(sep + 1) };
    });
};

const resolveAssertionResults = (assertions: AssertionResult[]): string =>
  assertions.map((r) => `${JSON.stringify(r.assertion.type)}=${r.passed ? 'y' : 'n'}`).join(' ');

export interface EvalSuiteOptions {
  models: { provider: WiredProvider; model: string }[];
  keepFixtures?: boolean;
}

/** Injectable seams for `runEvalSuite` so tests run without live providers. */
export interface EvalSuiteDeps {
  seedSource?: () => Promise<void>;
  clearSource?: () => Promise<void>;
  runCaseFn?: typeof runCase;
  gradeRunFn?: typeof gradeRun;
  connectors?: Record<WiredProvider, { createStreamingCompletion: unknown }>;
  langsmithClient?: Client | null;
  onLangsmithError?: (error: unknown) => void;
  readRepoFile?: (path: string) => string;
  onCase?: (event: EvalCaseEvent) => void;
}

/** Runs the golden suite over every requested model. */
export const runEvalSuite = async (
  options: EvalSuiteOptions,
  deps: EvalSuiteDeps = {},
): Promise<EvalResult[]> => {
  const seedSource = deps.seedSource ?? seedEvalSource;
  const clearSource = deps.clearSource ?? clearEvalSource;
  const runCaseFn = deps.runCaseFn ?? runCase;
  const gradeRunFn = deps.gradeRunFn ?? gradeRun;
  const connectors = deps.connectors ?? connectorsByProvider;
  const readRepoFile = deps.readRepoFile ?? defaultReadRepoFile;

  const results: EvalResult[] = [];
  const sweep = options.models.length > 1;
  await seedSource();
  try {
    for (const { provider, model } of options.models) {
      const connector = connectors[provider];
      for (const testCase of CASES) {
        const assertions = resolveAssertions(testCase, readRepoFile);
        try {
          const { run, evidence } = await runCaseFn(
            connector.createStreamingCompletion as Parameters<typeof runCase>[0],
            {
              provider,
              model,
              messages: [{ role: 'user', content: testCase.prompt }],
              userId: evalUserId.toHexString(),
              trace: { sessionId: `tova-evals-${testCase.id}` },
            },
            testCase,
          );
          const { score, assertions: assertionResults } = gradeRunFn(run, assertions);
          const report = resolveAssertionResults(assertionResults);
          results.push({ testCase, model, provider, score, report: `${report}\n${evidence}` });
          deps.onCase?.({ provider, model, caseId: testCase.id, score, report, evidence });
        } catch (error) {
          const report = `ungraded: ${error instanceof Error ? error.message : String(error)}`;
          const score: EvalScore = sweep ? 'error' : 'fail';
          results.push({ testCase, model, provider, score, report });
          deps.onCase?.({ provider, model, caseId: testCase.id, score, report });
        }
      }
    }
  } finally {
    if (!options.keepFixtures) await clearSource();
  }

  if (deps.langsmithClient) {
    try {
      await pushToLangSmith(deps.langsmithClient, results);
    } catch (error) {
      // Best-effort export: the local grading result is the source of truth.
      deps.onLangsmithError?.(error);
    }
  }
  return results;
};

/** Creates a langsmith client when a key is configured, else null. */
// @see #142
export const langsmithClientFromEnv = async (
  apiKey: string | undefined,
): Promise<Client | null> => {
  if (!apiKey) return null;
  const { Client } = await import('langsmith');
  return new Client({ apiKey });
};

export const defaultReadRepoFile = (p: string): string => {
  const repoRoot = path.resolve(__dirname, '../../../..');
  return fs.readFileSync(path.join(repoRoot, p), 'utf8');
};

export interface StartEvalRunOptions {
  models: { provider: WiredProvider; model: string }[];
  trigger: 'scheduled' | 'manual';
}

export class EvalRunBusyError extends Error {
  constructor() {
    super('An eval run is already in progress.');
    this.name = 'EvalRunBusyError';
  }
}

const MAX_STORED_ERROR_CHARS = 500;

type EvalRunDeps = EvalSuiteDeps & {
  createRecord?: typeof EvalRunRecord.create;
  findRunning?: () => Promise<unknown | null>;
  updateRecord?: (id: unknown, update: Record<string, unknown>) => Promise<unknown>;
};

/** Resolves the injectable seams, defaulting to the real collection. */
const resolveRunDeps = (deps: EvalRunDeps) => ({
  createRecord: deps.createRecord ?? EvalRunRecord.create.bind(EvalRunRecord),
  findRunning:
    deps.findRunning ?? (() => EvalRunRecord.findOne({ status: 'running' }).lean().exec()),
  updateRecord:
    deps.updateRecord ?? ((id, update) => EvalRunRecord.updateOne({ _id: id }, update).exec()),
});

/* Writes the `running` lease; rejects EvalRunBusyError when one is live. */
// @see #225
export const beginEvalRun = async (
  options: StartEvalRunOptions,
  deps: EvalRunDeps = {},
): Promise<string> => {
  const { createRecord, findRunning } = resolveRunDeps(deps);
  if (await findRunning()) throw new EvalRunBusyError();

  const modelKeys = options.models.map(({ provider, model }) => `${provider}:${model}`);
  const record = await createRecord({
    startedAt: new Date(),
    status: 'running',
    models: modelKeys,
  });
  return String((record as { _id: unknown })._id);
};

/** Runs the suite for an existing lease, settling to done/error. */
export const executeEvalRun = async (
  id: string,
  options: StartEvalRunOptions,
  deps: EvalRunDeps = {},
): Promise<EvalResult[]> => {
  const { updateRecord } = resolveRunDeps(deps);
  try {
    const results = await runEvalSuite({ models: options.models }, deps);
    await updateRecord(id, {
      $set: {
        status: 'done',
        finishedAt: new Date(),
        results: results.map(({ testCase, model, provider, score, report }) => ({
          caseId: testCase.id,
          model,
          provider,
          score,
          report,
        })),
      },
    });
    return results;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(
      0,
      MAX_STORED_ERROR_CHARS,
    );
    await updateRecord(id, { $set: { status: 'error', finishedAt: new Date(), error: message } });
    return [];
  }
};

/** Persists and executes one suite run: lease first, then run. */
// @see #225
export const startEvalRun = async (
  options: StartEvalRunOptions,
  deps: EvalRunDeps = {},
): Promise<{ id: string; results: EvalResult[] }> => {
  const id = await beginEvalRun(options, deps);
  const results = await executeEvalRun(id, options, deps);
  return { id, results };
};

/* Scheduled default: CHAT_MODEL on its deepinfra backend. */
// @see #236 #387
const defaultEvalRef = (): { provider: WiredProvider; model: string } => {
  const backend = sweepModels().find((m) => m.provider === 'deepinfra' && m.model === CHAT_MODEL);
  return {
    provider: 'deepinfra',
    model: backend?.model ?? CHAT_MODEL,
  };
};

/* Scheduled run models: TOVA_EVAL_MODELS csv, else the single default. */
// @see #142
export const resolveScheduledModels = (
  evals: { models?: string; model?: string; provider?: string } = {},
): { provider: WiredProvider; model: string }[] => {
  if (evals.models) {
    const parsed = parseModelsFlag(evals.models);
    if (parsed && parsed.length > 0) return parsed;
  }
  const fallback = defaultEvalRef();
  return [
    {
      provider: evals.provider === 'groq' ? 'groq' : fallback.provider,
      model: evals.model ?? fallback.model,
    },
  ];
};
