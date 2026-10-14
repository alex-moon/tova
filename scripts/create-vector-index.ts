/*
 * #294: create the Atlas Vector Search index over `workspace_embeddings`.
 *
 *   npx tsx scripts/create-vector-index.ts
 *   npm run db:vector-index
 *
 * Atlas-only: `$vectorSearch` / `createSearchIndex` do not exist on local
 * `mongod`, so this refuses a non-`mongodb+srv://` MONGODB_URL. Run it against
 * the live cluster after `npm run db:backfill-embeddings`; re-running is safe
 * (the index is existence-checked).
 *
 * If the live tier disallows programmatic creation (some docs say shared M0
 * requires the Atlas UI), create the same definition in the UI:
 *   vector  path=vector  numDimensions=<EMBEDDING_DIM>  similarity=cosine
 *   filter  path=model
 *   filter  path=userId
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { buildMongoUri } from '../apps/shared/src/mongoUri';
import { config } from '../apps/server/src/config';
import {
  VECTOR_INDEX_NAME,
  assertAtlasUrl,
  ensureVectorIndex,
  type SearchIndexManager,
} from '../apps/server/src/services/atlasVectorIndex';

const main = async (): Promise<void> => {
  const url = assertAtlasUrl(buildMongoUri());
  const dim = config.embeddings.dim;

  const client = new MongoClient(url);
  try {
    await client.connect();
    const collection = client
      .db('tova')
      .collection('workspace_embeddings') as unknown as SearchIndexManager;
    const result = await ensureVectorIndex(collection, dim);
    console.log(
      `vector index '${VECTOR_INDEX_NAME}' ${result} ` +
        `(dim=${dim}, model=${config.embeddings.model})`,
    );
  } finally {
    await client.close();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
