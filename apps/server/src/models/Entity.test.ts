import { Entity } from './Entity';
import { EntityEdge } from './EntityEdge';
import mongoose from 'mongoose';
// The shared jest setup (src/server/test/setup.ts) provides the in-memory
// Mongo, connects mongoose, syncs indexes, and clears collections per test.

/*
 * Plan-138 task 1: node identity is exact match on
 * {(userId, normalizedName, kind)} via a unique compound index; edges are
 * unique per (from, to, kind) so repeated mentions do not duplicate links.
 */

const userId = new mongoose.Types.ObjectId();
const sessionId = new mongoose.Types.ObjectId();

describe('Entity', () => {
  it('creates a node with defaults and a source ref', async () => {
    const doc = await Entity.create({
      userId,
      name: 'Taj Hotel',
      normalizedName: 'taj hotel',
      kind: 'place',
      sourceRefs: [{ sessionId }],
    });
    expect(doc.mentionCount).toBe(1);
    expect(doc.lastMentionedAt).toBeInstanceOf(Date);
    expect(doc.sourceRefs[0].sessionId.toString()).toBe(sessionId.toString());
  });

  it('looks nodes up by exact normalized name and kind', async () => {
    await Entity.create({
      userId,
      name: 'Taj Hotel',
      normalizedName: 'taj hotel',
      kind: 'place',
    });
    const found = await Entity.findOne({ userId, normalizedName: 'taj hotel', kind: 'place' });
    expect(found?.name).toBe('Taj Hotel');
    // Different kind → different node.
    const other = await Entity.create({
      userId,
      name: 'Taj Hotel',
      normalizedName: 'taj hotel',
      kind: 'organization',
    });
    expect(other._id).not.toEqual(found!._id);
  });

  it('enforces the unique identity index per user', async () => {
    await Entity.create({ userId, name: 'Taj Hotel', normalizedName: 'taj hotel', kind: 'place' });
    const otherUser = new mongoose.Types.ObjectId();
    await Entity.create({
      userId: otherUser,
      name: 'Taj Hotel',
      normalizedName: 'taj hotel',
      kind: 'place',
    });
    await expect(
      Entity.create({ userId, name: 'Taj Hotel', normalizedName: 'taj hotel', kind: 'place' }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('bumps mentionCount and lastMentionedAt', async () => {
    const doc = await Entity.create({
      userId,
      name: 'Anaya',
      normalizedName: 'anaya',
      kind: 'person',
      lastMentionedAt: new Date(0),
    });
    const updated = await Entity.findByIdAndUpdate(
      doc._id,
      [
        {
          $set: {
            mentionCount: { $add: ['$mentionCount', 1] },
            lastMentionedAt: new Date(),
          },
        },
      ],
      { new: true },
    );
    expect(updated?.mentionCount).toBe(2);
    expect(updated?.lastMentionedAt.getTime()).toBeGreaterThan(0);
  });
});

describe('EntityEdge', () => {
  it('stores a typed edge with source refs', async () => {
    const from = await Entity.create({
      userId,
      name: 'Anaya',
      normalizedName: 'anaya',
      kind: 'person',
    });
    const to = await Entity.create({
      userId,
      name: 'Taj Hotel',
      normalizedName: 'taj hotel',
      kind: 'place',
    });
    const edge = await EntityEdge.create({
      userId,
      fromEntityId: from._id,
      toEntityId: to._id,
      kind: 'involved-party',
      summary: 'Anaya plans to stay at the Taj Hotel.',
      sourceRefs: [{ sessionId }],
    });
    expect(edge.kind).toBe('involved-party');
    const found = await EntityEdge.findOne({
      userId,
      fromEntityId: from._id,
      kind: 'involved-party',
    });
    expect(found?.toEntityId.toString()).toBe(to._id.toString());
  });

  it('enforces edge uniqueness per (from, to, kind)', async () => {
    const from = await Entity.create({
      userId,
      name: 'Anaya',
      normalizedName: 'anaya',
      kind: 'person',
    });
    const to = await Entity.create({
      userId,
      name: 'Taj Hotel',
      normalizedName: 'taj hotel',
      kind: 'place',
    });
    const base = {
      userId,
      fromEntityId: from._id,
      toEntityId: to._id,
      kind: 'involved-party',
    };
    await EntityEdge.create(base);
    await expect(EntityEdge.create(base)).rejects.toThrow(/duplicate key/i);
    // A different kind still gets its own row.
    await expect(EntityEdge.create({ ...base, kind: 'prefers' })).resolves.toBeDefined();
  });
});
