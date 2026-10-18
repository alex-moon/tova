import type { Types } from 'mongoose';
import { Asset } from '../models/Asset';
import { AssetJob, type AssetJobDocument } from '../models/AssetJob';

/* Mongo-backed conversion queue with idempotent enqueue and atomic claim. */
// @see #67

export const MAX_JOB_ATTEMPTS = 3;

const POLL_INTERVAL_MS = 5000;

const MAX_STORED_ERROR_CHARS = 500;

export type AssetJobProcessor = (job: AssetJobDocument) => Promise<void>;

const clampError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_STORED_ERROR_CHARS);
};

// Idempotent enqueue: a live-status job is reused; a failed chain gets fresh.
export const enqueueAssetJob = async (
  assetId: Types.ObjectId | string,
): Promise<AssetJobDocument> => {
  const existing = await AssetJob.findOne({
    assetId,
    status: { $in: ['pending', 'processing', 'done'] },
  });
  if (existing) return existing;
  return AssetJob.create({ assetId });
};

// Atomic claim: one findOneAndUpdate; concurrent servers cannot double-claim.
export const claimNextAssetJob = async (): Promise<AssetJobDocument | null> =>
  AssetJob.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'processing' }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  );

// One poll tick: claim, run, settle; exhausted jobs terminal-fail.
export const runAssetJobTick = async (processor: AssetJobProcessor): Promise<void> => {
  const job = await claimNextAssetJob();
  if (!job) return;
  try {
    await processor(job);
    job.status = 'done';
    await job.save();
  } catch (err) {
    const message = clampError(err);
    const exhausted = job.attempts >= MAX_JOB_ATTEMPTS;
    await AssetJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: exhausted ? 'failed' : 'pending',
          lastError: message,
        },
      },
    );
    if (exhausted) {
      // Fail only lifecycles the processor did not finish.
      await Asset.updateOne(
        { _id: job.assetId, markdownStatus: 'pending' },
        { $set: { markdownStatus: 'failed', markdownFailureReason: message } },
      );
      await Asset.updateOne(
        { _id: job.assetId, thumbnailStatus: 'pending' },
        { $set: { thumbnailStatus: 'failed' } },
      );
    }
  }
};

let timer: ReturnType<typeof setInterval> | null = null;

let busy = false;

// A crash strands a `processing` row; the start sweep requeues stale ones.
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

export const requeueStaleAssetJobs = async (
  maxAgeMs: number = STALE_PROCESSING_MS,
): Promise<number> => {
  const result = await AssetJob.updateMany(
    { status: 'processing', updatedAt: { $lt: new Date(Date.now() - maxAgeMs) } },
    { $set: { status: 'pending' } },
  );
  return result.modifiedCount ?? 0;
};

export const startAssetJobPoller = (
  processor: AssetJobProcessor,
  intervalMs = POLL_INTERVAL_MS,
): ReturnType<typeof setInterval> => {
  if (timer) return timer;
  void requeueStaleAssetJobs().catch(() => undefined);
  timer = setInterval(() => {
    // One job per tick; skip while the previous run is still in flight.
    if (busy) return;
    busy = true;
    void runAssetJobTick(processor).finally(() => {
      busy = false;
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
};

export const stopAssetJobPoller = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
