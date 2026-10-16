import { Types } from 'mongoose';
import { Asset } from '../../main/models/Asset';
import { AssetJob } from '../../main/models/AssetJob';
import {
  MAX_JOB_ATTEMPTS,
  claimNextAssetJob,
  enqueueAssetJob,
  requeueStaleAssetJobs,
  runAssetJobTick,
  startAssetJobPoller,
  stopAssetJobPoller,
} from '../../main/services/assetJobService';
import { STALE_PROCESSING_MS } from '../../main/services/assetJobService';
import type { AssetJobDocument } from '../../main/models/AssetJob';

// Issue #67: Mongo-backed conversion queue running against the shared
// in-memory Mongo (test/setup.ts); the beforeEach wipe empties assetJobs
// between tests.

const createAssetDoc = async (tag: string): Promise<{ userId: string; id: string }> => {
  const fakeUserId = new Types.ObjectId();
  const asset = await Asset.create({
    userId: fakeUserId,
    filename: `doc-${tag}.pdf`,
    key: `${fakeUserId}/asset/${tag}.pdf`,
    contentType: 'application/pdf',
    size: 1000,
    status: 'ready',
  });
  return { userId: asset.userId.toString(), id: String(asset._id) };
};

const latestJobFor = async (assetId: string): Promise<AssetJobDocument | null> =>
  AssetJob.findOne({ assetId }).sort({ _id: -1 });

describe('enqueueAssetJob (#67)', () => {
  it('creates one pending job per asset', async () => {
    const asset = await createAssetDoc('enqueue');
    const job = await enqueueAssetJob(asset.id);
    expect(job.status).toBe('pending');
    expect(String(job.assetId)).toBe(asset.id);
    expect(await AssetJob.countDocuments({ assetId: asset.id })).toBe(1);
  });

  it('is idempotent while a job is live (pending/processing/done)', async () => {
    const asset = await createAssetDoc('enqueue-idem');
    const first = await enqueueAssetJob(asset.id);
    expect(String((await enqueueAssetJob(asset.id))._id)).toBe(String(first._id));
    await AssetJob.updateOne({ _id: first._id }, { $set: { status: 'done' } });
    expect(String((await enqueueAssetJob(asset.id))._id)).toBe(String(first._id));
    // A terminal-failed chain gets a fresh job instead.
    await AssetJob.updateOne({ _id: first._id }, { $set: { status: 'failed' } });
    const retried = await enqueueAssetJob(asset.id);
    expect(String(retried._id)).not.toBe(String(first._id));
  });
});

describe('claimNextAssetJob (#67)', () => {
  it('claims the oldest pending job atomically and bumps attempts', async () => {
    const asset = await createAssetDoc('claim');
    const first = await enqueueAssetJob(asset.id);

    const claimed = await claimNextAssetJob();
    expect(claimed?._id).toEqual(first._id);
    expect(claimed?.status).toBe('processing');
    expect(claimed?.attempts).toBe(1);
    // A claimed job is not claimable again; the queue is empty here.
    expect(await claimNextAssetJob()).toBeNull();
  });
});

