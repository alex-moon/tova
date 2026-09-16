/*
 * Jest stub: `@mastra/core` root entry. The real build ships ESM-only
 * transitive deps (`@sindresorhus/slugify`) that ts-jest cannot parse —
 * the same constraint documented on the agents entry stub. Unit suites
 * exercise their own mocks at the call boundary; these stubs only exist
 * so module resolution of `mastraService.ts` succeeds offline.
 */

export class Mastra {
  constructor(public readonly config: unknown) {}

  /*
   * mastraService registers every constructed agent via `mastra.addAgent`
   * (observability since #5). The stub only needs the call to succeed —
   * the agent behaviour itself lives behind the mocked agent module.
   */
  addAgent(): void {}
}
