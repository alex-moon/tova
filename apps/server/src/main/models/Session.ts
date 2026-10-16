import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: {
      type: String,
      default: 'New Chat',
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    /*
     * Per-chat incognito flag (#144): fixed at session creation from the
     * client's new-chat intent or the profile's 'incognito by default'.
     * Incognito sessions themselves are never persisted under today's
     * write-nothing semantics, so persisted documents are always false;
     * the default keeps old documents truthful.
     */
    incognito: {
      type: Boolean,
      default: false,
    },
    /*
     * #226: timestamp of the session's most recent persisted message. Bumped
     * on each persisted user turn in saveUserMessageWithMetrics. Drives the
     * sidebar order (and therefore "open the most recent chat on load").
     * Defaults to null for sessions that predate #226; the listing sort
     * places nulls last. No index here — the migration owns it.
     */
    lastMessageAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

export const Session = mongoose.model('Session', sessionSchema);
