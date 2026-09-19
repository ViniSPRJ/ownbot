import { resolve } from "node:path";

// Standalone services keep independent lockfiles and are deliberately not root workspaces.
// The root suite imports their tests and spawns their entrypoints, so install them together.
const root = resolve(import.meta.dir, "..");
for (const directory of [
  ".",
  "agent-bot",
  "agent-langgraph",
  "agent-computer",
  "supervisor",
  "integrations/pi-acp",
]) {
  console.log(`Installing ${directory} from its lockfile`);
  const installer = Bun.spawn(
    [process.execPath, "install", "--frozen-lockfile"],
    {
      cwd: resolve(root, directory),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await installer.exited;
  if (code !== 0) process.exit(code);
}
