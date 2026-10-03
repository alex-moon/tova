import { MongoMemoryServer } from 'mongodb-memory-server';

export default async function globalTeardown(): Promise<void> {
  const instance = (globalThis as Record<string, unknown>).__TOVA_TEST_MONGO__ as
    MongoMemoryServer | undefined;
  if (instance) await instance.stop();
}
