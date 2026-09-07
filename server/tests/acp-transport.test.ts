import { describe, expect, test } from "bun:test";
import {
  AcpRpcError,
  AcpStdioTransport,
  type AcpTransportOptions,
} from "../src/acp/transport";
const prelude = `import {createInterface} from 'node:readline'; const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n'); const lines=createInterface({input:process.stdin});`;
function agent(script: string, options: Partial<AcpTransportOptions> = {}) {
  return new AcpStdioTransport({
    command: process.execPath,
    args: ["-e", prelude + script],
    cwd: process.cwd(),
    env: {},
    requestTimeoutMs: 2000,
    ...options,
  });
}
describe("ACP stdio transport", () => {
  test("correlates concurrent fragmented UTF-8 replies", async () => {
    const t = agent(
      `lines.on('line',line=>{const m=JSON.parse(line);setTimeout(()=>{const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.params})+'\\n');for(const byte of b)process.stdout.write(Buffer.from([byte]));},m.params.delay);});`,
    );
    try {
      const values = await Promise.all([
        t.request("test", { text: "ação", delay: 30 }),
        t.request("test", { text: "日本語", delay: 0 }),
      ]);
      expect(values).toEqual([
        { text: "ação", delay: 30 },
        { text: "日本語", delay: 0 },
      ]);
    } finally {
      t.close();
    }
  });
  test("handles agent requests and session cancellation notifications", async () => {
    let observed: unknown;
    let served = false;
    const t = agent(
      `emit({jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{sessionId:'s'}});lines.on('line',line=>{const m=JSON.parse(line);if(m.method==='session/cancel')emit({jsonrpc:'2.0',method:'observed',params:m});if(m.method==='check')emit({jsonrpc:'2.0',id:m.id,result:true});});`,
      {
        onRequest: () => {
          served = true;
          return { outcome: "cancelled" };
        },
        onNotification: (_, params) => {
          observed = params;
        },
      },
    );
    try {
      await t.request("check");
      await t.cancel("s");
      await t.request("check");
      expect(served).toBe(true);
      expect(observed).toEqual({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: "s" },
      });
    } finally {
      t.close();
    }
  });
  test("unsupported client requests fail closed", async () => {
    const t = agent(
      `let result;emit({jsonrpc:'2.0',id:'x',method:'fs/read_text_file',params:{path:'/secret'}});lines.on('line',line=>{const m=JSON.parse(line);if(m.id==='x')result=m.error;if(m.method==='check')setTimeout(()=>emit({jsonrpc:'2.0',id:m.id,result}),30);});`,
    );
    try {
      expect(await t.request("check")).toEqual({
        code: -32601,
        message: "Client request failed",
      });
    } finally {
      t.close();
    }
  });
  test("timeout releases pending request and late response is ignored", async () => {
    const t = agent(
      `lines.on('line',line=>{const m=JSON.parse(line);setTimeout(()=>emit({jsonrpc:'2.0',id:m.id,result:'ok'}),m.method==='slow'?100:150);});`,
    );
    try {
      await expect(t.request("slow", {}, 10)).rejects.toThrow("timed out");
      expect(await t.request("fast")).toBe("ok");
    } finally {
      t.close();
    }
  });
  test("process exit rejects pending requests without stderr secrets", async () => {
    const t = agent(
      `lines.once('line',()=>{process.stderr.write('PRIVATE_TOKEN');process.exit(1);});`,
    );
    const results = await Promise.allSettled([
      t.request("one"),
      t.request("two"),
    ]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected")
        expect(r.reason.message).not.toContain("PRIVATE_TOKEN");
    }
    t.close();
  });
  test("spawn failure does not expose command", async () => {
    const t = agent("", { command: "/nonexistent/private-token-command" });
    await expect(t.request("one")).rejects.toThrow(
      "ACP process could not start",
    );
    t.close();
  });
  test("malformed or excessive stdout terminates transport", async () => {
    for (const output of ["not-json\n", "x".repeat(300)]) {
      const t = agent(
        `lines.once('line',()=>process.stdout.write(${JSON.stringify(output)}));`,
        { maxMessageBytes: 256 },
      );
      await expect(t.request("test")).rejects.toThrow(/Invalid ACP|too large/);
      t.close();
    }
  });
  test("outbound bytes and pending requests are bounded", async () => {
    const t = agent("", {
      maxMessageBytes: 128,
      maxQueuedBytes: 128,
      maxPendingRequests: 1,
    });
    try {
      const first = t.request("wait", {}, 30);
      await expect(t.request("second")).rejects.toThrow("capacity");
      await expect(
        t.notify("large", { text: "x".repeat(256) }),
      ).rejects.toThrow("capacity");
      await expect(first).rejects.toThrow("timed out");
    } finally {
      t.close();
    }
  });
  test("writes payload beyond pipe capacity under backpressure", async () => {
    const t = agent(
      `lines.on('line',line=>{const m=JSON.parse(line);emit({jsonrpc:'2.0',id:m.id,result:m.params.text.length});});`,
    );
    try {
      expect(await t.request("large", { text: "x".repeat(512 * 1024) })).toBe(
        512 * 1024,
      );
    } finally {
      t.close();
    }
  });
  test("close rejects in-flight and future operations", async () => {
    const t = agent("setInterval(()=>{},1000);");
    const first = t.request("wait");
    t.close();
    await expect(first).rejects.toThrow("closed");
    await expect(t.notify("later")).rejects.toThrow("closed");
    t.close();
  });
  test("RPC errors preserve codes but redact agent message", async () => {
    const t = agent(
      `lines.on('line',line=>{const m=JSON.parse(line);emit({jsonrpc:'2.0',id:m.id,error:{code:-32001,message:'SECRET'}});});`,
    );
    try {
      const e = await t.request("fail").catch((e) => e);
      expect(e).toBeInstanceOf(AcpRpcError);
      expect(e.code).toBe(-32001);
      expect(e.message).not.toContain("SECRET");
    } finally {
      t.close();
    }
  });
  test("null error responses reject promptly instead of orphaning requests", async () => {
    const t = agent(
      `lines.on('line',line=>{const m=JSON.parse(line);emit({jsonrpc:'2.0',id:m.id,error:null});});`,
    );
    try {
      await expect(t.request("invalid")).rejects.toThrow(
        "Invalid ACP protocol",
      );
    } finally {
      t.close();
    }
  });
  test("argv arguments remain literal without shell interpretation", async () => {
    const literal = "$(echo secret); *";
    const t = agent("", {
      args: [
        "-e",
        prelude +
          `lines.on('line',line=>{const m=JSON.parse(line);emit({jsonrpc:'2.0',id:m.id,result:process.argv.at(-1)});});`,
        literal,
      ],
    });
    try {
      expect(await t.request("argv")).toBe(literal);
    } finally {
      t.close();
    }
  });
  test.skipIf(process.platform === "win32")(
    "close kills CLI descendants even after the adapter exits",
    async () => {
      for (const exitLeader of [false, true]) {
        const childCode =
          "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000);";
        const t = agent(`
        const {spawn}=await import('node:child_process');
        const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','ignore','ignore','ipc']});
        let ready=false; child.on('message',()=>{ready=true});
        lines.on('line',line=>{const m=JSON.parse(line);const send=()=>{if(!ready){setTimeout(send,5);return;}emit({jsonrpc:'2.0',id:m.id,result:child.pid});${exitLeader ? "setTimeout(()=>process.exit(0),20);" : ""}};send();});
      `);
        let childPid: number | undefined;
        try {
          childPid = await t.request<number>("spawn");
          process.kill(childPid, 0);
          if (exitLeader)
            await new Promise((resolve) => setTimeout(resolve, 100));
          else t.close();
          const deadline = Date.now() + 4000;
          let alive = true;
          while (Date.now() < deadline) {
            try {
              process.kill(childPid, 0);
            } catch {
              alive = false;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(alive).toBe(false);
        } finally {
          t.close();
          if (childPid) {
            try {
              process.kill(childPid, "SIGKILL");
            } catch {}
          }
        }
      }
    },
    10000,
  );
});
