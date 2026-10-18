import mongoose from 'mongoose';

// Formerly McpServer; `type` is the discriminator. `api`/`sdk` reserved.
// @see #329 #328 #327
const connectorSchema = new mongoose.Schema(
  {
    // Rows racing the 20261016 migration default to pat, not validation.
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
      // SSRF guard: https-only, so no write path admits a bad URL.
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
    // mcp.pat auth: AES-256-GCM envelope of the header set; toJSON strips.
    headers: {
      type: {
        iv: { type: String, required: true },
        tag: { type: String, required: true },
        ciphertext: { type: String, required: true },
      },
      default: null,
    },
    // mcp.oauth vault: same envelope over the token blob; toJSON strips.
    // @see #327
    oauth: {
      type: {
        iv: { type: String, required: true },
        tag: { type: String, required: true },
        ciphertext: { type: String, required: true },
      },
      default: null,
    },
    // Set when a proactive refresh fails; cleared by a re-auth.
    // @see #327
    authState: {
      type: String,
      enum: ['ok', 'needs-reauth'],
      default: 'ok',
    },
    // Denormalised so the API can show "auth configured" without secrets.
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

// A user-scope connector needs its owner; platform ones are ownerless.
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

// Collection name pinned: the 20261016 migration renames to exactly this.
export const Connector = mongoose.model('Connector', connectorSchema, 'connectors');
