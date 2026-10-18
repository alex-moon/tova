/* Jest stub for `@mastra/core`: so module resolution succeeds offline. */

export class Mastra {
  constructor(public readonly config: unknown) {}

  /* Only addAgent needs to succeed; behaviour lives behind the mock. */
  addAgent(): void {}
}
