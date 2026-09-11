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
 *   AI-SDK-style chunks; only `text-delta` chunks carry content (`.delta`).
 *   Every lifecycle chunk (`start`/`step-start`/`text-start`/`text-end`/
 *   `step-finish`/`finish`) is filtered out — the SSE contract upstream
 *   emits only `{ delta }` chunks.
 */

const toNeutralStream = async (
  fullStream: AsyncIterable<{ type?: string; delta?: string }>,
): Promise<NeutralChunkStream> =>
  (async function* () {
    for await (const chunk of fullStream) {
      if (chunk?.type === 'text-delta') {
        yield { delta: chunk.delta ?? null };
      }
    }
  })();

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
      const result = await agentFor(options.model).generate(asMessageList(options.messages), {
        maxSteps: 1,
        modelSettings: {
          temperature: options.temperature,
          maxOutputTokens: options.max_tokens,
        },
      });
      return { choices: [{ message: { content: result.text ?? null } }] };
    },
    createStreamingCompletion: async (options: CompletionOptions): Promise<NeutralChunkStream> => {
      const result = await agentFor(options.model).stream(asMessageList(options.messages), {
        maxSteps: 1,
        modelSettings: {
          temperature: options.temperature,
          maxOutputTokens: options.max_tokens,
        },
      });
      return toNeutralStream(result.fullStream);
    },
  };
};

export const groqConnector: LlmConnector = buildConnector('groq');
export const deepinfraConnector: LlmConnector = buildConnector('deepinfra');
