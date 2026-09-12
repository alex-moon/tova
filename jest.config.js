module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/server'],
  testMatch: ['**/*.test.ts'],
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
