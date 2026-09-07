import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type AcpRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown> | unknown;
export interface AcpTransportOptions {
  command: string;
  args?: string[];
  cwd: string;
  /** Pass an explicitly scoped environment; credentials are never logged. */
  env: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  maxQueuedBytes?: number;
  maxPendingRequests?: number;
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: AcpRequestHandler;
}
export class AcpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** ACP v1 newline-delimited JSON-RPC over stdio. No shell and no stderr forwarding. */
export class AcpStdioTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly writes = new Set<(error: Error) => void>();
  private input = Buffer.alloc(0);
  private sequence = 0;
  private queuedBytes = 0;
  private servingRequests = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private failure?: Error;
  private killTimer?: ReturnType<typeof setTimeout>;
  private readonly messageLimit: number;
  private readonly queueLimit: number;
  private readonly pendingLimit: number;
  private readonly ownsProcessGroup = process.platform !== "win32";

  constructor(private readonly options: AcpTransportOptions) {
    this.messageLimit = options.maxMessageBytes ?? 8 * 1024 * 1024;
    this.queueLimit = options.maxQueuedBytes ?? 16 * 1024 * 1024;
    this.pendingLimit = options.maxPendingRequests ?? 128;
    for (const value of [
      this.messageLimit,
      this.queueLimit,
      this.pendingLimit,
      options.requestTimeoutMs ?? 120_000,
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("Invalid ACP transport limit");
    }
    if (!options.command || options.command.includes("\0"))
      throw new Error("Invalid ACP command");
    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      // A separate POSIX group lets close terminate the adapter and its CLI children.
      detached: this.ownsProcessGroup,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    // Drain logs without retaining or exposing private prompts, tokens, or credentials.
    this.child.stderr.resume();
    this.child.on("error", () =>
      this.fail(new Error("ACP process could not start")),
    );
    this.child.stdin.on("error", () =>
      this.fail(new Error("ACP input stream closed")),
    );
    this.child.stdout.on("error", () =>
      this.fail(new Error("ACP output stream failed")),
    );
    this.child.on("exit", () => {
      if (!this.ownsProcessGroup && this.killTimer)
        clearTimeout(this.killTimer);
      this.fail(new Error("ACP process exited"));
    });
    this.child.stdout.on("end", () =>
      this.fail(new Error("ACP output stream closed")),
    );
  }

  request<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutMs = this.options.requestTimeoutMs ?? 120_000,
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      return Promise.reject(new Error("Invalid ACP request timeout"));
    if (this.pending.size >= this.pendingLimit)
      return Promise.reject(new Error("ACP request capacity exceeded"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ACP request timed out"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      void this.send({ jsonrpc: "2.0", id, method, params }).catch(
        (error: Error) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(error);
        },
      );
    });
  }

  notify(method: string, params: unknown = {}): Promise<void> {
    return this.send({ jsonrpc: "2.0", method, params });
  }

  cancel(sessionId: string): Promise<void> {
    return this.notify("session/cancel", { sessionId });
  }

  close(): void {
    this.fail(new Error("ACP transport closed"));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.input = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const reject of this.writes) reject(error);
    this.writes.clear();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (this.signalOwnedProcess("SIGTERM")) {
      // Do not cancel on leader exit: the adapter may exit before its CLI children.
      this.killTimer = setTimeout(
        () => this.signalOwnedProcess("SIGKILL"),
        2_000,
      );
      this.killTimer.unref();
    }
  }

  private signalOwnedProcess(signal: NodeJS.Signals): boolean {
    const pid = this.child.pid;
    if (!pid || pid <= 1) return false;
    try {
      if (this.ownsProcessGroup) {
        process.kill(-pid, signal);
        return true;
      }
      if (this.child.exitCode !== null || this.child.signalCode !== null)
        return false;
      return this.child.kill(signal);
    } catch {
      // ESRCH means the owned group has already terminated. Never signal the caller's group.
      return false;
    }
  }

  private send(message: unknown): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    let data: Buffer;
    try {
      data = Buffer.from(`${JSON.stringify(message)}\n`);
    } catch {
      return Promise.reject(new Error("ACP message is not serializable"));
    }
    if (
      data.length > this.messageLimit ||
      this.queuedBytes + data.length > this.queueLimit
    ) {
      return Promise.reject(
        new Error("ACP outbound message capacity exceeded"),
      );
    }
    this.queuedBytes += data.length;
    const operation = this.writeTail
      .then(() => this.write(data))
      .finally(() => {
        this.queuedBytes -= data.length;
      });
    this.writeTail = operation.catch(() => {});
    return operation;
  }

  private write(data: Buffer): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<void>((resolve, reject) => {
      let flushed = false;
      let drained = false;
      const cleanup = () => {
        this.child.stdin.off("drain", onDrain);
        this.writes.delete(onFailure);
      };
      const finish = () => {
        if (flushed && drained) {
          cleanup();
          resolve();
        }
      };
      const onFailure = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onDrain = () => {
        drained = true;
        finish();
      };
      this.writes.add(onFailure);
      this.child.stdin.on("drain", onDrain);
      try {
        drained = this.child.stdin.write(data, (error) => {
          if (error) {
            onFailure(new Error("ACP write failed"));
            return;
          }
          flushed = true;
          finish();
        });
        finish();
      } catch {
        onFailure(new Error("ACP write failed"));
      }
    });
  }

  private consume(chunk: Buffer): void {
    if (this.failure) return;
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      if (this.input.length + i - start > this.messageLimit) {
        this.fail(new Error("ACP message too large"));
        return;
      }
      const line = Buffer.concat([this.input, chunk.subarray(start, i)]);
      this.input = Buffer.alloc(0);
      start = i + 1;
      try {
        this.receive(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)),
        );
      } catch {
        this.fail(new Error("Invalid ACP protocol message"));
        return;
      }
      if (this.failure) return;
    }
    if (this.input.length + chunk.length - start > this.messageLimit) {
      this.fail(new Error("ACP message too large"));
      return;
    }
    this.input = Buffer.concat([this.input, chunk.subarray(start)]);
  }

  private receive(message: any): void {
    if (
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      message.jsonrpc !== "2.0"
    )
      throw new Error("Invalid message");
    if (typeof message.method === "string") {
      if (!Object.hasOwn(message, "id")) {
        this.options.onNotification?.(message.method, message.params);
        return;
      }
      if (typeof message.id !== "string" && typeof message.id !== "number")
        throw new Error("Invalid request id");
      if (this.servingRequests >= this.pendingLimit) {
        void this.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "Client request capacity exceeded" },
        }).catch(() => this.close());
        return;
      }
      this.servingRequests++;
      void this.handleRequest(message).finally(() => {
        this.servingRequests--;
      });
      return;
    }
    if (
      typeof message.id !== "number" ||
      Object.hasOwn(message, "result") === Object.hasOwn(message, "error")
    )
      throw new Error("Invalid response");
    const pending = this.pending.get(message.id);
    if (!pending) return; // Timed-out requests may still receive replies.
    if (
      Object.hasOwn(message, "error") &&
      (!message.error ||
        typeof message.error.code !== "number" ||
        typeof message.error.message !== "string")
    )
      throw new Error("Invalid error");
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (Object.hasOwn(message, "error"))
      pending.reject(
        new AcpRpcError(message.error.code, "ACP agent returned an error"),
      );
    else pending.resolve(message.result);
  }

  private async handleRequest(message: {
    id: string | number;
    method: string;
    params: unknown;
  }): Promise<void> {
    let response: unknown;
    try {
      if (!this.options.onRequest)
        throw new AcpRpcError(-32601, "Unsupported client method");
      const result = await this.options.onRequest(
        message.method,
        message.params,
      );
      response = { jsonrpc: "2.0", id: message.id, result: result ?? null };
    } catch (error) {
      response = {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: error instanceof AcpRpcError ? error.code : -32603,
          message: "Client request failed",
        },
      };
    }
    try {
      await this.send(response);
    } catch {
      this.close();
    }
  }
}
