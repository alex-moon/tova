module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/server/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/server/test/setup.ts'],
};
