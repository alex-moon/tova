const keys = ['DO_SPACES_KEY', 'DO_SPACES_SECRET', 'DO_SPACES_BUCKET'] as const;

const backup: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of keys) {
    backup[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of keys) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

describe('storageService', () => {
  it('is unconfigured without the DO_SPACES_* vars', () => {
    expect(isStorageConfigured()).toBe(false);
  });

  it('is configured with key, secret and bucket present', () => {
    process.env.DO_SPACES_KEY = 'k';
    process.env.DO_SPACES_SECRET = 's';
    process.env.DO_SPACES_BUCKET = 'tova';
    expect(isStorageConfigured()).toBe(true);
  });

  it('rejects operations when unconfigured instead of crashing', async () => {
    await expect(deleteObject('x')).rejects.toThrow(/not configured/);
  });
});

import { deleteObject, isStorageConfigured } from './storageService';
