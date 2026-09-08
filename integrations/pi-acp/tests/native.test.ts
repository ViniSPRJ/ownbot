import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiAcpAdapter } from "../src/adapter";
import { createToolBridge } from "../../../server/src/acp/tool-bridge";
import { AcpPermissionGate } from "../../../server/src/acp/permissions";
import { z } from "zod";
/** Explicit opt-in: real Pi CLI, synthetic local model endpoint; no inference on the user's Macs. */
test.skipIf(!process.env.PI_NATIVE_CLI)(
  "native Pi CLI registers only Ownbot extension tools and completes a real MCP roundtrip",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-acp-native-"));
    let inferenceCalls = 0,
      toolCalls = 0;
    const advertised: string[][] = [];
    const model = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(r) {
        const body = (await r.json()) as any;
        inferenceCalls++;
        advertised.push((body.tools ?? []).map((t: any) => t.function.name));
        const afterTool = body.messages.some((m: any) => m.role === "tool");
        const delta = afterTool
          ? { role: "assistant", content: "Native bridge completed." }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "native_call",
                  type: "function",
                  function: {
                    name: "ownbot__echo",
                    arguments: JSON.stringify({ text: "NATIVE_BRIDGE_OK" }),
                  },
                },
              ],
            };
        const chunks = [
          {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason: null }],
          },
          {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: afterTool ? "stop" : "tool_calls",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 3,
              total_tokens: 13,
            },
          },
        ];
        return new Response(
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const bridge = await createToolBridge([
      {
        name: "echo",
        ref: "ownbot/echo",
        description: "Echo synthetic marker",
        parameters: z.object({ text: z.string() }),
        execute: async (args) => {
          toolCalls++;
          return (args as { text: string }).text;
        },
      },
    ]);
    const gate = new AcpPermissionGate("pi", new Set(["echo"]));
    let current: string | undefined;
    let text = "";
    const adapter = new PiAcpAdapter({
      config: {
        piCommand: process.env.PI_NATIVE_CLI!,
        defaultModel: "fixture",
        models: [
          {
            id: "fixture",
            name: "Fixture",
            model: "fixture",
            baseUrl: `http://127.0.0.1:${model.port}/v1`,
            contextWindow: 131072,
            maxTokens: 4096,
          },
        ],
      },
      fingerprint: "native-fixture",
      cwd,
      notify: (_, p) => {
        current = p.sessionId;
        gate.observe(p.update);
        if (p.update.sessionUpdate === "agent_message_chunk")
          text += p.update.content.text;
      },
      permission: async (p) => gate.decide(p, current),
    });
    try {
      const { sessionId } = await adapter.request("session/new", {
        cwd,
        mcpServers: [bridge.descriptor],
      });
      expect(
        await adapter.request("session/prompt", {
          sessionId,
          prompt: [
            {
              type: "text",
              text: "Call the echo tool once with NATIVE_BRIDGE_OK. Then respond briefly.",
            },
          ],
        }),
      ).toEqual({ stopReason: "end_turn" });
      expect(toolCalls).toBe(1);
      expect(inferenceCalls).toBe(2);
      expect(advertised).toEqual([["ownbot__echo"], ["ownbot__echo"]]);
      expect(text).toBe("Native bridge completed.");
    } finally {
      await adapter.close();
      await bridge.close();
      await model.stop(true);
      await rm(cwd, { recursive: true, force: true });
    }
  },
  20000,
);
