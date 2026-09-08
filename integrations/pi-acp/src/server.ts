import { StringDecoder } from "node:string_decoder";
import { PiAcpAdapter } from "./adapter";
import { loadConfig } from "./config";
process.umask(0o077);
const { config, fingerprint } = loadConfig();
const waiting = new Map<
  string,
  {
    resolve: (value: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let count = 0,
  buffer = "",
  active = 0;
const write = (value: any) => {
  process.stdout.write(JSON.stringify(value) + "\n");
};
const adapter = new PiAcpAdapter({
  config,
  fingerprint,
  cwd: process.cwd(),
  notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
  permission: (params) =>
    new Promise((resolve, reject) => {
      const id = `permission-${++count}`;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error("Permission timed out"));
      }, 30000);
      waiting.set(id, { resolve, reject, timer });
      write({
        jsonrpc: "2.0",
        id,
        method: "session/request_permission",
        params,
      });
    }),
});
const decoder = new StringDecoder("utf8");
const stop = async () => {
  await adapter.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdin.on("end", stop);
process.stdin.on("data", (chunk: Buffer) => {
  buffer += decoder.write(chunk);
  if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
    void stop();
    return;
  }
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const line = buffer.slice(0, end).replace(/\r$/, "");
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      void stop();
      return;
    }
    if (request.jsonrpc !== "2.0") {
      void stop();
      return;
    }
    if (!request.method) {
      const item = waiting.get(request.id);
      if (item) {
        clearTimeout(item.timer);
        waiting.delete(request.id);
        request.error
          ? item.reject(new Error("Permission refused"))
          : item.resolve(request.result);
      }
      continue;
    }
    if (request.id === undefined && request.method !== "session/cancel")
      continue;
    if (active >= 32) {
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32600, message: "ACP busy" },
      });
      continue;
    }
    active++;
    void adapter
      .request(request.method, request.params)
      .then(
        (result) => {
          if (request.id !== undefined)
            write({ jsonrpc: "2.0", id: request.id, result });
        },
        () => {
          if (request.id !== undefined)
            write({
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32603,
                message: "Pi ACP operation failed; no fallback was used",
              },
            });
        },
      )
      .finally(() => active--);
  }
});
