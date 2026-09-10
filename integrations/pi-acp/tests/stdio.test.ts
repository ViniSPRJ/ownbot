import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AcpStdioTransport } from "../../../server/src/acp/transport";
import { AcpPermissionGate } from "../../../server/src/acp/permissions";
import { createToolBridge } from "../../../server/src/acp/tool-bridge";
import { z } from "zod";
import { fixtureCommand } from "./fixture-command";

test("adapter executable speaks Ownbot ACP stdio including granted-tool permission and resume", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-acp-stdio-"));
  const config = join(cwd, "config.json");
  let calls = 0,
    text = "",
    sessionId: string | undefined;
  await writeFile(
    config,
    JSON.stringify({
      piCommand: await fixtureCommand(cwd),
      defaultModel: "m4",
      models: [
        {
          id: "m4",
          name: "M4",
          model: "nemotron",
          baseUrl: "http://100.92.206.45:8081/v1",
        },
      ],
    }),
  );
  const bridge = await createToolBridge([
    {
      name: "echo",
      ref: "fixture/echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => {
        calls++;
        return (args as { text: string }).text;
      },
    },
  ]);
  const gate = new AcpPermissionGate("pi", new Set(["echo"]));
  const make = () =>
    new AcpStdioTransport({
      command: process.execPath,
      args: [resolve(import.meta.dir, "../src/server.ts")],
      cwd,
      env: { OWNBOT_PI_ACP_CONFIG: config },
      requestTimeoutMs: 10000,
      onRequest: (method, p) => {
        expect(method).toBe("session/request_permission");
        return gate.decide(p, sessionId);
      },
      onNotification: (method, p: any) => {
        if (method === "session/update") {
          gate.observe(p.update);
          if (p.update.sessionUpdate === "agent_message_chunk")
            text += p.update.content.text;
        }
      },
    });
  let transport = make();
  try {
    const init = await transport.request<any>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(init.agentCapabilities.mcpCapabilities.http).toBe(true);
    const session = await transport.request<any>("session/new", {
      cwd,
      mcpServers: [bridge.descriptor],
    });
    sessionId = session.sessionId;
    expect(
      await transport.request<any>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "CALL" }],
      }),
    ).toEqual({ stopReason: "end_turn" });
    expect(calls).toBe(1);
    expect(text).toBe("BRIDGE_OK");
    transport.close();
    transport = make();
    await transport.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await transport.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [bridge.descriptor],
    });
    expect(
      await transport.request<any>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
      }),
    ).toEqual({ stopReason: "end_turn" });
  } finally {
    transport.close();
    await bridge.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 15000);
