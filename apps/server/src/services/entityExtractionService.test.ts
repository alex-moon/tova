import mongoose from 'mongoose';
import { Entity } from '../models/Entity';
import { EntityEdge } from '../models/EntityEdge';
import {
  extractAndPersistFromTurn,
  parseExtraction,
  validEdgeCandidates,
  validEntityCandidates,
  normalizeName,
} from './entityExtractionService';
import { muteConsoleError } from '../test/muteConsole';

/*
 * Plan-138 task 2: extraction output is untrusted, so junk JSON degrades to
 * no writes; valid output merge-or-creates nodes and only links stated
 * relationships. Mongoose is provided by the shared setup (in-memory Mongo);
 * the LLM call is a stub (titleService.test pattern).
 */

const mockCreateToolFree = jest.fn();

jest.mock('./inferenceService', () => ({
  inferenceService: {
    createToolFreeCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
  },
}));

beforeEach(async () => {
  mockCreateToolFree.mockReset();
});
const userId = new mongoose.Types.ObjectId().toString();
const sessionId = new mongoose.Types.ObjectId().toString();
const messageId = new mongoose.Types.ObjectId().toString();
const input = {
  userId,
  sessionId,
  messageId,
  userText: 'Looking at hotels near Colaba',
  assistantText: 'Taj Hotel is a good choice.',
};

describe('parseExtraction', () => {
  it('parses clean JSON', () => {
    expect(parseExtraction('{"entities":[],"edges":[]}')).toEqual({ entities: [], edges: [] });
  });

  it('salvages fenced and prose-wrapped JSON', () => {
    expect(parseExtraction('```json\n{"entities":[1]}\n```')).toEqual({ entities: [1] });
    expect(parseExtraction('Sure! {"entities":[]} hope that helps')).toEqual({ entities: [] });
  });

  it('returns null for unparseable output', () => {
    expect(parseExtraction('no json here')).toBeNull();
    expect(parseExtraction('{"entities": [')).toBeNull();
  });
});

describe('validEntityCandidates / validEdgeCandidates', () => {
  it('skips junk entity entries one by one', () => {
    const candidates = validEntityCandidates({
      entities: [
        { name: 'Taj Hotel', kind: 'place', summary: 'A hotel.' },
        { name: '', kind: 'place' },
        { name: 'Thing', kind: 'not a kind!!' },
        null,
        { name: '  spaces  ', kind: ' person ' },
      ],
    });
    expect(candidates).toEqual([
      { name: 'Taj Hotel', kind: 'place', summary: 'A hotel.', salience: 'low' },
      { name: 'spaces', kind: 'person', summary: '', salience: 'low' },
    ]);
  });

  it('reads a salience hint, defaulting to low on junk values', () => {
    const candidates = validEntityCandidates({
      entities: [
        { name: 'Funeral', kind: 'event', salience: 'high' },
        { name: 'Commute', kind: 'task', salience: 'strong' },
      ],
    });
    expect(candidates.map((c) => c.salience)).toEqual(['high', 'low']);
  });

  it('drops self-links and unkinded edges', () => {
    const edges = validEdgeCandidates({
      edges: [
        { from: 'Taj', to: 'Taj', kind: 'plan' },
        { from: 'Anaya', to: 'Taj', kind: 'involved-party', summary: 'Together.' },
        { from: 'A', to: 'B' },
      ],
    });
    expect(edges).toEqual([
      { from: 'Anaya', to: 'Taj', kind: 'involved-party', summary: 'Together.' },
    ]);
  });
});

