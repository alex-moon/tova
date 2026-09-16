export type Theme = 'light' | 'dark';

export const STORAGE_KEY = 'tova-theme';
export const COOKIE_NAME = 'tova-theme';

/**
 * Standalone twin: src/client/index.html carries a verbatim inline copy of
 * this logic that runs before the bundle loads (keep in sync).
 */
const readLocalStorage = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // blocked storage (e.g. some privacy modes); inline twin does the same
  }
};

export function resolveTheme(): Theme {
  const cookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  const fromCookie = cookie?.split('=')[1];
  if (fromCookie === 'light' || fromCookie === 'dark') return fromCookie;

  const stored = readLocalStorage();
  if (stored === 'light' || stored === 'dark') return stored;

  const prefersDark =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
}

export function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // cookie still written below — blocked storage must not lose the choice
  }
  document.cookie = `${COOKIE_NAME}=${theme};path=/;SameSite=Lax;max-age=31536000`;
}

export function readStoredTheme(): Theme | undefined {
  const stored = readLocalStorage();
  return stored === 'light' || stored === 'dark' ? stored : undefined;
}

/**
 * Apply an explicit per-user theme preference (issue #53) once the profile
 * is known. The user record is the source of truth once logged in: it wins
 * over device storage, and it is mirrored back into both stores so the
 * inline-script fast path (cookie → localStorage → system → light) paints
 * the account's theme on the next load without waiting for the profile
 * fetch. No saved preference keeps the device behaviour untouched.
 */
export function applyUserTheme(userTheme: string | undefined | null): void {
  if (userTheme === 'light' || userTheme === 'dark') {
    persistTheme(userTheme);
    applyTheme(userTheme);
  }
}
