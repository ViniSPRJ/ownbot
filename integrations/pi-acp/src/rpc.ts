import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
/** Pi uses LF-delimited JSON, not JSON-RPC. No shell or inherited provider credentials. */
export class PiRpc {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private exited: Promise<void>;
  private serial = 0;
  private closed = false;
  constructor(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    event: (value: any) => void,
    failed: () => void,
  ) {
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) =>
      this.child.once("close", () => resolve()),
    );
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    const fail = () => {
      if (!this.closed) {
        this.close();
        failed();
      }
    };
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) return fail();
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line);
          if (value.type === "response") {
            const item = this.pending.get(value.id);
            if (!item) continue;
            clearTimeout(item.timer);
            this.pending.delete(value.id);
            if (value.success !== true)
              item.reject(new Error("Pi rejected RPC command"));
            else item.resolve(value.data);
          } else event(value);
        } catch {
          fail();
          return;
        }
      }
    });
    this.child.stderr.on("data", () => {}); // Never copy provider diagnostics into protocol output.
    this.child.on("error", fail);
    this.child.on("exit", fail);
  }
  request(
    type: string,
    args: Record<string, unknown> = {},
    timeout = 20000,
  ): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Pi stopped"));
    if (this.pending.size >= 32)
      return Promise.reject(new Error("Pi RPC busy"));
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Pi RPC timed out"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ id, type, ...args }) + "\n",
        (e) => {
          if (e) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(new Error("Pi RPC write failed"));
          }
        },
      );
    });
  }
  async stop() {
    this.close();
    await this.exited;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Pi stopped"));
    }
    this.pending.clear();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }, 1500);
    timer.unref();
  }
}
