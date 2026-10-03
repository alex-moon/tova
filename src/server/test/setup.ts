import mongoose from 'mongoose';

const baseUri = process.env.__TOVA_TEST_MONGO_URI;
if (!baseUri) {
  throw new Error('globalSetup did not publish __TOVA_TEST_MONGO_URI');
}

const suiteDb = `tova_test_${process.env.JEST_WORKER_ID ?? '0'}_${Math.random()
  .toString(36)
  .slice(2, 10)}`;

beforeAll(async () => {
  const url = new URL(baseUri);
  url.pathname = `/${suiteDb}`;
  await mongoose.connect(url.toString());
  await mongoose.connection.syncIndexes();
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  }
});

beforeEach(async () => {
  const collections = await mongoose.connection.db?.collections();
  if (collections) {
    for (const collection of collections) {
      await collection.deleteMany({});
    }
  }
});
