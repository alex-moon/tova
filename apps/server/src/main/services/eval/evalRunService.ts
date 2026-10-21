/* Eval grading core shared by the CLI and the scheduled path. */
// @see #225 #129
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from 'langsmith';
import { gradeRun } from '../../evals/graders';
import { CASES, resolveExpectedContent, type EvalCase } from '../../evals/cases';
import { clearEvalSource, seedEvalSource, evalUserId } from '../../evals/mongoSource';
import { runCase } from '../../evals/runCase';
import type { Assertion, AssertionResult } from '../../evals/types';
import { inferenceService, isWiredProvider } from '../inferenceService';
import { sweepModels, CHAT_MODEL } from '../model/modelDefaults';
import { EvalRunRecord } from '../../models/EvalRunRecord';
import { clampError } from '../clampError';
import { asDatasetClient, ensureDataset } from '../langsmithDataset';

/* Wired providers; the sweep enumerates the fixed models' backends. */
// @see #233 #232 #236 #387
export type WiredProvider = 'groq' | 'deepinfra' | 'fireworks';

/* Streaming entry per wired provider, routed through the shared tally
 * so eval runs record ModelRouteError like every other caller. @see #398 */
export const connectorsByProvider = {
  groq: { createStreamingCompletion: inferenceService.createStreamingCompletion },
  deepinfra: { createStreamingCompletion: inferenceService.createStreamingCompletion },
  fireworks: { createStreamingCompletion: inferenceService.createStreamingCompletion },
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
  const ls = asDatasetClient(client);
  await ensureDataset(ls, DATASET_NAME);
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

/* Model+provider config errors: the caller can fix them, unlike a crash. */
export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalConfigError';
  }
}

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
      if (!isWiredProvider(entry.slice(0, sep))) {
        throw new EvalConfigError(
          `Unknown provider in --models '${entry}' (wired: deepinfra, fireworks, groq).`,
        );
      }
      return { provider: entry.slice(0, sep) as WiredProvider, model: entry.slice(sep + 1) };
    });
};

const resolveAssertionResults = (assertions: AssertionResult[]): string =>
  assertions.map((r) => `${JSON.stringify(r.assertion.type)}=${r.passed ? 'y' : 'n'}`).join(' ');

/* One hung stream must not wedge the suite; the cap stays under the
 * scheduler's 2 h stale-lease reclaim so a capped run can never race it. */
// @see #394
export const EVAL_CASE_TIMEOUT_MS = 5 * 60 * 1000;
export const EVAL_SUITE_CAP_MS = 90 * 60 * 1000;

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
  const suiteStart = Date.now();
  await seedSource();
  try {
    for (const { provider, model } of options.models) {
      const connector = connectors[provider];
      const thrown: { testCase: EvalCase; error: unknown }[] = [];
      let graded = 0;
      let capped = false;
      for (const testCase of CASES) {
        // Suite wall-clock cap: stop once the budget is spent.
        const remainingMs = EVAL_SUITE_CAP_MS - (Date.now() - suiteStart);
        if (remainingMs <= 0) {
          capped = true;
          break;
        }
        const caseMs = Math.min(EVAL_CASE_TIMEOUT_MS, remainingMs);
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
              abortSignal: AbortSignal.timeout(caseMs),
            },
            testCase,
          );
          const { score, assertions: assertionResults } = gradeRunFn(run, assertions);
          const report = resolveAssertionResults(assertionResults);
          results.push({ testCase, model, provider, score, report: `${report}\n${evidence}` });
          deps.onCase?.({ provider, model, caseId: testCase.id, score, report, evidence });
          graded += 1;
        } catch (error) {
          thrown.push({ testCase, error });
        }
      }
      // A crash with nothing graded is a run-level provider failure, not N
      // graded fails; a lone throw beside passing cases is case-level.
      // @see #394
      const crashScore: EvalScore = graded > 0 ? 'fail' : 'error';
      for (const { testCase, error } of thrown) {
        const report = `ungraded: ${error instanceof Error ? error.message : String(error)}`;
        results.push({ testCase, model, provider, score: crashScore, report });
        deps.onCase?.({ provider, model, caseId: testCase.id, score: crashScore, report });
      }
      // A capped run must not look like a complete one. @see #394
      if (capped)
        console.error(
          `eval suite: wall-clock cap spent; remaining cases on ` +
            `${provider}:${model} and any later models are skipped`,
        );
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
  const repoRoot = path.resolve(__dirname, '../../../../..');
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

