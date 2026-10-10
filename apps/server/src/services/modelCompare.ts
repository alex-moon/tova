import type { CompletionOptions, LlmConnector, LlmProvider } from './llmTypes';
import { groqConnector, deepinfraConnector, fireworksConnector } from './mastraService';
import { buildSystemContent } from './promptAssembly';
import { outputTokensFor, promptCharsFrom } from './outputTokenCap';

/*
 * Direct model comparison (issue #129): run one prompt against the existing
 * agent on several provider/model pairs and return each answer next to its
 * latency. The runner is the shared core for both consumers of this ticket —
 * the one-off CLI (`scripts/eval-model-compare.ts`) and the admin
 * "Compare" view (`POST /api/admin/model-compare`) — so a browser run and a
 * scripted run are guaranteed to exercise the identical code path: same
 * system-prompt assembly (`buildSystemContent`), same memoised Mastra
 * agents (`mastraService` connectors), same tool wiring. Routing itself is
 * bypassed (each model is forced), route decisions are
 * *informed* by comparing outputs side by side, not absorbed into them.
 *
 * Messages assemble exactly like the chat routes (system content first, then
 * the user line), with no user envelope block (a neutral profile) unless a
 * future caller passes one. Output tokens are capped with the same
 * `outputTokensFor` sizing the chat routes use when the selected model
 * carries a context length.
 */

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

/*
 * #151: the typesafe connector does not exist yet (openai-compatible wiring
 * is pending), so the entry resolves to `undefined` and compare runs against
 * it surface the "Unknown provider" error row instead of crashing the run.
 * #232/#234: fireworks is a first-class roster provider and is wired here so
 * the admin Compare tab can race each roster model's two backends.
 */
const PROVIDERS: Record<string, LlmConnector | undefined> = {
  groq: groqConnector,
  deepinfra: deepinfraConnector,
  fireworks: fireworksConnector,
  typesafe: undefined,
};

/**
 * Runs the prompt through each model sequentially. Serialised on purpose:
 * tool-warming, rate limits and a noisy parallel fan-out make side-by-side
 * comparisons misleadingly flaky, and N here is small.
 */
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
