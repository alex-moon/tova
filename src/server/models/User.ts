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

export interface UserDocument extends mongoose.Document {
  email: string;
  passwordHash: string;
  role: 'user' | 'admin';
  googleId: string | null;
  permissions: string[];
  comparePassword: (password: string) => Promise<boolean>;
}

export const User = mongoose.model<UserDocument>('User', userSchema);
