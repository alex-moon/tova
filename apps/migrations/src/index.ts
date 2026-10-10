import { mongoMigrateCli } from 'mongo-migrate-ts';
import 'dotenv/config';
import { buildMongoUri } from '../../server/src/mongoUri';

void mongoMigrateCli({
  uri: buildMongoUri(),
  migrationsDir: __dirname,
  globPattern: '**/*.ts',
});
