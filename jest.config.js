module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/server'],
  testMatch: ['**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/server/test/setup.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
};
