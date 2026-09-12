/*
 * Jest-only stub standing in for `@mastra/core/tools` in test suites that do
 * not explicitly mock it (same constraint as the agent/storage stubs: the
 * real package's transitive deps are ESM-only and cannot be `require`d by
 * ts-jest in CJS mode). Suites that need tool behaviour mock
 * '@mastra/core/tools' with `createTool` as an identity function, so the
 * tool config object itself is inspectable in tests.
 */
export const createTool = <T>(config: T): T => config;
