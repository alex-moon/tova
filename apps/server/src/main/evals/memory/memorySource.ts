import { Session } from '../../models/Session';
import { Message } from '../../models/Message';
import { Asset } from '../../models/Asset';
import { Task } from '../../models/Task';
import { TaskEvent } from '../../models/TaskEvent';
import { WorkspaceEmbedding } from '../../models/WorkspaceEmbedding';
import { evalUserId, ensureEvalUser } from '../mongoSource';
import type { MemoryScenario, MemorySeed } from './types';

// Scenario fixtures in the reserved eval user's workspace; ids map to Mongo.
// @see #289

export type SeedIdMap = Record<string, string>;

const seedChat = async (seed: MemorySeed): Promise<string> => {
  const at = new Date(seed.at);
  const session = await Session.create({
    userId: evalUserId,
    title: seed.title,
    lastMessageAt: at,
    // Soft-deleted seed: excluded by `deletedAt` as a user-deleted chat.
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
  // Explicit `createdAt` keeps fixtures deterministic; no wall-clock stamp.
  const at = new Date(seed.at);
  const asset = await Asset.create({
    userId: evalUserId,
    filename: seed.title,
    key: `${evalUserId.toHexString()}/eval-memory/${seed.id}`,
    contentType: 'text/markdown',
    size: seed.text.length,
    status: 'ready',
    textExtracted: seed.text,
    createdAt: at,
    updatedAt: at,
  });
  return String(asset._id);
};

const seedTask = async (seed: MemorySeed): Promise<string> => {
  // The task slice reads `updatedAt`, so pin both stamps to `seed.at`.
  const at = new Date(seed.at);
  const task = await Task.create({
    userId: evalUserId,
    instruction: seed.title,
    budget: { maxSteps: 25, maxCostUsd: 5 },
    createdAt: at,
    updatedAt: at,
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

// Bury the seed behind the old bounded pool; out-of-pool stays reachable.
// @see #293
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

  // Stale embeddings would eat the next scenario's ANN budget.
  // @see #294
  await WorkspaceEmbedding.deleteMany({ userId: evalUserId });
};
