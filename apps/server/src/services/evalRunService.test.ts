import { CASES } from '../evals/cases';
import { EvalRunRecord } from '../models/EvalRunRecord';
import {
  EvalRunBusyError,
  parseModelsFlag,
  resolveScheduledModels,
  runEvalSuite,
  startEvalRun,
  type EvalSuiteDeps,
} from './evalRunService';

/*
 * #225 service coverage. The suite drives live providers in production; here
 * connectors, runCase, gradeRun, fixtures, repo reads, and the LangSmith
 * client are all injected so the flows are deterministic. The shared jest
 * setup provides the in-memory Mongo (apps/server/src/test/setup.ts).
 */

const model = { provider: 'deepinfra' as const, model: 'openai/gpt-oss-20b' };
const sweepModels = [
  { provider: 'deepinfra' as const, model: 'openai/gpt-oss-20b' },
  { provider: 'groq' as const, model: 'openai/gpt-oss-20b' },
];

const connectors = {
  deepinfra: { createStreamingCompletion: async () => null },
  groq: { createStreamingCompletion: async () => null },
} as unknown as EvalSuiteDeps['connectors'];

const baseDeps = (over: EvalSuiteDeps = {}): EvalSuiteDeps => ({
  seedSource: async () => {},
  clearSource: async () => {},
  readRepoFile: () => '',
  connectors,
  runCaseFn: (async () => ({ run: { toolCalls: [], prompt: 'p' }, evidence: 'ev' })) as never,
  gradeRunFn: (() => ({ score: 'pass', assertions: [] })) as never,
  ...over,
});

describe('parseModelsFlag (#225)', () => {
  it('returns null when the flag is absent (single-model mode)', () => {
    expect(parseModelsFlag(undefined)).toBeNull();
  });

  it('parses provider:model entries and bare models default to deepinfra', () => {
    expect(parseModelsFlag('groq:openai/gpt-oss-20b,Qwen/Qwen3-14B')).toEqual([
      { provider: 'groq', model: 'openai/gpt-oss-20b' },
      { provider: 'deepinfra', model: 'Qwen/Qwen3-14B' },
    ]);
  });

  it('throws on an unknown provider', () => {
    expect(() => parseModelsFlag('typesafe:x')).toThrow(/Unknown provider/);
  });

  it('resolves `all` to the roster on both wired providers (#236)', () => {
    const messages: string[] = [];
    const models = parseModelsFlag('all', (m) => messages.push(m));
    // 3 roster models × 2 providers = 6 runs.
    expect(models).toHaveLength(6);
    expect(models).toContainEqual({
      provider: 'deepinfra',
      model: 'zai-org/GLM-5.3-Flash',
    });
    expect(models).toContainEqual({
      provider: 'fireworks',
      model: 'accounts/fireworks/models/glm-5p3-flash',
    });
    // groq is wired for single-run defaults but has no roster rows.
    expect(models!.every((m) => m.provider !== 'groq')).toBe(true);
    expect(messages[0]).toMatch(/wired providers/);
  });
});

describe('resolveScheduledModels (#225)', () => {
  it('prefers the models csv when set', () => {
    expect(
      resolveScheduledModels({
        models: 'groq:openai/gpt-oss-20b,Qwen/Qwen3-14B',
        model: 'ignored',
        provider: 'groq',
      }),
    ).toEqual([
      { provider: 'groq', model: 'openai/gpt-oss-20b' },
      { provider: 'deepinfra', model: 'Qwen/Qwen3-14B' },
    ]);
  });

  it('falls back to the single model/provider pair, defaulting to deepinfra', () => {
    expect(resolveScheduledModels({ model: 'Qwen/Qwen3-14B', provider: 'groq' })).toEqual([
      { provider: 'groq', model: 'Qwen/Qwen3-14B' },
    ]);
    // Unknown provider coerces to deepinfra (the completions-pinned default).
    expect(resolveScheduledModels({ model: 'x', provider: 'bogus' })).toEqual([
      { provider: 'deepinfra', model: 'x' },
    ]);
  });

  it('uses the cheapest roster model when nothing is configured (#236)', () => {
    expect(resolveScheduledModels({})).toEqual([
      { provider: 'deepinfra', model: 'zai-org/GLM-5.3-Flash' },
    ]);
  });

  it('lets a configured model override the roster default on deepinfra', () => {
    expect(resolveScheduledModels({ model: 'MiniMaxAI/MiniMax-M3' })).toEqual([
      { provider: 'deepinfra', model: 'MiniMaxAI/MiniMax-M3' },
    ]);
  });
});

