import { Types } from 'mongoose';
import { Asset } from '../models/Asset';
import {
  classifyFileIntentForEval,
  classifyFileIntentStrict,
  enrichmentLibraryBlock as enrich,
  enrichmentVotes,
  filesVoteFromReply,
  parseFilesVote,
  workspaceGateFrom,
  workspaceTraceMetadata,
  workspaceVoteFromReply,
} from './enrichmentService';

/*
 * #238: the enrichment pass. The `files` vote parser is ported verbatim from
 * the retired guard; the pass must (a) vote correctly, (b) inject the library
 * index only on a positive vote, (c) never throw, and (d) be kill-switchable.
 */

const mockCreateToolFree = jest.fn();

jest.mock('./inferenceService', () => ({
  inferenceService: {
    createToolFreeCompletion: (...args: unknown[]) => mockCreateToolFree(...args),
  },
}));

const voteResponse = (content: string) => ({
  choices: [{ message: { content } }],
});

const createAsset = async (userId: string, filename: string, status = 'ready') =>
  Asset.create({
    userId,
    filename,
    key: `key/${filename}`,
    contentType: 'text/plain',
    size: 10,
    status,
  });

describe('enrichmentService', () => {
  beforeEach(() => {
    mockCreateToolFree.mockReset();
    delete process.env.ENRICHMENT_ENABLED;
  });

  describe('parseFilesVote', () => {
    it('returns the last vote-shaped object, ignoring prose decoys', () => {
      const raw = 'Thinking... maybe {"example": 1} ... answer: {"files":"yes"} trailing';
      expect(parseFilesVote(raw)).toEqual({ files: 'yes' });
    });

    it('returns null when no object carries the files key', () => {
      expect(parseFilesVote('here: {"reasoning":"no"}')).toBeNull();
      expect(parseFilesVote('no json at all')).toBeNull();
    });
  });

  describe('filesVoteFromReply', () => {
    it('treats an explicit no as false, and any other present value as true', () => {
      expect(filesVoteFromReply('{"files":"no"}')).toBe(false);
      expect(filesVoteFromReply('{"files":"No"}')).toBe(false);
      expect(filesVoteFromReply('{"files":"yes"}')).toBe(true);
      expect(filesVoteFromReply('{"files":"maybe"}')).toBe(true);
    });

    it('treats a missing/unparseable vote as false (missing key is a no)', () => {
      expect(filesVoteFromReply('{"reasoning":"yes"}')).toBe(false);
      expect(filesVoteFromReply('garbage')).toBe(false);
    });
  });

  describe('workspaceVoteFromReply', () => {
    it('reads the workspace key with the same no-is-false posture', () => {
      expect(workspaceVoteFromReply('{"workspace":"yes"}')).toBe(true);
      expect(workspaceVoteFromReply('{"workspace":"no"}')).toBe(false);
      expect(workspaceVoteFromReply('{"files":"yes"}')).toBe(false);
      expect(workspaceVoteFromReply('garbage')).toBe(false);
    });

    it('reads both keys from the same vote object', () => {
      const raw = '{"files":"no","workspace":"yes"}';
      expect(filesVoteFromReply(raw)).toBe(false);
      expect(workspaceVoteFromReply(raw)).toBe(true);
    });
  });

  describe('enrichmentVotes', () => {
    it('returns both signals from the single aux call', async () => {
      mockCreateToolFree.mockResolvedValueOnce(voteResponse('{"files":"yes","workspace":"yes"}'));
      expect(await enrichmentVotes('what did we decide')).toEqual({
        files: true,
        workspace: true,
      });
    });

    it('degrades to both-false on failure and when disabled', async () => {
      mockCreateToolFree.mockRejectedValueOnce(new Error('boom'));
      expect(await enrichmentVotes('x')).toEqual({ files: false, workspace: false });
      process.env.ENRICHMENT_ENABLED = '0';
      mockCreateToolFree.mockClear();
      expect(await enrichmentVotes('x')).toEqual({ files: false, workspace: false });
      expect(mockCreateToolFree).not.toHaveBeenCalled();
    });

    it('marks a timeout with timedOut so it is distinguishable from a real no (#308)', async () => {
      process.env.ENRICHMENT_TIMEOUT_MS = '10';
      mockCreateToolFree.mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(voteResponse('{"workspace":"yes"}')), 200),
          ),
      );
      expect(await enrichmentVotes('x')).toEqual({
        files: false,
        workspace: false,
        timedOut: true,
      });
      delete process.env.ENRICHMENT_TIMEOUT_MS;
    });

    it('threads sessionId into the aux call trace (#308)', async () => {
      mockCreateToolFree.mockResolvedValueOnce(voteResponse('{"files":"no","workspace":"no"}'));
      await enrichmentVotes('x', [], 'abc123');
      const options = mockCreateToolFree.mock.calls[0][0] as { trace?: { sessionId?: string } };
      expect(options.trace?.sessionId).toBe('abc123');
    });

    it('omits trace.sessionId when the caller has none (#308)', async () => {
      mockCreateToolFree.mockResolvedValueOnce(voteResponse('{"files":"no","workspace":"no"}'));
      await enrichmentVotes('x');
      const options = mockCreateToolFree.mock.calls[0][0] as { trace?: { sessionId?: string } };
      expect(options.trace?.sessionId).toBeUndefined();
    });
  });

  describe('workspace trace facts (#308)', () => {
    it('maps skip / kill switch / memory-disabled to off', () => {
      const votes = { files: false, workspace: true };
      expect(workspaceGateFrom(votes, true)).toBe('off');
      process.env.ENRICHMENT_ENABLED = '0';
      expect(workspaceGateFrom(votes, false)).toBe('off');
      delete process.env.ENRICHMENT_ENABLED;
      process.env.WORKSPACE_MEMORY_ENABLED = '0';
      expect(workspaceGateFrom(votes, false)).toBe('off');
      delete process.env.WORKSPACE_MEMORY_ENABLED;
    });

    it('maps a timeout to timeout and the vote to yes/no', () => {
      process.env.WORKSPACE_MEMORY_ENABLED = '1';
      expect(workspaceGateFrom({ files: false, workspace: false, timedOut: true }, false)).toBe(
        'timeout',
      );
      expect(workspaceGateFrom({ files: false, workspace: true }, false)).toBe('yes');
      expect(workspaceGateFrom({ files: false, workspace: false }, false)).toBe('no');
      delete process.env.WORKSPACE_MEMORY_ENABLED;
    });

    it('renders flat namespaced metadata with the block slice count', () => {
      expect(
        workspaceTraceMetadata('yes', '- chat "a" (2026-01-01) — x\n- chat "b" (2026-01-02) — y'),
      ).toEqual({
        tova_workspace_gate: 'yes',
        tova_workspace_hits: 2,
      });
      expect(workspaceTraceMetadata('no', '')).toEqual({
        tova_workspace_gate: 'no',
        tova_workspace_hits: 0,
      });
    });
  });

  describe('classifyFileIntentStrict / classifyFileIntentForEval (T15b)', () => {
    it('strict rethrows a provider failure instead of swallowing it', async () => {
      mockCreateToolFree.mockRejectedValueOnce(new Error('429'));
      await expect(classifyFileIntentStrict('x')).rejects.toThrow('429');
    });

    it('probe reports an error outcome on a thrown call', async () => {
      mockCreateToolFree.mockRejectedValueOnce(new Error('429'));
      expect(await classifyFileIntentForEval('x')).toEqual({ outcome: 'error' });
    });

    it('probe reports an ok outcome with both votes', async () => {
      mockCreateToolFree.mockResolvedValueOnce(voteResponse('{"files":"no","workspace":"yes"}'));
      expect(await classifyFileIntentForEval('x')).toEqual({
        outcome: 'ok',
        files: false,
        workspace: true,
      });
    });

    it('probe reports a timeout when the cap fires', async () => {
      mockCreateToolFree.mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(voteResponse('{"workspace":"yes"}')), 200),
          ),
      );
      expect(await classifyFileIntentForEval('x', [], 10)).toEqual({ outcome: 'timeout' });
    });
  });

  describe('enrichmentLibraryBlock', () => {
    it('injects the library index on a positive vote', async () => {
      const userId = String(new Types.ObjectId());
      await createAsset(userId, 'CV.pdf');
      mockCreateToolFree.mockResolvedValueOnce(voteResponse('{"files":"yes"}'));
      const block = await enrich('summarise my CV', [], userId);
      expect(block).toContain('CV.pdf');
    });

    it('returns no block on a negative vote (no library read)', async () => {
      const userId = String(new Types.ObjectId());
      await createAsset(userId, 'CV.pdf');
      mockCreateToolFree.mockResolvedValueOnce(voteResponse('{"files":"no"}'));
      expect(await enrich('what is 2+2', [], userId)).toBe('');
    });

    it('returns no block when the library is empty', async () => {
      const userId = String(new Types.ObjectId());
      mockCreateToolFree.mockResolvedValueOnce(voteResponse('{"files":"yes"}'));
      expect(await enrich('summarise my CV', [], userId)).toBe('');
    });

    it('never throws when the aux call fails', async () => {
      const userId = String(new Types.ObjectId());
      mockCreateToolFree.mockRejectedValueOnce(new Error('boom'));
      expect(await enrich('summarise my CV', [], userId)).toBe('');
    });

    it('is disabled by ENRICHMENT_ENABLED=0 without calling the model', async () => {
      process.env.ENRICHMENT_ENABLED = '0';
      const userId = String(new Types.ObjectId());
      await createAsset(userId, 'CV.pdf');
      expect(await enrich('summarise my CV', [], userId)).toBe('');
      expect(mockCreateToolFree).not.toHaveBeenCalled();
    });

    it('degrades to no block when the aux call exceeds the timeout', async () => {
      process.env.ENRICHMENT_TIMEOUT_MS = '10';
      const userId = String(new Types.ObjectId());
      await createAsset(userId, 'CV.pdf');
      mockCreateToolFree.mockImplementationOnce(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(voteResponse('{"files":"yes"}')), 200)),
      );
      expect(await enrich('summarise my CV', [], userId)).toBe('');
      delete process.env.ENRICHMENT_TIMEOUT_MS;
    });
  });
});
