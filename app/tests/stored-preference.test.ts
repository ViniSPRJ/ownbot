import { afterEach, describe, expect, test } from "bun:test";
import { readStoredPreference } from "../src/lib/stored-preference";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("preferences across the OwnBot rename", () => {
  const pairs = [
    ["ownbot-theme", "openbot-theme", "light"],
    ["ownbot-sidebar", "openbot-sidebar", "collapsed"],
    ["ownbot.workspace-mode", "openbot.workspace-mode", "cowork"],
    ["ownbot.cowork-coworkers", "openbot.cowork-coworkers", '["codeexec"]'],
    ["ownbot.bot-thread.coord", "openbot.bot-thread.coord", "existing-thread"],
  ] as const;

  for (const [key, legacyKey, previous] of pairs) {
    test(`${key} retains the existing browser value until replaced`, () => {
      const values = new Map<string, string>([[legacyKey, previous]]);
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: (name: string) => values.get(name) ?? null },
      });
      expect(readStoredPreference(key, legacyKey)).toBe(previous);
      values.set(key, "current-value");
      expect(readStoredPreference(key, legacyKey)).toBe("current-value");
      values.set(key, "");
      expect(readStoredPreference(key, legacyKey)).toBe("");
      expect(values.get(legacyKey)).toBe(previous);
    });
  }

  test("an unavailable storage accessor does not interrupt application startup", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage is disabled");
      },
    });
    expect(readStoredPreference("ownbot-theme", "openbot-theme")).toBeNull();
  });
});
