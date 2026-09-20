import { seedEvalSource, clearEvalSource, evalUserId } from './mongoSource';
import { Asset } from '../models/Asset';

describe('#112 temp mongo source', () => {
  const userId = evalUserId.toHexString();

  it('seeds idempotently: one asset per fixture filename after repeat seeding', async () => {
    await seedEvalSource();
    await seedEvalSource();
    const files = await Asset.find({ userId });

    // One Bupa policy for case 2, one decoy for listing realism.
    expect(files.map((f) => f.filename).sort()).toEqual(['bupa-policy.md', 'utilities-notes.md']);
    expect(files.every((f) => f.status === 'ready' && f.textExtracted)).toBe(true);
  });

  it('seeds the fertility-coverage fact only inside the policy file body', async () => {
    await seedEvalSource();
    const policy = await Asset.findOne({ userId, filename: 'bupa-policy.md' });
    expect(policy?.textExtracted).toContain('Fertility treatment');

    // Cross-user probes must not see the fixtures.
    expect(await Asset.countDocuments()).toBe(2);
  });

  it('clearEvalSource removes the eval user and every seeded asset', async () => {
    await seedEvalSource();
    await clearEvalSource();
    expect(await Asset.countDocuments({ userId })).toBe(0);
  });
});
