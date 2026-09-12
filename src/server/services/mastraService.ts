import { Agent } from '@mastra/core/agent';
import {
  CompletionOptions,
  LlmConnector,
  LlmProvider,
  NeutralChunkStream,
  NeutralCompletion,
} from './llmTypes';

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
});

const buildConnector = (provider: LlmProvider): LlmConnector => {
  // Our neutral message shape is structurally Core-compatible; the cast is
  // needed only because the union `role` in the neutral type does not narrow
  // to a single Mastra message variant.
  const asMessageList = (messages: CompletionOptions['messages']) =>
    messages as unknown as Parameters<Agent['generate']>[0];

  const agentFor = (model: string) =>
    new Agent({
      id: `tova-${provider}`,
      name: `tova-${provider}`,
      instructions: '',
      model: `${provider}/${model}`,
    });

  return {
    createCompletion: async (options: CompletionOptions): Promise<NeutralCompletion> => {
      const result = await agentFor(options.model).generate(
        asMessageList(options.messages),
        callOptionsFrom(options),
      );
      return { choices: [{ message: { content: result.text ?? null } }] };
    },
    createStreamingCompletion: async (options: CompletionOptions): Promise<NeutralChunkStream> => {
      const result = await agentFor(options.model).stream(
        asMessageList(options.messages),
        callOptionsFrom(options),
      );
      return toNeutralStream(result.fullStream);
    },
  };
};

export const groqConnector: LlmConnector = buildConnector('groq');
export const deepinfraConnector: LlmConnector = buildConnector('deepinfra');
