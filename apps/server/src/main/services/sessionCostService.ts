import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { estimateCostUsd, loadPriceIndex, priceFor } from './traceStatsCost';
import type { AdminSessionCostRow, AdminSessionsCostPayload } from '@tova/shared';

/* Per-session cost breakdown from our own Message rows; token/cost totals cover only turns carrying usage (post-#224), priced per (model, provider) with unknown ≠ free. */
// @see #224 #199 #235

export interface SessionCostOptions {
  /** Window start; messages newer than this are included. */
  since: Date;
  /** Cap the number of sessions returned (most recent first). */
  limit?: number;
}

const DEFAULT_LIMIT = 50;

const finiteOr = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

// One row per (session, model, provider): grouping server-side keeps the result bounded; the provider dimension prices dual-provider models correctly.
// @see #235
interface GroupedRow {
  _id: { sessionId: unknown; modelName?: string | null; provider?: string | null };
  messagesIn: number;
  messagesOut: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usageCount: number;
  lastActivity: Date | null;
}

export const sessionCostBreakdown = async (
  options: SessionCostOptions,
): Promise<AdminSessionsCostPayload> => {
  const limit = options.limit ?? DEFAULT_LIMIT;

  // Grouping covers both roles; `usageCount` counts assistant rows with usage so a legacy model is not priced at $0 (unknown ≠ free).
  // @see #224
  const grouped = await Message.aggregate<GroupedRow>([
    { $match: { timestamp: { $gte: options.since } } },
    {
      $group: {
        _id: { sessionId: '$sessionId', modelName: '$modelName', provider: '$provider' },
        messagesIn: { $sum: { $cond: [{ $eq: ['$role', 'user'] }, 1, 0] } },
        messagesOut: { $sum: { $cond: [{ $eq: ['$role', 'assistant'] }, 1, 0] } },
        inputTokens: { $sum: { $ifNull: ['$usage.inputTokens', 0] } },
        outputTokens: { $sum: { $ifNull: ['$usage.outputTokens', 0] } },
        totalTokens: { $sum: { $ifNull: ['$usage.totalTokens', 0] } },
        usageCount: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $isNumber: '$usage.inputTokens' },
                  { $isNumber: '$usage.outputTokens' },
                  { $isNumber: '$usage.totalTokens' },
                ],
              },
              1,
              0,
            ],
          },
        },
        lastActivity: { $max: '$timestamp' },
      },
    },
  ]);

  // One roster read prices every group, with a model-only fallback for legacy turns.
  const priceIndex = await loadPriceIndex();

  interface Acc {
    messagesIn: number;
    messagesOut: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    anyPriced: boolean;
    lastActivity: number;
  }

  const bySession = new Map<string, Acc>();

  for (const row of grouped) {
    const sessionId = row._id.sessionId != null ? String(row._id.sessionId) : null;
    if (!sessionId) continue;
    const acc = bySession.get(sessionId) ?? {
      messagesIn: 0,
      messagesOut: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      anyPriced: false,
      lastActivity: 0,
    };
    const ts = row.lastActivity ? new Date(row.lastActivity).getTime() : 0;
    if (ts > acc.lastActivity) acc.lastActivity = ts;

    acc.messagesIn += row.messagesIn;
    acc.messagesOut += row.messagesOut;

    let inputTokens = finiteOr(row.inputTokens);
    const outputTokens = finiteOr(row.outputTokens);
    // A provider that reported only a total with no split must not be priced at $0; treat the total as input.
    if (inputTokens === 0 && outputTokens === 0) {
      inputTokens = finiteOr(row.totalTokens);
    }
    acc.inputTokens += inputTokens;
    acc.outputTokens += outputTokens;
    // A group with no logged usage has no known spend: unlogged must not misreport as free.
    const cost =
      row.usageCount > 0
        ? estimateCostUsd(
            inputTokens,
            outputTokens,
            priceFor(priceIndex, row._id.modelName ?? '', row._id.provider ?? undefined),
          )
        : null;
    if (cost !== null) {
      acc.anyPriced = true;
      acc.cost += cost;
    }

    bySession.set(sessionId, acc);
  }

  const sessionIds = [...bySession.keys()];
  const sessions =
    sessionIds.length > 0
      ? await Session.find({ _id: { $in: sessionIds } })
          .select({ title: 1 })
          .lean<{ _id: unknown; title?: string }[]>()
      : [];
  const titleById = new Map(sessions.map((s) => [String(s._id), s.title ?? 'Untitled']));

  const result: AdminSessionCostRow[] = sessionIds
    .map((sessionId) => {
      const acc = bySession.get(sessionId)!;
      return {
        sessionId,
        title: titleById.get(sessionId) ?? 'Untitled',
        messagesIn: acc.messagesIn,
        messagesOut: acc.messagesOut,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        estimatedCostUsd: acc.anyPriced ? acc.cost : null,
        lastActivityAt: new Date(acc.lastActivity).toISOString(),
      };
    })
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .slice(0, limit);

  let anyPricedTotal = false;
  let costTotal = 0;
  let messagesIn = 0;
  let messagesOut = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const row of result) {
    messagesIn += row.messagesIn;
    messagesOut += row.messagesOut;
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    if (row.estimatedCostUsd !== null) {
      anyPricedTotal = true;
      costTotal += row.estimatedCostUsd;
    }
  }

  return {
    since: options.since.toISOString(),
    sessions: result,
    totals: {
      sessions: result.length,
      messagesIn,
      messagesOut,
      inputTokens,
      outputTokens,
      estimatedCostUsd: anyPricedTotal ? costTotal : null,
    },
  };
};
