/*
 * Jest stub: `@mastra/core/storage` (see `mastraCoreStub.ts` for why the
 * real entry cannot be loaded under ts-jest).
 */

export class InMemoryStore {
  constructor(public readonly config: unknown) {}
}
