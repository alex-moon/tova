/**
 * One graded eval run (#158): streams the agent's answer through the given
 * connector entry point and records tool calls in order from the neutral
 * stream (#16), alongside the assistant's accumulated final text. Extracted
 * from `scripts/run-evals.ts` so the delta-accumulation is unit-testable
 * (the script itself is not, since importing it kicks off `main()`).
 */
import type { EvalCase } from './cases';
import type { EvalRun } from './types';
import type { CompletionOptions, NeutralStreamChunk } from '../services/llmTypes';
import { normalizeArgs } from './graders';

type CreateStreaming = (
  options: CompletionOptions,
) => Promise<AsyncIterable<NeutralStreamChunk> | null | undefined>;

/**
 * Streams the agent's answer for the case prompt; records tool calls in
 * order and accumulates `chunk.delta` into `finalText` so graders can run
 * the #158 text assertions (no-citation-without-search, explicit
 * no-sources refusal). `generate_file` content rides in the call's scalar
 * args, which is what `generatedContent` extracts for the `content_equals`
 * case; the assembled prompt is simply the caller's own message list.
 */
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
  // #159 cases grade the assistant's final answer and possibly several
  // generated files, so both are captured alongside the tool calls.
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
