import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Run the fixture with this test runner, including on Linux without Homebrew. */
export async function fixtureCommand(cwd: string): Promise<string> {
  const command = join(cwd, "fixture-pi");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    command,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(import.meta.dir, "fixture-pi.ts"))} "$@"\n`,
    { mode: 0o700 },
  );
  return command;
}
