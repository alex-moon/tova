import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

import { getJwtSecret } from '../config/jwt';
import { Pat } from '../models/Pat';
import { User } from '../models/User';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

export const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as {
      id: string;
      email: string;
      role: string;
    };
    req.user = decoded;
    next();
  } catch (_err) {
    res.clearCookie('token');
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

export const requireRole =
  (...roles: string[]) =>
  (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    next();
  };

// PAT bearer auth for admin routes (#184). An Authorization header opts in
// to token auth and must carry a valid, unexpired, unrevoked PAT; without
// one the cookie session flow applies unchanged. The creator's role is
// loaded live on every request (never baked into the token), so demoting a
// user demotes their PATs immediately. Every failure mode answers with the
// same 401 message — no oracle for whether a hash exists.
export const authenticateBearerOrSession = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const header = req.headers.authorization;
  if (!header) return authenticate(req, res, next);

  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  const reject = () => res.status(401).json({ message: 'Invalid or expired token' });
  if (!token) return reject();

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const pat = await Pat.findOne({ tokenHash });
    if (!pat || (pat.expiresAt && pat.expiresAt.getTime() <= Date.now())) return reject();

    const creator = await User.findById(pat.userId);
    if (!creator) return reject();

    req.user = { id: creator._id.toString(), email: creator.email, role: creator.role };
    // Usage stamp for the Access tab: diagnostics only, never worth
    // failing or slowing a request over.
    pat.updateOne({ lastUsedAt: new Date() }).catch(() => {});
    next();
  } catch (_err) {
    res.status(500).json({ message: 'Error authenticating token' });
  }
};
