import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectReconcileDatabase,
  isExecutableMain,
  jsonDeepEqual,
  loadPreparedManifest,
  parseReconcileArgs,
  RESOLUTION,
} from "../scripts/reconcile-handoff";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reconcile-handoff-"));
  dirs.push(dir);
  return dir;
}

async function writeSecret(
  dir: string,
  name: string,
  value: unknown,
): Promise<{ path: string; sha256: string }> {
  const path = join(dir, name);
  const buf = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(path, buf);
  await chmod(path, 0o600);
  return {
    path,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

const originalResult = {
  outcome: "unknown",
  reason: "Previous delivery was admitted; outcome unknown.",
};

function receiptBody(workKey: string, extras: Record<string, unknown> = {}) {
  return {
    workKey,
    originalResult,
    resolution: RESOLUTION,
    originalDeliveryOutcome: "unknown",
    id: "receipt-1",
    note: "internal archive of the original alert",
    ...extras,
  };
}

async function writeManifest(
  dir: string,
  entries: unknown[],
  extras: Record<string, unknown> = {},
): Promise<string> {
  const { path } = await writeSecret(dir, "manifest.json", {
    version: 1,
    operator: "operator-1",
    entries,
    ...extras,
  });
  return path;
}

describe("parseReconcileArgs", () => {
  test("dry-run is the default and the manifest path must be absolute", () => {
    expect(parseReconcileArgs(["/tmp/manifest.json"])).toEqual({
      manifestPath: "/tmp/manifest.json",
      apply: false,
    });
    expect(
      parseReconcileArgs(["--manifest", "/tmp/manifest.json", "--apply"]),
    ).toEqual({
      manifestPath: "/tmp/manifest.json",
      apply: true,
    });
  });

  test("rejects relative paths, extra flags and a missing path", () => {
    expect(() => parseReconcileArgs(["manifest.json"])).toThrow(
      "absolute path",
    );
    expect(() => parseReconcileArgs(["/tmp/a.json", "--replay"])).toThrow(
      "Unknown argument",
    );
    expect(() => parseReconcileArgs([])).toThrow("absolute operator manifest");
    expect(() => parseReconcileArgs(["/tmp/a.json", "/tmp/b.json"])).toThrow(
      "Exactly one manifest path",
    );
    expect(() => parseReconcileArgs(["/tmp/foo/../manifest.json"])).toThrow(
      "normalized absolute path",
    );
  });
});

describe("jsonDeepEqual", () => {
  test("compares plain JSON objects without key order", () => {
    expect(
      jsonDeepEqual({ a: 1, b: { c: true } }, { b: { c: true }, a: 1 }),
    ).toBe(true);
    expect(jsonDeepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonDeepEqual([1, 2], [1, 2])).toBe(true);
    expect(jsonDeepEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe("the executable import guard", () => {
  test("importing the CLI does not treat the test as main", () => {
    expect(isExecutableMain).toBe(false);
  });

  test("connecting refuses to guess a database", () => {
    expect(() => connectReconcileDatabase({})).toThrow(
      "DATABASE_URL is required",
    );
    expect(() => connectReconcileDatabase({ DATABASE_URL: "   " })).toThrow(
      "DATABASE_URL is required",
    );
  });
});

describe("manifest and receipt validation", () => {
  test("loads a valid version-1 archive pair", async () => {
    const dir = await tempDir();
    const workKey = "hop:abc:def";
    const receipt = await writeSecret(
      dir,
      "receipt.json",
      receiptBody(workKey),
    );
    const manifest = await writeManifest(dir, [
      {
        workKey,
        expectedResult: originalResult,
        receiptPath: receipt.path,
        receiptSha256: receipt.sha256,
        resolution: RESOLUTION,
        evidenceRefs: ["audit:agent.handoff_failed"],
      },
    ]);
    const loaded = await loadPreparedManifest(manifest);
    expect(loaded.manifest.operator).toBe("operator-1");
    expect(loaded.prepared[0]?.receiptId).toBe("receipt-1");
    expect(loaded.prepared[0]?.receiptSha256).toBe(receipt.sha256);
  });

  test("rejects a relative receipt path", async () => {
    const dir = await tempDir();
    const manifest = await writeManifest(dir, [
      {
        workKey: "hop:1",
        expectedResult: originalResult,
        receiptPath: "receipt.json",
        receiptSha256: "a".repeat(64),
        resolution: RESOLUTION,
        evidenceRefs: [],
      },
    ]);
    await expect(loadPreparedManifest(manifest)).rejects.toThrow(
      "absolute path",
    );
  });

  test("rejects a receipt symlink", async () => {
    const dir = await tempDir();
    const workKey = "hop:1";
    const receipt = await writeSecret(
      dir,
      "receipt.json",
      receiptBody(workKey),
    );
    const link = join(dir, "receipt.link.json");
    symlinkSync(receipt.path, link);
    await chmod(link, 0o600).catch(() => {});
    const manifest = await writeManifest(dir, [
      {
        workKey,
        expectedResult: originalResult,
        receiptPath: link,
        receiptSha256: receipt.sha256,
        resolution: RESOLUTION,
        evidenceRefs: [],
      },
    ]);
    await expect(loadPreparedManifest(manifest)).rejects.toThrow(
      /symlink|regular/,
    );
  });

  test("rejects a receipt hash mismatch", async () => {
    const dir = await tempDir();
    const workKey = "hop:1";
    const receipt = await writeSecret(
      dir,
      "receipt.json",
      receiptBody(workKey),
    );
    const manifest = await writeManifest(dir, [
      {
        workKey,
        expectedResult: originalResult,
        receiptPath: receipt.path,
        receiptSha256: "b".repeat(64),
        resolution: RESOLUTION,
        evidenceRefs: [],
      },
    ]);
    await expect(loadPreparedManifest(manifest)).rejects.toThrow(
      "receipt hash does not match",
    );
  });

  test("rejects receipt workKey and originalResult mismatches", async () => {
    const dir = await tempDir();
    const receipt = await writeSecret(
      dir,
      "receipt.json",
      receiptBody("hop:other", {
        originalResult: { outcome: "unknown", reason: "different" },
      }),
    );
    const manifest = await writeManifest(dir, [
      {
        workKey: "hop:1",
        expectedResult: originalResult,
        receiptPath: receipt.path,
        receiptSha256: receipt.sha256,
        resolution: RESOLUTION,
        evidenceRefs: [],
      },
    ]);
    await expect(loadPreparedManifest(manifest)).rejects.toThrow(
      "receipt.workKey does not match",
    );

    const matchingKey = await writeSecret(
      dir,
      "receipt-key.json",
      receiptBody("hop:1", {
        originalResult: { outcome: "unknown", reason: "different" },
      }),
    );
    const second = await writeManifest(dir, [
      {
        workKey: "hop:1",
        expectedResult: originalResult,
        receiptPath: matchingKey.path,
        receiptSha256: matchingKey.sha256,
        resolution: RESOLUTION,
        evidenceRefs: [],
      },
    ]);
    await expect(loadPreparedManifest(second)).rejects.toThrow(
      "originalResult does not match",
    );
  });

  test("rejects a receipt that does not archive unknown delivery", async () => {
    const dir = await tempDir();
    const receipt = await writeSecret(dir, "receipt.json", {
      workKey: "hop:1",
      originalResult,
      resolution: RESOLUTION,
      originalDeliveryOutcome: "delivered",
    });
    const manifest = await writeManifest(dir, [
      {
        workKey: "hop:1",
        expectedResult: originalResult,
        receiptPath: receipt.path,
        receiptSha256: receipt.sha256,
        resolution: RESOLUTION,
        evidenceRefs: [],
      },
    ]);
    await expect(loadPreparedManifest(manifest)).rejects.toThrow(
      "originalDeliveryOutcome must be unknown",
    );
  });

  test("rejects extra keys, bad version, and a non-record-only resolution", async () => {
    const dir = await tempDir();
    const extra = await writeSecret(dir, "extra.json", {
      version: 1,
      operator: "operator-1",
      entries: [],
      replay: true,
    });
    await expect(loadPreparedManifest(extra.path)).rejects.toThrow(
      "unexpected key",
    );

    const version = await writeSecret(dir, "v2.json", {
      version: 2,
      operator: "operator-1",
      entries: [
        {
          workKey: "hop:1",
          expectedResult: originalResult,
          receiptPath: "/tmp/r.json",
          receiptSha256: "a".repeat(64),
          resolution: RESOLUTION,
          evidenceRefs: [],
        },
      ],
    });
    await expect(loadPreparedManifest(version.path)).rejects.toThrow(
      "version must be 1",
    );

    const resolution = await writeSecret(dir, "delivered.json", {
      version: 1,
      operator: "operator-1",
      entries: [
        {
          workKey: "hop:1",
          expectedResult: originalResult,
          receiptPath: "/tmp/r.json",
          receiptSha256: "a".repeat(64),
          resolution: "delivered",
          evidenceRefs: [],
        },
      ],
    });
    await expect(loadPreparedManifest(resolution.path)).rejects.toThrow(
      "internal_record_archived",
    );
  });

  test("rejects a world-readable archive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-open-"));
    dirs.push(dir);
    const path = join(dir, "open.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, operator: "x", entries: [] }),
    );
    chmodSync(path, 0o644);
    await expect(loadPreparedManifest(path)).rejects.toThrow("mode 0600");
  });

  test("rejects a malformed receiptSha256", async () => {
    const dir = await tempDir();
    const manifest = await writeManifest(dir, [
      {
        workKey: "hop:1",
        expectedResult: originalResult,
        receiptPath: join(dir, "receipt.json"),
        receiptSha256: "not-a-hash",
        resolution: RESOLUTION,
        evidenceRefs: [],
      },
    ]);
    await expect(loadPreparedManifest(manifest)).rejects.toThrow("64 hex");
  });
});
