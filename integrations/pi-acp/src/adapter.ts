import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PiConfig } from "./config";
import { PiRpc } from "./rpc";

type Descriptor = {
  type: "http";
  name: "ownbot";
  url: string;
  headers: { name: string; value: string }[];
};
type Tool = {
  name: string;
  alias: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
type Saved = { sessionId: string; model: string; fingerprint: string };
const safeId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);

export class PiAcpAdapter {
  private rpc?: PiRpc;
  private starting = false;
  private sessionId?: string;
  private modelId: string;
  private bridge?: Descriptor;
  private tools: Tool[] = [];
  private usedCalls = new Set<string>();
  private checkpoint?: { file: string; contents?: string };
  private turn?: {
    resolve: (result: any) => void;
    reject: (e: Error) => void;
    text: string;
    failed: boolean;
    cancelled: boolean;
  };
  private relayToken = randomBytes(32).toString("hex");
  private relay: ReturnType<typeof Bun.serve>;
  private cwd: string;
  private stateRoot: string;
  constructor(
    private options: {
      config: PiConfig;
      fingerprint: string;
      cwd: string;
      notify: (method: string, params: any) => void;
      permission: (params: any) => Promise<any>;
    },
  ) {
    this.cwd = resolve(options.cwd);
    this.stateRoot = join(this.cwd, ".pi-acp");
    this.modelId = options.config.defaultModel;
    this.relay = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 2 * 1024 * 1024,
      fetch: (r) => this.relayRequest(r),
    });
  }
  private update(update: any) {
    this.options.notify("session/update", {
      sessionId: this.sessionId,
      update,
    });
  }
  private current() {
    return this.options.config.models.find((m) => m.id === this.modelId)!;
  }
  private configuration() {
    return {
      configOptions: [
        {
          id: "model",
          name: "Modelo local",
          category: "model",
          type: "select",
          currentValue: this.modelId,
          options: this.options.config.models.map((m) => ({
            value: m.id,
            name: m.name,
          })),
        },
      ],
    };
  }
  private async mcp(method: string, params: any = {}) {
    if (!this.bridge) throw new Error("Ownbot MCP missing");
    const response = await fetch(this.bridge.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(65000),
      headers: {
        "content-type": "application/json",
        ...Object.fromEntries(
          this.bridge.headers.map((h) => [h.name, h.value]),
        ),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params,
      }),
    });
    if (!response.ok) throw new Error("Ownbot MCP unavailable");
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error("MCP result too large");
    const body = JSON.parse(text);
    if (body.error) throw new Error("Ownbot MCP refused operation");
    return body.result;
  }
  private async connectBridge(descriptors: unknown) {
    if (!Array.isArray(descriptors) || descriptors.length > 1)
      throw new Error("Only Ownbot MCP is supported");
    this.bridge = undefined;
    this.tools = [];
    if (descriptors.length === 0) return;
    const d = descriptors[0];
    const u = new URL(d.url);
    if (
      d.type !== "http" ||
      d.name !== "ownbot" ||
      u.protocol !== "http:" ||
      u.hostname !== "127.0.0.1" ||
      !u.port ||
      u.pathname !== "/mcp" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !Array.isArray(d.headers) ||
      d.headers.length !== 1 ||
      d.headers[0]?.name?.toLowerCase() !== "authorization" ||
      typeof d.headers[0]?.value !== "string" ||
      !/^Bearer [A-Za-z0-9_-]+$/.test(d.headers[0].value)
    )
      throw new Error("Invalid Ownbot MCP descriptor");
    this.bridge = d;
    const init = await this.mcp("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "ownbot-pi-acp", version: "1" },
    });
    if (init.serverInfo?.name !== "ownbot") throw new Error("Wrong MCP server");
    const listed = await this.mcp("tools/list");
    if (!Array.isArray(listed.tools) || listed.tools.length > 256)
      throw new Error("Invalid Ownbot tools");
    this.tools = listed.tools.map((t: any) => ({
      ...t,
      alias:
        typeof t.name === "string" && t.name.length > 56
          ? `ownbot__${t.name.slice(0, 38)}_${createHash("sha256").update(t.name).digest("hex").slice(0, 16)}`
          : `ownbot__${t.name}`,
    }));
    if (
      this.tools.some(
        (t) =>
          !/^[A-Za-z0-9_-]{1,128}$/.test(t.name) ||
          !t.inputSchema ||
          typeof t.inputSchema !== "object",
      ) ||
      new Set(this.tools.map((t) => t.name)).size !== this.tools.length ||
      new Set(this.tools.map((t) => t.alias)).size !== this.tools.length
    )
      throw new Error("Unsupported Ownbot tool schema");
  }
  private async relayRequest(request: Request): Promise<Response> {
    const expected = Buffer.from(`Bearer ${this.relayToken}`),
      presented = Buffer.from(request.headers.get("authorization") ?? "");
    if (
      request.headers.has("origin") ||
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    )
      return new Response("Forbidden", { status: 403 });
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/tools")
      return Response.json({ tools: this.tools });
    if (request.method === "POST" && path === "/call") {
      try {
        const body = (await request.json()) as any;
        if (
          !this.turn ||
          this.turn.cancelled ||
          !this.sessionId ||
          typeof body.toolCallId !== "string" ||
          !body.toolCallId ||
          body.toolCallId.length > 256 ||
          this.usedCalls.has(body.toolCallId) ||
          this.usedCalls.size >= 4096 ||
          !this.tools.some((t) => t.name === body.tool)
        )
          throw new Error("Tool not granted");
        this.usedCalls.add(body.toolCallId);
        const envelope = {
          toolCallId: body.toolCallId,
          title: body.tool,
          rawInput: { server: "ownbot", tool: body.tool },
          _meta: { ownbot_pi_tool: true },
        };
        this.update({
          ...envelope,
          sessionUpdate: "tool_call",
          status: "pending",
        });
        const permission = await this.options.permission({
          sessionId: this.sessionId,
          toolCall: envelope,
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
          ],
        });
        if (
          permission.outcome?.outcome !== "selected" ||
          permission.outcome.optionId !== "once" ||
          !this.turn ||
          this.turn.cancelled
        )
          throw new Error("Permission denied");
        const result = await this.mcp("tools/call", {
          name: body.tool,
          arguments: body.arguments,
        });
        this.update({
          ...envelope,
          sessionUpdate: "tool_call_update",
          status: result.isError ? "failed" : "completed",
        });
        return Response.json(result);
      } catch {
        return new Response("Ownbot tool refused", { status: 403 });
      }
    }
    const match = /^\/inference\/([A-Za-z0-9_-]+)\/v1\/chat\/completions$/.exec(
      path,
    );
    if (request.method === "POST" && match) {
      const model = this.options.config.models.find((m) => m.id === match[1]);
      if (
        !model ||
        model.id !== this.modelId ||
        !this.turn ||
        this.turn.cancelled
      )
        return new Response("Model not selected", { status: 403 });
      try {
        const body = (await request.json()) as any;
        if (body.model !== model.model)
          return new Response("Model mismatch", { status: 403 });
        // No redirect, caller credentials, arbitrary destinations or hosted fallback.
        const response = await fetch(
          `${model.baseUrl.replace(/\/$/, "")}/chat/completions`,
          {
            method: "POST",
            redirect: "error",
            signal: request.signal,
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify(body),
          },
        );
        return new Response(response.body, {
          status: response.status,
          headers: {
            "content-type":
              response.headers.get("content-type") ?? "application/json",
          },
        });
      } catch {
        return new Response("Local model unavailable", { status: 502 });
      }
    }
    return new Response("Not found", { status: 404 });
  }
  private onEvent(event: any) {
    const turn = this.turn;
    if (!turn) return;
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      const text = event.assistantMessageEvent.delta;
      if (typeof text === "string" && text) {
        turn.text += text;
        this.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
      }
    }
    if (
      event.type === "error" ||
      event.type === "agent_error" ||
      (event.type === "message_end" &&
        (["error", "aborted", "length"].includes(event.message?.stopReason) ||
          event.message?.errorMessage))
    )
      turn.failed = true;
    if (event.type === "agent_end") {
      if (!turn.text) {
        const assistant = [...(event.messages ?? [])]
          .reverse()
          .find((m: any) => m.role === "assistant");
        const text = (assistant?.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        if (text) {
          turn.text = text;
          this.update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          });
        }
        if (
          ["error", "aborted", "length"].includes(assistant?.stopReason) ||
          assistant?.errorMessage
        )
          turn.failed = true;
      }
      if (turn.cancelled) turn.resolve({ stopReason: "cancelled" });
      else if (turn.failed || !turn.text)
        turn.reject(new Error("Pi did not complete a response"));
      else turn.resolve({ stopReason: "end_turn" });
    }
  }
  private async spawn() {
    const root = join(this.stateRoot, this.sessionId!);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { mode: 0o700, recursive: true });
    const providers = Object.fromEntries(
      this.options.config.models.map((m) => [
        `ownbot_${m.id}`,
        {
          api: "openai-completions",
          apiKey: this.relayToken,
          baseUrl: `http://127.0.0.1:${this.relay.port}/inference/${m.id}/v1`,
          models: [
            {
              id: m.model,
              name: m.name,
              reasoning: true,
              input: ["text"],
              contextWindow: m.contextWindow,
              maxTokens: m.maxTokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      ]),
    );
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({ providers }),
      { mode: 0o600 },
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [],
        extensions: [],
        skills: [],
        promptTemplates: [],
        autoCompact: false,
      }),
      { mode: 0o600 },
    );
    const args = [
      "--mode",
      "rpc",
      "--session",
      join(root, "session.jsonl"),
      "--provider",
      `ownbot_${this.modelId}`,
      "--model",
      this.current().model,
      "--no-builtin-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--thinking",
      "off",
      "-e",
      join(import.meta.dir, "extension.ts"),
    ];
    if (this.tools.length)
      args.push("--tools", this.tools.map((t) => t.alias).join(","));
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      TERM: "dumb",
      NO_COLOR: "1",
      OWNBOT_PI_TOOL_RELAY: `http://127.0.0.1:${this.relay.port}`,
      OWNBOT_PI_TOOL_TOKEN: this.relayToken,
    };
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    this.rpc = new PiRpc(
      this.options.config.piCommand,
      args,
      workspace,
      env,
      (event) => this.onEvent(event),
      () => this.turn?.reject(new Error("Pi process stopped")),
    );
    const state = await this.rpc.request("get_state");
    if (
      state.model?.id !== this.current().model ||
      state.model?.provider !== `ownbot_${this.modelId}` ||
      resolve(state.sessionFile ?? "") !== join(root, "session.jsonl")
    )
      throw new Error("Pi session configuration mismatch");
    const catalogue = await this.rpc.request("get_available_models");
    if (
      this.options.config.models.some(
        (m) =>
          !catalogue.models?.some(
            (c: any) => c.id === m.model && c.provider === `ownbot_${m.id}`,
          ),
      )
    )
      throw new Error("Pi model catalogue mismatch");
    await this.rpc.request("set_auto_retry", { enabled: false });
    await this.rpc.request("set_auto_compaction", { enabled: false });
  }
  private async save() {
    const path = join(this.stateRoot, `${this.sessionId}.json`),
      temporary = `${path}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        sessionId: this.sessionId,
        model: this.modelId,
        fingerprint: this.options.fingerprint,
      }),
      { mode: 0o600 },
    );
    await rename(temporary, path);
  }
  async request(method: string, params: any = {}): Promise<any> {
    if (method === "initialize")
      return {
        protocolVersion: 1,
        agentInfo: { name: "ownbot-pi-acp", version: "1" },
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
          promptCapabilities: { embeddedContext: false, image: false },
        },
      };
    if (method === "session/new" || method === "session/load") {
      if (this.rpc || this.sessionId || this.starting)
        throw new Error("Session already active");
      this.starting = true;
      try {
        if ((await realpath(params.cwd)) !== (await realpath(this.cwd)))
          throw new Error("Wrong session workspace");
        await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
        if (method === "session/load") {
          if (!safeId(params.sessionId)) throw new Error("Invalid session ID");
          const saved = JSON.parse(
            await readFile(
              join(this.stateRoot, `${params.sessionId}.json`),
              "utf8",
            ),
          ) as Saved;
          if (
            saved.sessionId !== params.sessionId ||
            saved.fingerprint !== this.options.fingerprint ||
            !this.options.config.models.some((m) => m.id === saved.model)
          )
            throw new Error("Session owner or configuration mismatch");
          this.sessionId = saved.sessionId;
          this.modelId = saved.model;
        } else this.sessionId = randomUUID();
        await this.connectBridge(params.mcpServers ?? []);
        await this.spawn();
        await this.save();
        return { sessionId: this.sessionId, ...this.configuration() };
      } finally {
        this.starting = false;
      }
    }
    if (!this.rpc || params.sessionId !== this.sessionId)
      throw new Error("Unknown session");
    if (
      method === "session/set_config_option" ||
      method === "session/set_model"
    ) {
      const modelId =
        method === "session/set_model" ? params.modelId : params.value;
      if (
        this.starting ||
        this.turn ||
        (method !== "session/set_model" && params.configId !== "model") ||
        !this.options.config.models.some((m) => m.id === modelId)
      )
        throw new Error("Model not allowed");
      const model = this.options.config.models.find((m) => m.id === modelId)!;
      this.starting = true;
      try {
        const selected = await this.rpc.request("set_model", {
          provider: `ownbot_${model.id}`,
          modelId: model.model,
        });
        if (
          selected?.id !== model.model ||
          selected?.provider !== `ownbot_${model.id}`
        )
          throw new Error("Pi did not confirm selected model");
        this.modelId = model.id;
        await this.save();
        return this.configuration();
      } finally {
        this.starting = false;
      }
    }
    if (method === "session/cancel") {
      if (this.turn) this.turn.cancelled = true;
      await this.rpc.request("abort", {}, 5000);
      return {};
    }
    if (method === "session/prompt") {
      if (
        this.starting ||
        this.turn ||
        !Array.isArray(params.prompt) ||
        params.prompt.some(
          (c: any) => c.type !== "text" || typeof c.text !== "string",
        )
      )
        throw new Error("Only text prompts are supported");
      const message = params.prompt.map((c: any) => c.text).join("\n");
      if (message.length > 2 * 1024 * 1024) throw new Error("Prompt too large");
      this.starting = true;
      this.usedCalls.clear();
      const file = join(this.stateRoot, this.sessionId!, "session.jsonl");
      try {
        this.checkpoint = {
          file,
          contents: await readFile(file, "utf8").catch((e) => {
            if (e.code === "ENOENT") return undefined;
            throw e;
          }),
        };
      } catch (e) {
        this.starting = false;
        throw e;
      }
      let finished!: Promise<any>;
      finished = new Promise((resolve, reject) => {
        this.turn = {
          resolve,
          reject,
          text: "",
          failed: false,
          cancelled: false,
        };
      });
      // Avoid an unhandled rejection if the subprocess fails before prompt acknowledgement.
      void finished.catch(() => {});
      this.starting = false;
      try {
        await this.rpc.request("prompt", { message });
        const result = await finished;
        if (result.stopReason === "end_turn") {
          await this.save();
          this.checkpoint = undefined;
        } else {
          await this.rpc.stop();
          this.rpc = undefined;
          await this.rollback();
        }
        return result;
      } catch (e) {
        await this.rpc?.stop();
        this.rpc = undefined;
        await this.rollback();
        throw e;
      } finally {
        this.turn = undefined;
      }
    }
    throw new Error("Unsupported ACP operation");
  }
  private async rollback() {
    const checkpoint = this.checkpoint;
    this.checkpoint = undefined;
    if (!checkpoint) return;
    if (checkpoint.contents === undefined)
      await rm(checkpoint.file, { force: true });
    else await writeFile(checkpoint.file, checkpoint.contents, { mode: 0o600 });
  }
  async close() {
    this.turn?.reject(new Error("Pi adapter stopped"));
    await this.rpc?.stop();
    await this.rollback();
    await this.relay.stop(true);
  }
}
