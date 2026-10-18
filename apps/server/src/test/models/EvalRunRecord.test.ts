import { EvalRunRecord } from '../../main/models/EvalRunRecord';
// Shared jest setup: in-memory Mongo, mongoose connect, index sync, wipes.

/* Computed rollup: fresh rows sit in `running` until the service settles. */
// @see #225
describe('EvalRunRecord', () => {
  it('defaults to a running lease with no results', async () => {
    const doc = await EvalRunRecord.create({ startedAt: new Date(), models: ['deepinfra:x'] });
    expect(doc.status).toBe('running');
    expect(doc.finishedAt).toBeNull();
    expect(doc.error).toBeNull();
    expect(doc.results).toEqual([]);
    expect(doc.models).toEqual(['deepinfra:x']);
    // A row is a tool-use run unless stated, with no stages/metrics.
    // @see #289
    expect(doc.kind).toBe('tool-use');
    expect(doc.stages).toEqual([]);
    expect(doc.metrics).toBeNull();
  });

  it('stores a memory run with its kind, stages and metrics payload', async () => {
    const doc = await EvalRunRecord.create({
      startedAt: new Date(),
      kind: 'memory',
      models: ['memory'],
      stages: ['retrieval'],
      metrics: { corpusHash: 'abc', stages: ['retrieval'] },
    });
    const found = await EvalRunRecord.findById(doc._id);
    expect(found?.kind).toBe('memory');
    expect(found?.stages).toEqual(['retrieval']);
    expect(found?.metrics).toEqual({ corpusHash: 'abc', stages: ['retrieval'] });
  });

  it('rejects an unknown kind', async () => {
    await expect(EvalRunRecord.create({ startedAt: new Date(), kind: 'alien' })).rejects.toThrow();
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
    expect(keys).toContain(JSON.stringify({ kind: 1, startedAt: -1 }));
  });

  // Otherwise Mongoose would pluralise, bypassing the migration's collection.
  it('binds to the `evalruns` collection the migration creates', () => {
    expect(EvalRunRecord.collection.name).toBe('evalruns');
  });
});
