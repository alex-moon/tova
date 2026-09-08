import React, { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

const STORAGE_KEY = 'tova-theme';

type Theme = 'light' | 'dark';

const systemPrefersDark =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

const applyTheme = (theme: Theme | null) => {
  if (typeof document === 'undefined') return;
  const dark = theme ? theme === 'dark' : systemPrefersDark;
  document.documentElement.classList.toggle('dark', dark);
};

const ThemeToggle: React.FC = () => {
  const [theme, setTheme] = useState<Theme | null>(() => {
    if (typeof localStorage === 'undefined') return null;
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggle = () => {
    const current = theme === null ? (systemPrefersDark ? 'dark' : 'light') : theme;
    const next: Theme = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY, next);
    setTheme(next);
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={
        theme === 'dark' || (theme === null && systemPrefersDark)
          ? 'Switch to light mode'
          : 'Switch to dark mode'
      }
      onClick={toggle}
    >
      {theme === 'dark' || (theme === null && systemPrefersDark) ? <Sun /> : <Moon />}
    </Button>
  );
};

export default ThemeToggle;
