import { mongoMigrateCli } from 'mongo-migrate-ts';
import 'dotenv/config';

void mongoMigrateCli({
  uri:
    process.env.MONGODB_URI ||
    `mongodb://tova:${process.env.MONGODB_PASSWORD}@mongodb:27017/tova?authSource=admin`,
  migrationsDir: __dirname,
  globPattern: '**/*.ts',
});
