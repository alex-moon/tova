import mongoose from 'mongoose';
import { Entity } from '../models/Entity';
import { EntityEdge } from '../models/EntityEdge';
import {
  buildKnowledgeBlock,
  pickTopEntities,
  promptWords,
  retrieveKnowledgeBlock,
  scoreEntity,
} from './entityRetrievalService';

/*
 * Plan-138 task 3: selection is scored purely (no Mongo inside the scorer);
 * the Mongo-backed wrapper only gathers the candidate pool and endpoint
 * names, so its integration test just seeds nodes/edges and checks the block.
 */

const entity = (overrides: Partial<import('../models/Entity').EntityDoc> = {}) =>
  ({
    _id: new mongoose.Types.ObjectId(),
    mentionCount: 1,
    lastMentionedAt: new Date(),
    ...overrides,
  }) as import('../models/Entity').EntityDoc;

describe('promptWords / scoreEntity', () => {
  it('drops stopwords and short tokens so connectives never score', () => {
    expect(promptWords('Give me recommendations for restaurants near the hotel').has('the')).toBe(
      false,
    );
    expect(promptWords('Give me recommendations for restaurants near the hotel').has('hotel')).toBe(
      true,
    );
  });

  it('scores keyword overlap above everything else', () => {
    const hotel = entity({ name: 'Hotel Sahara', kind: 'place', mentionCount: 99 });
    expect(scoreEntity('which hotel is best', hotel)).toBeGreaterThan(10);
  });

  it('a zero-overlap node scores 0 — recency alone never selects it', () => {
    const unrelated = entity({ name: 'Taj Hotel', kind: 'place', mentionCount: 99 });
    expect(scoreEntity('weekend hiking ideas', unrelated)).toBe(0);
  });

  it('mention frequency and recent mention add smaller, positive weight', () => {
    const base = entity({ name: 'Restaurant Name', kind: 'place', mentionCount: 1 });
    const frequent = entity({ name: 'Restaurant Name', kind: 'place', mentionCount: 10 });
    expect(scoreEntity('show me the restaurant name mention', frequent)).toBeGreaterThan(
      scoreEntity('show me the restaurant name mention', base),
    );
  });
});

describe('pickTopEntities', () => {
  it('ranks overlapping nodes and drops zero scores', () => {
    const prompt = 'restaurants near the taj hotel';
    const pool = [
      entity({ name: 'Taj Hotel', kind: 'place' }),
      entity({ name: 'Anaya', kind: 'person' }),
      entity({ name: 'Gateway of India', kind: 'place' }),
    ];
    const picked = pickTopEntities(prompt, pool);
    expect(picked).toHaveLength(1);
    expect(picked[0].entity.name).toBe('Taj Hotel');
  });
});

describe('buildKnowledgeBlock', () => {
  const tai = entity({
    name: 'Taj Hotel',
    kind: 'place',
    summary: 'Near Colaba.',
    mentionCount: 3,
  });
  const anaya = entity({ name: 'Anaya', kind: 'person', summary: 'The user’s daughter.' });

  it('omits the block entirely when nothing is relevant', () => {
    expect(buildKnowledgeBlock('chia seeds recipe', [anaya], [])).toBe('');
  });

  it('builds bounded node lines and stated-edge lines', () => {
    const block = buildKnowledgeBlock(
      'restaurants near taj hotel',
      [tai, anaya],
      [
        {
          fromId: String(anaya._id),
          toId: String(tai._id),
          fromName: 'Anaya',
          toName: 'Taj Hotel',
          kind: 'involved-party',
          summary: 'Anaya is visiting.',
        },
      ],
    );
    expect(block).toContain('place: Taj Hotel — Near Colaba. — mentioned 3 times');
    expect(block).toContain('Anaya —involved-party→ Taj Hotel');
    expect(block.length).toBeLessThanOrEqual(1500);
  });

  it('hard-caps total block size at the character budget', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      entity({ name: `Naming Restaurant ${i}`, kind: 'place', mentionCount: i + 1 }),
    );
    const block = buildKnowledgeBlock('naming restaurant', many, []);
    expect(block.length).toBeLessThanOrEqual(1500);
  });
});

describe('retrieveKnowledgeBlock (integration)', () => {
  const userId = new mongoose.Types.ObjectId();

  it("returns '' for a user with no graph", async () => {
    expect(await retrieveKnowledgeBlock('ideas', userId.toString())).toBe('');
  });

  const createNode = (name: string, kind: string, confidence = 0.9) =>
    Entity.create({
      userId,
      name,
      normalizedName: name.toLowerCase(),
      kind,
      confidence,
    });

  it('inlines relevant nodes plus their direct edges with resolved names', async () => {
    const tai = await createNode('Taj Hotel', 'place');
    const anaya = await createNode('Anaya', 'person');
    await EntityEdge.create({
      userId,
      fromEntityId: anaya._id,
      toEntityId: tai._id,
      kind: 'involved-party',
      summary: 'Anaya is visiting the hotel.',
    });
    const other = await createNode('Distant Project', 'project');
    await EntityEdge.create({
      userId,
      fromEntityId: other._id,
      toEntityId: other._id,
      kind: 'plan',
    });
    const block = await retrieveKnowledgeBlock('restaurants near taj hotel', userId.toString());
    expect(block).toContain('place: Taj Hotel');
    expect(block).toContain('—involved-party→ Taj Hotel');
  });

  it('plan task 7: low-confidence nodes are excluded even with keyword overlap', async () => {
    await createNode('Gateway Hotel', 'place', 0.25); // below HIGH_CONFIDENCE
    const block = await retrieveKnowledgeBlock('restaurants near gateway hotel', userId.toString());
    expect(block).toBe('');
  });

  it('plan task 7: crossing the threshold brings the node back', async () => {
    const fiveBumps = Number(1 - 0.75 * 0.8 ** 5); // saturating growth from LOW
    expect(fiveBumps).toBeGreaterThan(0.75);
    await createNode('Colaba Hotel', 'place', fiveBumps);
    const block = await retrieveKnowledgeBlock('restaurants near colaba hotel', userId.toString());
    expect(block).toContain('place: Colaba Hotel');
  });

  it('plan task 7: pre-confidence legacy docs (no field) read as low and stay out', async () => {
    const legacy = await createNode('Legacy Hotel', 'place');
    await Entity.updateOne({ _id: legacy._id }, { $unset: { confidence: 1 } });
    const block = await retrieveKnowledgeBlock('restaurants near legacy hotel', userId.toString());
    expect(block).toBe('');
  });
});
