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
    /** Who owns the title: a 'user' rename is never overwritten. */
    // @see #359
    titleSource: {
      type: String,
      enum: ['system', 'user'],
      default: 'system',
    },
    /** System-maintained summary; a soft scope signal, not editable. */
    // @see #359
    subtitle: {
      type: String,
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    /** Incognito sessions are never persisted, so rows are always false. */
    // @see #144
    incognito: {
      type: Boolean,
      default: false,
    },
    /** Most recent persisted message; drives the sidebar order. */
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

// Sidebar order: live chats by most recent activity, on every load.
// @see #377
sessionSchema.index({ userId: 1, deletedAt: 1, lastMessageAt: -1 });
