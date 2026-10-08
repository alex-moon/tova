import { Types } from 'mongoose';
import { Asset } from '../models/Asset';
import {
  enrichmentLibraryBlock as enrich,
  filesVoteFromReply,
  parseFilesVote,
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
