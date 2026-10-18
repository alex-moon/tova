import { randomUUID } from 'crypto';
import type { Types } from 'mongoose';
import { Asset } from '../models/Asset';
import { AssetJob, type AssetJobDocument } from '../models/AssetJob';
import { redactForLog } from './logRedaction';

/* Mongo-backed conversion queue with idempotent enqueue and atomic claim. */
// @see #67 #396

export const MAX_JOB_ATTEMPTS = 3;

const POLL_INTERVAL_MS = 5000;

const MAX_STORED_ERROR_CHARS = 500;

// Terminal rows stick around for debugging, then the TTL index reclaims them.
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The sweep cutoff is 5 min, so a 60s heartbeat keeps live jobs safe.
const HEARTBEAT_MS = 60_000;

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
// The lease token is rotated per claim so a stale twin cannot settle its run.
// @see #396
export const claimNextAssetJob = async (): Promise<AssetJobDocument | null> =>
  AssetJob.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'processing', leaseToken: randomUUID() }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  );

// One poll tick: claim, run, settle; exhausted jobs terminal-fail.
// Settles are guarded by the claim lease — a job swept mid-run cannot write.
// @see #396
export const runAssetJobTick = async (processor: AssetJobProcessor): Promise<void> => {
  let job: AssetJobDocument | null;
  try {
    job = await claimNextAssetJob();
  } catch (err) {
    console.error('Asset job claim error:', redactForLog(err));
    return;
  }
  if (!job) return;
  const lease = job.leaseToken ?? '';
  const leaseFilter = { _id: job._id, leaseToken: lease, status: 'processing' as const };
  // A long legitimate step must not look dead to the stale sweep.
  const heartbeat = setInterval(() => {
    void AssetJob.updateOne(leaseFilter, { $set: { updatedAt: new Date() } }).catch(
      () => undefined,
    );
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    await processor(job);
    const settled = await AssetJob.updateOne(leaseFilter, {
      $set: { status: 'done', expiresAt: new Date(Date.now() + JOB_TTL_MS) },
    });
    if (!settled.modifiedCount) return;
  } catch (err) {
    clearInterval(heartbeat);
    const message = clampError(err);
    const exhausted = job.attempts >= MAX_JOB_ATTEMPTS;
    const settled = await AssetJob.updateOne(leaseFilter, {
      $set: {
        status: exhausted ? 'failed' : 'pending',
        lastError: message,
        ...(exhausted ? { expiresAt: new Date(Date.now() + JOB_TTL_MS) } : {}),
      },
    });
    if (!settled.modifiedCount) return;
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
  } finally {
    clearInterval(heartbeat);
  }
};

let timer: ReturnType<typeof setInterval> | null = null;

let busy = false;

// A crash strands a `processing` row; the start sweep requeues stale ones.
// The sweep charges an attempt so a poison job cannot restart forever, and
// terminal-fails jobs already at the cap.
// @see #396
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

export const requeueStaleAssetJobs = async (
  maxAgeMs: number = STALE_PROCESSING_MS,
): Promise<number> => {
  const cutoff = new Date(Date.now() - maxAgeMs);
  await AssetJob.updateMany(
    { status: 'processing', attempts: { $gte: MAX_JOB_ATTEMPTS }, updatedAt: { $lt: cutoff } },
    { $set: { status: 'failed', expiresAt: new Date(Date.now() + JOB_TTL_MS) } },
  );
  const result = await AssetJob.updateMany(
    { status: 'processing', updatedAt: { $lt: cutoff } },
    { $set: { status: 'pending', leaseToken: null }, $inc: { attempts: 1 } },
  );
  return result.modifiedCount ?? 0;
};

export const startAssetJobPoller = (
  processor: AssetJobProcessor,
  intervalMs = POLL_INTERVAL_MS,
): ReturnType<typeof setInterval> => {
  if (timer) return timer;
  void requeueStaleAssetJobs().catch((err: unknown) => {
    console.error('Asset job boot sweep error:', redactForLog(err));
  });
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
