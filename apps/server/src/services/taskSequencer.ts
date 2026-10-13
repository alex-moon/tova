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

/*
 * Task sequencer (#254, epic #251) — the driver-owned turn loop over the task
 * stream. The loop-ownership spike (decision (c), cap 1; see
 * `docs/done/plan-254-task-entity.md`) froze the shape:
 *
 *   one driver step = one `raceRosterCompletion` call pinned to `maxSteps: 1`,
 *   whose options carry `maxSteps: 1` so Mastra runs exactly one model turn
 *   (executing any tools it chose) and returns; the driver records the step as
 *   one `assistant` TaskEvent and drains queued steering at the call boundary
 *   before the next step.
 *
 * Steering granularity is therefore the model step, not the individual tool
 * call (the spike raised this on #251). The interrupt override (D8) is parked.
 *
 * OQ5 (guard-vs-race) default: the step races the roster via
 * `raceRosterCompletion` with no guard classifier, matching how the chat path
 * routes post-#232 (`chat.ts` calls `pickRosterRoute`/`routeAndComplete`, which
 * add no policy — "Racing never calls the guard"). Reintroducing the tier guard
 * for tasks is an open owner decision; this default is flagged on the slice PR.
 *
 * ZDR (D7): tasks are durable by definition, so ZDR users do not get tasks.
 * The refusal lives at task *creation* (the API slice), which does not exist
 * yet; this loop never creates tasks.
 */

// One step's model/provider and parsed result, ready to persist.
export interface TaskStepOutcome {
  model: string;
  provider: string;
  text: string;
  tools: TaskToolEvent[];
  usage?: NeutralCompletion['usage'];
}

const MAX_STEP_TEXT_CHARS = 2000;

/*
 * Render one executed tool exchange as an assistant turn for history replay.
 * Our neutral message shape is system/user/assistant only (the chat path never
 * sends a native `tool` role), so the driver replays its own past tool usage as
 * assistant narration: the call (name + scalar args) and a clipped result. The
 * *authoritative* step record stays the structured `TaskEvent.tools`, not this
 * string — this is purely what the next call's prompt sees.
 */
export const renderToolReplay = (tool: TaskToolEvent): string => {
  const name = tool.name ?? 'tool';
  const query = tool.query ? ` (${tool.query})` : '';
  const result = 'result' in tool && tool.result !== undefined ? JSON.stringify(tool.result) : '';
  const clipped =
    result.length > MAX_STEP_TEXT_CHARS ? `${result.slice(0, MAX_STEP_TEXT_CHARS)}…` : result;
  return `[tool ${name}${query}]${clipped ? ` → ${clipped}` : ''}`;
};

/*
 * Reassemble the model message list from the task stream (D5: full task
 * history, not the chat path's 10-message window). `system` rows are visible
 * notices, never fed back as context. Assistant rows replay their text (or,
 * when the step only called tools, the rendered tool exchanges); user rows
 * replay their instruction/steering text verbatim.
 */
export const assembleTaskHistory = (events: TaskEventDocument[]): CompletionOptions['messages'] => {
  const messages: CompletionOptions['messages'] = [];
  for (const event of events) {
    if (event.role === 'system') continue;
    if (event.role === 'user') {
      if (event.content) messages.push({ role: 'user', content: event.content });
      continue;
    }
    if (event.role === 'assistant') {
      const replay = event.content
        ? event.content
        : (event.tools ?? []).map((t) => renderToolReplay(t as TaskToolEvent)).join('\n');
      if (replay) messages.push({ role: 'assistant', content: replay });
      continue;
    }
    // A driver-executed `tool` row is reserved for a future (b) path; no (c)
    // step writes one, so it is skipped rather than mis-replayed.
  }
  return messages;
};

/*
 * Parse a completed step into its persistable shape. The step's text may be
 * empty when it chose a tool (spike: `text = ""` at cap 1); tool results carry
 * `name` + optional `args`, mapped to the #196 `PersistedToolEvent` chip shape
 * (phase 'result' — under (c) the driver never executes a call itself, so there
 * is no separate live 'call' chip). `args` is forwarded so `toolResultEvent`
 * recovers the call's `query` the way the streaming path's `toolCallEvent`
 * does; without it the chip would silently lose its query and history replay
 * would render a bare `[tool name]`.
 */
export const parseStepOutcome = (outcome: CompletionOutcome): TaskStepOutcome => {
  const completion = outcome.result.completion;
  const tools: TaskToolEvent[] = (completion.toolResults ?? []).map((r) => ({
    ...toolResultEvent({ name: r.name, result: r.result, ...(r.args ? { args: r.args } : {}) }),
    // The raw result rides the chip so the next step can replay what the tool
    // returned (D10). It is clipped only when the prompt is assembled.
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

/*
 * Run exactly one driver step for a task: assemble history from the stream,
 * size `max_tokens` against the picked model's window, and race the roster with
 * `maxSteps: 1`. The userId rides the per-call options exactly as chat tools
 * do (D3) so workspace tools scope to the owning user.
 */
export const runTaskStep = async (
  task: TaskDocument,
  events: TaskEventDocument[],
  deps: RaceDeps = {},
): Promise<TaskStepOutcome> => {
  const messages = assembleTaskHistory(events);
  // Size the output budget against the picked model's window (D5), mirroring
  // the chat path: the non-streaming route reads the primary's `contextLength`
  // before the call. Unknown window sends the base budget untouched.
  const picking = await pickRosterRoute(false, deps);
  const options: Omit<CompletionOptions, 'provider' | 'model'> = {
    messages,
    userId: String(task.userId),
    maxSteps: 1,
    max_tokens: outputTokensFor(picking?.contextLength, promptCharsFrom(messages)),
    trace: { tags: ['task', `task:${String(task._id)}`], metadata: { taskId: String(task._id) } },
  };
  const outcome = await raceRosterCompletion(options, false, deps);
  return parseStepOutcome(outcome);
};
