import { Session } from '../../models/Session';
import { Message } from '../../models/Message';
import { Asset } from '../../models/Asset';
import { Task } from '../../models/Task';
import { TaskEvent } from '../../models/TaskEvent';
import { evalUserId, ensureEvalUser } from '../mongoSource';
import type { MemoryScenario, MemorySeed } from './types';

/*
 * #289 scenario fixtures. Each scenario is materialised into the reserved eval
 * user's workspace, so retrieval reads real `Session`/`Message`/`Asset`/`Task`
 * rows exactly as the chat path would — no retrieval test-doubles. Scenarios
 * are isolated by clearing before each seed, so one scenario's slices cannot
 * leak into another's hit-rate.
 *
 * `seedMemoryScenario` returns a seed-id → real-Mongo-id map: the corpus speaks
 * in stable synthetic ids, but hit-rate must match the id retrieval actually
 * emitted (`WorkspaceSlice.id`).
 */

export type SeedIdMap = Record<string, string>;

const seedChat = async (seed: MemorySeed): Promise<string> => {
  const at = new Date(seed.at);
  const session = await Session.create({
    userId: evalUserId,
    title: seed.title,
    lastMessageAt: at,
    // A soft-deleted seed is materialised then excluded by `deletedAt`, exactly
    // as a user-deleted chat is — the corpus's `deleted-seed` case.
    deletedAt: seed.deleted ? at : null,
  });
  const message = await Message.create({
    sessionId: session._id,
    role: 'user',
    content: seed.text,
    timestamp: at,
  });
  return String(message._id);
};

const seedFile = async (seed: MemorySeed): Promise<string> => {
  const asset = await Asset.create({
    userId: evalUserId,
    filename: seed.title,
    key: `${evalUserId.toHexString()}/eval-memory/${seed.id}`,
    contentType: 'text/markdown',
    size: seed.text.length,
    status: 'ready',
    textExtracted: seed.text,
  });
  return String(asset._id);
};

const seedTask = async (seed: MemorySeed): Promise<string> => {
  const task = await Task.create({
    userId: evalUserId,
    instruction: seed.title,
    budget: { maxSteps: 25, maxCostUsd: 5 },
  });
  await TaskEvent.create({ taskId: task._id, seq: 0, role: 'user', content: seed.title });
  await TaskEvent.create({ taskId: task._id, seq: 1, role: 'assistant', content: seed.text });
  return String(task._id);
};

const seedOne = (seed: MemorySeed): Promise<string> => {
  if (seed.kind === 'chat') return seedChat(seed);
  if (seed.kind === 'file') return seedFile(seed);
  return seedTask(seed);
};

/*
 * Bury the scenario's seed beyond `MESSAGE_POOL` with newer filler turns, so
 * the `out-of-pool` case is genuinely unreachable by the bounded read (the
 * ticket's "old relevant chat outside the current bounded recent pool").
 */
const fillPool = async (count: number): Promise<void> => {
  const start = Date.parse('2026-09-30T10:00:00.000Z');
  const session = await Session.create({
    userId: evalUserId,
    title: 'Filler chat',
    lastMessageAt: new Date(start + count * 1000),
  });
  await Message.insertMany(
    Array.from({ length: count }, (_, i) => ({
      sessionId: session._id,
      role: 'user',
      content: `Filler turn ${i}: unrelated notes about the weather, traffic, and lunch plans.`,
      timestamp: new Date(start + i * 1000),
    })),
  );
};

/** Materialise one scenario's seeds (+ pool filler); returns the id map. */
export const seedMemoryScenario = async (scenario: MemoryScenario): Promise<SeedIdMap> => {
  await ensureEvalUser();
  const map: SeedIdMap = {};
  for (const seed of scenario.seeds) map[seed.id] = await seedOne(seed);
  if (scenario.poolFill) await fillPool(scenario.poolFill);
  return map;
};

/** Remove every scenario artifact for the reserved eval user. */
export const clearMemoryCorpus = async (): Promise<void> => {
  const sessions = await Session.find({ userId: evalUserId }).select('_id').lean();
  const sessionIds = sessions.map((s) => s._id);
  await Message.deleteMany({ sessionId: { $in: sessionIds } });
  await Session.deleteMany({ userId: evalUserId });

  await Asset.deleteMany({ userId: evalUserId });

  const tasks = await Task.find({ userId: evalUserId }).select('_id').lean();
  const taskIds = tasks.map((t) => t._id);
  await TaskEvent.deleteMany({ taskId: { $in: taskIds } });
  await Task.deleteMany({ userId: evalUserId });
};
