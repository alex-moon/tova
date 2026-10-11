import type { RosterModel } from './rosterConfig';
import type { RaceDeps } from './racingService';
import type { NeutralCompletion } from './llmTypes';
import { enqueueTask } from './taskService';
import { TaskEvent } from '../models/TaskEvent';
import {
  assembleTaskHistory,
  parseStepOutcome,
  renderToolReplay,
  runTaskStep,
} from './taskSequencer';

// #254 sequencer primitives: history reassembly from the task stream, step
// parsing, and one driver step raced with injected roster deps (no provider).

const model = (overrides: Partial<RosterModel> = {}): RosterModel => ({
  modelId: 'm-primary',
  label: 'Primary',
  tools: true,
  vision: true,
  contextLength: 1048576,
  inputPrice: 0.2,
  outputPrice: 0.6,
  providers: [{ provider: 'deepinfra', modelId: 'di-primary' }],
  ...overrides,
});

const events = async (taskId: unknown) => TaskEvent.find({ taskId }).sort({ seq: 1 });

describe('renderToolReplay (#254)', () => {
  it('renders the tool name, query, and a clipped result', () => {
    expect(
      renderToolReplay({
        phase: 'result',
        name: 'read_file',
        label: 'r',
        status: 'ok',
        query: 'x',
      }),
    ).toContain('[tool read_file (x)]');
  });
});

describe('assembleTaskHistory (#254)', () => {
  it('replays user and assistant text, skips system notices', async () => {
    const task = await enqueueTask({
      userId: '000000000000000000000000',
      instruction: 'first',
      maxSteps: 5,
      maxCostUsd: 5,
    });
    await TaskEvent.create({
      taskId: task._id,
      seq: 1,
      role: 'assistant',
      content: 'thinking',
      step: 0,
    });
    await TaskEvent.create({ taskId: task._id, seq: 2, role: 'system', content: 'note', step: 0 });

    const messages = assembleTaskHistory(await events(task._id));
    expect(messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'thinking' },
    ]);
  });

  it('replays a tool-only step as assistant narration', async () => {
    const task = await enqueueTask({
      userId: '000000000000000000000000',
      maxSteps: 5,
      maxCostUsd: 5,
    });
    await TaskEvent.create({
      taskId: task._id,
      seq: 0,
      role: 'assistant',
      content: '',
      step: 0,
      tools: [{ phase: 'result', name: 'list_files', label: 'List', status: 'ok' }],
    });

    const messages = assembleTaskHistory(await events(task._id));
    expect(messages).toEqual([{ role: 'assistant', content: '[tool list_files]' }]);
  });
});

describe('parseStepOutcome (#254)', () => {
  it('maps text, model/provider, tool chips, and usage', () => {
    const outcome = parseStepOutcome({
      result: {
        model: model({ modelId: 'winner' }),
        provider: { provider: 'deepinfra', modelId: 'di-winner' },
        completion: {
          choices: [{ message: { content: '' } }],
          toolResults: [{ name: 'read_file', result: { content: 'hi' } }],
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
      },
      attempts: 1,
    });
    expect(outcome.model).toBe('winner');
    expect(outcome.provider).toBe('deepinfra');
    expect(outcome.text).toBe('');
    expect(outcome.tools[0]).toMatchObject({ phase: 'result', name: 'read_file' });
    expect(outcome.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });
});

describe('runTaskStep (#254)', () => {
  it('pins maxSteps: 1, sizes max_tokens, and carries userId on the race', async () => {
    const task = await enqueueTask({
      userId: '0000000000000000000042ab',
      instruction: 'do it',
      maxSteps: 5,
      maxCostUsd: 5,
    });
    const seen: Array<Record<string, unknown>> = [];
    const deps: RaceDeps = {
      roster: [model()],
      now: () => 1,
      startCompletion: async (options): Promise<NeutralCompletion> => {
        seen.push(options as unknown as Record<string, unknown>);
        return { choices: [{ message: { content: 'answer' } }] };
      },
    };

    const outcome = await runTaskStep(task, await events(task._id), deps);

    expect(outcome.text).toBe('answer');
    expect(seen[0].maxSteps).toBe(1);
    expect(seen[0].userId).toBe('0000000000000000000042ab');
    expect(seen[0].max_tokens).toBeGreaterThan(0);
  });
});
