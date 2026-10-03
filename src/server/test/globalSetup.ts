import { MongoMemoryServer } from 'mongodb-memory-server';

let mongo: MongoMemoryServer | undefined;

export default async function globalSetup(): Promise<void> {
  mongo = await MongoMemoryServer.create();
  (globalThis as Record<string, unknown>).__TOVA_TEST_MONGO__ = mongo;
  process.env.__TOVA_TEST_MONGO_URI = mongo.getUri();
  process.env.__TOVA_TEST_MONGO_DB = mongo.instanceInfo?.dbName ?? 'tova';
}
