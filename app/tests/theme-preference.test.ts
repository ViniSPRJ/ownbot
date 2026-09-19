import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  applyDarkTheme,
  parseStoredDarkTheme,
  THEME_STORAGE_KEY,
} from "../src/lib/theme";

describe("theme preference", () => {
  test("defaults to dark while preserving an explicit light preference", () => {
    expect(parseStoredDarkTheme("dark")).toBe(true);
    expect(parseStoredDarkTheme("light")).toBe(false);
    expect(parseStoredDarkTheme(null)).toBe(true);
  });

  test("persists and applies the selected theme", () => {
    const writes: Array<[string, string]> = [];
    const toggles: Array<[string, boolean]> = [];
    const schemes: Array<string> = [];

    applyDarkTheme(true, {
      setStoredValue: (key, value) => writes.push([key, value]),
      toggleRootClass: (name, force) => toggles.push([name, force]),
      setRootColorScheme: (scheme) => schemes.push(scheme),
    });

    expect(writes).toEqual([[THEME_STORAGE_KEY, "dark"]]);
    expect(toggles).toEqual([["dark", true]]);
    expect(schemes).toEqual(["dark"]);
  });
});

describe("pre-paint theme boot", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  test("the boot script reads the same storage key the app writes", () => {
    expect(html).toContain(THEME_STORAGE_KEY);
  });

  test("the first paint retains a legacy light theme until a new preference is saved", () => {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const stored = new Map<string, string>([["openbot-theme", "light"]]);
    const classes = new Set<string>();
    const root = {
      classList: {
        toggle: (name: string, enabled: boolean) => {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
      },
      style: { colorScheme: "" },
    };
    const boot = new Function("window", "document", script!);
    const browser = {
      localStorage: { getItem: (key: string) => stored.get(key) ?? null },
    };
    boot(browser, { documentElement: root });
    expect(classes.has("dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");
    stored.set(THEME_STORAGE_KEY, "dark");
    boot(browser, { documentElement: root });
    expect(classes.has("dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");
  });

  test("the boot script runs before the first paint", () => {
    const boot = html.match(/<script(?![^>]*\bsrc=)[^>]*>/);

    expect(boot).not.toBeNull();
    expect(boot?.[0]).not.toContain("module");
    expect(boot?.[0]).not.toContain("defer");
  });

  test("the boot script applies the dark class itself", () => {
    expect(html).toContain("documentElement");
    expect(html).toMatch(/classList[\s\S]*dark/);
  });

  test("the document declares a color scheme before the stylesheet arrives", () => {
    expect(html).toContain("colorScheme");
  });
});

describe("color scheme", () => {
  const styles = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );

  test("both themes tell the browser which one they are", () => {
    expect(styles).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light/);
    expect(styles).toMatch(/\.dark\s*\{[\s\S]*?color-scheme:\s*dark/);
  });
});
