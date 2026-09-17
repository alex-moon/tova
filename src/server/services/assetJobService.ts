import type { Types } from 'mongoose';
import { Asset } from '../models/Asset';
import { AssetJob, type AssetJobDocument } from '../models/AssetJob';

// Mongo-backed conversion queue (issue #67): enqueue is idempotent per
// "live" job, the poller claims one pending job atomically per tick, and
// failures retry up to MAX_JOB_ATTEMPTS before terminal-failing the job and
// the asset's markdown status. The processor is injectable so tests (and a
// later iteration's conversion service) can supply the real converter.

export const MAX_JOB_ATTEMPTS = 3;

const POLL_INTERVAL_MS = 5000;

const MAX_STORED_ERROR_CHARS = 500;

export type AssetJobProcessor = (job: AssetJobDocument) => Promise<void>;

const clampError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_STORED_ERROR_CHARS);
};

// Idempotent enqueue: a pending/processing/done job for the asset is reused
// (enqueue only matters while the asset's markdownStatus is 'pending');
// a previously failed chain gets a fresh job.
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

// Atomic claim: status + attempts bump in one findOneAndUpdate, sorted
// oldest-pending-first. Single consumer in-process; multiple server
// processes would still not double-claim the same row.
export const claimNextAssetJob = async (): Promise<AssetJobDocument | null> =>
  AssetJob.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'processing' }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  );

// One poll tick: claim a job, run the processor, and settle the outcome.
// Processor failures retry until MAX_JOB_ATTEMPTS attempts have been made,
// at which point the job terminal-fails and the asset's markdown status flips
// to 'failed' (the asset itself stays 'ready' — the original binary is fine).
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
      await Asset.updateOne(
        { _id: job.assetId },
        {
          $set: {
            markdownStatus: 'failed',
            markdownFailureReason: message,
          },
        },
      );
    }
  }
};

let timer: ReturnType<typeof setInterval> | null = null;

let busy = false;

// A server crash mid-job leaves a `processing` row stranded forever, which
// also blocks enqueueAssetJob (a live-status job is reused). At poller start
// such jobs older than STALE_PROCESSING_MS are requeued as `pending` so a
// restart self-heals; updatedAt (bumped by the claim and by timestamps) is
// the staleness clock. Attempts are not incremented — the sweep does not
// count against the retry cap because the processor never observed the loss.
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
    // One job per tick; skip ticks while the previous processor run is still
    // in flight so slow conversions don't stack up queries.
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

export const isAssetJobPollerRunning = (): boolean => timer !== null;
