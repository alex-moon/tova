import mongoose from 'mongoose';
import { inferenceService } from './inferenceService';
import { Entity, LOW_CONFIDENCE, bumpConfidence, type Salience } from '../models/Entity';
import { EntityEdge } from '../models/EntityEdge';

/*
 * Per-user entity graph extraction (issue #138, plan-138 task 2). One
 * fire-and-forget tool-free LLM call per completed turn — the titleService
 * pattern — that pulls durable real-world entities and *stated* relationships
 * out of the exchange and merges them into the per-user graph. Every failure
 * degrades to a log entry: the graph is enrichment, never load-bearing, so a
 * bad extraction must not fail a chat turn that has already been served.
 */

const EXTRACTION_MODEL = process.env.ROUTER_SMALL_MODEL || 'openai/gpt-oss-20b';

// Plan-138 decision 6: extraction stays off until the flag is set, so the
// extra LLM call can be disabled instantly without a deploy.
export const isEntityExtractionEnabled = (): boolean => Boolean(process.env.ENTITY_GRAPH_ENABLED);

const EXTRACTION_PROMPT =
  'You extract a memory graph from a chat exchange. From the user statement and the ' +
  'assistant reply, identify durable real-world entities (a person, place, organization, ' +
  'project, task, event, commitment, or preference the user has) and relationships ' +
  'between them. Ignore code, generic concepts, and anything the assistant merely cited. ' +
  'State a relationship ONLY when the text actually links the two entities (a plan, ' +
  'involvement, gate/signoff, preference, or location-style tie). ' +
  'Tag each entity `salience: "high"` ONLY when it is emotionally significant to the user ' +
  '(a family event, a strong personal preference); default to "low". ' +
  'Reply with ONLY a JSON object, no prose or code fences, shaped exactly like: ' +
  '{"entities":[{"name":"...","kind":"person|place|organization|project|task|event|commitment|preference","summary":"one sentence","salience":"low|high"}],' +
  '"edges":[{"from":"entity name","to":"entity name","kind":"involved-party|plan|prefers|located-in|gate","summary":"one sentence"}]} ' +
  'If there is nothing durable, reply {"entities":[],"edges":[]}';

const KIND_PATTERN = /^[a-z][a-z-]*$/;

export const normalizeName = (name: string): string =>
  name.toLowerCase().replace(/\s+/g, ' ').trim();

type EntityCandidate = { name: string; kind: string; summary: string; salience: Salience };
type EdgeCandidate = { from: string; to: string; kind: string; summary: string };

/*
 * Extraction output is untrusted (plan-138 task 2b): the model may wrap the
 * JSON in fences, prefix prose, or emit a truncated tail. The parse salvages
 * the structure or returns null; the candidate validators below then skip
 * junk entries one by one rather than poisoning the graph.
 */
export const parseExtraction = (raw: string): unknown => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    // Not clean JSON: try the widest {..} span before giving up.
  }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
};

const cleanSummary = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

export const validEntityCandidates = (parsed: unknown): EntityCandidate[] => {
  const list = (parsed as { entities?: unknown } | null)?.entities;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (item): item is { name: unknown; kind: unknown; summary?: unknown; salience?: unknown } =>
        typeof item === 'object' && item !== null,
    )
    .filter((item) => typeof item.name === 'string' && item.name.trim() !== '')
    .filter((item) => typeof item.kind === 'string' && KIND_PATTERN.test(item.kind.trim()))
    .map((item) => ({
      name: (item.name as string).trim(),
      kind: (item.kind as string).trim().toLowerCase(),
      summary: cleanSummary(item.summary),
      salience: item.salience === 'high' ? 'high' : 'low',
    }));
};

export const validEdgeCandidates = (parsed: unknown): EdgeCandidate[] => {
  const list = (parsed as { edges?: unknown } | null)?.edges;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (item): item is { from?: unknown; to?: unknown; kind?: unknown; summary?: unknown } =>
        typeof item === 'object' && item !== null,
    )
    .filter(
      (item) =>
        typeof item.from === 'string' &&
        item.from.trim() !== '' &&
        typeof item.to === 'string' &&
        item.to.trim() !== '' &&
        typeof item.kind === 'string' &&
        KIND_PATTERN.test(item.kind.trim()),
    )
    .filter((item) => normalizeName(item.from as string) !== normalizeName(item.to as string))
    .map((item) => ({
      from: (item.from as string).trim(),
      to: (item.to as string).trim(),
      kind: (item.kind as string).trim().toLowerCase(),
      summary: cleanSummary(item.summary),
    }));
};

export type ExtractionInput = {
  userId: string;
  sessionId: string;
  messageId: string;
  userText: string;
  assistantText: string;
};

/*
 * Merge-or-create (plan decision 3): identity is exact match on
 * {(userId, normalizedName, kind)}. The upsert bumps mentionCount and
 * lastMentionedAt on the match path and only sets name/kind on insert, so a
 * repeated mention reuses the existing node — never a second one. A failed
 * upsert (e.g. a race across concurrent turns) logs and skips, never throws.
 *
 * Confidence (plan task 7): a fresh node starts at LOW_CONFIDENCE; a merge
 * applies the saturating bump computed from the pre-update value (read-
 * modify-write on a tiny race window — far less frequent than it sounds,
 * and a missed bump merely slows a node's rise, never loses data). Salience
 * can only rise from a re-mention: a commute habit never earns salience, and
 * using salience in retrieval is deliberately out of scope (plan task 7f).
 */
