import { ModelErrorStat } from '../models/ModelErrorStat';
import type { ProviderName } from './modelConfigService';
import { redactForLog, redactString } from './logRedaction';

/*
 * #168 diagnostics (Alex, 2026-09-26): per-model errors grouped by status
 * code/message. Records every non-abort completion endpoint failure —
 * including the 429/413/mid-stream shapes the cool-off deliberately does
 * NOT disable on — so real connector error shapes accumulate in Mongo and
 * survive deploys, unlike the logs. Classification decisions elsewhere are
 * unchanged; this is write-only observation.
 */

// Diagnostics render in admin and must not persist prompt-shaped content:
// both the key and the sample pass through the #145 redaction heuristics.
const MAX_KEY = 200;
const MAX_SAMPLE = 500;

export const recordEndpointError = async (
  provider: ProviderName,
  model: string,
  err: unknown,
): Promise<void> => {
  try {
    // Same extraction convention as the 413/429 matchers (modelFailover.ts):
    // status codes ride the error object when the SDK attaches one; Mastra
    // stream errors rethrow as plain Errors with the payload text only.
    const statusCode = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
    const hasStatus = typeof statusCode === 'number' && Number.isFinite(statusCode);
    const message = err instanceof Error ? err.message : String(err);
    const key = hasStatus
      ? String(statusCode)
      : redactString(message).slice(0, MAX_KEY).trim() || 'unknown';
    const sample = redactForLog(err).slice(0, MAX_SAMPLE);
    await ModelErrorStat.updateOne(
      { provider, model, key },
      {
        $inc: { count: 1 },
        $set: {
          lastSeenAt: new Date(),
          sample,
          ...(hasStatus ? { statusCode } : {}),
        },
      },
      { upsert: true },
    );
  } catch (writeErr) {
    // Best-effort, mirroring `disableModel`: diagnostics must never mask or
    // duplicate the real failure the caller is already surfacing.
    console.error('ModelErrorStat write error:', writeErr);
  }
};
