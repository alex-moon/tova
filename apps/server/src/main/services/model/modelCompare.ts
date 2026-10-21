import type { CompletionOptions, LlmProvider } from '../llmTypes';
import { inferenceService, isWiredProvider } from '../inferenceService';
import { buildSystemContent } from '../promptAssembly';
import { outputTokensFor, promptCharsFrom } from '../outputTokenCap';

/* One prompt through each model; shared core for the CLI and admin tab. */
// @see #129

export interface CompareModelRef {
  provider: LlmProvider;
  model: string;
  /** Optional row context length — sizes the output cap like chat does. */
  contextLength?: number;
}

export interface ModelComparisonResult {
  provider: string;
  model: string;
  answer: string | null;
  latencyMs: number;
  error?: string;
}

export interface ComparisonRun {
  prompt: string;
  results: ModelComparisonResult[];
}

export const MAX_COMPARE_MODELS = 6;

/** Sequential on purpose: parallel fan-out makes comparisons flaky. */
export const runModelComparison = async (
  prompt: string,
  models: CompareModelRef[],
): Promise<ComparisonRun> => {
  const system = buildSystemContent(null);
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: prompt },
  ];
  const results: ModelComparisonResult[] = [];
  for (const ref of models) {
    const started = Date.now();
    if (!isWiredProvider(ref.provider)) {
      results.push({
        provider: ref.provider,
        model: ref.model,
        answer: null,
        latencyMs: 0,
        error: `Unknown provider: ${ref.provider}`,
      });
      continue;
    }
    try {
      const options: CompletionOptions = {
        provider: ref.provider,
        model: ref.model,
        messages,
        max_tokens: outputTokensFor(
          ref.contextLength === undefined ? undefined : ref.contextLength,
          promptCharsFrom(messages),
        ),
      };
      // Through inferenceService so failures hit the ModelRouteError tally.
      // @see #175 #398
      const completion = await inferenceService.createCompletion(options);
      results.push({
        provider: ref.provider,
        model: ref.model,
        answer: completion.choices[0]?.message?.content ?? null,
        latencyMs: Date.now() - started,
      });
    } catch (err) {
      results.push({
        provider: ref.provider,
        model: ref.model,
        answer: null,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { prompt, results };
};
