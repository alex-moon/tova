import type { RosterModel } from '../../main/services/rosterConfig';
import type { RaceDeps } from '../../main/services/racingService';
import type { NeutralCompletion } from '../../main/services/llmTypes';
import { enqueueTask } from '../../main/services/taskService';
import { TaskEvent } from '../../main/models/TaskEvent';
import {
  assembleTaskHistory,
  parseStepOutcome,
  renderToolReplay,
  runTaskStep,
} from '../../main/services/taskSequencer';

// Sequencer primitives: history reassembly, step parsing, one raced step.
// @see #254
const model = (overrides: Partial<RosterModel> = {}): RosterModel => ({
  modelId: 'm-primary',
  label: 'Primary',
  tools: true,
  contextLength: 1048576,
  inputPrice: 0.2,
  outputPrice: 0.6,
  providers: [{ provider: 'deepinfra', modelId: 'di-primary' }],
  ...overrides,
});

const events = async (taskId: unknown) => TaskEvent.find({ taskId }).sort({ seq: 1 });

describe('renderToolReplay (#254)', () => {
  it('renders the tool name and query', () => {
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

  it('renders the result and clips it to the step-text cap', () => {
    const line = renderToolReplay({
      phase: 'result',
      name: 'read_file',
      label: 'r',
      status: 'ok',
      result: { content: 'x'.repeat(5000) },
    });
    expect(line).toContain('[tool read_file]');
    expect(line).toContain('→');
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(2100);
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

  it('replays the tool query and result so the next step sees the output (D10)', async () => {
    const task = await enqueueTask({
      userId: '000000000000000000000000',
      instruction: 'search for groq pricing',
      maxSteps: 5,
      maxCostUsd: 5,
    });
    // The driver must replay the executed call's query/result or it re-runs.
    await TaskEvent.create({
      taskId: task._id,
      seq: 1,
      role: 'assistant',
      content: '',
      step: 0,
      tools: [
        {
          phase: 'result',
          name: 'web_search',
          label: 'Searched the web',
          status: 'ok',
          query: 'groq pricing',
          result: { results: [{ url: 'https://groq.com/pricing' }] },
        },
      ],
    });

    const messages = assembleTaskHistory(await events(task._id));
    expect(messages[1]).toEqual({
      role: 'assistant',
      content:
        '[tool web_search (groq pricing)] → {"results":[{"url":"https://groq.com/pricing"}]}',
    });
  });

  it('replays content and the tool exchange together on a narrating tool step (#362)', async () => {
    const task = await enqueueTask({
      userId: '000000000000000000000000',
      instruction: 'gather sources',
      maxSteps: 5,
      maxCostUsd: 5,
    });
    // #362 shape: narration plus a tool call in one step; both must survive.
    await TaskEvent.create({
      taskId: task._id,
      seq: 1,
      role: 'assistant',
      content: "I'll start by finding and reading the draft.",
      step: 0,
      tools: [
        {
          phase: 'result',
          name: 'list_files',
          label: 'Listed your files',
          status: 'ok',
          resultCount: 1,
          result: { files: [{ id: 'f1', filename: 'draft.md' }] },
        },
      ],
    });

    const messages = assembleTaskHistory(await events(task._id));
    expect(messages[1]).toEqual({
      role: 'assistant',
      content:
        'I\'ll start by finding and reading the draft.\n[tool list_files] → {"files":[{"id":"f1","filename":"draft.md"}]}',
    });
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

  it('recovers the chip query from the call args (D10)', () => {
    const outcome = parseStepOutcome({
      result: {
        model: model(),
        provider: { provider: 'deepinfra', modelId: 'di' },
        completion: {
          choices: [{ message: { content: '' } }],
          toolResults: [
            { name: 'web_search', result: { results: [] }, args: { query: 'groq pricing' } },
          ],
        },
      },
      attempts: 1,
    });
    // Without the args passthrough the chip silently loses its query.
    expect(outcome.tools[0]).toMatchObject({
      phase: 'result',
      name: 'web_search',
      query: 'groq pricing',
    });
  });

  it('omits the query when the call carried no string query arg', () => {
    const outcome = parseStepOutcome({
      result: {
        model: model(),
        provider: { provider: 'deepinfra', modelId: 'di' },
        completion: {
          choices: [{ message: { content: '' } }],
          toolResults: [{ name: 'read_file', result: {}, args: { fileId: 'abc' } }],
        },
      },
      attempts: 1,
    });
    expect(outcome.tools[0].query).toBeUndefined();
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
