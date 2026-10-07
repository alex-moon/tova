import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { ProviderRouting } from '../models/ProviderRouting';
import { User } from '../models/User';
import { sessionCostBreakdown } from './sessionCostService';

/*
 * #224 per-session cost breakdown. These cases pin the "unknown ≠ free"
 * behaviour for turns that predate per-message usage logging: a message whose
 * model has a known price but which carries no token usage must render as
 * unpriced (`null` → `—`), never `$0`. Also covers the total-only fallback and
 * the mixed priced/unpriced session total.
 */
describe('sessionCostBreakdown (#224)', () => {
  const since = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const makeUser = async () =>
    User.create({ email: `u-${Math.random()}@example.com`, passwordHash: 'x' });

  it('does not price a usage-less turn at $0 even when its model is priced', async () => {
    const user = await makeUser();
    await ProviderRouting.create({
      provider: 'deepinfra',
      model: 'priced/legacy',
      tier: 'large',
      inputPrice: 2,
      outputPrice: 4,
    });
    const session = await Session.create({ userId: user!._id, title: 'Legacy' });
    // A pre-#224 assistant message: priced model, but no `usage` recorded.
    await Message.create({
      sessionId: session._id,
      role: 'assistant',
      content: 'old',
      modelName: 'priced/legacy',
      timestamp: new Date(),
    });

    const payload = await sessionCostBreakdown({ since: since() });
    const row = payload.sessions.find((s) => s.sessionId === String(session._id));
    expect(row).toBeDefined();
    expect(row!.messagesOut).toBe(1);
    expect(row!.estimatedCostUsd).toBeNull();
    expect(payload.totals.estimatedCostUsd).toBeNull();
  });

  it('falls back to the total when only totalTokens is present (#OC-7)', async () => {
    const user = await makeUser();
    await ProviderRouting.create({
      provider: 'deepinfra',
      model: 'priced/totalonly',
      tier: 'large',
      inputPrice: 1,
      outputPrice: 3,
    });
    const session = await Session.create({ userId: user!._id, title: 'TotalOnly' });
    await Message.create({
      sessionId: session._id,
      role: 'assistant',
      content: 'hi',
      modelName: 'priced/totalonly',
      timestamp: new Date(),
      // 1M total, no split. Treated as input (1M @ $1) = $1.
      usage: { totalTokens: 1_000_000 },
    });

    const payload = await sessionCostBreakdown({ since: since() });
    const row = payload.sessions.find((s) => s.sessionId === String(session._id));
    expect(row!.inputTokens).toBe(1_000_000);
    expect(row!.estimatedCostUsd).toBe(1);
  });

  it('sums only priced turns into a mixed session total', async () => {
    const user = await makeUser();
    await ProviderRouting.create({
      provider: 'deepinfra',
      model: 'priced/mixed',
      tier: 'large',
      inputPrice: 2,
      outputPrice: 4,
    });
    const session = await Session.create({ userId: user!._id, title: 'Mixed' });
    // Priced turn: 1M in @ $2 = $2.
    await Message.create({
      sessionId: session._id,
      role: 'assistant',
      content: 'a',
      modelName: 'priced/mixed',
      timestamp: new Date(),
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });
    // Unpriced turn (unknown model): contributes tokens, no cost.
    await Message.create({
      sessionId: session._id,
      role: 'assistant',
      content: 'b',
      modelName: 'unknown/mixed',
      timestamp: new Date(),
      usage: { inputTokens: 500, outputTokens: 500 },
    });

    const payload = await sessionCostBreakdown({ since: since() });
    const row = payload.sessions.find((s) => s.sessionId === String(session._id));
    expect(row!.inputTokens).toBe(1_000_500);
    expect(row!.outputTokens).toBe(500);
    expect(row!.estimatedCostUsd).toBe(2);
  });
});
