#!/opt/homebrew/bin/bun
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
const args = process.argv.slice(2),
  value = (flag: string) => args[args.indexOf(flag) + 1]!;
for (const flag of [
  "--no-builtin-tools",
  "--no-extensions",
  "--no-skills",
  "--no-context-files",
  "--no-prompt-templates",
])
  if (!args.includes(flag)) process.exit(2);
if (
  process.env.OPENAI_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.XAI_API_KEY
)
  process.exit(3);
const file = value("--session"),
  providers = JSON.parse(
    readFileSync(process.env.PI_CODING_AGENT_DIR + "/models.json", "utf8"),
  ).providers;
let provider = value("--provider"),
  id = value("--model"),
  waiting = false;
if (!existsSync(file)) writeFileSync(file, "INITIAL\n");
const out = (v: any) => process.stdout.write(JSON.stringify(v) + "\n");
const end = (text: string) =>
  out({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  });
const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const req = JSON.parse(line);
    void handle(req);
  }
});
async function handle(req: any) {
  const response = (data: any = {}) =>
    out({
      id: req.id,
      type: "response",
      command: req.type,
      success: true,
      data,
    });
  if (req.type === "get_state")
    return response({
      model: { provider, id },
      sessionFile: file,
      isStreaming: false,
    });
  if (req.type === "get_available_models")
    return response({
      models: Object.entries(providers).flatMap(([provider, p]: any) =>
        p.models.map((m: any) => ({ ...m, provider })),
      ),
    });
  if (req.type === "set_model") {
    provider = req.provider;
    id = req.modelId;
    return response({ provider, id });
  }
  if (req.type === "abort") {
    response();
    if (waiting) {
      waiting = false;
      end("CANCELLED");
    }
    return;
  }
  if (req.type !== "prompt") return response();
  response();
  writeFileSync(file, readFileSync(file, "utf8") + req.message + "\n");
  if (req.message === "WAIT") {
    waiting = true;
    return;
  }
  if (req.message === "FAIL") {
    out({ type: "agent_error", message: "fixture secret" });
    end("failed");
    return;
  }
  if (req.message === "CALL") {
    const r = await fetch(process.env.OWNBOT_PI_TOOL_RELAY + "/call", {
      method: "POST",
      headers: {
        authorization: "Bearer " + process.env.OWNBOT_PI_TOOL_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tool: "echo",
        toolCallId: "call-1",
        arguments: { text: "BRIDGE_OK" },
      }),
    });
    if (!r.ok) {
      out({ type: "agent_error" });
      end("denied");
      return;
    }
    end((await r.json()).content[0].text);
    return;
  }
  end("PI_OK:" + id);
}
