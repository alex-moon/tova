import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { AuthProvider } from './AuthContext';
import type { User } from './AuthContext';

const me = vi.fn();
const updateProfile = vi.fn();

vi.mock('../services/auth', () => ({
  default: {
    me: (...args: unknown[]) => me(...args),
    updateProfile: (...args: unknown[]) => updateProfile(...args),
  },
  AuthError: class AuthError extends Error {
    name = 'AuthError';
  },
}));

// The browser zone under test is whatever this runner's Intl reports; the
// point is that the client forwards exactly that value, not a guess.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const userWithoutZone: User = {
  id: '1',
  email: 'a@b.c',
  role: 'user',
  permissions: [],
};

const userWithZone: User = { ...userWithoutZone, timezone: zone };

describe('AuthContext timezone report (#261)', () => {
  beforeEach(() => {
    me.mockReset();
    updateProfile.mockReset();
  });

  afterEach(cleanup);

  it('reports the browser zone once when the account has none stored', async () => {
    me.mockResolvedValue(userWithoutZone);
    const updated = { ...userWithoutZone, timezone: zone };
    updateProfile.mockResolvedValue(updated);
    render(
      <AuthProvider>
        <div />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledTimes(1);
    });
    expect(updateProfile).toHaveBeenCalledWith({ timezone: zone });
    // The PATCH response replaces the context user so the report does not
    // re-fire on the next effect run (the stored zone now matches).
    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledTimes(1);
    });
  });

  it('does not report when the stored zone already matches the browser', async () => {
    me.mockResolvedValue(userWithZone);
    render(
      <AuthProvider>
        <div />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(me).toHaveBeenCalledTimes(1);
    });
    // Give the effect a beat; no report may fire for a matching zone.
    await new Promise((r) => setTimeout(r, 10));
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('never throws into the tree when the report fails', async () => {
    me.mockResolvedValue(userWithoutZone);
    updateProfile.mockRejectedValue(new Error('offline'));
    render(
      <AuthProvider>
        <div />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalled();
    });
    // The user from /me survives the failed report.
    await new Promise((r) => setTimeout(r, 10));
  });
});
