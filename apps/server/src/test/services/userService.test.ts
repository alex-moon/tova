import { User } from '../../main/models/User';
import { resolveOrCreateUser } from '../../main/services/userService';

// Duplicate-email races collapse onto the winner instead of surfacing 500s.
// @see #397

describe('resolveOrCreateUser', () => {
  it('creates a user with a random password hash and no googleId when none given', async () => {
    const user = await resolveOrCreateUser('svc-new@example.com');
    expect(user.email).toBe('svc-new@example.com');
    // The schema pre-save hook hashes whatever random material arrived.
    expect(user.passwordHash).toMatch(/^\$2b\$/);
    expect(user.googleId ?? undefined).toBeUndefined();
  });

  it('returns the existing user and links the Google identity', async () => {
    await User.create({ email: 'svc-existing@example.com', passwordHash: 'x' });
    const user = await resolveOrCreateUser('svc-existing@example.com', 'g-1', {
      name: 'Ada',
    });
    expect(String(user.googleId)).toBe('g-1');
    expect(user.name).toBe('Ada');
  });

  it('returns the winner when create loses a concurrent duplicate race (#397)', async () => {
    const existing = await User.create({
      email: 'svc-race@example.com',
      passwordHash: 'x',
    });
    // Entry findOne misses (loser has not seen the winner yet), create hits
    // the unique index, catch-time findOne finds the winner.
    const findSpy = jest
      .spyOn(User, 'findOne')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing);
    const createSpy = jest
      .spyOn(User, 'create')
      .mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));

    try {
      // The loser returns the winner unlinked; the next login links it.
      const user = await resolveOrCreateUser('svc-race@example.com', 'g-2');
      expect(String(user._id)).toBe(String(existing._id));
    } finally {
      findSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it('rethrows a 11000 with no row to fall back to (row vanished)', async () => {
    const createSpy = jest
      .spyOn(User, 'create')
      .mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));

    try {
      await expect(resolveOrCreateUser('svc-ghost@example.com')).rejects.toThrow(/E11000/u);
    } finally {
      createSpy.mockRestore();
    }
  });

  it('rethrows non-11000 create failures untouched', async () => {
    const createSpy = jest.spyOn(User, 'create').mockRejectedValue(new Error('mongo down'));

    try {
      await expect(resolveOrCreateUser('svc-down@example.com')).rejects.toThrow(/mongo down/u);
    } finally {
      createSpy.mockRestore();
    }
  });
});
