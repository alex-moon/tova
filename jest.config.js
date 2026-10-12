module.exports = {
  // tsconfig without rootDir so suites may import the scripts/ harness directly.
  preset: 'ts-jest',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json', isolatedModules: true }],
  },
  testEnvironment: 'node',
  // Silence all console output from tests: suites intentionally exercise
  // error paths whose expected console.error/warn logging would otherwise
  // pollute the test output.
  silent: true,
  roots: ['<rootDir>/apps/server/src', '<rootDir>/apps/shared/src'],
  testMatch: ['**/*.test.ts'],
  globalSetup: '<rootDir>/apps/server/src/test/globalSetup.ts',
  globalTeardown: '<rootDir>/apps/server/src/test/globalTeardown.ts',
  setupFilesAfterEnv: ['<rootDir>/apps/server/src/test/setup.ts'],
  modulePathIgnorePatterns: ['<rootDir>/apps/server/dist/'],
  // `@mastra/core`'s CJS build requires ESM-only transitive deps (e.g.
  // `@sindresorhus/slugify`), which ts-jest cannot load. Suites that need
  // agent behaviour mock '@mastra/core/agent' explicitly; everything else
  // gets inert stubs (src/server/test/mastra*Stub.ts etc.).
  moduleNameMapper: {
    // @tova/shared now carries a runtime helper (buildMongoUri); resolve it to
    // source so suites never depend on a prior shared build.
    '^@tova/shared$': '<rootDir>/apps/shared/src/index.ts',
    '^@mastra/core/agent$': '<rootDir>/apps/server/src/test/mastraAgentStub.ts',
    '^@mastra/core/tools$': '<rootDir>/apps/server/src/test/mastraToolsStub.ts',
    '^@mastra/core/storage$': '<rootDir>/apps/server/src/test/mastraStorageStub.ts',
    '^@mastra/core$': '<rootDir>/apps/server/src/test/mastraCoreStub.ts',
    '^@mastra/observability$': '<rootDir>/apps/server/src/test/observabilityStub.ts',
    '^@mastra/langsmith$': '<rootDir>/apps/server/src/test/langsmithStub.ts',
  },
};
