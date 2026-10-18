import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    googleId: {
      type: String,
      default: null,
    },
    permissions: {
      type: [String],
      default: [],
    },
    // Profile fields; filled by Google login or PATCH /api/profile.
    // @see #35
    name: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    avatarUrl: {
      type: String,
      default: null,
    },
    // User-owned (never written by Google); set only via PATCH /api/profile.
    preferredName: {
      type: String,
      trim: true,
      maxlength: 20,
      default: null,
    },
    // Per-user settings; created lazily on first write (no backfill needed).
    settings: {
      type: new mongoose.Schema(
        {
          customInstructions: {
            type: String,
            maxlength: 4000,
            default: null,
          },
          // null = no explicit choice; client follows prefers-color-scheme.
          // @see #53
          theme: {
            type: String,
            enum: ['light', 'dark'],
            default: null,
          },
          // null = no explicit choice; client starts from latest chat.
          // @see #96
          startupChat: {
            type: String,
            enum: ['recent', 'new'],
            default: null,
          },
          // When true, turns and attachments are never persisted.
          // @see #116
          zdr: {
            type: Boolean,
            default: false,
          },
          // Browser IANA zone; absent = unknown, prompt falls back to UTC.
          // @see #266 #261
          timezone: {
            type: String,
            maxlength: 64,
            default: null,
          },
          // Only `false` is written explicitly; absent defaults to true.
          // @see #59
          confirmDeletes: {
            type: new mongoose.Schema(
              {
                chat: { type: Boolean, default: true },
                file: { type: Boolean, default: true },
              },
              { _id: false },
            ),
            default: null,
          },
        },
        { _id: false },
      ),
      default: null,
    },
    // Coarse country-level geolocation; no city or lat/lon stored.
    // @see #50
    location: {
      type: new mongoose.Schema(
        {
          country: { type: String, maxlength: 100 },
          countryCode: { type: String, uppercase: true, maxlength: 2 },
          resolvedAt: { type: Date },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Hash password before saving
userSchema.pre('save', async function () {
  if (!this.isModified('passwordHash')) return;

  try {
    const salt = await bcrypt.genSalt(10);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
  } catch (err: unknown) {
    throw err;
  }
});

userSchema.methods.comparePassword = async function (this: UserDocument, password: string) {
  return bcrypt.compare(password, this.passwordHash);
};

export interface UserSettings {
  customInstructions: string | null;
  // Optional so partial literals typecheck; runtime default null.
  // @see #53
  theme?: 'light' | 'dark';
  startupChat?: 'recent' | 'new';
  zdr?: boolean;
  confirmDeletes?: { chat: boolean; file: boolean } | null;
  timezone?: string | null;
}

export interface UserLocation {
  country: string | null;
  countryCode: string | null;
  resolvedAt: Date | null;
}

export interface UserDocument extends mongoose.Document {
  email: string;
  passwordHash: string;
  role: 'user' | 'admin';
  googleId: string | null;
  permissions: string[];
  name: string | null;
  avatarUrl: string | null;
  preferredName: string | null;
  settings: UserSettings | null;
  location: UserLocation | null;
  createdAt: Date;
  updatedAt: Date;
  comparePassword: (password: string) => Promise<boolean>;
}

export const User = mongoose.model<UserDocument>('User', userSchema);
