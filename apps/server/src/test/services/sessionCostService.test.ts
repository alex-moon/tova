import { Message } from '../../main/models/Message';
import { Session } from '../../main/models/Session';
import { ModelRoster } from '../../main/models/ModelRoster';
import { User } from '../../main/models/User';
import { sessionCostBreakdown } from '../../main/services/sessionCostService';

/* Cost breakdown: pins "unknown ≠ free" and the fallback pricing. */
// @see #224 #235
describe('sessionCostBreakdown (#224/#235)', () => {
  const since = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const makeUser = async () =>
    User.create({ email: `u-${Math.random()}@example.com`, passwordHash: 'x' });

  const seedModel = (
    modelId: string,
    providers: { provider: string; inputPrice?: number; outputPrice?: number }[],
  ) =>
    ModelRoster.create({
      modelId,
      label: modelId,
      tools: true,
      vision: true,
      eligible: true,
      providers: providers.map((p) => ({ ...p, modelId, enabled: true, disabledUntil: null })),
    });

  it('does not price a usage-less turn at $0 even when its model is priced', async () => {
    const user = await makeUser();
    await seedModel('priced/legacy', [{ provider: 'deepinfra', inputPrice: 2, outputPrice: 4 }]);
    const session = await Session.create({ userId: user!._id, title: 'Legacy' });
    // A pre-usage-logging message: priced model, no `usage` recorded.
    // @see #224
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
    await seedModel('priced/totalonly', [{ provider: 'deepinfra', inputPrice: 1, outputPrice: 3 }]);
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
    await seedModel('priced/mixed', [{ provider: 'deepinfra', inputPrice: 2, outputPrice: 4 }]);
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

  it('prices each turn by its persisted provider on a dual-priced model (#235)', async () => {
    const user = await makeUser();
    await seedModel('dual/model', [
      { provider: 'deepinfra', inputPrice: 1, outputPrice: 1 },
      { provider: 'fireworks', inputPrice: 10, outputPrice: 10 },
    ]);
    const session = await Session.create({ userId: user!._id, title: 'Dual' });
    // DeepInfra turn: 1M in @ $1 = $1.
    await Message.create({
      sessionId: session._id,
      role: 'assistant',
      content: 'a',
      modelName: 'dual/model',
      provider: 'deepinfra',
      timestamp: new Date(),
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });
    // Fireworks turn on the SAME model: 1M in @ $10 = $10.
    await Message.create({
      sessionId: session._id,
      role: 'assistant',
      content: 'b',
      modelName: 'dual/model',
      provider: 'fireworks',
      timestamp: new Date(),
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });

    const payload = await sessionCostBreakdown({ since: since() });
    const row = payload.sessions.find((s) => s.sessionId === String(session._id));
    expect(row!.estimatedCostUsd).toBe(11);
  });

  it('falls back to the model default when a turn has no provider (#235)', async () => {
    const user = await makeUser();
    await seedModel('dual/legacy', [
      { provider: 'deepinfra', inputPrice: 1, outputPrice: 1 },
      { provider: 'fireworks', inputPrice: 10, outputPrice: 10 },
    ]);
    const session = await Session.create({ userId: user!._id, title: 'LegacyDual' });
    // No `provider` → fallback picks the first fully-priced provider.
    await Message.create({
      sessionId: session._id,
      role: 'assistant',
      content: 'a',
      modelName: 'dual/legacy',
      timestamp: new Date(),
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });

    const payload = await sessionCostBreakdown({ since: since() });
    const row = payload.sessions.find((s) => s.sessionId === String(session._id));
    expect(row!.estimatedCostUsd).toBe(1);
  });
});
