import type { TaskDocument } from '../../models/Task';
import type { TaskEventDocument, TaskToolEvent } from '../../models/TaskEvent';
import { toolResultEvent } from '../llm/toolChips';
import type { CompletionOptions, NeutralCompletion } from '../llm/llmTypes';
import { outputTokensFor, promptCharsFrom } from '../llm/outputTokenCap';
import { inferenceService } from '../llm/inferenceService';
import { contextLengthFor, TASK_MODEL, TASK_PROVIDER } from '../model/modelDefaults';

/* Driver's turn loop: one step = one DeepInfra completion on TASK_MODEL. */
// @see #254 #251 #196 #298 #387

// One step's model/provider and parsed result, ready to persist.
export interface TaskStepOutcome {
  model: string;
  provider: string;
  text: string;
  tools: TaskToolEvent[];
  usage?: NeutralCompletion['usage'];
}

/* Injectable completion transport (tests) plus the per-call abort signal. */
// @see #387 #395
export interface TaskStepOpts {
  signal?: AbortSignal;
}

export interface TaskStepDeps extends TaskStepOpts {
  startCompletion?: (options: CompletionOptions) => Promise<NeutralCompletion>;
}

const MAX_STEP_TEXT_CHARS = 2000;

/* Render a tool exchange as narration for history replay. */
export const renderToolReplay = (tool: TaskToolEvent): string => {
  const name = tool.name ?? 'tool';
  const query = tool.query ? ` (${tool.query})` : '';
  const result = 'result' in tool && tool.result !== undefined ? JSON.stringify(tool.result) : '';
  const clipped =
    result.length > MAX_STEP_TEXT_CHARS ? `${result.slice(0, MAX_STEP_TEXT_CHARS)}…` : result;
  return `[tool ${name}${query}]${clipped ? ` → ${clipped}` : ''}`;
};

/* Reassemble the message list from the stream; system rows are notices. */
export const assembleTaskHistory = (events: TaskEventDocument[]): CompletionOptions['messages'] => {
  const messages: CompletionOptions['messages'] = [];
  for (const event of events) {
    if (event.role === 'system') continue;
    if (event.role === 'user') {
      if (event.content) messages.push({ role: 'user', content: event.content });
      continue;
    }
    if (event.role === 'assistant') {
      // Text and tools replay together; a dropped tool blinds the next step.
      // @see #362
      const replay = [
        event.content,
        ...(event.tools ?? []).map((t) => renderToolReplay(t as TaskToolEvent)),
      ]
        .filter(Boolean)
        .join('\n');
      if (replay) messages.push({ role: 'assistant', content: replay });
      continue;
    }
    // A driver-executed tool row is a future path; skip, don't mis-replay.
  }
  return windowedTaskHistory(messages);
};

/* Replay window, mirroring chat's windowedHistory. @see #395 */
export const TASK_HISTORY_MAX_MESSAGES = 200;
export const TASK_HISTORY_MAX_CHARS = 400_000;

/* Newest always rides (truncated when alone over budget); the first message
   anchors the instruction; the middle fills newest-first. @see #395 */
export const windowedTaskHistory = (
  messages: CompletionOptions['messages'],
): CompletionOptions['messages'] => {
  if (messages.length === 0) return [];
  const [anchor, ...rest] = messages;
  if (rest.length === 0) return [anchor];
  const newest = rest[rest.length - 1];
  const newestContent = typeof newest.content === 'string' ? newest.content : '';
  const kept: CompletionOptions['messages'] =
    newestContent.length > TASK_HISTORY_MAX_CHARS
      ? [{ ...newest, content: newestContent.slice(0, TASK_HISTORY_MAX_CHARS) }]
      : [newest];
  let used = Math.min(newestContent.length, TASK_HISTORY_MAX_CHARS);
  for (let i = rest.length - 2; i >= 1; i -= 1) {
    const content = typeof rest[i].content === 'string' ? rest[i].content : '';
    if (
      used + content.length > TASK_HISTORY_MAX_CHARS ||
      kept.length >= TASK_HISTORY_MAX_MESSAGES - 1
    ) {
      break;
    }
    used += content.length;
    kept.unshift(rest[i]);
  }
  return [anchor, ...kept];
};

/* Parse a completed step into its persistable shape (chip-shaped tools). */
// @see #196
export const parseStepOutcome = (outcome: {
  model: string;
  provider: string;
  completion: NeutralCompletion;
}): TaskStepOutcome => {
  const { completion } = outcome;
  const tools: TaskToolEvent[] = (completion.toolResults ?? []).map((r) => ({
    ...toolResultEvent({ name: r.name, result: r.result, ...(r.args ? { args: r.args } : {}) }),
    // The raw result rides the chip so the next step can replay it.
    ...(r.result !== undefined ? { result: r.result } : {}),
  }));
  return {
    model: outcome.model,
    provider: outcome.provider,
    text: completion.choices[0]?.message?.content ?? '',
    tools,
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
};

/* One driver step: assemble history, size max_tokens, complete on DeepInfra. */
export const runTaskStep = async (
  task: TaskDocument,
  events: TaskEventDocument[],
  deps: TaskStepDeps = {},
): Promise<TaskStepOutcome> => {
  const messages = assembleTaskHistory(events);
  const options: CompletionOptions = {
    provider: TASK_PROVIDER,
    model: TASK_MODEL,
    // Lean task agent; tool choice is auto so a text step can settle done.
    // @see #387 #417
    taskMode: true,
    messages,
    userId: String(task.userId),
    // Files this step generates attribute to the task (kind 'task').
    // @see #298
    taskId: String(task._id),
    maxSteps: 1,
    max_tokens: outputTokensFor(contextLengthFor(TASK_MODEL), promptCharsFrom(messages)),
    // Cancel aborts the in-flight step through the completion layer. @see #395
    ...(deps.signal ? { abortSignal: deps.signal } : {}),
    trace: { tags: ['task', `task:${String(task._id)}`], metadata: { taskId: String(task._id) } },
  };
  const start =
    deps.startCompletion ?? ((o: CompletionOptions) => inferenceService.createCompletion(o));
  const started = Date.now();
  const completion = await start(options);
  // TTFT diagnostics for a non-streaming path: total step latency.
  // @see #387
  console.info(`task step ${TASK_PROVIDER}/${TASK_MODEL} latency ${Date.now() - started}ms`);
  return parseStepOutcome({ model: TASK_MODEL, provider: TASK_PROVIDER, completion });
};
