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
  },
  {
    timestamps: true,
  },
);

export const Session = mongoose.model('Session', sessionSchema);
