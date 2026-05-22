import { createContext, useContext, type ReactNode } from 'react';

const ThemeContext = createContext({});

export const useThemeMode = () => useContext(ThemeContext);

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  return <ThemeContext.Provider value={{}}>{children}</ThemeContext.Provider>;
}
