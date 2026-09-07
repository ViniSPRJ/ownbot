import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAcpModelRoutes } from "../src/acp/model-routes";
import { acpModelSelectionFor, acpProfileFor } from "../src/acp/config";
const original = {
  config: process.env.OPENBOT_ACP_CONFIG,
  private: process.env.OPENBOT_PRIVATE_AGENT_IDS,
};
let root: string;
afterEach(() => {
  for (const [key, value] of [
    ["OPENBOT_ACP_CONFIG", original.config],
    ["OPENBOT_PRIVATE_AGENT_IDS", original.private],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});
function setup(role = "admin", exists = true, discoveryFails = false) {
  root = mkdtempSync(join(tmpdir(), "acp-model-routes-"));
  const file = join(root, "profiles.json");
  writeFileSync(
    file,
    JSON.stringify({
      profiles: {
        codex: {
          command: "/secret/cli",
          workspaceRoot: root,
          env: { TOKEN: "hidden" },
        },
      },
      agents: { coord: "codex", quant: "codex", credito: "codex" },
    }),
  );
  process.env.OPENBOT_ACP_CONFIG = file;
  process.env.OPENBOT_PRIVATE_AGENT_IDS = "credito";
  let discoveries = 0;
  const routes = createAcpModelRoutes(
    {
      get: async () =>
        exists ? { id: "coord", systemOwned: true, deletedAt: null } : null,
    } as any,
    async (c, next) => {
      c.set("actor", { id: "owner", role } as any);
      await next();
    },
    undefined,
    async () => {
      discoveries++;
      if (discoveryFails) throw new Error("secret-cli-error");
      return {
        models: [
          { id: "small", name: "Small" },
          { id: "large", name: "Large" },
        ],
        currentModel: "small",
      };
    },
  );
  const put = (body: unknown, id = "coord") =>
    routes.request(`/${id}/acp-models`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { routes, put, file, discoveries: () => discoveries };
}
test("only administrators of accessible, nonprivate ACP agents may discover or change CLI models", async () => {
  const member = setup("user");
  expect((await member.routes.request("/coord/acp-models")).status).toBe(403);
  expect((await member.put({ model: "small", revision: "x" })).status).toBe(
    403,
  );
  expect(member.discoveries()).toBe(0);
});
test("private model boundaries and deleted/unknown agents cannot reach the CLI", async () => {
  const app = setup();
  expect((await app.routes.request("/credito/acp-models")).status).toBe(409);
  expect(app.discoveries()).toBe(0);
});
test("inaccessible agents return 404 without discovery", async () => {
  const app = setup("admin", false);
  expect((await app.routes.request("/coord/acp-models")).status).toBe(404);
  expect(app.discoveries()).toBe(0);
});
test("catalogue contains no credentials; saves affect only the chosen role and survive reload", async () => {
  const app = setup();
  const response = await app.routes.request("/coord/acp-models");
  const body = await response.json();
  expect(JSON.stringify(body)).not.toContain("hidden");
  expect(JSON.stringify(body)).not.toContain("/secret/cli");
  expect(
    (await app.put({ model: "large", revision: body.selection.revision }))
      .status,
  ).toBe(200);
  expect(acpProfileFor("coord")!.model).toBe("large");
  expect(acpProfileFor("quant")!.model).toBeUndefined();
  expect(
    JSON.parse(readFileSync(app.file, "utf8")).profiles.codex.env.TOKEN,
  ).toBe("hidden");
  expect(
    (await app.put({ model: "small", revision: body.selection.revision }))
      .status,
  ).toBe(409);
});
test("unlisted models and executable injection are rejected before persistence", async () => {
  const app = setup();
  const revision = acpModelSelectionFor("coord")!.revision;
  const before = readFileSync(app.file, "utf8");
  expect((await app.put({ model: "made-up", revision })).status).toBe(400);
  expect(
    (await app.put({ model: "small", revision, command: "/bin/sh" })).status,
  ).toBe(400);
  expect(readFileSync(app.file, "utf8")).toBe(before);
});
test("login and CLI errors are sanitized and do not change the selection", async () => {
  const app = setup("admin", true, true);
  const response = await app.routes.request("/coord/acp-models");
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret-cli-error");
  expect(acpProfileFor("coord")!.model).toBeUndefined();
});