describe('runAssetJobTick (#67)', () => {
  it('marks the job done and skips when nothing is queued', async () => {
    const asset = await createAssetDoc('tick-success');
    const processor = jest.fn().mockResolvedValue(undefined);
    await runAssetJobTick(processor);
    expect(processor).not.toHaveBeenCalled();

    await enqueueAssetJob(asset.id);
    await runAssetJobTick(processor);
    expect(processor).toHaveBeenCalledTimes(1);
    const claimedJob = (processor.mock.calls[0]?.[0] ?? null) as AssetJobDocument | null;
    expect(String(claimedJob?.assetId)).toBe(asset.id);
    const job = await latestJobFor(asset.id);
    expect(job?.status).toBe('done');
  });

  it('requeues a failed attempt under the retry cap and stores lastError', async () => {
    const asset = await createAssetDoc('tick-retry');
    await enqueueAssetJob(asset.id);
    const processor = jest.fn().mockRejectedValue(new Error('boom'));
    await runAssetJobTick(processor);
    const afterFirst = await latestJobFor(asset.id);
    expect(afterFirst?.status).toBe('pending');
    expect(afterFirst?.attempts).toBe(1);
    expect(afterFirst?.lastError).toBe('boom');
    // Asset markdown state untouched until the cap is reached.
    const untouched = await Asset.findById(asset.id);
    expect(untouched?.markdownStatus).toBe('none');
  });

  it('terminal-fails at the attempt cap and flips the asset markdown status', async () => {
    const asset = await createAssetDoc('tick-cap');
    // A job only exists because a lifecycle is pending (#208: a job can also
    // stand for a thumbnail); seed the markdown lifecycle so the terminal
    // failure has something to flip.
    await Asset.updateOne({ _id: asset.id }, { $set: { markdownStatus: 'pending' } });
    await enqueueAssetJob(asset.id);
    const processor = jest.fn().mockRejectedValue(new Error('converter exploded'));
    for (let i = 0; i < MAX_JOB_ATTEMPTS; i++) {
      await runAssetJobTick(processor);
    }
    const job = await latestJobFor(asset.id);
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(MAX_JOB_ATTEMPTS);
    const stored = await AssetJob.findOne({ assetId: asset.id, status: 'pending' });
    expect(stored).toBeNull();

    const updated = await Asset.findById(asset.id);
    expect(updated?.markdownStatus).toBe('failed');
    expect(updated?.markdownFailureReason).toBe('converter exploded');
  });

  it('terminal-fails a pending thumbnail without clobbering a ready markdown (#208)', async () => {
    const asset = await createAssetDoc('tick-cap-thumb');
    await Asset.updateOne(
      { _id: asset.id },
      { $set: { markdownStatus: 'ready', thumbnailStatus: 'pending' } },
    );
    await enqueueAssetJob(asset.id);
    const processor = jest.fn().mockRejectedValue(new Error('image decode exploded'));
    for (let i = 0; i < MAX_JOB_ATTEMPTS; i++) {
      await runAssetJobTick(processor);
    }
    const updated = await Asset.findById(asset.id);
    expect(updated?.thumbnailStatus).toBe('failed');
    expect(updated?.markdownStatus).toBe('ready');
    expect(updated?.markdownFailureReason).toBeNull();
  });
});

describe('stale `processing` requeue (#67, plan Open Question C)', () => {
  const strandJob = async (assetId: string, ageMs: number): Promise<AssetJobDocument> => {
    await enqueueAssetJob(assetId);
    const claimed = await claimNextAssetJob();
    expect(claimed?.status).toBe('processing');
    if (ageMs > 0) {
      // Backdate updatedAt past the staleness cutoff. Bypass mongoose so the
      // timestamps plugin cannot rewrite the supplied value.
      await AssetJob.collection.updateOne(
        { _id: claimed?._id },
        { $set: { updatedAt: new Date(Date.now() - ageMs) } },
      );
    }
    return claimed as AssetJobDocument;
  };

  it('requeues only processing jobs older than the cutoff', async () => {
    const fresh = await createAssetDoc('stale-fresh');
    await strandJob(fresh.id, 0);
    const stale = await createAssetDoc('stale-old');
    await strandJob(stale.id, STALE_PROCESSING_MS + 1000);

    expect(await requeueStaleAssetJobs()).toBe(1);
    const freshJob = await latestJobFor(fresh.id);
    expect(freshJob?.status).toBe('processing');
    const staleJob = await latestJobFor(stale.id);
    expect(staleJob?.status).toBe('pending');
    // The sweep does not charge an attempt.
    expect(staleJob?.attempts).toBe(1);
  });

  it('a stranded processing job self-heals on the next poller start', async () => {
    const asset = await createAssetDoc('stale-heal');
    await strandJob(asset.id, STALE_PROCESSING_MS + 1000);
    // Enqueue alone is a no-op while the stranded row is "live".
    await enqueueAssetJob(asset.id);
    const processor = jest.fn().mockResolvedValue(undefined);
    // Short-lived poller start (real bootstrap hook): the fire-and-forget
    // requeue flips the stranded row to pending, the poller then claims and
    // completes it. A 'processing' row is not claimable, so the only way the
    // processor can run is via the requeue.
    startAssetJobPoller(processor, 10);
    await new Promise((r) => setTimeout(r, 60));
    stopAssetJobPoller();
    await new Promise((r) => setTimeout(r, 60));
    expect(processor).toHaveBeenCalledTimes(1);
    const healed = await latestJobFor(asset.id);
    expect(healed?.status).toBe('done');
  });
});

describe('poller lifecycle (#67)', () => {
  it('polls until stopped', async () => {
    const processor = jest.fn().mockResolvedValue(undefined);
    startAssetJobPoller(processor, 10);
    const asset = await createAssetDoc('poller');
    await enqueueAssetJob(asset.id);
    await new Promise((r) => setTimeout(r, 80));
    expect(processor.mock.calls.length).toBeGreaterThanOrEqual(1);
    stopAssetJobPoller();
    const callsAtStop = processor.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(processor.mock.calls.length).toBe(callsAtStop);
    const stopped = await latestJobFor(asset.id);
    expect(stopped?.status).toBe('done');
  });
});
