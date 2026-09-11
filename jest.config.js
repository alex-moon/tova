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
  // gets an inert stub (src/server/test/mastraAgentStub.ts).
  moduleNameMapper: {
    '^@mastra/core/agent$': '<rootDir>/src/server/test/mastraAgentStub.ts',
  },
};
