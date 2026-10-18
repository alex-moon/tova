/* Embed the workspace corpus into `workspace_embeddings`; idempotent. */
// @see #294 #289
import 'dotenv/config';
import mongoose from 'mongoose';
import { buildMongoUri } from '../apps/shared/src/main/mongoUri';
import { config } from '../apps/server/src/main/config';
import { User } from '../apps/server/src/main/models/User';
import { embedWorkspaceUser } from '../apps/server/src/main/services/workspaceEmbeddingIngest';

// Rough public embedding pricing; order-of-magnitude bound, not a bill.
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

    const totals = {
      total: 0,
      pending: 0,
      embedded: 0,
      skipped: 0,
      empty: 0,
      truncated: 0,
      failed: 0,
      chars: 0,
    };
    for (const user of users) {
      const result = await embedWorkspaceUser(String(user._id), { dryRun: args.dryRun });
      totals.total += result.total;
      totals.pending += result.pending;
      totals.embedded += result.embedded;
      totals.skipped += result.skipped;
      totals.empty += result.empty;
      totals.truncated += result.truncated;
      totals.failed += result.failed;
      totals.chars += result.chars;
    }

    const estTokens = Math.round(totals.chars / CHARS_PER_TOKEN);
    const estCostUsd = (estTokens / 1_000_000) * USD_PER_MILLION_TOKENS;

    console.log(
      `model=${model} dim=${dim} users=${users.length} slices=${totals.total} ` +
        `embed=${totals.pending} skip=${totals.skipped} empty=${totals.empty} ` +
        `truncated=${totals.truncated}`,
    );
    console.log(
      `est. input ~${estTokens} tokens (~$${estCostUsd.toFixed(4)}) ` +
        `[${totals.pending} of ${totals.total} slices]`,
    );

    if (args.dryRun) {
      console.log('dry-run: no embed calls, no writes');
      return;
    }

    console.log(`done: written=${totals.embedded} failed=${totals.failed}`);
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
