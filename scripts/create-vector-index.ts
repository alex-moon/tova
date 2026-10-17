/* Create the Atlas Vector Search index over `workspace_embeddings`; Atlas-only and safe to re-run. */
// @see #294
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { buildMongoUri } from '../apps/shared/src/main/mongoUri';
import { config } from '../apps/server/src/main/config';
import {
  VECTOR_INDEX_NAME,
  assertAtlasUrl,
  ensureVectorIndex,
  type SearchIndexManager,
} from '../apps/server/src/main/services/atlasVectorIndex';

const main = async (): Promise<void> => {
  const url = assertAtlasUrl(buildMongoUri());
  const dim = config.embeddings.dim;

  const client = new MongoClient(url);
  try {
    await client.connect();
    // `db()` with no name uses the connection string's database, honouring a non-`tova` Atlas/eval target.
    const collection = client
      .db()
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
