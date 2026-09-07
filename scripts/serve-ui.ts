/** Production UI: immutable build assets, SPA navigation, and streaming API/WS proxy. */
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import type { Socket } from "node:net";
import { pipeline } from "node:stream";

export type UiOptions = {
  dist: string;
  api: string;
  host?: string;
  port?: number;
  allowedHosts?: string[];
};
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".mobileconfig": "application/x-apple-aspen-config",
  ".webmanifest": "application/manifest+json",
};
const apiPath = (url: string) =>
  url.split("?", 1)[0] === "/api" || url.startsWith("/api/");

function respond(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

/** No build or server startup side effects when imported by tests. */
export async function createUiServer(options: UiOptions) {
  const root = await realpath(options.dist);
  const index = await realpath(path.join(root, "index.html"));
  if (!index.startsWith(root + path.sep) || !(await stat(index)).isFile())
    throw new Error("UI build index is missing");
  const api = new URL(options.api);
  if (
    !["http:", "https:"].includes(api.protocol) ||
    api.username ||
    api.password ||
    api.pathname !== "/"
  ) {
    throw new Error(
      "OPENBOT_UI_API_URL must be an HTTP origin without credentials or a path",
    );
  }
  const allowedHosts = options.allowedHosts ?? [
    "localhost",
    "127.0.0.1",
    "[::1]",
    ".tail3c3777.ts.net",
  ];
  const allowedHost = (req: IncomingMessage) => {
    try {
      const host = new URL(
        `http://${req.headers.host ?? ""}`,
      ).hostname.toLowerCase();
      return allowedHosts.some((entry) =>
        entry.startsWith(".") ? host.endsWith(entry) : host === entry,
      );
    } catch {
      return false;
    }
  };
  const requestUpstream =
    api.protocol === "https:" ? httpsRequest : httpRequest;
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    if (!allowedHost(req)) {
      respond(res, 403, "Host not allowed");
      return;
    }
    const raw = req.url ?? "/";
    if (apiPath(raw)) {
      // Preserve /api, cookies, authorization, Origin, Host, SSE, and streaming bodies.
      // Vite's current proxy also preserves Host (changeOrigin is not enabled).
      const upstream = requestUpstream(
        api,
        { method: req.method, path: raw, headers: req.headers },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          pipeline(reply, res, () => {});
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent && !res.destroyed)
          respond(res, 502, "API unavailable");
        else res.destroy();
      });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      respond(res, 405, "Method not allowed");
      return;
    }
    if (raw.split("?", 1)[0] === "/__ui/health") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(
        req.method === "HEAD"
          ? undefined
          : JSON.stringify({ status: "ok", mode: "static" }),
      );
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw.split("?", 1)[0]!);
    } catch {
      respond(res, 400, "Invalid path");
      return;
    }
    if (
      !decoded.startsWith("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      decoded.split("/").some((part) => part.startsWith("."))
    ) {
      respond(res, 400, "Invalid path");
      return;
    }
    try {
      let target = path.join(root, decoded);
      try {
        target = await realpath(target);
        if (!target.startsWith(root + path.sep) && target !== root) {
          respond(res, 404, "Not found");
          return;
        }
        if (!(await stat(target)).isFile()) target = index;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as NodeJS.ErrnoException).code !== "ENOTDIR"
        )
          throw error;
        // Missing assets must be 404, not HTML masquerading as a script.
        if (path.extname(decoded) || decoded.startsWith("/assets/")) {
          respond(res, 404, "Not found");
          return;
        }
        target = index;
      }
      const info = await stat(target);
      const extension = path.extname(target);
      const immutable =
        target.startsWith(path.join(root, "assets") + path.sep) &&
        /-[a-zA-Z0-9_-]{8,}\.[^.]+$/.test(target);
      res.writeHead(200, {
        "Content-Type": MIME[extension] ?? "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control": immutable
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'",
      });
      if (req.method === "HEAD") res.end();
      else pipeline(createReadStream(target), res, () => {});
    } catch {
      if (!res.headersSent) respond(res, 500, "Unable to read UI build");
      else res.destroy();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!allowedHost(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!apiPath(req.url ?? "")) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = requestUpstream(api, {
      method: req.method,
      path: req.url,
      headers: req.headers,
    });
    const timer = setTimeout(() => {
      upstream.destroy();
      socket.destroy();
    }, 15_000);
    upstream.on("upgrade", (reply, remote, upstreamHead) => {
      clearTimeout(timer);
      sockets.add(remote);
      remote.on("close", () => {
        sockets.delete(remote);
        socket.destroy();
      });
      remote.on("error", () => socket.destroy());
      socket.on("close", () => remote.destroy());
      const headers = reply.rawHeaders.reduce(
        (all, value, i) => all + (i % 2 ? value + "\r\n" : value + ": "),
        "",
      );
      socket.write(
        `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${headers}\r\n`,
      );
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
    });
    upstream.on("response", (reply) => {
      clearTimeout(timer);
      // Retain API rejection status; never return SPA HTML for a failed upgrade.
      socket.end(
        `HTTP/1.1 ${reply.statusCode ?? 502} Upgrade rejected\r\nConnection: close\r\n\r\n`,
      );
      reply.resume();
    });
    upstream.on("error", () => {
      clearTimeout(timer);
      socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => {
      clearTimeout(timer);
      upstream.destroy();
    });
    upstream.end();
  });
  return {
    server,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 3010, options.host ?? "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("UI has no TCP address");
      return `http://${options.host ?? "127.0.0.1"}:${address.port}`;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

if (import.meta.main) {
  const host = process.env.APP_HOST ?? "127.0.0.1";
  const port = Number(process.env.APP_PORT ?? "3010");
  const api =
    process.env.OPENBOT_UI_API_URL ??
    `http://127.0.0.1:${process.env.SERVER_PORT ?? "3001"}`;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid APP_PORT");
  if (process.argv.includes("--check")) {
    // Read-only checks. Never sends a chat, runs a routine, or modifies state.
    for (const url of [`http://${host}:${port}/__ui/health`, `${api}/health`]) {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok)
        throw new Error(`Health check failed: ${response.status}`);
      const body = (await response.json()) as { status?: string };
      if (body.status !== "ok")
        throw new Error("Health check returned unexpected body");
    }
    console.log(
      JSON.stringify({ status: "ok", checks: ["static-ui", "api-liveness"] }),
    );
  } else {
    const ui = await createUiServer({
      dist:
        process.env.OPENBOT_UI_DIST ??
        path.resolve(import.meta.dir, "../app/dist"),
      api,
      host,
      port,
      allowedHosts: process.env.OPENBOT_UI_ALLOWED_HOSTS?.split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    });
    await ui.listen();
    console.log(
      JSON.stringify({ service: "openbot-ui", mode: "static", host, port }),
    );
    const stop = () => {
      void ui.close().then(() => process.exit(0));
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
}
