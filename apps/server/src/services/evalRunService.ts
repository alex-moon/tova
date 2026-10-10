/*
 * #225 eval run service: the grading core extracted from
 * `scripts/run-evals.ts` so the CLI and the scheduled "Evals" path share one
 * code path (same stance as `runModelComparison` for #129). The service owns
 * no Mongo connection lifecycle — in-process it uses the shared connection the
 * server already owns; `scripts/run-evals.ts` keeps connect/disconnect.
 *
 * `runEvalSuite` does the work (seed fixtures, drive `runCase`/`gradeRun` over
 * CASES × models, best-effort LangSmith export) and returns per-case results.
 * `startEvalRun` wraps it with the persisted rollup (`EvalRunRecord`) and the
 * single-run lease (Decision 6). Dependencies are injectable so unit tests can
 * exercise the flows without live providers or LangSmith.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from 'langsmith';
import { gradeRun } from '../evals/graders';
import { CASES, resolveExpectedContent, type EvalCase } from '../evals/cases';
import { clearEvalSource, seedEvalSource, evalUserId } from '../evals/mongoSource';
import { runCase } from '../evals/runCase';
import type { Assertion, AssertionResult } from '../evals/types';
import { groqConnector, deepinfraConnector, fireworksConnector } from './mastraService';
import { sweepModels } from './modelConfigService';
import { ROSTER_SEED, type RosterProvider } from './rosterConfig';
import { EvalRunRecord } from '../models/EvalRunRecord';

/*
 * #233: the wired providers now include `fireworks` (added to the roster by
 * #232). `groq` stays wired for the auxiliary-model single-run default; the
 * roster sweep (#236) enumerates deepinfra/fireworks rows.
 */
export type WiredProvider = 'groq' | RosterProvider;

export const connectorsByProvider = {
  groq: groqConnector,
  deepinfra: deepinfraConnector,
  fireworks: fireworksConnector,
} as const;

/** Eval score, stringly typed as the runner always produced it. `error` is a
 * run-level crash recorded in sweep mode, distinct from a graded `fail`. */
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

/**
 * `@repo:<path>` markers resolve against the repository at grading time, so
 * the golden content expectation moves with the file (README) instead of
 * being duplicated inside the case data.
 */
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

/* Best-effort LangSmith export: the `tova-evals` dataset is created when
 * absent and re-used otherwise (score-over-time stays on one dataset), each
 * case becomes an example, each graded run becomes a run on that example
 * with a 1 (pass) / 0.5 (partial) / 0 (fail) feedback score and the
 * assertion report as the comment. Failures degrade to a warning — the
 * local grading result is unchanged. */
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
      score: SCORES[result.score],
      comment: `${result.provider}:${result.model}\n${result.report.slice(0, 4000)}`,
    });
  }
};

/**
 * `--models` csv parsing: entries are `<provider>:<model>` or bare `<model>`
 * (bare = deepinfra — completions are pinned there, #94). Returns null when
 * the flag is absent (single-model mode). Throws on a bad value; the CLI maps
 * that to a non-zero exit and prints the message.
 */
export const parseModelsFlag = (
  value: string | undefined,
  warned?: (message: string) => void,
): { provider: WiredProvider; model: string }[] | null => {
  if (value === undefined) return null;
  if (value === 'all') {
    // Wired roster providers only: typesafe/groq are excluded from the roster
    // sweep (no roster rows, no sweep connector) and that exclusion is stated,
    // not hidden (#158 plan).
    warned?.(
      'sweep universe: the fixed roster on wired providers (deepinfra, fireworks); ' +
        'other providers are excluded.',
    );
    return sweepModels(Object.keys(connectorsByProvider) as RosterProvider[]).map(
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

/**
 * Runs the golden suite over every requested model and returns per-case
 * results. Seeds fixtures, clears them on teardown unless `keepFixtures`, and
 * exports to LangSmith when a client is available (best-effort: an export
 * failure never fails the run).
 */
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

/**
 * Creates a `langsmith` client when a key is configured, else null. Kept out
 * of `runEvalSuite` so the service never reaches for env ad hoc (issue #142's
 * spirit) and tests inject a mock.
 */
export const langsmithClientFromEnv = async (
  apiKey: string | undefined,
): Promise<Client | null> => {
  if (!apiKey) return null;
  const { Client } = await import('langsmith');
  return new Client({ apiKey });
};

export const defaultReadRepoFile = (p: string): string => {
  const repoRoot = path.resolve(__dirname, '../../..');
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

/**
 * Writes the `running` lease and returns its id. Rejects with
 * `EvalRunBusyError` when a run is already live — the cross-restart
 * serialisation guard (Decision 6). Kept separate from `executeEvalRun` so a
 * "Run now" route can answer 202 immediately after the lease exists.
 */
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

/**
 * Runs the suite for an existing lease and settles the document to
 * `done`/`error`. A run-level crash is recorded, never thrown (Decision 5).
 */
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

/**
 * Persists and executes one suite run. Creates the `running` lease document
 * first (so a crash leaves a reclaimable row), runs the suite, and settles the
 * document to `done`/`error`. Consult `status: 'running'` in Mongo for
 * cross-restart safety (Decision 6): a second caller while one is live is
 * rejected with `EvalRunBusyError`.
 */
export const startEvalRun = async (
  options: StartEvalRunOptions,
  deps: EvalRunDeps = {},
): Promise<{ id: string; results: EvalResult[] }> => {
  const id = await beginEvalRun(options, deps);
  const results = await executeEvalRun(id, options, deps);
  return { id, results };
};

/*
 * #236: the scheduled default is a roster model, not the retired guard model
 * (`openai/gpt-oss-20b` has no roster home). GLM 5.3 Flash is the cheapest
 * roster entry, keeping an unattended daily run as cheap as the roster allows.
 * Sourced from `ROSTER_SEED` so the id cannot drift from the roster definition;
 * override with `TOVA_EVAL_MODELS` (or `TOVA_EVAL_MODEL`/`TOVA_EVAL_PROVIDER`).
 */
const defaultEvalRef = (): { provider: RosterProvider; model: string } => {
  const model = ROSTER_SEED.find((m) => m.modelId === 'zai-org/GLM-5.3-Flash') ?? ROSTER_SEED[0];
  const provider = model.providers.find((p) => p.provider === 'deepinfra') ?? model.providers[0];
  return { provider: provider.provider, model: provider.modelId };
};

/**
 * Resolves the model set for a scheduled run (OQ2 fallback): the
 * `TOVA_EVAL_MODELS` csv when set, else the runner's single-model default
 * (`TOVA_EVAL_MODEL` / `TOVA_EVAL_PROVIDER`, defaulting to the cheapest roster
 * model on DeepInfra). Values come from config, not ad-hoc `process.env`
 * (issue #142).
 */
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
