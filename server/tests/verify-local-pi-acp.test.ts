import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertOptIn,
  loadOperatorConfig,
  OPT_IN_ENV,
  parseVerifyArgs,
  runVerify,
  scopedAdapterEnv,
  selectCatalogModel,
  TIMEOUT_MS,
} from "../scripts/verify-local-pi-acp";

const dirs: string[] = [];
const validModel = {
  id: "m4",
  name: "M4",
  model: "nemotron",
  baseUrl: "http://100.92.206.45:8081/v1",
};
const validConfig = {
  piCommand: "/usr/bin/true",
  defaultModel: "m4",
  models: [validModel],
};

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function writeConfig(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "verify-local-pi-acp-test-"));
  dirs.push(dir);
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify(value));
  return file;
}

describe("parseVerifyArgs", () => {
  test("requires absolute --config and catalogue --model", () => {
    const parsed = parseVerifyArgs([
      "--config",
      "/tmp/pi-acp.json",
      "--model",
      "m4",
    ]);
    expect(parsed).toEqual({
      config: "/tmp/pi-acp.json",
      model: "m4",
      timeoutMs: TIMEOUT_MS.default,
    });
  });

  test("accepts bounded --timeout-ms", () => {
    expect(
      parseVerifyArgs([
        "--config",
        "/tmp/pi-acp.json",
        "--model",
        "m4",
        "--timeout-ms",
        "1000",
      ]).timeoutMs,
    ).toBe(1000);
    expect(
      parseVerifyArgs([
        "--config",
        "/tmp/pi-acp.json",
        "--model",
        "m4",
        "--timeout-ms",
        String(TIMEOUT_MS.max),
      ]).timeoutMs,
    ).toBe(TIMEOUT_MS.max);
  });

  test("rejects missing flags, relative config, and unknown arguments", () => {
    expect(() => parseVerifyArgs([])).toThrow("--config is required");
    expect(() => parseVerifyArgs(["--config", "/tmp/pi-acp.json"])).toThrow(
      "--model is required",
    );
    expect(() => parseVerifyArgs(["--model", "m4"])).toThrow(
      "--config is required",
    );
    expect(() =>
      parseVerifyArgs(["--config", "pi-acp.json", "--model", "m4"]),
    ).toThrow("--config must be an absolute path");
    expect(() =>
      parseVerifyArgs([
        "--config",
        "/tmp/pi-acp.json",
        "--model",
        "m4",
        "--help",
      ]),
    ).toThrow("Unknown argument");
    expect(() =>
      parseVerifyArgs([
        "--config",
        "/tmp/pi-acp.json",
        "--model",
        "m4",
        "extra",
      ]),
    ).toThrow("Unexpected argument");
  });

  test("rejects duplicate flags and invalid catalogue ids", () => {
    expect(() =>
      parseVerifyArgs([
        "--config",
        "/tmp/a.json",
        "--config",
        "/tmp/b.json",
        "--model",
        "m4",
      ]),
    ).toThrow("Duplicate --config");
    expect(() =>
      parseVerifyArgs([
        "--config",
        "/tmp/pi-acp.json",
        "--model",
        "m4",
        "--model",
        "m5",
      ]),
    ).toThrow("Duplicate --model");
    expect(() =>
      parseVerifyArgs(["--config", "/tmp/pi-acp.json", "--model", "bad id"]),
    ).toThrow("--model must be a catalogue id");
    expect(() => parseVerifyArgs(["--config"])).toThrow(
      "Missing value for --config",
    );
  });

  test("rejects --timeout-ms outside the bounded integer range", () => {
    const base = ["--config", "/tmp/pi-acp.json", "--model", "m4"];
    expect(() => parseVerifyArgs([...base, "--timeout-ms", "999"])).toThrow(
      "--timeout-ms must be a bounded integer",
    );
    expect(() =>
      parseVerifyArgs([...base, "--timeout-ms", String(TIMEOUT_MS.max + 1)]),
    ).toThrow("--timeout-ms must be a bounded integer");
    expect(() => parseVerifyArgs([...base, "--timeout-ms", "0"])).toThrow(
      "--timeout-ms must be a bounded integer",
    );
    expect(() => parseVerifyArgs([...base, "--timeout-ms", "1e5"])).toThrow(
      "--timeout-ms must be a bounded integer",
    );
    expect(() => parseVerifyArgs([...base, "--timeout-ms", "1000.5"])).toThrow(
      "--timeout-ms must be a bounded integer",
    );
    expect(() =>
      parseVerifyArgs([...base, "--timeout-ms", "--timeout-ms"]),
    ).toThrow("Missing value for --timeout-ms");
  });
});

