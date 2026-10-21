import type { CompletionOptions, NeutralCompletion } from '../../../main/services/llm/llmTypes';
import { TASK_MODEL, TASK_PROVIDER } from '../../../main/services/model/modelDefaults';
import { enqueueTask } from '../../../main/services/task/taskService';
import { TaskEvent } from '../../../main/models/TaskEvent';
import {
  assembleTaskHistory,
  parseStepOutcome,
  renderToolReplay,
  runTaskStep,
  windowedTaskHistory,
} from '../../../main/services/task/taskSequencer';

// Sequencer primitives: history reassembly, step parsing, one pinned step.
// @see #254 #387

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
    // No instruction: the placeholder seed occupies seq 0. @see #395
    await TaskEvent.create({
      taskId: task._id,
      seq: 1,
      role: 'assistant',
      content: '',
      step: 0,
      tools: [{ phase: 'result', name: 'list_files', label: 'List', status: 'ok' }],
    });

    const messages = assembleTaskHistory(await events(task._id));
    expect(messages).toEqual([
      { role: 'user', content: '(no instruction provided)' },
      { role: 'assistant', content: '[tool list_files]' },
    ]);
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

describe('windowedTaskHistory (#395)', () => {
  const msg = (role: 'user' | 'assistant', content: string) => ({ role, content });

  it('keeps the anchor and newest while dropping the oldest middle under the char budget', () => {
    const messages = [
      msg('user', 'instruction'),
      msg('assistant', 'a'.repeat(450_000)),
      msg('user', 'steer'),
      msg('assistant', 'newest state'),
    ];
    const windowed = windowedTaskHistory(messages);
    expect(windowed.map((m) => m.content)).toEqual(['instruction', 'steer', 'newest state']);
  });

  it('truncates an over-budget newest and still rides it', () => {
    const messages = [msg('user', 'instruction'), msg('assistant', 'x'.repeat(400_001))];
    const windowed = windowedTaskHistory(messages);
    expect(windowed).toHaveLength(2);
    expect((windowed[1].content as string).length).toBe(400_000);
  });

  it('keeps the anchor even when the message cap is full', () => {
    const messages = [
      msg('user', 'instruction'),
      ...Array.from({ length: 300 }, (_, i) => msg('assistant', `step ${i}`)),
    ];
    const windowed = windowedTaskHistory(messages);
    expect(windowed).toHaveLength(200);
    expect(windowed[0].content).toBe('instruction');
    // The oldest middle steps are the ones dropped.
    expect(windowed[1].content).toBe('step 101');
    expect(windowed.at(-1)?.content).toBe('step 299');
  });
});

describe('parseStepOutcome (#254)', () => {
  it('maps text, model/provider, tool chips, and usage', () => {
    const outcome = parseStepOutcome({
      model: 'winner',
      provider: 'deepinfra',
      completion: {
        choices: [{ message: { content: '' } }],
        toolResults: [{ name: 'read_file', result: { content: 'hi' } }],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    });
    expect(outcome.model).toBe('winner');
    expect(outcome.provider).toBe('deepinfra');
    expect(outcome.text).toBe('');
    expect(outcome.tools[0]).toMatchObject({ phase: 'result', name: 'read_file' });
    expect(outcome.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it('recovers the chip query from the call args (D10)', () => {
    const outcome = parseStepOutcome({
      model: 'm',
      provider: 'deepinfra',
      completion: {
        choices: [{ message: { content: '' } }],
        toolResults: [
          { name: 'web_search', result: { results: [] }, args: { query: 'groq pricing' } },
        ],
      },
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
      model: 'm',
      provider: 'deepinfra',
      completion: {
        choices: [{ message: { content: '' } }],
        toolResults: [{ name: 'read_file', result: {}, args: { fileId: 'abc' } }],
      },
    });
    expect(outcome.tools[0].query).toBeUndefined();
  });
});

describe('runTaskStep (#254/#387)', () => {
  it('pins DeepInfra/TASK_MODEL, toolUse required, maxSteps 1, and the userId', async () => {
    const task = await enqueueTask({
      userId: '0000000000000000000042ab',
      instruction: 'do it',
      maxSteps: 5,
      maxCostUsd: 5,
    });
    const seen: Array<Record<string, unknown>> = [];
    const deps = {
      startCompletion: async (options: CompletionOptions): Promise<NeutralCompletion> => {
        seen.push(options as unknown as Record<string, unknown>);
        return { choices: [{ message: { content: 'answer' } }] };
      },
    };

    const outcome = await runTaskStep(task, await events(task._id), deps);

    expect(outcome.text).toBe('answer');
    expect(outcome.model).toBe(TASK_MODEL);
    expect(outcome.provider).toBe(TASK_PROVIDER);
    expect(seen[0].model).toBe(TASK_MODEL);
    expect(seen[0].provider).toBe(TASK_PROVIDER);
    expect(seen[0].toolUse).toBe('required');
    expect(seen[0].maxSteps).toBe(1);
    expect(seen[0].userId).toBe('0000000000000000000042ab');
    expect(seen[0].max_tokens).toBeGreaterThan(0);
  });
});
