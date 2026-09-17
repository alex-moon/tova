import mongoose from 'mongoose';

<<<<<<< HEAD
/*
 * MCP server config (issue #36). One collection covers both scopes:
 *  - scope 'platform': seeded from TOVA_MCP_SERVERS env, exposed to all users,
 *    editable only through the admin route.
 *  - scope 'user': personal servers, owner = userId, managed via
 *    /api/mcp-servers.
 *
 * The `headers` field holds an AES-256-GCM envelope (services/crypto.ts) and
 * is stripped from serialization — only `headersConfigured` is ever exposed,
 * and header values are never logged or returned.
 */
=======
>>>>>>> origin/feat/36-mcp-support
const mcpServerSchema = new mongoose.Schema(
  {
    scope: {
      type: String,
      enum: ['platform', 'user'],
      required: true,
    },
<<<<<<< HEAD
=======
    // Required when scope is 'user'; null/absent for platform servers.
>>>>>>> origin/feat/36-mcp-support
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
<<<<<<< HEAD
    },
    headers: {
      type: { iv: String, tag: String, ciphertext: String },
      default: null,
    },
=======
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
>>>>>>> origin/feat/36-mcp-support
    headersConfigured: {
      type: Boolean,
      default: false,
    },
    tools: {
      type: [
        {
<<<<<<< HEAD
=======
          _id: false,
>>>>>>> origin/feat/36-mcp-support
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
<<<<<<< HEAD
    toJSON: {
      transform(_doc, ret) {
        delete ret.headers;
        return ret;
      },
    },
  },
);

=======
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
>>>>>>> origin/feat/36-mcp-support
mcpServerSchema.index(
  { scope: 1, userId: 1, url: 1 },
  {
    unique: true,
    partialFilterExpression: { scope: 'user' },
  },
);
<<<<<<< HEAD
mcpServerSchema.index({ scope: 1, enabled: 1 });
=======

mcpServerSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret.headers;
    return ret;
  },
});
>>>>>>> origin/feat/36-mcp-support

export type McpServerDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof mcpServerSchema>
>;

export const McpServer = mongoose.model('McpServer', mcpServerSchema);
