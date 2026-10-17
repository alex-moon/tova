/* Jest-only stub for `@mastra/core/tools` (ESM-only transitive deps); suites needing tool behaviour mock this module with createTool as an identity function so the tool config is inspectable. */
export const createTool = <T>(config: T): T => config;
