import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COOKIE_NAME,
  STORAGE_KEY,
  applyTheme,
  persistTheme,
  readStoredTheme,
  resolveTheme,
} from './theme';

const setCookie = (value: string) => {
  document.cookie = `${COOKIE_NAME}=${value};path=/`;
};

const clearCookie = () => {
  document.cookie = `${COOKIE_NAME}=;path=/;max-age=0`;
};

const mockPrefersDark = (dark: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' ? dark : false,
    media: query,
  })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  document.cookie = '';
  clearCookie();
  localStorage.clear();
  document.documentElement.className = '';
  mockPrefersDark(false);
});

describe('resolveTheme', () => {
  it('defaults to light with no cookie, storage, or system preference', () => {
    expect(resolveTheme()).toBe('light');
  });

  it('follows dark system preference when nothing is stored', () => {
    mockPrefersDark(true);
    expect(resolveTheme()).toBe('dark');
  });

  it('cookie beats localStorage', () => {
    mockPrefersDark(true);
    setCookie('light');
    localStorage.setItem(STORAGE_KEY, 'dark');
    expect(resolveTheme()).toBe('light');
  });

  it('localStorage beats system preference', () => {
    mockPrefersDark(true);
    localStorage.setItem(STORAGE_KEY, 'light');
    expect(resolveTheme()).toBe('light');
  });

  it('ignores invalid cookie and storage values', () => {
    setCookie('sepia');
    localStorage.setItem(STORAGE_KEY, 'sepia');
    expect(resolveTheme()).toBe('light');
  });
});

describe('applyTheme', () => {
  it('sets exactly one class', () => {
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    applyTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });
});

describe('persistTheme', () => {
  it('writes localStorage and cookie', () => {
    persistTheme('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    expect(readStoredTheme()).toBe('dark');
    expect(document.cookie).toContain(`${COOKIE_NAME}=dark`);
  });
});

describe('readStoredTheme', () => {
  it('returns undefined when storage is empty or invalid', () => {
    expect(readStoredTheme()).toBeUndefined();
    localStorage.setItem(STORAGE_KEY, 'nope');
    expect(readStoredTheme()).toBeUndefined();
  });
});

describe('blocked storage', () => {
  it('resolveTheme falls back to system preference when localStorage throws', () => {
    mockPrefersDark(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(resolveTheme()).toBe('dark');
  });

  it('persistTheme still writes the cookie when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    persistTheme('dark');
    expect(document.cookie).toContain(`${COOKIE_NAME}=dark`);
  });
});
