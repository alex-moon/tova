import mongoose from 'mongoose';
import { Entity } from '../models/Entity';
import { EntityEdge } from '../models/EntityEdge';
import { normalizeName } from './entityExtractionService';

/*
 * Prompt-assembly retrieval (issue #138, plan-138 task 3). Pure selection —
 * score a candidate pool of nodes against the current user prompt, then
 * materialise a compact "what we know about you" block with a hard character
 * cap (plan decision 7). The scoring part is pure so it is fully
 * unit-testable without Mongo.
 */

export type ScoredEntity = {
  _id: mongoose.Types.ObjectId;
  name: string;
  kind: string;
  summary?: string;
  mentionCount: number;
  lastMentionedAt: Date;
};

const WORD_PATTERN = /[a-z0-9']+/g;

// Stopwords that carry no linking signal; "the hotel" prompts still match a
// node named "Hotel Sahara" via 'hotel', but 'the'/'near' alone must not
// surface unrelated nodes.
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'for',
  'to',
  'of',
  'in',
  'on',
  'near',
  'at',
  'is',
  'it',
  'my',
  'me',
  'you',
  'we',
  'i',
  'be',
  'are',
  'was',
]);

export const promptWords = (prompt: string): Set<string> => {
  const words = normalizeName(prompt).match(WORD_PATTERN) ?? [];
  return new Set(words.filter((word) => word.length > 1 && !STOPWORDS.has(word)));
};

/*
 * Deterministic score = keyword overlap (the dominant signal) × 10 +
 * log-scaled mention frequency + recency bonus. Keyword overlap of zero
 * scores 0 — recency alone must not drag irrelevant nodes into the block,
 * but such nodes stay in the pool so pure-recency trends remain observable.
 */
export const scoreEntity = (prompt: string, entity: ScoredEntity): number => {
  const words = promptWords(prompt);
  const nameWords = normalizeName(entity.name).match(WORD_PATTERN) ?? [];
  let overlap = nameWords.filter((word) => words.has(word)).length;
  if (entity.summary) {
    const summaryWords = normalizeName(entity.summary).match(WORD_PATTERN) ?? [];
    overlap += summaryWords.filter((word) => words.has(word)).length;
  }
  if (overlap === 0) return 0;
  const ageDays = Math.max(0, Date.now() - new Date(entity.lastMentionedAt).getTime()) / 86400000;
  return overlap * 10 + Math.log(1 + entity.mentionCount) + Math.max(0, 5 - ageDays);
};

export const pickTopEntities = (
  prompt: string,
  nodes: ScoredEntity[],
  n = 8,
): { entity: ScoredEntity; score: number }[] =>
  nodes
    .map((entity) => ({ entity, score: scoreEntity(prompt, entity) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);

const BLOCK_CAP = 1500;

const oneLine = (text: string, cap = 120): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > cap ? `${line.substring(0, cap - 1)}…` : line;
};

export const buildKnowledgeBlock = (
  prompt: string,
  nodes: ScoredEntity[],
  edges: {
    fromId: string;
    toId: string;
    fromName: string;
    toName: string;
    kind: string;
    summary?: string;
  }[],
  n = 8,
  cap = BLOCK_CAP,
): string => {
  const picked = pickTopEntities(prompt, nodes, n);
  if (picked.length === 0) return '';
  const nameById = new Map(picked.map(({ entity }) => [String(entity._id), entity.name] as const));
  const selectedIds = new Set(nameById.keys());
  const lines: string[] = [];
  let used = 0;
  for (const { entity } of picked) {
    const details = [`${entity.kind}: ${entity.name}`];
    if (entity.summary) details.push(entity.summary);
    details.push(`mentioned ${entity.mentionCount} times`);
    const line = `- ${details.join(' — ')}`;
    if (used + line.length > cap) break;
    lines.push(line);
    used += line.length;
  }
  for (const edge of edges) {
    if (!selectedIds.has(edge.fromId) && !selectedIds.has(edge.toId)) continue;
    const edgeLine =
      `- ${nameById.get(edge.fromId) ?? edge.fromName} —${edge.kind}→ ` +
      `${nameById.get(edge.toId) ?? edge.toName}` +
      (edge.summary ? ` (${oneLine(edge.summary, 80)})` : '');
    // Other-endpoint nodes outside the selected set still surface (their
    // name came from the Mongo fetch below); skip dangling names entirely.
    if (!nameById.get(edge.fromId) && !edge.fromName) continue;
    if (!nameById.get(edge.toId) && !edge.toName) continue;
    if (used + edgeLine.length > cap) break;
    lines.push(edgeLine);
    used += edgeLine.length;
  }
  return lines.join('\n');
};

/*
 * Mongo-backed selection: a recent bounded pool (plan decision: recency
 * order for cheap candidate recursion, then scoring picks the winners) plus
 * the direct edges of the survivors. Empty block when nothing is relevant.
 */
export const retrieveKnowledgeBlock = async (
  prompt: string,
  userId: string,
  n = 8,
): Promise<string> => {
  const pool = await Entity.find({ userId: new mongoose.Types.ObjectId(userId) })
    .sort({ lastMentionedAt: -1 })
    .limit(100)
    .lean();
  if (pool.length === 0) return '';
  const picked = pickTopEntities(prompt, pool as unknown as ScoredEntity[], n);
  if (picked.length === 0) return '';
  const ids = picked.map((entry) => entry.entity._id);
  const edges = await EntityEdge.find({
    userId: new mongoose.Types.ObjectId(userId),
    $or: [{ fromEntityId: { $in: ids } }, { toEntityId: { $in: ids } }],
  })
    .limit(50)
    .lean();
  // Endpoint names: the picked side comes from scoring, the far side needs a
  // name lookup so edge lines stay human-readable even though the far node
  // is not part of the selected set.
  const farIds = edges.flatMap((edge) => [
    edge.fromEntityId,
    edge.toEntityId,
  ]) as mongoose.Types.ObjectId[];
  const nameDocs = await Entity.find({ _id: { $in: farIds } })
    .select('name')
    .lean();
  const nameById = new Map<string, string>([
    ...picked.map(({ entity }) => [String(entity._id), entity.name] as const),
    ...nameDocs.map((doc) => [String(doc._id), doc.name] as const),
  ]);
  return buildKnowledgeBlock(
    prompt,
    pool as unknown as ScoredEntity[],
    edges.map((edge) => ({
      fromId: String(edge.fromEntityId),
      toId: String(edge.toEntityId),
      fromName: nameById.get(String(edge.fromEntityId)) ?? '',
      toName: nameById.get(String(edge.toEntityId)) ?? '',
      kind: edge.kind,
      summary: edge.summary ?? undefined,
    })),
    n,
  );
};
