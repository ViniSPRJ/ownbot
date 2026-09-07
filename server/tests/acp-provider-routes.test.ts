import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAcpProviderRoutes } from "../src/acp/provider-routes";
import { acpProfileFor, acpProviderSelectionFor } from "../src/acp/config";
const original = {
  config: process.env.OPENBOT_ACP_CONFIG,
  private: process.env.OPENBOT_PRIVATE_AGENT_IDS,
};
const roots: string[] = [];
afterEach(() => {
  for (const [key, value] of [
    ["OPENBOT_ACP_CONFIG", original.config],
    ["OPENBOT_PRIVATE_AGENT_IDS", original.private],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup(
  options: {
    role?: string;
    missing?: boolean;
    deleted?: boolean;
    fail?: boolean;
    duringDiscovery?: (file: string) => void;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "acp-providers-"));
  roots.push(root);
  const file = join(root, "profiles.json");
  writeFileSync(
    file,
    JSON.stringify({
      profiles: {
        codex: {
          command: "/secret/codex",
          workspaceRoot: root,
          env: { TOKEN: "secret-value" },
        },
        claude: {
          provider: "claude",
          command: "/secret/claude",
          workspaceRoot: root,
        },
        grok: {
          provider: "grok",
          command: "/secret/grok",
          workspaceRoot: root,
        },
      },
      agents: {
        coord: { profile: "codex", model: "astra" },
        quant: { profile: "codex", model: "terra" },
        credito: "codex",
      },
    }),
  );
  process.env.OPENBOT_ACP_CONFIG = file;
  process.env.OPENBOT_PRIVATE_AGENT_IDS = "credito";
  let calls = 0;
  const routes = createAcpProviderRoutes(
    {
      get: async () =>
        options.missing
          ? null
          : { deletedAt: options.deleted ? new Date() : null },
    } as any,
    async (c, next) => {
      c.set("actor", { id: "owner", role: options.role ?? "admin" } as any);
      await next();
    },
    undefined,
    async (profile) => {
      calls++;
      options.duringDiscovery?.(file);
      if (options.fail) throw new Error("secret-command-failed");
      return { models: [], currentModel: null };
    },
  );
  return {
    file,
    routes,
    calls: () => calls,
    put: (body: unknown, id = "coord") =>
      routes.request(`/${id}/acp-providers`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}
test("only admin can read or update provider settings", async () => {
  const app = setup({ role: "user" });
  expect((await app.routes.request("/coord/acp-providers")).status).toBe(403);
  expect((await app.put({ profileId: "claude", revision: "x" })).status).toBe(
    403,
  );
  expect(app.calls()).toBe(0);
});
test("private, missing and deleted agents cannot start a CLI", async () => {
  const app = setup();
  expect((await app.routes.request("/credito/acp-providers")).status).toBe(409);
  expect(
    (await app.put({ profileId: "claude", revision: "x" }, "credito")).status,
  ).toBe(409);
  const missing = setup({ missing: true });
  expect((await missing.routes.request("/coord/acp-providers")).status).toBe(
    404,
  );
  const deleted = setup({ deleted: true });
  expect((await deleted.routes.request("/coord/acp-providers")).status).toBe(
    404,
  );
  expect(app.calls() + missing.calls() + deleted.calls()).toBe(0);
});
test("catalogue exposes only connection IDs and provider names", async () => {
  const app = setup();
  const response = await app.routes.request("/coord/acp-providers");
  const text = await response.text();
  expect(text).not.toContain("secret");
  expect(text).not.toContain("workspaceRoot");
  expect(JSON.parse(text).selection.profiles).toEqual([
    { id: "codex", provider: "codex" },
    { id: "claude", provider: "claude" },
    { id: "grok", provider: "grok" },
  ]);
});
test("changing a provider clears only its model override and preserves other agents and operator secrets", async () => {
  const app = setup();
  const revision = acpProviderSelectionFor("coord")!.revision;
  expect((await app.put({ profileId: "claude", revision })).status).toBe(200);
  expect(acpProfileFor("coord")!.provider).toBe("claude");
  expect(acpProfileFor("coord")!.model).toBeUndefined();
  expect(acpProfileFor("quant")!.model).toBe("terra");
  expect(
    JSON.parse(readFileSync(app.file, "utf8")).profiles.codex.env.TOKEN,
  ).toBe("secret-value");
  expect(app.calls()).toBe(1);
  expect((await app.put({ profileId: "grok", revision })).status).toBe(409);
});
test("saving the current connection preserves the exact model selection and file", async () => {
  const app = setup();
  const before = readFileSync(app.file, "utf8");
  expect(
    (
      await app.put({
        profileId: "codex",
        revision: acpProviderSelectionFor("coord")!.revision,
      })
    ).status,
  ).toBe(200);
  expect(readFileSync(app.file, "utf8")).toBe(before);
  expect(acpProfileFor("coord")!.model).toBe("astra");
});
test("unlisted profiles, prototype properties, and process injection never start a CLI", async () => {
  const app = setup();
  const revision = acpProviderSelectionFor("coord")!.revision;
  for (const profileId of ["unknown", "__proto__", "constructor"])
    expect((await app.put({ profileId, revision })).status).toBe(400);
  expect(
    (await app.put({ profileId: "claude", revision, command: "/bin/sh" }))
      .status,
  ).toBe(400);
  expect(app.calls()).toBe(0);
});
test("failed ACP handshake is sanitized and preserves the selected runtime", async () => {
  const app = setup({ fail: true });
  const before = readFileSync(app.file, "utf8");
  const response = await app.put({
    profileId: "claude",
    revision: acpProviderSelectionFor("coord")!.revision,
  });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret-command");
  expect(readFileSync(app.file, "utf8")).toBe(before);
});
test("a concurrent model edit during discovery wins instead of being overwritten", async () => {
  const app = setup({
    duringDiscovery: (file) => {
      const config = JSON.parse(readFileSync(file, "utf8"));
      config.agents.quant.model = "updated";
      writeFileSync(file, JSON.stringify(config));
    },
  });
  expect(
    (
      await app.put({
        profileId: "claude",
        revision: acpProviderSelectionFor("coord")!.revision,
      })
    ).status,
  ).toBe(409);
  expect(acpProfileFor("coord")!.model).toBe("astra");
  expect(acpProfileFor("quant")!.model).toBe("updated");
});
test("unmapped agents cannot be silently migrated to a hosted runtime", async () => {
  const app = setup();
  expect((await app.routes.request("/unmapped/acp-providers")).status).toBe(
    409,
  );
  expect(
    (
      await app.put(
        {
          profileId: "claude",
          revision: acpProviderSelectionFor("coord")!.revision,
        },
        "unmapped",
      )
    ).status,
  ).toBe(409);
  expect(app.calls()).toBe(0);
});
