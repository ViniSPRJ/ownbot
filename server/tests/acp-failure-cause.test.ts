import { expect, test } from "bun:test";
import { acpFailureCause } from "../src/acp/failure";

/**
 * Every ACP failure reached the log as the same line. The cause names which of ownbot's own guards
 * fired; nothing that came out of the CLI is classified, and nothing is quoted.
 */
test("ownbot's own failures are named", () => {
  expect(acpFailureCause(new Error("Duplicate ACP tool name"))).toBe(
    "tool_catalogue",
  );
  expect(acpFailureCause(new Error("Versão ACP não suportada"))).toBe(
    "protocol",
  );
  expect(
    acpFailureCause(
      new Error(
        "Este agente ACP não oferece MCP HTTP para as ferramentas do ownbot.",
      ),
    ),
  ).toBe("mcp_http");
  expect(acpFailureCause(new Error("Agente ACP não retornou uma sessão"))).toBe(
    "session",
  );
  expect(acpFailureCause(new Error("A CLI não concluiu o turno."))).toBe(
    "cli_turn",
  );
  expect(
    acpFailureCause(
      new Error(
        "A CLI terminou sem retornar uma resposta final após as ferramentas.",
      ),
    ),
  ).toBe("no_final_message");
  expect(
    acpFailureCause(
      new Error("Este agente já está trabalhando nesta conversa."),
    ),
  ).toBe("busy");
});

test("the transport's own sanitised failures are one family", () => {
  for (const message of [
    "ACP process exited",
    "ACP request timed out",
    "ACP transport closed",
    "Invalid ACP command",
    "Invalid ACP request timeout",
    "Unsupported ACP client operation",
  ]) {
    expect(acpFailureCause(new Error(message))).toBe("transport");
  }
});

test("anything the CLI said is unknown, and never becomes part of the answer", () => {
  const causes = new Set([
    acpFailureCause(new Error("read ECONNRESET")),
    acpFailureCause(
      new Error("Bearer sk-live-000 rejected by https://internal.example/auth"),
    ),
    acpFailureCause(
      new Error(
        "/home/viniciuspinho/.secrets/openbot-private.env: permission denied",
      ),
    ),
    acpFailureCause(new Error("")),
    acpFailureCause("not an error"),
    acpFailureCause(undefined),
  ]);
  expect(causes).toEqual(new Set(["unknown"]));
  // The classification is drawn from a closed set, so no substring of an error can escape through it.
  const vocabulary = new Set([
    "busy",
    "tool_catalogue",
    "protocol",
    "mcp_http",
    "session",
    "transport",
    "cli_turn",
    "no_final_message",
    "unknown",
  ]);
  expect(
    vocabulary.has(acpFailureCause(new Error("token=abc ACP process exited"))),
  ).toBe(true);
});
