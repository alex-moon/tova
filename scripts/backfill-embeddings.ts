/*
 * #294: embed the existing workspace corpus into `workspace_embeddings`.
 *
 *   npx tsx scripts/backfill-embeddings.ts [--user <id>] [--dry-run]
 *   npm run db:backfill-embeddings
 *
 * Idempotent: a slice is (re-)embedded only when its `textHash` differs from
 * the stored row, so re-running over an unchanged corpus is a no-op. The
 * decision logic lives in `workspaceEmbeddingBackfill.ts` and is unit-tested;
 * this script owns the Mongo reads/writes and the DeepInfra calls.
 *
 * Needs: a reachable Mongo (`MONGODB_URL`) and `DEEPINFRA_API_KEY`. Run
 * `npm run db:vector-index` once against Atlas before retrieval can use these
 * rows (the local stack has no `$vectorSearch`).
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { buildMongoUri } from '../apps/shared/src/mongoUri';
import { config } from '../apps/server/src/config';
import { User } from '../apps/server/src/models/User';
import { WorkspaceEmbedding } from '../apps/server/src/models/WorkspaceEmbedding';
import { collectWorkspaceSlices } from '../apps/server/src/services/workspaceRetrievalService';
import { embedTexts } from '../apps/server/src/services/embeddingService';
import {
  embeddingKey,
  existingEmbeddingHashes,
  planEmbeddingWrites,
  type EmbeddableSlice,
} from '../apps/server/src/services/workspaceEmbeddingBackfill';

const EMBED_BATCH = 64;
// Rough public pricing for a bge-base-class embedding (~$0.067 per 1M input
// tokens); reported as an order-of-magnitude cost bound, not a bill.
const USD_PER_MILLION_TOKENS = 0.067;
const CHARS_PER_TOKEN = 4;

interface Args {
  userId?: string;
  dryRun: boolean;
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--user') {
      const value = argv[i + 1];
      if (!value) throw new Error('--user requires a user id');
      args.userId = value;
      i += 1;
    }
  }
  return args;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const model = config.embeddings.model;
  const dim = config.embeddings.dim;

  await mongoose.connect(buildMongoUri());
  try {
    const users = args.userId
      ? [{ _id: new mongoose.Types.ObjectId(args.userId) }]
      : await User.find({}).select('_id').lean();

    const slices: EmbeddableSlice[] = [];
    // The plan carries no ownership; keep a key -> owner map so the upsert can
    // write the `userId` the Atlas `$vectorSearch` filter needs.
    const ownerByKey = new Map<string, mongoose.Types.ObjectId>();
    for (const user of users) {
      const owner = user._id as mongoose.Types.ObjectId;
      const collected = await collectWorkspaceSlices(String(owner));
      for (const slice of collected) {
        slices.push({ kind: slice.kind, id: slice.id, text: slice.text });
        ownerByKey.set(embeddingKey(slice.kind, slice.id, model), owner);
      }
    }

    const rows = await WorkspaceEmbedding.find({ model })
      .select('kind sourceId model textHash')
      .lean();
    const existingHashes = existingEmbeddingHashes(rows, model);

    const plan = planEmbeddingWrites(slices, existingHashes, model);
    const totalChars = plan.toEmbed.reduce((sum, item) => sum + item.text.length, 0);
    const estTokens = Math.round(totalChars / CHARS_PER_TOKEN);
    const estCostUsd = (estTokens / 1_000_000) * USD_PER_MILLION_TOKENS;

    console.log(
      `model=${model} dim=${dim} slices=${plan.total} ` +
        `embed=${plan.toEmbed.length} skip=${plan.skipped} empty=${plan.empty} ` +
        `truncated=${plan.truncated}`,
    );
    console.log(
      `est. input ~${estTokens} tokens (~$${estCostUsd.toFixed(4)}) ` +
        `[${plan.toEmbed.length} of ${plan.total} slices]`,
    );

    if (args.dryRun) {
      console.log('dry-run: no embed calls, no writes');
      return;
    }

    let written = 0;
    let failed = 0;
    for (let i = 0; i < plan.toEmbed.length; i += EMBED_BATCH) {
      const batch = plan.toEmbed.slice(i, i + EMBED_BATCH);
      let vectors: number[][];
      try {
        vectors = await embedTexts(
          batch.map((item) => item.text),
          { kind: 'passage' },
        );
      } catch (error) {
        failed += batch.length;
        console.error(`embed batch ${i / EMBED_BATCH} failed: ${String(error)}`);
        continue;
      }
      for (let j = 0; j < batch.length; j += 1) {
        const item = batch[j];
        const userId = ownerByKey.get(embeddingKey(item.kind, item.sourceId, model));
        if (!userId) {
          failed += 1;
          console.error(`upsert ${item.kind}:${item.sourceId} failed: unknown owner`);
          continue;
        }
        try {
          await WorkspaceEmbedding.updateOne(
            { kind: item.kind, sourceId: item.sourceId, model },
            {
              $set: {
                userId,
                dim,
                vector: vectors[j],
                textHash: item.textHash,
              },
            },
            { upsert: true },
          );
          written += 1;
        } catch (error) {
          failed += 1;
          console.error(`upsert ${item.kind}:${item.sourceId} failed: ${String(error)}`);
        }
      }
    }

    console.log(`done: written=${written} failed=${failed}`);
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
