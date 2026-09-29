import { MongoMemoryServer } from 'mongodb-memory-server';

(async () => {
  try {
    const m = await MongoMemoryServer.create();
    console.log('CREATED', m.getUri());
    await m.stop();
    console.log('STOPPED');
  } catch (e) {
    console.error('FAILED', e);
    process.exit(1);
  }
})();
