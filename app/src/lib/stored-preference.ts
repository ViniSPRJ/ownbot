/** Read the OwnBot preference first, retaining the prior brand's saved browser state. */
export function readStoredPreference(
  key: string,
  legacyKey: string,
): string | null {
  try {
    const storage = globalThis.localStorage;
    return storage?.getItem(key) ?? storage?.getItem(legacyKey) ?? null;
  } catch {
    // Blocked storage must not hide the app or prevent a chat from opening.
    return null;
  }
}
