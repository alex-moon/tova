import type { CompletionOptions, LlmConnector, LlmProvider } from './llmTypes';
import { groqConnector, deepinfraConnector, fireworksConnector } from './mastraService';
import { buildSystemContent } from './promptAssembly';
import { outputTokensFor, promptCharsFrom } from './outputTokenCap';

/* Direct model comparison: one prompt through the existing agent on several pairs, shared core for the CLI and the admin Compare tab so both exercise the identical path; routing is bypassed, decisions informed. */
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

/* The typesafe connector does not exist yet, so the entry resolves to undefined and compare surfaces an error row instead of crashing; fireworks is wired so Compare can race each roster model's backends. */
// @see #151 #232 #234
const PROVIDERS: Record<string, LlmConnector | undefined> = {
  groq: groqConnector,
  deepinfra: deepinfraConnector,
  fireworks: fireworksConnector,
  typesafe: undefined,
};

/** Runs the prompt through each model sequentially on purpose: parallel fan-out makes side-by-side comparisons misleadingly flaky, and N is small. */
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
    const connector = PROVIDERS[ref.provider];
    if (!connector) {
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
      const completion = await connector.createCompletion(options);
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
