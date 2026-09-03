/**
 * Loaded before any test file, to make module loading deterministic.
 *
 * Deep inside the runtime's dependencies, `@modelcontextprotocol/sdk`
 * does `require("eventsource")` from CommonJS, and eventsource ships as ESM only. Bun permits that
 * only when the module has already been evaluated as ESM by something earlier in the process, so
 * whether it works depends on the order the test files happen to be walked, an order that changes
 * whenever a test file is added or renamed.
 *
 * The failure is not a failing test. The file throws while being imported, so its tests are never
 * registered and never reported.
 *
 * Importing it here evaluates it as ESM once, before anything requires it, so the order no longer
 * decides the outcome. `eventsource` is declared as a dev dependency of this package for the same
 * reason; test determinism depends on it.
 *
 * This compatibility shim is narrow enough to delete when the SDK ships an ESM-safe require or Bun
 * handles it.
 */

import "eventsource";

/**
 * Point the suite at its own database.
 *
 * Every integration test reads `process.env.DATABASE_URL` and falls back to the development URL,
 * which Bun's automatic `.env` loading also supplies, so left alone the suite runs against the same
 * database the local `openbot-server.service` is serving: its sweepers claim the tests' work items
 * and the tests leave rows behind. `TEST_DATABASE_URL` (see `.env.test`, which `bun test` loads
 * because it sets NODE_ENV=test) takes precedence when set; without it, nothing changes.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
