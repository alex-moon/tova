/*
 * Jest stub: `@mastra/core` root entry. The real build ships ESM-only
 * transitive deps (`@sindresorhus/slugify`) that ts-jest cannot parse —
 * the same constraint documented on the agents entry stub. Unit suites
 * exercise their own mocks at the call boundary; these stubs only exist
 * so module resolution of `mastraService.ts` succeeds offline.
 */

export class Mastra {
  constructor(public readonly config: unknown) {}
  /**
   * Matches the real signature used in mastraService.ts (agent registered
   * under an explicit key). No-op here — the stub only needs to resolve
   * module loading; suites exercise the agent boundary with their own mocks.
   */
  addAgent(_agent: unknown, _key?: string): void {}
}
