import { mongoMigrateCli } from 'mongo-migrate-ts';
import 'dotenv/config';

void mongoMigrateCli({
  uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/tova',
  migrationsDir: __dirname,
  globPattern: '**/*.ts',
});
