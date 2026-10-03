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
  roots: ['<rootDir>/src/server'],
  testMatch: ['**/*.test.ts'],
  globalSetup: '<rootDir>/src/server/test/globalSetup.ts',
  globalTeardown: '<rootDir>/src/server/test/globalTeardown.ts',
  setupFilesAfterEnv: ['<rootDir>/src/server/test/setup.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  // `@mastra/core`'s CJS build requires ESM-only transitive deps (e.g.
  // `@sindresorhus/slugify`), which ts-jest cannot load. Suites that need
  // agent behaviour mock '@mastra/core/agent' explicitly; everything else
  // gets inert stubs (src/server/test/mastra*Stub.ts etc.).
  moduleNameMapper: {
    '^@mastra/core/agent$': '<rootDir>/src/server/test/mastraAgentStub.ts',
    '^@mastra/core/tools$': '<rootDir>/src/server/test/mastraToolsStub.ts',
    '^@mastra/core/storage$': '<rootDir>/src/server/test/mastraStorageStub.ts',
    '^@mastra/core$': '<rootDir>/src/server/test/mastraCoreStub.ts',
    '^@mastra/observability$': '<rootDir>/src/server/test/observabilityStub.ts',
    '^@mastra/langsmith$': '<rootDir>/src/server/test/langsmithStub.ts',
  },
};
