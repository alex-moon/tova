import { Types } from 'mongoose';
import { Asset } from '../models/Asset';
import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { Task } from '../models/Task';
import { TaskEvent } from '../models/TaskEvent';
import {
  buildWorkspaceBlock,
  isWorkspaceMemoryEnabled,
  matchSnippet,
  pickTopSlices,
  promptWords,
  retrieveWorkspaceBlock,
  rrfFuse,
  scoreSlice,
  taskTitle,
  vectorCandidates,
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
  describe('promptWords', () => {
    it('keeps content words and drops stopwords and single characters', () => {
      const words = promptWords('Give me recommendations for restaurants near the hotel');
      expect(words.has('restaurants')).toBe(true);
      expect(words.has('hotel')).toBe(true);
      expect(words.has('the')).toBe(false);
      expect(words.has('near')).toBe(false);
      expect(words.has('me')).toBe(false);
      expect(words.has('a')).toBe(false);
    });
  });

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

  describe('matchSnippet', () => {
    it('returns short text unchanged', () => {
      expect(matchSnippet('the lease has a pets clause', 'pets')).toBe(
        'the lease has a pets clause',
      );
    });

    it('centres a long text on the first matched keyword', () => {
      const text = `${'intro '.repeat(200)}pets clause ${'outro '.repeat(200)}`;
      const snippet = matchSnippet(text, 'pets clause', 80);
      expect(snippet.length).toBeLessThanOrEqual(80);
      expect(snippet).toContain('pets clause');
      expect(snippet.startsWith('…')).toBe(true);
    });

    it('falls back to the head when the match is at the very start', () => {
      const text = `pets ${'tail '.repeat(200)}`;
      const snippet = matchSnippet(text, 'pets', 40);
      expect(snippet.length).toBeLessThanOrEqual(40);
      expect(snippet.startsWith('pets')).toBe(true);
    });

    it('never exceeds the cap for any match position', () => {
      const text = `alpha ${'filler '.repeat(100)} omega`;
      for (const cap of [10, 20, 40, 80, 160]) {
        for (const prompt of ['alpha', 'omega', 'filler']) {
          expect(matchSnippet(text, prompt, cap).length).toBeLessThanOrEqual(cap);
        }
      }
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

    it('shows the matched region of a long slice, not just its head', () => {
      const text = `${'intro '.repeat(300)}the pets clause allows one cat`;
      const block = buildWorkspaceBlock('pets clause', [
        slice({ kind: 'file', title: 'lease.pdf', text }),
      ]);
      expect(block).toContain('pets clause allows one cat');
    });

    it('labels file slices as files', () => {
      const block = buildWorkspaceBlock('lease', [
        slice({ kind: 'file', title: 'lease.pdf', text: 'the lease has a pets clause' }),
      ]);
      expect(block).toContain('file "lease.pdf"');
    });

    it('labels task slices as tasks (#298)', () => {
      const block = buildWorkspaceBlock('budget', [
        slice({
          kind: 'task',
          title: 'Plan the move',
          text: 'the moving budget is twelve thousand',
        }),
      ]);
      expect(block).toContain('task "Plan the move"');
    });

    it('honours the character cap', () => {
      const long = slice({ text: 'budget '.repeat(400) });
      const withCap = buildWorkspaceBlock('budget', [long], 6, 80);
      const withoutCap = buildWorkspaceBlock('budget', [long], 6, 10000);
      expect(withCap.length).toBeLessThanOrEqual(80);
      expect(withoutCap.length).toBeGreaterThan(80);
    });

    it('counts joining newlines against the cap (multi-slice)', () => {
      const many = Array.from({ length: 6 }, (_, i) =>
        slice({ id: String(i), title: `Move ${i}`, text: 'budget is twelve thousand' }),
      );
      for (const cap of [40, 80, 120, 200, 400]) {
        expect(buildWorkspaceBlock('budget', many, 6, cap).length).toBeLessThanOrEqual(cap);
      }
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

  describe('taskTitle (#298)', () => {
    it('collapses whitespace and falls back when empty', () => {
      expect(taskTitle('  Plan   the move\nover the weekend  ')).toBe(
        'Plan the move over the weekend',
      );
      expect(taskTitle('')).toBe('Untitled task');
      expect(taskTitle('   ')).toBe('Untitled task');
    });

    it('caps a long instruction with an ellipsis', () => {
      const title = taskTitle('x'.repeat(200));
      expect(title.length).toBeLessThanOrEqual(60);
      expect(title.endsWith('…')).toBe(true);
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

    it('is not starved by a busier other user (pool scoped session-first)', async () => {
      // Regression: a global newest-first message scan would fill the window
      // with `other`'s flood, leaving this user's own history out entirely.
      const userId = String(new Types.ObjectId());
      const other = String(new Types.ObjectId());
      const session = await Session.create({ userId, title: 'Move' });
      await Message.create({
        sessionId: session._id,
        role: 'user',
        content: 'the moving budget is twelve thousand',
        timestamp: new Date('2020-01-01'),
      });
      const otherSession = await Session.create({ userId: other, title: 'Noise' });
      await Message.insertMany(
        Array.from({ length: 30 }, () => ({
          sessionId: otherSession._id,
          role: 'user',
          content: 'the budget budget budget filler',
          timestamp: new Date(),
        })),
      );

      const block = await retrieveWorkspaceBlock('what did we say about the budget', userId);
      expect(block).toContain('Move');
      expect(block).toContain('twelve thousand');
      expect(block).not.toContain('filler');
    });

    it('excludes the just-saved current turn from the corpus', async () => {
      const userId = String(new Types.ObjectId());
      const session = await Session.create({ userId, title: 'Move' });
      const current = await Message.create({
        sessionId: session._id,
        role: 'user',
        content: 'the moving budget is twelve thousand',
        timestamp: new Date(),
      });
      await Message.create({
        sessionId: session._id,
        role: 'user',
        content: 'earlier we set the moving budget at nine thousand',
        timestamp: new Date(Date.now() - 60_000),
      });

      const block = await retrieveWorkspaceBlock(
        'what did we say about the budget',
        userId,
        undefined,
        String(current._id),
      );
      expect(block).not.toContain('twelve thousand');
      expect(block).toContain('nine thousand');
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

    it('excludes ephemeral (ZDR) assets from the corpus entirely', async () => {
      const userId = String(new Types.ObjectId());
      await Asset.create({
        userId,
        filename: 'throwaway.txt',
        key: 'k',
        contentType: 'text/plain',
        size: 1,
        status: 'ready',
        ephemeral: true,
        textExtracted: 'the lease pets clause allows one cat',
      });
      const block = await retrieveWorkspaceBlock('lease pets clause', userId);
      expect(block).not.toContain('throwaway.txt');
      expect(block).not.toContain('one cat');
    });

    it('retrieves task work from the task stream (#298)', async () => {
      const userId = String(new Types.ObjectId());
      const task = await Task.create({
        userId,
        instruction: 'Plan the move budget',
        budget: { maxSteps: 25, maxCostUsd: 5 },
      });
      await TaskEvent.create({
        taskId: task._id,
        seq: 0,
        role: 'user',
        content: 'Plan the move budget',
      });
      await TaskEvent.create({
        taskId: task._id,
        seq: 1,
        role: 'assistant',
        content: 'the moving budget is twelve thousand',
      });

      const block = await retrieveWorkspaceBlock('what was the moving budget', userId);
      expect(block).toContain('task "Plan the move budget"');
      expect(block).toContain('twelve thousand');
    });

    it('never leaks another user\u2019s tasks (#298)', async () => {
      const userId = String(new Types.ObjectId());
      const other = String(new Types.ObjectId());
      const otherTask = await Task.create({
        userId: other,
        instruction: 'Secret budget',
        budget: { maxSteps: 25, maxCostUsd: 5 },
      });
      await TaskEvent.create({
        taskId: otherTask._id,
        seq: 0,
        role: 'assistant',
        content: 'the secret moving budget is nine million',
      });

      const block = await retrieveWorkspaceBlock('what was the moving budget', userId);
      expect(block).not.toContain('nine million');
      expect(block).not.toContain('Secret budget');
    });

    it('skips system notices and drops tasks with no content (#298)', async () => {
      const userId = String(new Types.ObjectId());
      const empty = await Task.create({
        userId,
        instruction: 'Empty task',
        budget: { maxSteps: 25, maxCostUsd: 5 },
      });
      await TaskEvent.create({
        taskId: empty._id,
        seq: 0,
        role: 'system',
        content: 'Task paused: budget reached.',
      });
      const real = await Task.create({
        userId,
        instruction: 'Real task',
        budget: { maxSteps: 25, maxCostUsd: 5 },
      });
      await TaskEvent.create({
        taskId: real._id,
        seq: 0,
        role: 'assistant',
        content: 'the moving budget is twelve thousand',
      });

      const block = await retrieveWorkspaceBlock('what was the moving budget', userId);
      expect(block).toContain('task "Real task"');
      expect(block).not.toContain('Empty task');
      expect(block).not.toContain('budget reached');
    });

    it("excludes the current turn's attached asset (not past work)", async () => {
      const userId = String(new Types.ObjectId());
      const attached = await Asset.create({
        userId,
        filename: 'lease.pdf',
        key: 'k',
        contentType: 'application/pdf',
        size: 1,
        status: 'ready',
        textExtracted: 'the lease pets clause allows one cat',
      });
      await Asset.create({
        userId,
        filename: 'old-lease.pdf',
        key: 'k2',
        contentType: 'application/pdf',
        size: 1,
        status: 'ready',
        textExtracted: 'the earlier lease pets clause allowed two cats',
      });
      const block = await retrieveWorkspaceBlock(
        'lease pets clause',
        userId,
        undefined,
        undefined,
        String(attached._id),
      );
      expect(block).not.toContain('file "lease.pdf"');
      expect(block).toContain('file "old-lease.pdf"');
    });

    it('returns empty when nothing overlaps and never throws', async () => {
      const userId = String(new Types.ObjectId());
      expect(await retrieveWorkspaceBlock('birds', userId)).toBe('');
      expect(await retrieveWorkspaceBlock('birds', 'not-an-object-id')).toBe('');
    });
  });

  /*
   * #294, task 8: the semantic stage is the one non-unit-testable piece
   * (`$vectorSearch` is Atlas-only). These tests inject `embed`/`search` so the
   * degradation contract — every failure path returns `[]`, never throws — is
   * pinned in CI. No test makes a provider call.
   */
  describe('vectorCandidates (#294)', () => {
    const query = 'what do you know about my partner';

    it('embeds the query and returns the injected search hits', async () => {
      const embed = jest.fn(async () => [[0.1, 0.2, 0.3]]);
      const search = jest.fn(async () => [{ sourceId: 'a', score: 0.9 }]);
      const hits = await vectorCandidates(query, 'user', 'model-x', 6, { embed, search });
      expect(embed).toHaveBeenCalledWith([query]);
      expect(search).toHaveBeenCalledTimes(1);
      expect(hits).toEqual([{ sourceId: 'a', score: 0.9 }]);
    });

    it('sizes the ANN window with headroom (floor 100)', async () => {
      const search = jest.fn(async () => []);
      await vectorCandidates(query, 'user', 'model-x', 6, { embed: async () => [[1]], search });
      expect(search.mock.calls[0][0]).toMatchObject({ limit: 100, numCandidates: 100 });
    });

    it('grows the ANN window with n so numCandidates stays >= limit', async () => {
      const search = jest.fn(async () => []);
      await vectorCandidates(query, 'user', 'model-x', 100, { embed: async () => [[1]], search });
      expect(search.mock.calls[0][0]).toMatchObject({ limit: 400, numCandidates: 400 });
    });

    it('degrades to [] when the embed throws (e.g. missing key)', async () => {
      const search = jest.fn();
      const hits = await vectorCandidates(query, 'user', 'model-x', 6, {
        embed: async () => {
          throw new Error('DEEPINFRA_API_KEY is not configured');
        },
        search,
      });
      expect(hits).toEqual([]);
      expect(search).not.toHaveBeenCalled();
    });

    it('degrades to [] when the search throws (index absent / unavailable)', async () => {
      const hits = await vectorCandidates(query, 'user', 'model-x', 6, {
        embed: async () => [[1]],
        search: async () => {
          throw new Error('$vectorSearch is not allowed');
        },
      });
      expect(hits).toEqual([]);
    });

    it('degrades to [] on timeout without waiting for the stage', async () => {
      const hits = await vectorCandidates(query, 'user', 'model-x', 6, {
        embed: () => new Promise<number[][]>(() => {}),
        timeoutMs: 10,
      });
      expect(hits).toEqual([]);
    });

    it('returns [] without searching when the query vector is empty', async () => {
      const search = jest.fn();
      const hits = await vectorCandidates(query, 'user', 'model-x', 6, {
        embed: async () => [[]],
        search,
      });
      expect(hits).toEqual([]);
      expect(search).not.toHaveBeenCalled();
    });
  });

  /*
   * #294, task 9: reciprocal rank fusion. Pure, so every branch is unit-tested
   * with hand-built rankings.
   */
  describe('rrfFuse (#294)', () => {
    const a = slice({ id: 'a', at: new Date('2024-01-01') });
    const b = slice({ id: 'b', at: new Date('2024-01-02') });
    const c = slice({ id: 'c', at: new Date('2024-01-03') });
    const slices = [a, b, c];

    it('a document in both rankings beats a document in only one', () => {
      const bm25 = [
        { slice: a, score: 9 },
        { slice: b, score: 8 },
      ];
      const vector = [
        { sourceId: 'a', score: 0.9 },
        { sourceId: 'c', score: 0.8 },
      ];
      // a: 1/61 + 1/61; b: 1/62; c: 1/62.
      const fused = rrfFuse(slices, bm25, vector);
      expect(fused[0].id).toBe('a');
      expect(
        fused
          .slice(1)
          .map((s) => s.id)
          .sort(),
      ).toEqual(['b', 'c']);
    });

    it('includes a vector-only hit and can outrank a lower BM25-only hit', () => {
      const bm25 = [
        { slice: a, score: 9 },
        { slice: b, score: 8 },
      ];
      const vector = [{ sourceId: 'c', score: 0.9 }];
      // a: 1/61; c: 1/61; b: 1/62 — c (vector-only) outranks b (bm25 #2).
      const fused = rrfFuse(slices, bm25, vector);
      expect(fused.findIndex((s) => s.id === 'c')).toBeLessThan(
        fused.findIndex((s) => s.id === 'b'),
      );
    });

    it('drops a vector hit whose sourceId is not in the collected set', () => {
      const vector = [{ sourceId: 'ghost', score: 0.99 }];
      expect(rrfFuse(slices, [], vector)).toEqual([]);
    });

    it('weights change the order', () => {
      const bm25 = [{ slice: a, score: 9 }];
      const vector = [{ sourceId: 'b', score: 0.9 }];
      // Equal weight: a and b tie on score, tiebreak by `at` desc -> b (newer).
      expect(rrfFuse(slices, bm25, vector)[0].id).toBe('b');
      expect(rrfFuse(slices, bm25, vector, { bm25: 5, vector: 1 })[0].id).toBe('a');
      expect(rrfFuse(slices, bm25, vector, { bm25: 1, vector: 5 })[0].id).toBe('b');
    });

    it('is deterministic: equal score falls back to at desc', () => {
      const older = slice({ id: 'older', at: new Date('2024-01-01') });
      const newer = slice({ id: 'newer', at: new Date('2024-01-02') });
      const fused = rrfFuse(
        [older, newer],
        [{ slice: older, score: 1 }],
        [{ sourceId: 'newer', score: 1 }],
      );
      expect(fused.map((s) => s.id)).toEqual(['newer', 'older']);
    });

    it('breaks a same-score same-time tie by id ascending', () => {
      const x = slice({ id: 'x', at: new Date('2024-01-01') });
      const y = slice({ id: 'y', at: new Date('2024-01-01') });
      const fused = rrfFuse(
        [y, x],
        [
          { slice: x, score: 9 },
          { slice: y, score: 8 },
        ],
        [
          { sourceId: 'y', score: 0.9 },
          { sourceId: 'x', score: 0.8 },
        ],
      );
      // x: 1/61 + 1/62; y: 1/62 + 1/61 -> equal; same `at` -> id asc -> x.
      expect(fused.map((s) => s.id)).toEqual(['x', 'y']);
    });

    it('is safe on empty inputs', () => {
      expect(rrfFuse(slices, [], [])).toEqual([]);
      expect(rrfFuse([], [], [])).toEqual([]);
    });

    it('matches a hand-computed RRF score', () => {
      // k=60, weights 1/1. a is bm25 #1 and vector #2; b is bm25 #2 and vector #1.
      const bm25 = [
        { slice: a, score: 9 },
        { slice: b, score: 8 },
      ];
      const vector = [
        { sourceId: 'b', score: 0.9 },
        { sourceId: 'a', score: 0.8 },
      ];
      // a: 1/61 + 1/62; b: 1/62 + 1/61 -> equal; tiebreak at desc -> b (newer).
      const fused = rrfFuse(slices, bm25, vector);
      expect(fused.slice(0, 2).map((s) => s.id)).toEqual(['b', 'a']);
    });
  });
});
