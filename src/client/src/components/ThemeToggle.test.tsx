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

describe('ThemeToggle (issue #41 resolver)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  afterEach(cleanup);

  it('sets no class on a fresh load with no stored choice', async () => {
    mockPrefersDark(true);
    const ThemeToggle = await load();
    render(<ThemeToggle />);
    expect(document.documentElement).not.toHaveClass('dark');
    expect(document.documentElement).not.toHaveClass('light');
  });

  it('keeps an explicit light choice when the system prefers dark', async () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    mockPrefersDark(true);
    const ThemeToggle = await load();
    render(<ThemeToggle />);
    expect(document.documentElement).toHaveClass('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

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
});
