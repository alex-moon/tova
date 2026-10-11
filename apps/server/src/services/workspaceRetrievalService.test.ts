import { Types } from 'mongoose';
import { Asset } from '../models/Asset';
import { Message } from '../models/Message';
import { Session } from '../models/Session';
import {
  buildWorkspaceBlock,
  isWorkspaceMemoryEnabled,
  pickTopSlices,
  retrieveWorkspaceBlock,
  scoreSlice,
  type WorkspaceSlice,
} from './workspaceRetrievalService';

/*
 * #253: workspace memory retrieval. Scoring is pure; the Mongo-backed read
 * joins messages to their session titles and never throws; the block is capped
 * and empty-on-nothing.
 */

const slice = (over: Partial<WorkspaceSlice> = {}): WorkspaceSlice => ({
  kind: 'chat',
  id: 'x',
  title: 'Budget chat',
  text: 'we agreed the budget for the move is twelve thousand',
  at: new Date(),
  ...over,
});

describe('workspaceRetrievalService', () => {
  describe('scoreSlice', () => {
    it('scores zero on no keyword overlap even for a fresh slice', () => {
      expect(scoreSlice('unrelated question about birds', slice())).toBe(0);
    });

    it('scores overlap, with recency only reordering equals', () => {
      const fresh = scoreSlice('budget', slice({ at: new Date() }));
      const stale = scoreSlice('budget', slice({ at: new Date('2020-01-01') }));
      expect(fresh).toBeGreaterThan(stale);
      expect(scoreSlice('budget', slice())).toBeGreaterThan(0);
    });

    it('returns zero for an all-stopword prompt', () => {
      expect(scoreSlice('the a of', slice())).toBe(0);
    });
  });

  describe('pickTopSlices', () => {
    it('drops zero-score slices and ranks by score', () => {
      const picks = pickTopSlices('budget for the move', [
        slice({ id: 'a', text: 'budget move' }),
        slice({ id: 'b', text: 'unrelated birdwatching notes' }),
        slice({ id: 'c', text: 'budget' }),
      ]);
      expect(picks.map((p) => p.slice.id)).toEqual(['a', 'c']);
    });

    it('caps the number of picks', () => {
      const many = Array.from({ length: 20 }, (_, i) => slice({ id: String(i) }));
      expect(pickTopSlices('budget', many, 3)).toHaveLength(3);
    });
  });

  describe('buildWorkspaceBlock', () => {
    it('returns empty when nothing overlaps (no prompt drift)', () => {
      expect(buildWorkspaceBlock('birds', [slice()])).toBe('');
    });

    it('renders one labelled line per picked slice', () => {
      const block = buildWorkspaceBlock('budget', [slice({ title: 'Move planning' })]);
      expect(block).toContain('chat "Move planning"');
      expect(block).toContain('budget');
    });

    it('labels file slices as files', () => {
      const block = buildWorkspaceBlock('lease', [
        slice({ kind: 'file', title: 'lease.pdf', text: 'the lease has a pets clause' }),
      ]);
      expect(block).toContain('file "lease.pdf"');
    });

    it('honours the character cap', () => {
      const long = slice({ text: 'budget '.repeat(400) });
      const withCap = buildWorkspaceBlock('budget', [long], 6, 80);
      const withoutCap = buildWorkspaceBlock('budget', [long], 6, 10000);
      expect(withCap.length).toBeLessThanOrEqual(80);
      expect(withoutCap.length).toBeGreaterThan(80);
    });
  });

  describe('isWorkspaceMemoryEnabled', () => {
    afterEach(() => {
      delete process.env.WORKSPACE_MEMORY_ENABLED;
    });

    it('defaults off and is kill-switchable', () => {
      expect(isWorkspaceMemoryEnabled()).toBe(false);
      process.env.WORKSPACE_MEMORY_ENABLED = '1';
      expect(isWorkspaceMemoryEnabled()).toBe(true);
      process.env.WORKSPACE_MEMORY_ENABLED = 'false';
      expect(isWorkspaceMemoryEnabled()).toBe(false);
    });
  });

  describe('retrieveWorkspaceBlock', () => {
    it('retrieves matching user messages and never leaks another user', async () => {
      const userId = String(new Types.ObjectId());
      const other = String(new Types.ObjectId());
      const session = await Session.create({ userId, title: 'Move' });
      const otherSession = await Session.create({ userId: other, title: 'Secret' });
      await Message.create({
        sessionId: session._id,
        role: 'user',
        content: 'the moving budget is twelve thousand',
      });
      await Message.create({
        sessionId: otherSession._id,
        role: 'user',
        content: 'the moving budget is nine million secret',
      });

      const block = await retrieveWorkspaceBlock('what did we say about the budget', userId);
      expect(block).toContain('Move');
      expect(block).not.toContain('Secret');
      expect(block).not.toContain('nine million');
    });

    it('includes extracted asset text', async () => {
      const userId = String(new Types.ObjectId());
      await Asset.create({
        userId,
        filename: 'notes.txt',
        key: 'k',
        contentType: 'text/plain',
        size: 1,
        status: 'ready',
        textExtracted: 'the lease pets clause allows one cat',
      });
      const block = await retrieveWorkspaceBlock('lease pets clause', userId);
      expect(block).toContain('notes.txt');
    });

    it('returns empty when nothing overlaps and never throws', async () => {
      const userId = String(new Types.ObjectId());
      expect(await retrieveWorkspaceBlock('birds', userId)).toBe('');
      expect(await retrieveWorkspaceBlock('birds', 'not-an-object-id')).toBe('');
    });
  });
});
