import { mongoMigrateCli } from 'mongo-migrate-ts';
import 'dotenv/config';

void mongoMigrateCli({
  uri: `mongodb://tova:${process.env.MONGODB_PASSWORD}@localhost:27017/tova?authSource=admin`,
  migrationsDir: __dirname,
  globPattern: '**/*.ts',
});