describe("operator config", () => {
  test("loads a valid Pi ACP catalogue without printing it", async () => {
    const file = await writeConfig(validConfig);
    const loaded = loadOperatorConfig(file);
    expect(loaded.defaultModel).toBe("m4");
    expect(selectCatalogModel(loaded, "m4").id).toBe("m4");
    expect(selectCatalogModel(loaded, "m4").model).toBe("nemotron");
  });

  test("rejects invalid catalogues without echoing extra keys or values", async () => {
    const secret = "sk-secret-must-not-leak";
    const file = await writeConfig({
      ...validConfig,
      apiKey: secret,
    });
    expect(() => loadOperatorConfig(file)).toThrow(
      "Operator Pi ACP config is invalid",
    );
    try {
      loadOperatorConfig(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("apiKey");
    }
  });

  test("rejects relative piCommand, unknown default, and unknown --model", async () => {
    const relative = await writeConfig({
      ...validConfig,
      piCommand: "pi",
    });
    expect(() => loadOperatorConfig(relative)).toThrow(
      "Operator Pi ACP config is invalid",
    );
    const missingDefault = await writeConfig({
      ...validConfig,
      defaultModel: "missing",
    });
    expect(() => loadOperatorConfig(missingDefault)).toThrow(
      "Operator Pi ACP config is invalid",
    );
    const file = await writeConfig(validConfig);
    const loaded = loadOperatorConfig(file);
    expect(() => selectCatalogModel(loaded, "m5")).toThrow(
      "Requested model is not in the operator catalogue",
    );
  });

  test("rejects unreadable, non-JSON, and relative paths", async () => {
    expect(() => loadOperatorConfig("config.json")).toThrow(
      "Config path must be absolute",
    );
    expect(() => loadOperatorConfig("/tmp/does-not-exist-pi-acp.json")).toThrow(
      "Operator Pi ACP config is unreadable",
    );
    const dir = await mkdtemp(join(tmpdir(), "verify-local-pi-acp-test-"));
    dirs.push(dir);
    const file = join(dir, "config.json");
    await writeFile(file, "{not json");
    expect(() => loadOperatorConfig(file)).toThrow(
      "Operator Pi ACP config is not JSON",
    );
  });
});

describe("opt-in and scoped env", () => {
  test("refuses unless OWNBOT_VERIFY_LOCAL_PI=1, accepting the legacy alias", () => {
    expect(() => assertOptIn({})).toThrow(OPT_IN_ENV);
    expect(() => assertOptIn({ [OPT_IN_ENV]: "true" })).toThrow(OPT_IN_ENV);
    expect(() => assertOptIn({ [OPT_IN_ENV]: "0" })).toThrow(OPT_IN_ENV);
    expect(() => assertOptIn({ [OPT_IN_ENV]: "1" })).not.toThrow();
    expect(() => assertOptIn({ OPENBOT_VERIFY_LOCAL_PI: "1" })).not.toThrow();
    expect(() => assertOptIn({ OWNBOT_VERIFY_LOCAL_PI: "0", OPENBOT_VERIFY_LOCAL_PI: "1" })).toThrow(OPT_IN_ENV);
  });

  test("child env is only PATH and OWNBOT_PI_ACP_CONFIG", () => {
    const env = scopedAdapterEnv("/tmp/pi-acp.json", {
      PATH: "/bin",
      OPENAI_API_KEY: "sk-should-not-leak",
      ANTHROPIC_API_KEY: "sk-should-not-leak",
      [OPT_IN_ENV]: "1",
    });
    expect(env).toEqual({
      PATH: "/bin",
      OWNBOT_PI_ACP_CONFIG: "/tmp/pi-acp.json",
    });
  });

  test("runVerify refuses before ACP or inference when opt-in is missing", async () => {
    const file = await writeConfig(validConfig);
    await expect(
      runVerify(
        { config: file, model: "m4", timeoutMs: TIMEOUT_MS.min },
        { PATH: "/bin" },
      ),
    ).rejects.toThrow(OPT_IN_ENV);
  });

  test("CLI exits nonzero without opt-in and does not inherit provider keys", async () => {
    const file = await writeConfig(validConfig);
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "../scripts/verify-local-pi-acp.ts"),
        "--config",
        file,
        "--model",
        "m4",
      ],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        OPENAI_API_KEY: "sk-should-not-leak",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    const stderr = new TextDecoder().decode(result.stderr);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stderr).toContain(OPT_IN_ENV);
    expect(stderr).not.toContain("sk-should-not-leak");
    expect(stdout).not.toContain("sk-should-not-leak");
  });
});