/** Lease seams shared by both suite runners; the memory runner adds `run`. */
export interface EvalLeaseDeps {
  createRecord?: typeof EvalRunRecord.create;
  findRunning?: () => Promise<unknown | null>;
  updateRecord?: (id: unknown, update: Record<string, unknown>) => Promise<unknown>;
}

/** Resolves the injectable lease seams, defaulting to the real collection. */
export const resolveLeaseDeps = (deps: EvalLeaseDeps) => ({
  createRecord: deps.createRecord ?? EvalRunRecord.create.bind(EvalRunRecord),
  findRunning:
    deps.findRunning ?? (() => EvalRunRecord.findOne({ status: 'running' }).lean().exec()),
  updateRecord:
    deps.updateRecord ?? ((id, update) => EvalRunRecord.updateOne({ _id: id }, update).exec()),
});

/* Atomically writes the `running` lease; the unique partial index turns a
 * concurrent second write into E11000, surfaced as EvalRunBusyError. */
// @see #394
export const writeEvalLease = async (
  doc: Record<string, unknown>,
  deps: Pick<EvalLeaseDeps, 'createRecord'>,
): Promise<string> => {
  try {
    const createRecord = deps.createRecord ?? EvalRunRecord.create.bind(EvalRunRecord);
    const record = await createRecord(doc);
    return String((record as { _id: unknown })._id);
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) throw new EvalRunBusyError();
    throw error;
  }
};

/** Suite seams plus the lease seams; what `startEvalRun` accepts. */
export type EvalRunDeps = EvalSuiteDeps & EvalLeaseDeps;

/* Writes the `running` lease; rejects EvalRunBusyError when one is live. */
// @see #225 #394
export const beginEvalRun = async (
  options: StartEvalRunOptions,
  deps: EvalRunDeps = {},
): Promise<string> => {
  const { findRunning } = resolveLeaseDeps(deps);
  if (await findRunning()) throw new EvalRunBusyError();

  const modelKeys = options.models.map(({ provider, model }) => `${provider}:${model}`);
  return writeEvalLease(
    {
      startedAt: new Date(),
      status: 'running',
      models: modelKeys,
    },
    deps,
  );
};

/** Runs the suite for an existing lease, settling to done/error. */
export const executeEvalRun = async (
  id: string,
  options: StartEvalRunOptions,
  deps: EvalRunDeps = {},
): Promise<EvalResult[]> => {
  const { updateRecord } = resolveLeaseDeps(deps);
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
    const message = clampError(error);
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
  if (evals.provider && !isWiredProvider(evals.provider)) {
    throw new EvalConfigError(
      `Unknown provider '${evals.provider}' in the eval provider config ` +
        `(wired: ${Object.keys(connectorsByProvider).join(', ')}).`,
    );
  }
  const fallback = defaultEvalRef();
  const provider = (evals.provider as WiredProvider) || fallback.provider;
  if (evals.model) return [{ provider, model: evals.model }];
  // Model+provider resolve as one unit: with no explicit model, the provider
  // must host a fixed model or the config is an error — never a silent
  // cross-backend model id. @see #394
  const known = sweepModels().find((m) => m.provider === provider);
  if (!known) {
    throw new EvalConfigError(
      `Provider '${provider}' hosts no fixed eval model ` +
        '(CHAT_MODEL/TASK_MODEL backends); set TOVA_EVAL_MODEL explicitly.',
    );
  }
  return [{ provider, model: known.model }];
};
