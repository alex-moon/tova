import type { LlmProvider } from '../llm/llmTypes';

/* Fixed per-function models: env-pinned ids, known backends, static metadata. */
// @see #387

/** Chat model id (display id, as persisted on messages). */
export const CHAT_MODEL = process.env.CHAT_MODEL || 'zai-org/GLM-5.3-Flash';

/** Task model id; tasks always ride DeepInfra (DS4.1F is fireworks-stale). */
export const TASK_MODEL = process.env.TASK_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash-1017';

/** The one provider tasks may ride. */
export const TASK_PROVIDER: LlmProvider = 'deepinfra';

/* Provider-specific model ids per chat backend; only known defaults map. */
// @see #232
const BACKEND_IDS: Record<string, Partial<Record<LlmProvider, string>>> = {
  'zai-org/GLM-5.3-Flash': {
    deepinfra: 'zai-org/GLM-5.3-Flash',
    fireworks: 'accounts/fireworks/models/glm-5p3-flash',
  },
  'deepseek-ai/DeepSeek-V4.1-Flash': {
    deepinfra: 'deepseek-ai/DeepSeek-V4.1-Flash',
    fireworks: 'accounts/fireworks/models/deepseek-v4p1-flash',
  },
};

/* Chat's raceable backends; an unknown model override rides deepinfra alone. */
export const chatBackends = (): { provider: LlmProvider; modelId: string }[] => {
  const known = BACKEND_IDS[CHAT_MODEL];
  if (known) {
    return Object.entries(known).map(([provider, modelId]) => ({
      provider: provider as LlmProvider,
      modelId: modelId as string,
    }));
  }
  return [{ provider: 'deepinfra', modelId: CHAT_MODEL }];
};

/* Context windows for output-budget sizing; unknown ids fall to undefined. */
// @see #298
const CONTEXT_LENGTHS: Record<string, number> = {
  'zai-org/GLM-5.3-Flash': 1048576,
  'deepseek-ai/DeepSeek-V4.1-Flash': 1048576,
  'deepseek-ai/DeepSeek-V4.1-Flash-1017': 1048576,
};

export const contextLengthFor = (modelId: string): number | undefined => CONTEXT_LENGTHS[modelId];

/* USD/1M prices for cost estimates; unknown rows estimate as null. */
// @see #199
const MODEL_PRICES: Record<
  string,
  Partial<Record<LlmProvider, { input: number; output: number }>>
> = {
  'zai-org/GLM-5.3-Flash': {
    deepinfra: { input: 0.15, output: 0.5 },
    fireworks: { input: 0.15, output: 0.5 },
  },
  'deepseek-ai/DeepSeek-V4.1-Flash': {
    deepinfra: { input: 0.2, output: 0.6 },
    fireworks: { input: 0.3, output: 1.2 },
  },
  'deepseek-ai/DeepSeek-V4.1-Flash-1017': {
    deepinfra: { input: 0.2, output: 0.6 },
  },
};

export const priceRowsForModel = (
  modelId: string,
): Partial<Record<LlmProvider, { inputPrice: number; outputPrice: number }>> => {
  const rows = MODEL_PRICES[modelId];
  if (!rows) return {};
  const out: Partial<Record<LlmProvider, { inputPrice: number; outputPrice: number }>> = {};
  for (const [provider, row] of Object.entries(rows)) {
    if (row) out[provider as LlmProvider] = { inputPrice: row.input, outputPrice: row.output };
  }
  return out;
};

/* Every priced model id, so the cost index also covers pre-retirement ids. */
export const pricedModels = (): string[] => Object.keys(MODEL_PRICES);

/* Eval sweep universe: the deduped backend pairs of the fixed models. */
export const sweepModels = (): { provider: LlmProvider; model: string }[] => {
  const seen = new Set<string>();
  const refs: { provider: LlmProvider; model: string }[] = [];
  for (const { provider, modelId } of [
    ...chatBackends(),
    { provider: TASK_PROVIDER, modelId: TASK_MODEL },
  ]) {
    const key = `${provider}:${modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ provider, model: modelId });
  }
  return refs;
};