describe('runEvalSuite (#225)', () => {
  it('grades every case and returns results', async () => {
    const seen: string[] = [];
    const results = await runEvalSuite(
      { models: [model] },
      baseDeps({ onCase: (event) => seen.push(event.caseId) }),
    );
    expect(results).toHaveLength(CASES.length);
    expect(results.every((r) => r.score === 'pass')).toBe(true);
    expect(seen).toHaveLength(CASES.length);
  });

  it('records a thrown case as `error` in sweep mode and `fail` otherwise', async () => {
    const runCaseFn = (async () => {
      throw new Error('provider exploded');
    }) as never;
    const single = await runEvalSuite({ models: [model] }, baseDeps({ runCaseFn }));
    expect(single.every((r) => r.score === 'fail')).toBe(true);
    expect(single[0].report).toMatch(/ungraded: provider exploded/);

    const sweep = await runEvalSuite({ models: sweepModels }, baseDeps({ runCaseFn }));
    expect(sweep.every((r) => r.score === 'error')).toBe(true);
  });

  it('clears fixtures unless keepFixtures is set', async () => {
    let cleared = 0;
    const clearSource = async () => {
      cleared += 1;
    };
    await runEvalSuite({ models: [model] }, baseDeps({ clearSource }));
    expect(cleared).toBe(1);
    await runEvalSuite({ models: [model], keepFixtures: true }, baseDeps({ clearSource }));
    expect(cleared).toBe(1);
  });

  it('still returns local grading when the LangSmith export fails', async () => {
    let warned: unknown = null;
    const results = await runEvalSuite(
      { models: [model] },
      baseDeps({
        langsmithClient: {} as never,
        onLangsmithError: (err) => {
          warned = err;
        },
        // A fake client whose hasDataset rejects: pushToLangSmith throws.
      }),
    );
    expect(results).toHaveLength(CASES.length);
    expect(warned).toBeInstanceOf(Error);
  });
});

describe('startEvalRun (#225)', () => {
  it('writes a done rollup with per-case results', async () => {
    const { id, results } = await startEvalRun({ models: [model], trigger: 'manual' }, baseDeps());
    expect(results).toHaveLength(CASES.length);
    const doc = await EvalRunRecord.findById(id);
    expect(doc?.status).toBe('done');
    expect(doc?.finishedAt).toBeInstanceOf(Date);
    expect(doc?.models).toEqual(['deepinfra:openai/gpt-oss-20b']);
    expect(doc?.results).toHaveLength(CASES.length);
    expect(doc?.results[0]).toMatchObject({ provider: 'deepinfra', score: 'pass' });
  });

  it('rejects a second run while one is running', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runCaseFn = (async () => {
      await gate;
      return { run: { toolCalls: [], prompt: 'p' }, evidence: 'ev' };
    }) as never;
    const first = startEvalRun({ models: [model], trigger: 'manual' }, baseDeps({ runCaseFn }));
    // Let the running doc be created before the second attempt.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(
      startEvalRun({ models: [model], trigger: 'manual' }, baseDeps({ runCaseFn })),
    ).rejects.toBeInstanceOf(EvalRunBusyError);
    release();
    await first;
  });

  it('settles to error when the suite throws, and does not reject', async () => {
    const { id, results } = await startEvalRun(
      { models: [model], trigger: 'scheduled' },
      baseDeps({
        seedSource: async () => {
          throw new Error('seed failed');
        },
      }),
    );
    expect(results).toEqual([]);
    const doc = await EvalRunRecord.findById(id);
    expect(doc?.status).toBe('error');
    expect(doc?.error).toMatch(/seed failed/);
    expect(doc?.finishedAt).toBeInstanceOf(Date);
  });
});
