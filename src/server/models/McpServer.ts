import mongoose from 'mongoose';

const mcpServerSchema = new mongoose.Schema(
  {
    scope: {
      type: String,
      enum: ['platform', 'user'],
      required: true,
    },
    // Required when scope is 'user'; null/absent for platform servers.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    // AES-256-GCM envelope (src/server/services/crypto.ts). Secret material at
    // rest is only these three fields; the toJSON transform below strips the
    // whole envelope so no API response ever echoes it.
    headers: {
      type: {
        iv: { type: String, required: true },
        tag: { type: String, required: true },
        ciphertext: { type: String, required: true },
      },
      default: null,
    },
    // Denormalized so the API can show "auth configured" without exposing
    // anything about the header itself (name or value).
    headersConfigured: {
      type: Boolean,
      default: false,
    },
    tools: {
      type: [
        {
          _id: false,
          name: { type: String, required: true },
          description: { type: String, default: '' },
        },
      ],
      default: [],
    },
    status: {
      type: String,
      enum: ['connected', 'unreachable', 'never-tested'],
      default: 'never-tested',
    },
    enabled: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

mcpServerSchema.index({ scope: 1, name: 1 });
mcpServerSchema.index(
  { scope: 1, userId: 1, url: 1 },
  {
    unique: true,
    partialFilterExpression: { scope: 'user' },
  },
);

mcpServerSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.headers;
    return ret;
  },
});

export type McpServerDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof mcpServerSchema>
>;

export const McpServer = mongoose.model('McpServer', mcpServerSchema);
