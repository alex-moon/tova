import { CASES } from '../../../main/evals/cases';
import { EvalRunRecord } from '../../../main/models/EvalRunRecord';
import {
  EVAL_SUITE_CAP_MS,
  EvalConfigError,
  EvalRunBusyError,
  parseModelsFlag,
  resolveScheduledModels,
  runEvalSuite,
  startEvalRun,
  type EvalRunDeps,
} from '../../../main/services/eval/evalRunService';

/* Service coverage: all collaborators injected so flows are deterministic. */
// @see #225

const model = { provider: 'deepinfra' as const, model: 'openai/gpt-oss-20b' };
const sweepModels = [
  { provider: 'deepinfra' as const, model: 'openai/gpt-oss-20b' },
  { provider: 'groq' as const, model: 'openai/gpt-oss-20b' },
];

const connectors = {
  deepinfra: { createStreamingCompletion: async () => null },
  groq: { createStreamingCompletion: async () => null },
} as unknown as EvalRunDeps['connectors'];

const baseDeps = (over: EvalRunDeps = {}): EvalRunDeps => ({
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

  it('resolves `all` to the fixed-model backends (#387)', () => {
    const messages: string[] = [];
    const models = parseModelsFlag('all', (m) => messages.push(m));
    // GLM (deepinfra + fireworks) + DeepSeek (deepinfra), deduped.
    // @see #387
    expect(models).toHaveLength(3);
    expect(models).toContainEqual({
      provider: 'deepinfra',
      model: 'zai-org/GLM-5.3-Flash',
    });
    expect(models).toContainEqual({
      provider: 'fireworks',
      model: 'accounts/fireworks/models/glm-5p3-flash',
    });
    expect(models).toContainEqual({
      provider: 'deepinfra',
      model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    });
    // groq is wired for single-run defaults but hosts no fixed model.
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
  });

  it('honours any wired provider, not just groq (#394)', () => {
    // The model default is that provider's own fixed model, one unit.
    expect(resolveScheduledModels({ provider: 'fireworks' })).toEqual([
      {
        provider: 'fireworks',
        model: 'accounts/fireworks/models/glm-5p3-flash',
      },
    ]);
  });

  it('throws when a wired provider hosts no fixed model (#394)', () => {
    // groq is wired but hosts none of the fixed models; the deepinfra
    // default id must never leak across backends.
    expect(() => resolveScheduledModels({ provider: 'groq' })).toThrow(EvalConfigError);
  });

  it('throws on an unknown provider instead of stranding the model elsewhere (#394)', () => {
    expect(() => resolveScheduledModels({ model: 'x', provider: 'bogus' })).toThrow(
      EvalConfigError,
    );
  });

  it('uses CHAT_MODEL on deepinfra when nothing is configured (#387)', () => {
    expect(resolveScheduledModels({})).toEqual([
      { provider: 'deepinfra', model: 'zai-org/GLM-5.3-Flash' },
    ]);
  });

  it('lets a configured model override the CHAT_MODEL default on deepinfra', () => {
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

  it('scores a whole-run throw as `error` and a lone throw as `fail` (#394)', async () => {
    const runCaseFn = (async () => {
      throw new Error('provider exploded');
    }) as never;
    // Every case throws: a provider outage, not graded fails — even though
    // the scheduled default is single-model.
    const single = await runEvalSuite({ models: [model] }, baseDeps({ runCaseFn }));
    expect(single.every((r) => r.score === 'error')).toBe(true);
    expect(single[0].report).toMatch(/ungraded: provider exploded/);

    const sweep = await runEvalSuite({ models: sweepModels }, baseDeps({ runCaseFn }));
    expect(sweep.every((r) => r.score === 'error')).toBe(true);
  });

  it('scores a lone throw beside graded cases as `fail`, not `error` (#394)', async () => {
    let calls = 0;
    const runCaseFn = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('flaky case');
      return { run: { toolCalls: [], prompt: 'p' }, evidence: 'ev' };
    }) as never;
    const results = await runEvalSuite({ models: [model] }, baseDeps({ runCaseFn }));
    // Thrown cases flush after the graded ones.
    expect(results[results.length - 1].score).toBe('fail');
    expect(results.slice(0, -1).every((r) => r.score === 'pass')).toBe(true);
  });

  it('logs and skips remaining cases once the suite cap is spent (#394)', async () => {
    const now = Date.now();
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const runCaseFn = (async () => {
      calls += 1;
      // The budget is exhausted inside the first case; case 2 never starts.
      if (calls === 1) dateSpy.mockReturnValue(now + EVAL_SUITE_CAP_MS + 1);
      return { run: { toolCalls: [], prompt: 'p' }, evidence: 'ev' };
    }) as never;
    const results = await runEvalSuite({ models: [model] }, baseDeps({ runCaseFn }));
    expect(results).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/wall-clock cap spent/));
    dateSpy.mockRestore();
    errorSpy.mockRestore();
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

  it('enforces the lease atomically when the pre-check misses (#394)', async () => {
    // Simulates the check-then-create race: both callers see no running row,
    // the unique partial index rejects the second insert.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runCaseFn = (async () => {
      await gate;
      return { run: { toolCalls: [], prompt: 'p' }, evidence: 'ev' };
    }) as never;
    const first = startEvalRun(
      { models: [model], trigger: 'manual' },
      baseDeps({ runCaseFn, findRunning: async () => null }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(
      startEvalRun(
        { models: [model], trigger: 'manual' },
        baseDeps({ runCaseFn, findRunning: async () => null }),
      ),
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
