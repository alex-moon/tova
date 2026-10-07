import { EvalRunRecord } from './EvalRunRecord';
// The shared jest setup (src/server/test/setup.ts) provides the in-memory
// Mongo, connects mongoose, syncs indexes, and clears collections per test.

/*
 * Plan-225 task 1: the computed eval rollup. Defaults keep a freshly created
 * row in the `running` lease state until the service settles it; the indexes
 * back the list query and the once-per-window idempotency check.
 */
describe('EvalRunRecord', () => {
  it('defaults to a running lease with no results', async () => {
    const doc = await EvalRunRecord.create({ startedAt: new Date(), models: ['deepinfra:x'] });
    expect(doc.status).toBe('running');
    expect(doc.finishedAt).toBeNull();
    expect(doc.error).toBeNull();
    expect(doc.results).toEqual([]);
    expect(doc.models).toEqual(['deepinfra:x']);
  });

  it('stores per-case results without subdocument ids', async () => {
    const doc = await EvalRunRecord.create({
      startedAt: new Date(),
      models: ['deepinfra:x'],
      results: [
        { caseId: 'case-a', model: 'x', provider: 'deepinfra', score: 'pass', report: 'y' },
      ],
    });
    const found = await EvalRunRecord.findById(doc._id);
    expect(found?.results).toHaveLength(1);
    expect(found?.results[0].score).toBe('pass');
    expect((found?.results[0] as unknown as { _id?: unknown })._id).toBeUndefined();
  });

  it('rejects an unknown status', async () => {
    await expect(
      EvalRunRecord.create({ startedAt: new Date(), status: 'alien' }),
    ).rejects.toThrow();
  });

  it('declares the list and idempotency indexes', async () => {
    const indexes = await EvalRunRecord.collection.indexes();
    const keys = indexes.map((index) => JSON.stringify(index.key));
    expect(keys).toContain(JSON.stringify({ startedAt: -1 }));
    expect(keys).toContain(JSON.stringify({ status: 1, startedAt: -1 }));
  });

  // The migration `create-eval-runs` pre-creates `evalruns`. Without the
  // explicit collection name Mongoose pluralises the model to
  // `evalrunrecords`, so the migration would create a collection the service
  // never writes and the intended indexes would never exist.
  it('binds to the `evalruns` collection the migration creates', () => {
    expect(EvalRunRecord.collection.name).toBe('evalruns');
  });
});
