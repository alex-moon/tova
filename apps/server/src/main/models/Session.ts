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
    /** Who owns the title: a 'user' rename may never be overwritten by a system process. */
    // @see #359
    titleSource: {
      type: String,
      enum: ['system', 'user'],
      default: 'system',
    },
    /** System-maintained one-line summary; a soft retrieval scope signal, never user-editable. */
    // @see #359
    subtitle: {
      type: String,
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    /** Fixed at creation; incognito sessions are never persisted, so stored rows are always false. */
    // @see #144
    incognito: {
      type: Boolean,
      default: false,
    },
    /** Timestamp of the most recent persisted message; drives the sidebar order. */
    // @see #226
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
