import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { estimateCostUsd, loadPriceIndex, priceFor, type PriceIndex } from './trace/traceStatsCost';
import type { AdminSessionCostRow, AdminSessionsCostPayload } from '@tova/shared';

/* Per-session cost breakdown from Message rows; unknown usage is not free. */
// @see #224 #199 #235

export interface SessionCostOptions {
  /** Window start; messages newer than this are included. */
  since: Date;
  /** Cap the number of sessions returned (most recent first). */
  limit?: number;
  /** Override the price index (tests); default is the static fixed-model one. */
  // @see #387
  priceIndex?: PriceIndex;
}

const DEFAULT_LIMIT = 50;

const finiteOr = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

// One row per (session, model, provider); provider prices dual models right.
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

  // usageCount counts rows with usage so a legacy model is not $0.
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

  // One index read prices every group; model-only fallback for legacy.
  const priceIndex = options.priceIndex ?? (await loadPriceIndex());

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
    // A total-only report must not price at $0; treat as input.
    if (inputTokens === 0 && outputTokens === 0) {
      inputTokens = finiteOr(row.totalTokens);
    }
    acc.inputTokens += inputTokens;
    acc.outputTokens += outputTokens;
    // No logged usage = no known spend; unlogged is not free.
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
