/* Jest stub for `@mastra/core/storage` (cannot load under ts-jest). */

export class InMemoryStore {
  constructor(public readonly config: unknown) {}
}
