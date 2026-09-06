import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  deliveryStatus,
  executionQuery,
  executionStatus,
  type Execution,
} from "./executions";

function run(
  status: string | null,
  claimedAt: string | null = null,
  finishedAt: string | null = null,
): Execution {
  return { id: "run-a", status, claimedAt, finishedAt } as Execution;
}

describe("execution and delivery labels", () => {
  test("task completion is independent from notification delivery", () => {
    expect(executionStatus(run("succeeded"))).toBe("Concluída");
    expect(deliveryStatus("pending")).toBe("Aguardando envio");
    expect(executionStatus(run("failed"))).toBe("Falhou");
    expect(deliveryStatus("sent")).toContain("confirmada");
    expect(executionStatus(run("skipped"))).toContain("Não concluída");
  });
  test("unrecognized terminal state is not presented as running or waiting", () => {
    for (const claimedAt of [null, "2026-09-06T00:00:00Z"]) {
      const label = executionStatus(
        run("unknown", claimedAt, "2026-09-06T00:10:00Z"),
      );
      expect(label).not.toBe("Em execução");
      expect(label).not.toBe("Aguardando execução");
      expect(label).not.toBe("Concluída");
    }
  });
  test("known active states distinguish acceptance from execution", () => {
    expect(executionStatus(run(null))).toBe("Aguardando execução");
    expect(executionStatus(run(null, "2026-09-06T00:00:00Z"))).toBe(
      "Em execução",
    );
    expect(deliveryStatus(null)).not.toContain("confirmada");
    expect(deliveryStatus("ambiguous")).not.toContain("confirmada");
  });
});

describe("stable per-execution query", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => fetchSpy?.mockRestore());
  test("uses an encoded run ID and its own query key, never a channel preview", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ run: { id: "run /?#", replyText: "stored result" } }),
        { status: 200 },
      ),
    );
    const query = executionQuery("run /?#");
    expect([...query.queryKey]).toEqual(["routines", "execution", "run /?#"]);
    const result = await (query.queryFn as () => Promise<Execution>)();
    expect(result.replyText).toBe("stored result");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/operations/runs/run%20%2F%3F%23",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(executionQuery("other").queryKey).not.toEqual(query.queryKey);
    expect(executionQuery().enabled).toBe(false);
  });
});
