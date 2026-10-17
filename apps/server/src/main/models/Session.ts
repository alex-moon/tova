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
    /*
     * #359: who owns the title. 'system' = derived from the opening message;
     * 'user' = renamed by the user, and no system process may overwrite it
     * after that. Existing documents predate the field and are 'system'.
     */
    titleSource: {
      type: String,
      enum: ['system', 'user'],
      default: 'system',
    },
    /*
     * #359: the system-maintained one-line summary of what the chat is about
     * (a soft scope signal for retrieval, and the better library label).
     * Generated/revised fire-and-forget on a turn cadence; null until the
     * first revision lands. Never user-editable today.
     */
    subtitle: {
      type: String,
      default: null,
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
