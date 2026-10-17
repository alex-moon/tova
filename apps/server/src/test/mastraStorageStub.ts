/* Jest stub for `@mastra/core/storage` (the real entry cannot load under ts-jest). */

export class InMemoryStore {
  constructor(public readonly config: unknown) {}
}
