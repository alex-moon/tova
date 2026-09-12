import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import { Observability } from '@mastra/observability';
import { buildTracingOptions } from '@mastra/observability';
import { LangSmithExporter, withLangsmithMetadata } from '@mastra/langsmith';
import {
  CompletionOptions,
  LlmConnector,
  LlmProvider,
  NeutralChunkStream,
  NeutralCompletion,
  TraceContext,
} from './llmTypes';

/*
 * LangSmith tracing (issue #5), via the official Mastra plugin
 * (`@mastra/langsmith`): a singleton `Mastra` instance carries
 * `LangSmithExporter` in its observability config, and every agent call in
 * the process is traced hierarchically (agent run → step → inference → llm,
 * with token usage and latency) into the configured project. Env-gated:
 * with no API key no exporter is configured at all and nothing is posted —
 * the off-path is byte-identical to the pre-#5 behaviour. Credentials are
 * read from `LANGSMITH_API_KEY` (`LANGCHAIN_API_KEY` works too) and the
 * project from `LANGCHAIN_PROJECT` — see `.env.example`.
 */
const langsmithKey = process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY;

// Mastra docs: storage is required for tracing even when exporting
// externally. Application data stays in MongoDB; `InMemoryStore` only
// backs Mastra's internal snapshot lookups.
export const mastra = new Mastra({
  storage: new InMemoryStore(),
  ...(langsmithKey
    ? {
        observability: new Observability({
          configs: {
            langsmith: {
              serviceName: 'tova',
              exporters: [new LangSmithExporter({ apiKey: langsmithKey })],
            },
          },
        }),
      }
    : {}),
});

/*
 * The single owner of all `@mastra/*` imports and of provider construction.
 * Mastra's bundled model router ships both providers inside `@mastra/core`
 * (router ids `groq/<model>` / `deepinfra/<model>`) and reads the keys from
 * `GROQ_API_KEY` / `DEEPINFRA_API_KEY` when none is passed explicitly, so the
 * provider classes reduce to: build an Agent per call aimed at the right
 * router id, and normalise Mastra's AI-SDK-style shapes to the neutral types.
 * Callers never see Mastra or Groq shapes past this module.
 *
 * Mapping notes (verified in the #4 spike):
 * - `agent.generate` resolves to an object with `text`.
 * - `agent.stream` resolves to an output object whose `fullStream` yields
 *   AI-SDK-style chunks; only `text-delta` chunks carry content (in
 *   `payload.text`). Every lifecycle chunk (`start`/`step-start`/
 *   `text-start`/`text-end`/`step-finish`/`finish`) is filtered out — the
 *   SSE contract upstream emits only `{ delta }` chunks. `error` chunks are
 *   rethrown (fail loudly).
 */

/*
 * FullStream chunk shape (verified 2026-09-12 against real Groq/DeepInfra
 * endpoints, `@mastra/core@1.66.0`): content is nested in `payload`, i.e.
 * `{ type: 'text-delta', payload: { text: '...' } }` — flat `chunk.delta`
 * does not exist. Upstream errors surface as `{ type: 'error', payload:
 * { error } }` chunks rather than iterator rejections; they are rethrown
 * here so callers fail loudly instead of seeing a silent all-empty stream.
 */
interface FullStreamChunk {
  type?: string;
  payload?: { text?: string; error?: unknown };
}

const errorTextFrom = (payload: FullStreamChunk['payload']): string => {
  const err = payload?.error;
  if (err instanceof Error) return err.message;
  if (typeof (err as { message?: unknown })?.message === 'string')
    return (err as { message: string }).message;
  return JSON.stringify(err);
};

const toNeutralStream = async (fullStream: AsyncIterable<unknown>): Promise<NeutralChunkStream> =>
  (async function* () {
    for await (const raw of fullStream ?? []) {
      const chunk = raw as FullStreamChunk;
      if (chunk?.type === 'error') throw new Error(errorTextFrom(chunk.payload));
      if (chunk?.type === 'text-delta') yield { delta: chunk.payload?.text ?? null };
    }
  })();

/*
 * Omit unset call settings rather than forwarding `temperature: undefined`
 * / `maxOutputTokens: undefined` into Mastra's model settings (undefined
 * keys can trip SDK-level validation; absent keys cannot).
 */
const modelSettingsFrom = (options: CompletionOptions) => ({
  ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  ...(options.max_tokens !== undefined ? { maxOutputTokens: options.max_tokens } : {}),
});

/*
 * Abort/disconnect plumbing: forward a caller-supplied signal to Mastra's
 * call options (AI-SDK style) instead of sending undefined keys.
 */
const callOptionsFrom = (options: CompletionOptions) => ({
  ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  maxSteps: 1,
  modelSettings: modelSettingsFrom(options),
  ...traceOptionsFrom(options.trace),
});

/*
 * Trace attach: plain metadata/tags ride directly on the call, the
 * LangSmith session key goes through the plugin helper. `withLangsmithMetadata`
 * is only consulted when an exporter exists (key present).
 */
const traceOptionsFrom = (trace?: TraceContext) => ({
  ...(trace?.metadata ? { metadata: trace.metadata } : {}),
  ...(trace?.tags?.length ? { tags: trace.tags } : {}),
  ...(langsmithKey && trace?.sessionId
    ? {
        tracingOptions: buildTracingOptions(withLangsmithMetadata({ sessionId: trace.sessionId })),
      }
    : {}),
});

/*
 * Agents are memoised per provider/model (creation is stateful — Mastra
 * wires an internal store per agent) so repeated turns on the same model
 * reuse one instance.
 */
const agentCache = new Map<string, Agent>();

const agentFor = (provider: LlmProvider, model: string): Agent => {
  const cacheKey = `${provider}/${model}`;
  const cached = agentCache.get(cacheKey);
  if (cached) return cached;
  const agent = new Agent({
    // The neutral message shape is structurally Core-compatible; the cast
    // exists because the union `role` in the neutral type does not narrow
    // to a single Mastra message variant.
    id: `tova-${provider}`,
    name: `tova-${provider}`,
    instructions: '',
    model: `${provider}/${model}`,
  });
  agentCache.set(cacheKey, agent);
  return agent;
};

const buildConnector = (provider: LlmProvider): LlmConnector => {
  const asMessageList = (messages: CompletionOptions['messages']) =>
    messages as unknown as Parameters<Agent['generate']>[0];

  return {
    createCompletion: async (options: CompletionOptions): Promise<NeutralCompletion> => {
      const result = await agentFor(provider, options.model).generate(
        asMessageList(options.messages),
        callOptionsFrom(options),
      );
      return { choices: [{ message: { content: result.text ?? null } }] };
    },
    createStreamingCompletion: async (options: CompletionOptions): Promise<NeutralChunkStream> => {
      const result = await agentFor(provider, options.model).stream(
        asMessageList(options.messages),
        callOptionsFrom(options),
      );
      return toNeutralStream(result.fullStream);
    },
  };
};

export const groqConnector: LlmConnector = buildConnector('groq');
export const deepinfraConnector: LlmConnector = buildConnector('deepinfra');