describe('extractAndPersistFromTurn', () => {
  it('creates nodes and a stated edge from valid output', async () => {
    mockCreateToolFree.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: [
                { name: 'Anaya', kind: 'person', summary: "The user's daughter." },
                { name: 'Taj Hotel', kind: 'place', summary: 'Hotel near Colaba.' },
              ],
              edges: [
                {
                  from: 'Anaya',
                  to: 'Taj Hotel',
                  kind: 'involved-party',
                  summary: 'Anaya is visiting and the hotel suits her.',
                },
              ],
            }),
          },
        },
      ],
    });
    await extractAndPersistFromTurn(input);
    const nodes = await Entity.find();
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.mentionCount === 1)).toBe(true);
    expect(nodes.every((n) => String(n.sourceRefs[0].sessionId) === sessionId)).toBe(true);
    const edge = await EntityEdge.findOne();
    expect(edge?.kind).toBe('involved-party');
  });

  it('merge-or-creates: a repeated entity bumps the existing node', async () => {
    mockCreateToolFree.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: [{ name: 'Taj Hotel', kind: 'place', summary: 'Hotel near Colaba.' }],
              edges: [],
            }),
          },
        },
      ],
    });
    await extractAndPersistFromTurn(input);
    await extractAndPersistFromTurn({ ...input, userText: 'Compare Taj Hotel to others' });
    const nodes = await Entity.find();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].mentionCount).toBe(2);
    expect(String(nodes[0].sourceRefs[0].messageId)).toBe(messageId);
  });

  it('plan task 7: new nodes start LOW, merges saturate below 1, salience can rise', async () => {
    mockCreateToolFree.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: [
                { name: 'Taj Hotel', kind: 'place', salience: 'high' },
                { name: 'Commute', kind: 'task' },
              ],
              edges: [],
            }),
          },
        },
      ],
    });
    await extractAndPersistFromTurn(input);
    let nodes = await Entity.find();
    expect(nodes.every((n) => n.confidence === 0.25)).toBe(true); // LOW_CONFIDENCE
    expect(nodes.find((n) => n.name === 'Commute')!.salience).toBe('low');
    expect(nodes.find((n) => n.name === 'Taj Hotel')!.salience).toBe('high');
    for (let i = 0; i < 8; i += 1) {
      await extractAndPersistFromTurn({ ...input, userText: `Mention ${i} of Taj Hotel` });
    }
    const taj = await Entity.findOne({ name: 'Taj Hotel' });
    expect(taj!.mentionCount).toBe(9);
    // Eight saturating bumps land past HIGH but never at/above 1.
    expect(taj!.confidence).toBeCloseTo(1 - 0.8 ** 8 * 0.75, 10);
    expect(taj!.confidence).toBeGreaterThan(0.75);
    expect(taj!.confidence).toBeLessThan(1);
    // Salience only ever rises: a later 'low' mention cannot demote it.
    await extractAndPersistFromTurn({ ...input, userText: 'more Taj Hotel chat' });
    expect((await Entity.findOne({ name: 'Taj Hotel' }))!.salience).toBe('high');
  });

  it('dedupes an entity named twice within one turn (no double confidence bump)', async () => {
    mockCreateToolFree.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: [
                { name: 'Taj Hotel', kind: 'place' },
                { name: 'taj hotel', kind: 'place' },
              ],
              edges: [],
            }),
          },
        },
      ],
    });
    await extractAndPersistFromTurn(input);
    const nodes = await Entity.find();
    expect(nodes).toHaveLength(1);
    // One merge per turn: cross-chat confirmation, not intra-chat echo.
    expect(nodes[0].mentionCount).toBe(1);
    expect(nodes[0].confidence).toBe(0.25);
  });

  it('plan task 9: a legacy node without salience/confidence fields never gets nulls', async () => {
    // Insert a raw doc that skipped the schema defaults (pre-flag production
    // write or migrated data).
    await Entity.collection.insertOne({
      userId: new mongoose.Types.ObjectId(userId),
      name: 'Taj Hotel',
      normalizedName: 'taj hotel',
      kind: 'place',
      mentionCount: 1,
      sourceRefs: [],
    });
    mockCreateToolFree.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: [{ name: 'Taj Hotel', kind: 'place', salience: 'low' }],
              edges: [],
            }),
          },
        },
      ],
    });
    await extractAndPersistFromTurn(input);
    const node = await Entity.findOne({ name: 'Taj Hotel' }).lean();
    expect(node?.salience).toBe('low'); // never null
    // undefined confidence coalesces to LOW, then one bump: 0.4, never null.
    expect(node?.confidence).toBeCloseTo(0.4, 10);
  });

  it('plan task 9: a Mongo write failure degrades to a log entry, resolving quietly', async () => {
    const mute = muteConsoleError();
    try {
      mockCreateToolFree.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                entities: [{ name: 'Taj Hotel', kind: 'place' }],
                edges: [],
              }),
            },
          },
        ],
      });
      jest.spyOn(Entity, 'findOneAndUpdate').mockRejectedValueOnce(new Error('mongod down'));
      await expect(extractAndPersistFromTurn(input)).resolves.toBeUndefined();
      expect(await Entity.countDocuments()).toBe(0);
    } finally {
      mute.mockRestore();
      jest.restoreAllMocks();
    }
  });

  it('degrades silently on junk JSON with no partial writes', async () => {
    const mute = muteConsoleError();
    try {
      mockCreateToolFree.mockResolvedValueOnce({
        choices: [{ message: { content: 'not json at all' } }],
      });
      await extractAndPersistFromTurn(input);
    } finally {
      mute.mockRestore();
    }
    expect(await Entity.countDocuments()).toBe(0);
    expect(await EntityEdge.countDocuments()).toBe(0);
  });

  it('degrades silently and rethrows nothing on LLM failure', async () => {
    const mute = muteConsoleError();
    try {
      mockCreateToolFree.mockRejectedValueOnce(new Error('429 TPM'));
      await expect(extractAndPersistFromTurn(input)).resolves.toBeUndefined();
    } finally {
      mute.mockRestore();
    }
    expect(await Entity.countDocuments()).toBe(0);
  });

  it('skips edges whose endpoints did not resolve to nodes', async () => {
    mockCreateToolFree.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: [{ name: 'Taj Hotel', kind: 'place' }],
              edges: [{ from: 'Ghost Node', to: 'Taj Hotel', kind: 'plan' }],
            }),
          },
        },
      ],
    });
    await extractAndPersistFromTurn(input);
    expect(await EntityEdge.countDocuments()).toBe(0);
  });

  it('uses the tool-free groq path with the entity-graph-extract trace tag', async () => {
    mockCreateToolFree.mockResolvedValueOnce({
      choices: [{ message: { content: '{"entities":[],"edges":[]}' } }],
    });
    await extractAndPersistFromTurn(input);
    const options = mockCreateToolFree.mock.calls[0][0];
    expect(options.provider).toBe('groq');
    expect(options.model).toBe(process.env.AUX_MODEL || 'openai/gpt-oss-20b');
    expect(JSON.stringify(options)).not.toMatch(/web_search|"tools"|tool_choice/);
    expect(options.trace).toEqual({ sessionId, tags: ['entity-graph-extract'] });
  });
});

describe('normalizeName', () => {
  it('lowercases and collapses whitespace — the identity key', () => {
    expect(normalizeName('Taj   Hotel')).toBe('taj hotel');
  });
});
