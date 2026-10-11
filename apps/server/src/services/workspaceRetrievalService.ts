import mongoose from 'mongoose';
import { Asset } from '../models/Asset';
import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { promptWords } from './entityRetrievalService';
import { config } from '../config';

/*
 * #253: workspace memory — retrieval over the user's past work.
 *
 * The epic's unit of memory is a *piece of work*, not an extracted concept
 * (that was #138, superseded). The v1 corpus is addressable *views* over what
 * already exists — `Message` rows joined to their `Session` title, and `Asset`
 * rows' extracted text — read at retrieval time; nothing is copied into a new
 * store (the ticket's "no eager copies into library-shaped docs").
 *
 * Retrieval is personal-scale and lexical (#251: no vector infra in v1):
 * keyword-overlap scoring over a recent bounded candidate pool, recency as a
 * tiebreak only. An overlap of zero scores zero, so recency alone cannot drag
 * an unrelated slice into the block — the same rule the entity block keeps.
 *
 * The gate (does a turn deserve retrieval at all?) lives in
 * `enrichmentService.ts`; this module is pure retrieval + layout, mirroring
 * the entityRetrievalService split so scoring is unit-testable without Mongo.
 */

// #251/decision: kill switch, mirroring ENTITY_GRAPH_PROMPT_INJECTION.
// Default OFF — a wrong injection pollutes every turn, so the block ships
// opt-in until the gate evals exist (see docs/plan-253-workspace-memory.md).
export const isWorkspaceMemoryEnabled = (): boolean => config.workspaceMemory.enabled;

// Injection budget (chars). Below the entity block's 1500 because the library
// index competes for the same prompt budget (plan decision 4).
export const BLOCK_CAP = 1200;

// Candidate pool sizes: bounded so cost is flat regardless of history length.
const MESSAGE_POOL = 200;
const ASSET_POOL = 50;
const MAX_SLICES = 6;

export type WorkspaceSlice = {
  kind: 'chat' | 'file';
  id: string;
  title: string;
  text: string;
  at: Date;
};

/*
 * Deterministic score = keyword overlap × 10 + a small recency nudge, with a
 * hard floor at zero overlap (recency never lifts an irrelevant slice in).
 * The recency nudge is scaled so it can only reorder equals, not outrank a
 * slice with strictly more overlap.
 */
export const scoreSlice = (prompt: string, slice: { text: string; at: Date }): number => {
  const words = promptWords(prompt);
  if (words.size === 0) return 0;
  const sliceWords = promptWords(slice.text);
  let overlap = 0;
  for (const word of words) if (sliceWords.has(word)) overlap += 1;
  if (overlap === 0) return 0;
  const ageDays = Math.max(0, Date.now() - new Date(slice.at).getTime()) / 86400000;
  return overlap * 10 + Math.max(0, 5 - ageDays);
};

export const pickTopSlices = (
  prompt: string,
  slices: WorkspaceSlice[],
  n = MAX_SLICES,
): { slice: WorkspaceSlice; score: number }[] =>
  slices
    .map((slice) => ({ slice, score: scoreSlice(prompt, slice) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);

const oneLine = (text: string, cap = 160): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > cap ? `${line.substring(0, cap - 1)}…` : line;
};

/*
 * Layout: one bullet per slice, hard character cap, empty-on-nothing so an
 * empty block never shifts an otherwise identical prompt (the entity block's
 * regression guard, plan-138 decision 4). Chat slices carry their session
 * title + date; file slices carry their filename.
 */
export const buildWorkspaceBlock = (
  prompt: string,
  slices: WorkspaceSlice[],
  n = MAX_SLICES,
  cap = BLOCK_CAP,
): string => {
  const picked = pickTopSlices(prompt, slices, n);
  if (picked.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  for (const { slice } of picked) {
    const date = new Date(slice.at).toISOString().slice(0, 10);
    const label = slice.kind === 'chat' ? `chat "${slice.title}"` : `file "${slice.title}"`;
    const line = `- ${label} (${date}) — ${oneLine(slice.text)}`;
    if (used + line.length > cap) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
};

/*
 * Mongo-backed retrieval: a recent bounded pool of the user's messages (joined
 * to their session titles) and extracted-asset text, scored against the prompt.
 * Empty block when nothing overlaps. Never throws — memory, like the entity
 * block, must not degrade a chat turn.
 */
export const retrieveWorkspaceBlock = async (
  prompt: string,
  userId: string,
  n = MAX_SLICES,
): Promise<string> => {
  try {
    const uid = new mongoose.Types.ObjectId(userId);
    const [messages, assets] = await Promise.all([
      Message.find({ role: 'user' })
        .sort({ timestamp: -1 })
        .limit(MESSAGE_POOL * 4)
        .select('sessionId content timestamp')
        .lean(),
      Asset.find({
        userId: uid,
        status: 'ready',
        $or: [{ textExtracted: { $ne: null } }, { markdownExtracted: { $ne: null } }],
      })
        .sort({ _id: -1 })
        .limit(ASSET_POOL)
        .select('filename textExtracted markdownExtracted createdAt')
        .lean(),
    ]);

    // The pool must belong to this user: messages are keyed by sessionId, not
    // userId, so the user's session ids are the join key. Bounded by the
    // message pool above.
    const sessionIds = [
      ...new Set(messages.map((m) => String(m.sessionId as mongoose.Types.ObjectId))),
    ].slice(0, MESSAGE_POOL);
    const sessions = await Session.find({
      _id: { $in: sessionIds.map((id) => new mongoose.Types.ObjectId(id)) },
      userId: uid,
      deletedAt: null,
    })
      .select('title')
      .lean();
    const titleById = new Map(sessions.map((s) => [String(s._id), s.title as string] as const));
    const ownedSessionIds = new Set(titleById.keys());

    const slices: WorkspaceSlice[] = [];
    for (const m of messages) {
      const sid = String(m.sessionId);
      if (!ownedSessionIds.has(sid)) continue;
      const text = (m.content as string) ?? '';
      if (!text.trim()) continue;
      slices.push({
        kind: 'chat',
        id: String(m._id),
        title: titleById.get(sid) ?? 'Untitled chat',
        text,
        at: m.timestamp as Date,
      });
      if (slices.length >= MESSAGE_POOL) break;
    }
    for (const a of assets) {
      const text = ((a.markdownExtracted as string) || (a.textExtracted as string) || '').trim();
      if (!text) continue;
      slices.push({
        kind: 'file',
        id: String(a._id),
        title: a.filename as string,
        text,
        at: (a.createdAt as Date) ?? new Date(0),
      });
    }

    return buildWorkspaceBlock(prompt, slices, n);
  } catch (err) {
    console.error('Workspace retrieval error:', err);
    return '';
  }
};
