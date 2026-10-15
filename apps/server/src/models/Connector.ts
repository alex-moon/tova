import mongoose from 'mongoose';

/*
 * Connector (#329, epic #328) — the model formerly known as McpServer. The
 * product concept is "connectors"; `type` is the discriminator. Only
 * `mcp.pat` is storable today (#329); #327 extends the enum with 'mcp.oauth'.
 * `api` / `sdk` are reserved contract names (apps/shared/src/connectors.ts),
 * rejected at validation, never stored.
 */
const connectorSchema = new mongoose.Schema(
  {
    // Required with a default: the default makes any row that races the
    // 20261016 migration (rename + type backfill) behave as a pat connector
    // instead of failing validation.
    type: {
      type: String,
      enum: ['mcp.pat'],
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
        message: 'Connector url must be a valid https URL',
      },
    },
    // mcp.pat auth material: AES-256-GCM envelope
    // (apps/server/src/services/crypto.ts) of the auth header set. Secret
    // material at rest is only these three fields; the toJSON transform below
    // strips the whole envelope so no API response ever echoes it. #327 adds
    // the mcp.oauth token vault alongside, not inside, this field.
    headers: {
      type: {
        iv: { type: String, required: true },
        tag: { type: String, required: true },
        ciphertext: { type: String, required: true },
      },
      default: null,
    },
    // Denormalized so the API can show "auth configured" (wire field
    // `authConfigured`) without exposing anything about the header itself.
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
    return ret;
  },
});

export type ConnectorDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof connectorSchema>
>;

// Collection name pinned explicitly: the 20261016 migration renames the
// legacy `mcpservers` collection to exactly this.
export const Connector = mongoose.model('Connector', connectorSchema, 'connectors');
