import { vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE_NAME, STORAGE_KEY } from '../main/theme';

const SOURCE = readFileSync(
  new URL(import.meta.url).pathname.replace(/theme\.inline\.test\.ts$/, '../../index.html'),
  'utf8',
);

const script = /<script>([\s\S]*?)<\/script>/.exec(SOURCE)?.[1];

const runInlineScript = (): void => {
  if (!script) throw new Error('inline theme script not found in apps/client/index.html');
  new Function(script)();
};

const mockPrefersDark = (dark: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' ? dark : false,
    media: query,
  })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  document.cookie = `${COOKIE_NAME}=;path=/;max-age=0`;
  localStorage.clear();
  document.documentElement.className = '';
  delete (window as { matchMedia?: unknown }).matchMedia;
});

// The inline head script twins theme.ts's resolve logic; run the actual script text so drift fails loudly.
describe('inline theme script (apps/client/index.html)', () => {
  it('exists as a standalone script block', () => {
    expect(script).toContain('tova-theme=');
  });

  it('adds the light class when nothing is known (default order)', () => {
    runInlineScript();
    expect(document.documentElement).toHaveClass('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('adds the dark class when the system prefers dark', () => {
    mockPrefersDark(true);
    runInlineScript();
    expect(document.documentElement).toHaveClass('dark');
  });

  it('honors the cookie over localStorage and the system preference', () => {
    document.cookie = `${COOKIE_NAME}=light;path=/`;
    localStorage.setItem(STORAGE_KEY, 'dark');
    mockPrefersDark(true);
    runInlineScript();
    expect(document.documentElement).toHaveClass('light');
  });

  it('honors localStorage over the system preference when the cookie is invalid', () => {
    document.cookie = `${COOKIE_NAME}=sepia;path=/`;
    localStorage.setItem(STORAGE_KEY, 'dark');
    mockPrefersDark(true);
    runInlineScript();
    expect(document.documentElement).toHaveClass('dark');
  });

  it('falls back to light when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    runInlineScript();
    expect(document.documentElement).toHaveClass('light');
  });
});
