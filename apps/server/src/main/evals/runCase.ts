/** One graded eval run: streams the agent's answer through a connector entry point. */
// @see #158 #16
import type { EvalCase } from './cases';
import type { EvalRun } from './types';
import type { CompletionOptions, NeutralStreamChunk } from '../services/llmTypes';
import { normalizeArgs } from './graders';

type CreateStreaming = (
  options: CompletionOptions,
) => Promise<AsyncIterable<NeutralStreamChunk> | null | undefined>;

/** Streams the answer, records tool calls in order, and accumulates `chunk.delta` into `finalText`. */
// @see #158
export const runCase = async (
  createStreamingCompletion: CreateStreaming,
  options: CompletionOptions,
  testCase: EvalCase,
): Promise<{ run: EvalRun; evidence: string }> => {
  const stream = await createStreamingCompletion(options);
  if (!stream) throw new Error(`no connector for provider ${options.provider ?? 'groq'}`);
  const toolCalls: EvalRun['toolCalls'] = [];
  let deltas: string[] = [];
  for await (const chunk of stream) {
    if (chunk.delta) deltas = [...deltas, chunk.delta];
    if (chunk.toolCall)
      toolCalls.push({
        name: chunk.toolCall.name,
        ...(chunk.toolCall.args ? { args: normalizeArgs(chunk.toolCall.args) } : {}),
      });
  }
  const generateCall = toolCalls.find((call) => call.name === 'generate_file');
  const generatedContent =
    typeof generateCall?.args?.content === 'string' ? generateCall.args.content : undefined;
  // Capture generated files so cases can grade answers and files, not just tool calls.
  // @see #159
  const generatedFiles = toolCalls
    .filter((call) => call.name === 'generate_file' && typeof call.args?.content === 'string')
    .map((call) => ({
      filename: String(call.args?.filename ?? ''),
      content: String(call.args?.content ?? ''),
    }));
  const finalText = deltas.join('');
  const run: EvalRun = {
    toolCalls,
    prompt: testCase.prompt,
    ...(!finalText.trim() ? {} : { finalText, answer: finalText }),
    ...(!generatedFiles.length ? {} : { generatedFiles }),
    ...(generatedContent !== undefined ? { generatedContent } : {}),
  };
  const evidence = toolCalls
    .map((call) => `${call.name}${call.args ? ` ${JSON.stringify(call.args).slice(0, 120)}` : ''}`)
    .join(' | ');
  return { run, evidence };
};
