import mongoose from 'mongoose';
import { TaskEvent } from './TaskEvent';

const taskId = () => new mongoose.Types.ObjectId();

const createEvent = (overrides: Record<string, unknown> = {}) =>
  TaskEvent.create({
    taskId: taskId(),
    seq: 0,
    role: 'user',
    content: 'hello',
    ...overrides,
  });

describe('TaskEvent model (#254)', () => {
  it('rejects a role outside the enum', async () => {
    await expect(createEvent({ role: 'alien' })).rejects.toThrow();
  });

  it('requires taskId and seq', async () => {
    await expect(TaskEvent.create({ role: 'user', content: 'x' })).rejects.toThrow();
    await expect(
      TaskEvent.create({ taskId: taskId(), role: 'user', content: 'x' }),
    ).rejects.toThrow();
  });

  it('round-trips an assistant step with model/provider/tools/usage', async () => {
    const id = taskId();
    await TaskEvent.create({
      taskId: id,
      seq: 1,
      role: 'assistant',
      content: 'done',
      model: 'deepseek-ai/DeepSeek-V4.1-Flash',
      provider: 'deepinfra',
      step: 0,
      tools: [{ phase: 'result', name: 'list_files', label: 'Listing files', status: 'ok' }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    const doc = await TaskEvent.findOne({ taskId: id, seq: 1 });
    expect(doc?.model).toBe('deepseek-ai/DeepSeek-V4.1-Flash');
    expect(doc?.provider).toBe('deepinfra');
    expect(doc?.usage?.totalTokens).toBe(15);
    expect(doc?.tools?.[0].name).toBe('list_files');
  });

  it('leaves tools/usage absent when not provided (unknown, not empty)', async () => {
    const doc = await createEvent();
    expect(doc.tools).toBeUndefined();
    expect(doc.usage).toBeUndefined();
  });

  it('round-trips a tool chip with its raw result (#254 resume payload)', async () => {
    const id = taskId();
    await TaskEvent.create({
      taskId: id,
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
          result: { results: [{ url: 'https://example.com' }] },
        },
      ],
    });
    const doc = await TaskEvent.findOne({ taskId: id, seq: 1 });
    // The raw result must survive persistence — without it the next step's
    // history replay loses the tool output the model needs to continue.
    expect(doc?.tools?.[0].result).toEqual({ results: [{ url: 'https://example.com' }] });
    expect(doc?.tools?.[0].query).toBe('groq pricing');
  });

  it('reads events back in { taskId, seq } order', async () => {
    const id = taskId();
    for (const seq of [2, 0, 1]) {
      await TaskEvent.create({ taskId: id, seq, role: 'user', content: `s${seq}` });
    }
    const ordered = await TaskEvent.find({ taskId: id }).sort({ seq: 1 });
    expect(ordered.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('enforces unique seq per task', async () => {
    const id = taskId();
    await TaskEvent.create({ taskId: id, seq: 0, role: 'user', content: 'a' });
    await expect(
      TaskEvent.create({ taskId: id, seq: 0, role: 'user', content: 'b' }),
    ).rejects.toThrow();
  });
});
