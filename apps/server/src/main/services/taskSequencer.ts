import type { TaskDocument } from '../models/Task';
import type { TaskEventDocument, TaskToolEvent } from '../models/TaskEvent';
import { toolResultEvent } from '../routes/chat';
import type { CompletionOptions, NeutralCompletion } from './llmTypes';
import { outputTokensFor, promptCharsFrom } from './outputTokenCap';
import {
  pickRosterRoute,
  raceRosterCompletion,
  type CompletionOutcome,
  type RaceDeps,
} from './racingService';

/* Driver's turn loop: one step = one roster race on a single model. */
// @see #254 #251 #196 #298

// One step's model/provider and parsed result, ready to persist.
export interface TaskStepOutcome {
  model: string;
  provider: string;
  text: string;
  tools: TaskToolEvent[];
  usage?: NeutralCompletion['usage'];
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
  return messages;
};

/* Parse a completed step into its persistable shape (chip-shaped tools). */
// @see #196
export const parseStepOutcome = (outcome: CompletionOutcome): TaskStepOutcome => {
  const completion = outcome.result.completion;
  const tools: TaskToolEvent[] = (completion.toolResults ?? []).map((r) => ({
    ...toolResultEvent({ name: r.name, result: r.result, ...(r.args ? { args: r.args } : {}) }),
    // The raw result rides the chip so the next step can replay it.
    ...(r.result !== undefined ? { result: r.result } : {}),
  }));
  return {
    model: outcome.result.model.modelId,
    provider: outcome.result.provider.provider,
    text: completion.choices[0]?.message?.content ?? '',
    tools,
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
};

/* One driver step: assemble history, size max_tokens, race the roster. */
export const runTaskStep = async (
  task: TaskDocument,
  events: TaskEventDocument[],
  deps: RaceDeps = {},
): Promise<TaskStepOutcome> => {
  const messages = assembleTaskHistory(events);
  // Size the output budget against the model's window, like chat.
  // @see #298
  const picking = await pickRosterRoute(deps);
  const options: Omit<CompletionOptions, 'provider' | 'model'> = {
    messages,
    userId: String(task.userId),
    // Files this step generates attribute to the task (kind 'task').
    // @see #298
    taskId: String(task._id),
    maxSteps: 1,
    max_tokens: outputTokensFor(picking?.contextLength, promptCharsFrom(messages)),
    trace: { tags: ['task', `task:${String(task._id)}`], metadata: { taskId: String(task._id) } },
  };
  const outcome = await raceRosterCompletion(options, deps);
  return parseStepOutcome(outcome);
};
