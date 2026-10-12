import { mongoMigrateCli } from 'mongo-migrate-ts';
import 'dotenv/config';
import { buildMongoUri } from '../../shared/src/mongoUri';

void mongoMigrateCli({
  uri: buildMongoUri(),
  migrationsDir: __dirname,
  globPattern: '**/*.ts',
});
