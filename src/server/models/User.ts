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
    // Profile fields (issue #35). `name` and `avatarUrl` are optional: only
    // present once populated (Google login or PATCH /api/profile).
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
          // Theme preference (issue #53): null = no explicit choice, the
          // client follows prefers-color-scheme then light.
          theme: {
            type: String,
            enum: ['light', 'dark'],
            default: null,
          },
          // Startup-chat preference (issue #96): null = no explicit choice;
          // the client starts from the most recent chat then.
          startupChat: {
            type: String,
            enum: ['recent', 'new'],
            default: null,
          },
          // Delete-confirmation preferences (issue #59): only `false` is ever
          // written explicitly ("Always" or a Profile toggle); absent keys
          // default to true, so legacy docs need no backfill.
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
    // Coarse country-level geolocation (issue #50), resolved server-side from
    // the request IP. Absent = unresolved; only country/countryCode and the
    // resolution timestamp are ever stored — no city or lat/lon data.
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

// Method to check password
userSchema.methods.comparePassword = async function (this: UserDocument, password: string) {
  return bcrypt.compare(password, this.passwordHash);
};

export interface UserSettings {
  customInstructions: string | null;
  // Absent at the TS level when never written; runtime default is null = no
  // explicit preference (issue #53). Marked optional so existing partial
  // literals (`{ customInstructions }`) keep typechecking.
  theme?: 'light' | 'dark';
  startupChat?: 'recent' | 'new';
  confirmDeletes?: { chat: boolean; file: boolean } | null;
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
