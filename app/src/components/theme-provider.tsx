import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  applyDarkTheme,
  parseStoredDarkTheme,
  THEME_STORAGE_KEY,
} from "@/lib/theme";

type ThemeContextValue = {
  dark: boolean;
  setDark: (dark: boolean) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(() => {
    try {
      return parseStoredDarkTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      return parseStoredDarkTheme(null);
    }
  });

  useEffect(() => {
    applyDarkTheme(dark, {
      setStoredValue: (key, value) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {}
      },
      toggleRootClass: (name, force) =>
        document.documentElement.classList.toggle(name, force),
      setRootColorScheme: (scheme) => {
        document.documentElement.style.colorScheme = scheme;
      },
    });
  }, [dark]);

  return (
    <ThemeContext.Provider value={{ dark, setDark }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);

  if (!value) {
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return value;
}
