import { mongoMigrateCli } from 'mongo-migrate-ts';
import 'dotenv/config';
import { buildMongoUri } from '../src/server/mongoUri';

void mongoMigrateCli({
  uri: buildMongoUri(),
  migrationsDir: __dirname,
  globPattern: '**/*.ts',
});
