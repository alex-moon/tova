/**
 * Temporary Mongo source for the #112 evals (#112): a synthetic eval user
 * with a small seeded asset library in the local `tova` database. Run scope:
 * the asset tools read through the shared Mongoose connection, so the
 * fixtures live in the same database under a reserved user id rather than
 * in a second connection/database. Seeding is idempotent (upserts are keyed
 * on userId + filename); `clearEvalSource` removes every eval artifact.
 */
import mongoose from 'mongoose';
import { Asset } from '../models/Asset';
import { User } from '../models/User';

// Stable 24-hex ObjectId so eval runs across sessions reuse one fixture user.
const EVAL_USER_ID_HEX = '6f61e78155a5b2c0d3e1f7a2';
export const evalUserId = new mongoose.Types.ObjectId(EVAL_USER_ID_HEX);
export const evalUserEmail = 'eval-fixture@tova.local';

/* Content for the #112 Bupa case: the retrieval eval is "search my files
 * then read the policy" — what it says about fertility treatment must be
 * discoverable only inside the seeded file, never from web search. */
const BUPA_POLICY_TEXT = `Bupa Health Insurance — policy schedule PROV-2026-00318
Covered benefits:
- Fertility treatment: 60% coverage, up to £4,000 per cycle, requires GP referral.
- Physiotherapy: 6 sessions per year.
- Maternity: not covered on this plan.
Exclusions: pre-existing conditions declared at inception;
fertility cycles beyond the second are reduced to 40% coverage.`;

const FIXTURE_FILES: { filename: string; contentType: string; text: string }[] = [
  {
    filename: 'bupa-policy.md',
    contentType: 'text/markdown',
    text: BUPA_POLICY_TEXT,
  },
  {
    filename: 'utilities-notes.md',
    contentType: 'text/markdown',
    text: '# Utility bills\n\nBroadband contract renewals in November.',
  },
];

const ensureEvalUser = async () => {
  await User.updateOne(
    { _id: evalUserId },
    { $setOnInsert: { email: evalUserEmail, passwordHash: 'eval-fixture', role: 'user' } },
    { upsert: true },
  );
};

/** Upsert every fixture asset for the eval user; never touches other users. */
export const seedEvalSource = async (): Promise<void> => {
  await ensureEvalUser();
  for (const file of FIXTURE_FILES) {
    await Asset.updateOne(
      { userId: evalUserId, filename: file.filename },
      {
        $setOnInsert: {
          userId: evalUserId,
          filename: file.filename,
          key: `${evalUserId.toHexString()}/eval/${file.filename}`,
          contentType: file.contentType,
          size: Buffer.byteLength(file.text),
          textExtracted: file.text,
          status: 'ready',
          origin: 'user-upload',
        },
      },
      { upsert: true },
    );
  }
};

/** Remove the eval user and all their seeded assets (runner teardown). */
export const clearEvalSource = async (): Promise<void> => {
  await Asset.deleteMany({ userId: evalUserId });
  await User.deleteOne({ _id: evalUserId });
};