const upsertEntity = async (
  userId: string,
  candidate: EntityCandidate,
  input: { sessionId: string; messageId: string },
): Promise<mongoose.Types.ObjectId | null> => {
  const sourceRef = {
    sessionId: new mongoose.Types.ObjectId(input.sessionId),
    messageId: new mongoose.Types.ObjectId(input.messageId),
  };
  try {
    const prior = await Entity.findOneAndUpdate(
      {
        userId: new mongoose.Types.ObjectId(userId),
        normalizedName: normalizeName(candidate.name),
        kind: candidate.kind,
      },
      {
        $setOnInsert: {
          name: candidate.name,
          kind: candidate.kind,
          confidence: LOW_CONFIDENCE,
          salience: candidate.salience,
          ...(candidate.summary ? { summary: candidate.summary } : {}),
          sourceRefs: [sourceRef],
        },
      },
      { upsert: true },
    );
    if (!prior) {
      const inserted = await Entity.findOne({
        userId: new mongoose.Types.ObjectId(userId),
        normalizedName: normalizeName(candidate.name),
        kind: candidate.kind,
      });
      return (inserted?._id as mongoose.Types.ObjectId) ?? null;
    }
    const bump = bumpConfidence(prior.confidence ?? LOW_CONFIDENCE);
    await Entity.updateOne(
      { _id: prior._id },
      {
        $set: {
          lastMentionedAt: new Date(),
          confidence: bump,
          // `?? 'low'`: a legacy doc without the field must not get a null
          // salience written by $set (the schema default only runs on insert).
          salience: candidate.salience === 'high' ? 'high' : (prior.salience ?? 'low'),
        },
        $inc: { mentionCount: 1 },
        $push: { sourceRefs: sourceRef },
      },
    );
    return prior._id as mongoose.Types.ObjectId;
  } catch (err) {
    console.error(`Entity upsert error for "${candidate.name}" (${candidate.kind}):`, err);
    return null;
  }
};

const upsertEdge = async (
  userId: string,
  fromEntityId: mongoose.Types.ObjectId,
  toEntityId: mongoose.Types.ObjectId,
  candidate: EdgeCandidate,
  input: { sessionId: string; messageId: string },
): Promise<void> => {
  try {
    await EntityEdge.findOneAndUpdate(
      {
        userId: new mongoose.Types.ObjectId(userId),
        fromEntityId,
        toEntityId,
        kind: candidate.kind,
      },
      {
        $setOnInsert: { ...(candidate.summary ? { summary: candidate.summary } : {}) },
        $push: {
          sourceRefs: {
            sessionId: new mongoose.Types.ObjectId(input.sessionId),
            messageId: new mongoose.Types.ObjectId(input.messageId),
          },
        },
      },
      { upsert: true },
    );
  } catch (err) {
    console.error('Entity edge upsert error:', err);
  }
};

/*
 * The core per-turn extraction: LLM call → tolerant parse → merge-or-create →
 * edges only where both endpoints resolved to graph nodes. Creates nothing
 * when the LLM call or parse fails, and never rethrows.
 */
export const extractAndPersistFromTurn = async (input: ExtractionInput): Promise<void> => {
  const trimmedExchange =
    `${input.userText.replace(/\s+/g, ' ').trim()}\n\nAssistant replied:\n` +
    `${input.assistantText.replace(/\s+/g, ' ').trim()}`;
  try {
    const completion = await inferenceService.createToolFreeCompletion({
      provider: 'groq',
      model: EXTRACTION_MODEL,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: trimmedExchange.substring(0, 4000) },
      ],
      temperature: 0.2,
      // Reasoning tokens from the small model eat into this budget before
      // any JSON text (titleService precedent: 30 was far too small there).
      max_tokens: 1024,
      trace: { sessionId: input.sessionId, tags: ['entity-graph-extract'] },
    });
    const raw = completion.choices[0]?.message?.content ?? '';
    const parsed = parseExtraction(raw);
    if (!parsed || typeof parsed !== 'object') {
      // Junk model output: nothing durable, nothing written (plan 2f).
      return;
    }
    // Edge endpoints are named, not kind-tagged, so resolution is by
    // normalized name only; an ambiguous name (same name, several kinds) is
    // skipped — silently mis-linking nodes is worse than dropping an edge.
    const nodesByName = new Map<string, mongoose.Types.ObjectId[]>();
    // A single turn may name the same entity more than once (or the model may
    // emit it twice). Confidence bumps mean *cross-chat* confirmation ("what
    // fires together wires together"), so a node is merged into the graph at
    // most once per turn — dedupe on the identity key up front.
    const seen = new Set<string>();
    for (const candidate of validEntityCandidates(parsed)) {
      const key = `${normalizeName(candidate.name)}\u0000${candidate.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = await upsertEntity(input.userId, candidate, input);
      if (!id) continue;
      const nameKey = normalizeName(candidate.name);
      const existing = nodesByName.get(nameKey) ?? [];
      existing.push(id);
      nodesByName.set(nameKey, existing);
    }
    const resolve = (name: string): mongoose.Types.ObjectId | null => {
      const ids = nodesByName.get(normalizeName(name));
      return ids && ids.length === 1 ? ids[0] : null;
    };
    for (const edge of validEdgeCandidates(parsed)) {
      const from = resolve(edge.from);
      const to = resolve(edge.to);
      if (!from || !to) continue;
      await upsertEdge(input.userId, from, to, edge, input);
    }
  } catch (err) {
    console.error('Entity extraction error:', err);
  }
};
