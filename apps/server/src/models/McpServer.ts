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
      // SSRF guard (issue #36): MCP client connects are outbound HTTP; only
      // https URLs are accepted. The API route validates too, but the model
      // must not let a bad URL through via any other write path.
      validate: {
        validator: (value: string) => {
          try {
            const parsed = new URL(value);
            return parsed.protocol === 'https:' && !!parsed.hostname;
          } catch {
            return false;
          }
        },
        message: 'MCP server url must be a valid https URL',
      },
    },
    // AES-256-GCM envelope (apps/server/src/services/crypto.ts). Secret material at
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

// A user-scope server must carry its owner; platform servers must be ownerless.
const validateScopeOwnership = function (this: { scope?: string; userId?: unknown }): boolean {
  if (this.scope === 'user') return !!this.userId;
  if (this.scope === 'platform') return this.userId == null;
  return false;
};
mcpServerSchema.path('userId').validate(validateScopeOwnership, 'userId ownership mismatch');

mcpServerSchema.index({ scope: 1, name: 1 });
mcpServerSchema.index({ scope: 1, enabled: 1 });

mcpServerSchema.index(
  { scope: 1, userId: 1, url: 1 },
  {
    unique: true,
    partialFilterExpression: { scope: 'user' },
  },
);

mcpServerSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret.headers;
    return ret;
  },
});

export type McpServerDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof mcpServerSchema>
>;

export const McpServer = mongoose.model('McpServer', mcpServerSchema);
