import { createContext, useContext, useState, useEffect, forwardRef, type ReactNode } from 'react';

type ThemeMode = 'light' | 'dark';

interface ThemeContextType {
  mode: ThemeMode;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextType>({ mode: 'light', toggle: () => {} });

export const useThemeMode = () => useContext(ThemeContext);

export const ThemeModeProvider = forwardRef<HTMLDivElement, { children: ReactNode }>(({ children }, _ref) => {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem('theme-mode');
    if (stored === 'dark' || stored === 'light') return stored;
    return 'light';
  });

  useEffect(() => {
    localStorage.setItem('theme-mode', mode);
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    if (mode === 'dark') root.classList.add('dark');
  }, [mode]);

  const toggle = () => setMode(m => (m === 'light' ? 'dark' : 'light'));

  return <ThemeContext.Provider value={{ mode, toggle }}>{children}</ThemeContext.Provider>;
});

ThemeModeProvider.displayName = 'ThemeModeProvider';
