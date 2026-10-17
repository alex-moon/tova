import mongoose from 'mongoose';

// The model formerly known as McpServer; `type` is the discriminator. `api`/`sdk` are reserved names.
// @see #329 #328 #327
const connectorSchema = new mongoose.Schema(
  {
    // Default makes any row racing the 20261016 migration behave as a pat connector, not fail validation.
    type: {
      type: String,
      enum: ['mcp.pat', 'mcp.oauth'],
      required: true,
      default: 'mcp.pat',
    },
    scope: {
      type: String,
      enum: ['platform', 'user'],
      required: true,
    },
    // Required when scope is 'user'; null/absent for platform connectors.
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
      // SSRF guard: https-only, enforced at the model so no write path lets a bad URL through.
      // @see #36
      validate: {
        validator: (value: string) => {
          try {
            const parsed = new URL(value);
            return parsed.protocol === 'https:' && !!parsed.hostname;
          } catch {
            return false;
          }
        },
        message: 'Connector url must be a valid https URL',
      },
    },
    // mcp.pat auth material: AES-256-GCM envelope of the auth header set; toJSON strips it entirely.
    headers: {
      type: {
        iv: { type: String, required: true },
        tag: { type: String, required: true },
        ciphertext: { type: String, required: true },
      },
      default: null,
    },
    // mcp.oauth token vault: same envelope shape over the OAuth token blob; toJSON strips it.
    // @see #327
    oauth: {
      type: {
        iv: { type: String, required: true },
        tag: { type: String, required: true },
        ciphertext: { type: String, required: true },
      },
      default: null,
    },
    // 'needs-reauth' when a proactive token refresh fails; cleared by a successful re-auth.
    // @see #327
    authState: {
      type: String,
      enum: ['ok', 'needs-reauth'],
      default: 'ok',
    },
    // Denormalized so the API can show "auth configured" without exposing the header itself.
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

// A user-scope connector must carry its owner; platform ones must be ownerless.
const validateScopeOwnership = function (this: { scope?: string; userId?: unknown }): boolean {
  if (this.scope === 'user') return !!this.userId;
  if (this.scope === 'platform') return this.userId == null;
  return false;
};
connectorSchema.path('userId').validate(validateScopeOwnership, 'userId ownership mismatch');

connectorSchema.index({ scope: 1, name: 1 });
connectorSchema.index({ scope: 1, enabled: 1 });

connectorSchema.index(
  { scope: 1, userId: 1, url: 1 },
  {
    unique: true,
    partialFilterExpression: { scope: 'user' },
  },
);

connectorSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret.headers;
    delete ret.oauth;
    return ret;
  },
});

export type ConnectorDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof connectorSchema>
>;

// Collection name pinned explicitly: the 20261016 migration renames the legacy collection to exactly this.
export const Connector = mongoose.model('Connector', connectorSchema, 'connectors');
