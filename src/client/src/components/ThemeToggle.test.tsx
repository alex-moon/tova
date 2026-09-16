import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const STORAGE_KEY = 'tova-theme';

const mockPrefersDark = (dark: boolean) => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue({ matches: dark }),
  });
};

const load = async () => {
  const mod = await import('./ThemeToggle');
  return mod.default;
};

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.removeItem(STORAGE_KEY);
    document.cookie = `${STORAGE_KEY}=;path=/;max-age=0`;
    document.documentElement.className = '';
  });

  afterEach(cleanup);

  it('toggles from system dark to explicit light and back to dark', async () => {
    mockPrefersDark(true);
    const ThemeToggle = await load();
    render(<ThemeToggle />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(document.documentElement).toHaveClass('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Switch to dark mode');
    fireEvent.click(button);
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement).not.toHaveClass('light');
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Switch to light mode');
  });

  it('keeps an explicit light choice when the system prefers dark', async () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    mockPrefersDark(true);
    const ThemeToggle = await load();
    render(<ThemeToggle />);
    expect(document.documentElement).toHaveClass('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('keeps the dark class set at first paint when the system prefers dark (no stored choice)', async () => {
    // Regression: with the CSS system fallback removed, dropping both classes
    // after mount flipped dark-system users to light mid-session.
    mockPrefersDark(true);
    const ThemeToggle = await load();
    render(<ThemeToggle />);
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement).not.toHaveClass('light');
  });

  it('shows light when the system prefers light and nothing is stored', async () => {
    mockPrefersDark(false);
    const ThemeToggle = await load();
    render(<ThemeToggle />);
    expect(document.documentElement).toHaveClass('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('honors the cookie mirror over the system preference after mount', async () => {
    // Pre-auth page-load case: inline script resolves from the cookie; the
    // toggle must not undo it.
    document.cookie = `${STORAGE_KEY}=light;path=/`;
    mockPrefersDark(true);
    const ThemeToggle = await load();
    render(<ThemeToggle />);
    expect(document.documentElement).toHaveClass('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('persists the choice to both localStorage and the cookie on toggle', async () => {
    mockPrefersDark(false);
    const ThemeToggle = await load();
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(document.cookie).toContain(`${STORAGE_KEY}=dark`);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });
});
