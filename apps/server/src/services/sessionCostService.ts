import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { estimateCostUsd, loadPriceIndex, priceFor } from './traceStatsCost';
import type { AdminSessionCostRow, AdminSessionsCostPayload } from '@tova/shared';

/*
 * Per-session cost breakdown for the admin Traces tab (#224). The model rollup
 * comes from LangSmith llm runs; this view comes from our own persisted
 * `Message` rows, which carry the per-role message counts the session table
 * needs (the model rollup above covers model-level spend from LangSmith).
 *
 * Message in = `role:'user'`, message out = `role:'assistant'`. Token totals and
 * cost cover only the assistant messages that carry `usage` — that field only
 * exists from #224 onward, so counts and token/cost totals describe different
 * rows until usage builds up. The skew is expected and surfaced in the UI.
 *
 * Cost is joined at read time from roster prices (USD per 1M, #199), keyed by
 * `(model, provider)` (#235): each turn is priced by the provider that actually
 * served it, since one model's two providers can carry different prices. The
 * group carries the persisted `Message.provider`; a legacy turn with no
 * provider falls back to the model-only pick, same as `traceStatsCost`
 * (unknown ≠ free: a message whose model has no known price contributes nothing
 * to the session cost and, if no message in the session is priced, the row
 * renders `—`).
 */

export interface SessionCostOptions {
  /** Window start; messages newer than this are included. */
  since: Date;
  /** Cap the number of sessions returned (most recent first). */
  limit?: number;
}

const DEFAULT_LIMIT = 50;

const finiteOr = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

// One row per (session, model, provider) produced by the aggregation below.
// Grouping server-side keeps the result bounded by distinct session×model×
// provider tuples rather than by every message in the window (the window can be
// 30 days wide). The provider dimension is what makes dual-price models price
// correctly (#235): each turn is billed at its serving provider's rate.
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

  // Only assistant messages can carry token usage, but message-in counts come
  // from user rows, so the grouping covers both roles. `usageCount` counts
  // assistant rows that actually carry usage, so a model whose only turns
  // predate #224 is not priced at $0 (unknown ≠ free).
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

  // One roster read prices every group: the index resolves `(model, provider)`
  // with a model-only fallback for legacy turns (same resolver as the LangSmith
  // rollup).
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
    // Fallback (plan OC-7): a provider that reported only a total with no
    // split must not be silently priced at `$0`. Treat the total as input so
    // the turn still contributes an estimate.
    if (inputTokens === 0 && outputTokens === 0) {
      inputTokens = finiteOr(row.totalTokens);
    }
    acc.inputTokens += inputTokens;
    acc.outputTokens += outputTokens;
    // A (session, model) group with no logged usage (all turns before #224)
    // has no known spend: do NOT price it at `$0`, which would misreport
    // "unlogged" as "free". Only groups that carry token data contribute cost.
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
