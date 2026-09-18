import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  type Handoff,
  handoffStatus,
  type PiDelegation,
  piDelegationStatus,
  piDelegationsQuery,
  piLifecycleLabel,
  piTerminalLabel,
  piWatchAttemptsLabel,
} from "./executions";

function item(
  lifecycle: PiDelegation["lifecycle"],
  terminalState: PiDelegation["terminalState"] = null,
): PiDelegation {
  return {
    key: "k",
    executor: "pi-m5",
    jobId: "a".repeat(32),
    lifecycle,
    terminalState,
    attempts: 2,
    runAt: null,
    createdAt: "2026-09-17T00:00:00.000Z",
    finishedAt: lifecycle === "terminal" ? "2026-09-17T00:10:00.000Z" : null,
    leaseUntil: null,
  };
}

describe("Pi delegation labels", () => {
  test("lifecycle copy does not treat queue finish as job success", () => {
    expect(piLifecycleLabel("queued")).toBe("Aguardando acompanhamento");
    expect(piLifecycleLabel("queued")).not.toBe("Enfileirada");
    expect(piLifecycleLabel("watching")).toBe("Consultando status");
    expect(piLifecycleLabel("watching")).not.toContain("fila");
    expect(piLifecycleLabel("terminal")).toBe("Encerrada");
    expect(piLifecycleLabel("overdue")).toBe("Atrasada");
    expect(piLifecycleLabel("exhausted")).toBe("Tentativas esgotadas");
    expect(piLifecycleLabel("unknown")).toBe("Estado desconhecido");
    expect(piWatchAttemptsLabel(1)).toBe("1 tentativa de acompanhamento");
    expect(piWatchAttemptsLabel(2)).toBe("2 tentativas de acompanhamento");
    expect(piWatchAttemptsLabel(0)).toBe("0 tentativas de acompanhamento");
    expect(piDelegationStatus(item("terminal", "completed"))).toContain(
      "Encerrada",
    );
    expect(piDelegationStatus(item("terminal", "completed"))).not.toBe(
      "Concluída",
    );
    expect(piDelegationStatus(item("queued"))).not.toContain("Concluído");
    expect(piDelegationStatus(item("queued"))).not.toBe("Enfileirada");
  });

  test("completed is a receipt on the executor, not callback delivery", () => {
    const label = piTerminalLabel("completed");
    expect(label).toBe("Concluído no executor");
    expect(label).not.toContain("entrega");
    expect(label).not.toContain("confirmada");
    expect(piDelegationStatus(item("terminal", "completed"))).toContain(
      "Concluído no executor",
    );
  });

  test("access_revoked, unknown and failed stay distinct from completed", () => {
    expect(piTerminalLabel("access_revoked")).toBe("Acesso revogado");
    expect(piTerminalLabel("unknown")).toBe("Resultado desconhecido");
    expect(piTerminalLabel("failed")).toBe("Falhou");
    expect(piTerminalLabel("interrupted")).toBe("Interrompido");
    expect(piTerminalLabel("invalid_watch")).toBe("Acompanhamento inválido");
    expect(piTerminalLabel("executor_unavailable")).toBe(
      "Executor indisponível",
    );
    for (const state of [
      "access_revoked",
      "unknown",
      "failed",
      "interrupted",
      "invalid_watch",
      "executor_unavailable",
    ] as const) {
      const status = piDelegationStatus(item("terminal", state));
      expect(status).not.toContain("Concluído no executor");
      expect(status).toContain("Encerrada");
    }
  });

  test("unrecognized lifecycle or terminal reason is unknown, never completed", () => {
    expect(piLifecycleLabel("mystery" as PiDelegation["lifecycle"])).toBe(
      "Estado desconhecido",
    );
    expect(piTerminalLabel("success" as PiDelegation["terminalState"])).toBe(
      "Resultado desconhecido",
    );
    expect(piTerminalLabel(null)).toBeNull();
  });
});

describe("handoff reconciled copy", () => {
  test("agent.handoff_reconciled does not claim original delivery", () => {
    const hop: Handoff = {
      id: "h",
      event: "agent.handoff_reconciled",
      at: "",
      from: "a",
      to: "b",
      run: null,
      workKey: "job",
    };
    expect(handoffStatus(hop)).toBe(
      "Reconciliada; entrega original não confirmada",
    );
  });
});

describe("actor-scoped Pi delegations query", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => fetchSpy?.mockRestore());
  test("reads the authenticated operations endpoint every 15s without an owner query", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          delegations: [
            {
              key: "k",
              executor: "pi-m5",
              jobId: "a".repeat(32),
              lifecycle: "queued",
              terminalState: null,
              attempts: 1,
              runAt: null,
              createdAt: "2026-09-17T00:00:00.000Z",
              finishedAt: null,
              leaseUntil: null,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const query = piDelegationsQuery();
    expect([...query.queryKey]).toEqual(["routines", "pi-delegations"]);
    expect(query.refetchInterval).toBe(15_000);
    const result = await (query.queryFn as () => Promise<PiDelegation[]>)();
    expect(result).toHaveLength(1);
    expect(result[0]?.executor).toBe("pi-m5");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/operations/pi-delegations",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain("owner=");
  });
});
