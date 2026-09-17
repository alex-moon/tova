import mongoose from 'mongoose';

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
const mcpServerSchema = new mongoose.Schema(
  {
    scope: {
      type: String,
      enum: ['platform', 'user'],
      required: true,
    },
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
    headers: {
      type: { iv: String, tag: String, ciphertext: String },
      default: null,
    },
    headersConfigured: {
      type: Boolean,
      default: false,
    },
    tools: {
      type: [
        {
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
    toJSON: {
      transform(_doc, ret) {
        delete ret.headers;
        return ret;
      },
    },
  },
);

mcpServerSchema.index(
  { scope: 1, userId: 1, url: 1 },
  {
    unique: true,
    partialFilterExpression: { scope: 'user' },
  },
);
mcpServerSchema.index({ scope: 1, enabled: 1 });

export type McpServerDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof mcpServerSchema>
>;

export const McpServer = mongoose.model('McpServer', mcpServerSchema);
