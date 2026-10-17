/* Jest stub for the `@mastra/core` root entry: the real build ships ESM-only transitive deps ts-jest cannot parse; these stubs exist only so module resolution of mastraService.ts succeeds offline. */

export class Mastra {
  constructor(public readonly config: unknown) {}

  /* The stub only needs addAgent to succeed; agent behaviour lives behind the mocked agent module. */
  addAgent(): void {}
}
