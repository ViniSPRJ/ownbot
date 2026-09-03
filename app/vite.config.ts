import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const mobileconfigMime = {
  name: "mobileconfig-mime",
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      const path = (req.url ?? "").split("?")[0];
      if (path.endsWith(".mobileconfig")) {
        res.setHeader("Content-Type", "application/x-apple-aspen-config");
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [tanstackRouter(), react(), tailwindcss(), mobileconfigMime],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    allowedHosts: [".tail3c3777.ts.net", "localhost", "127.0.0.1"],
    port: Number.parseInt(process.env.APP_PORT ?? "3010", 10),
    strictPort: true,
    hmr: {
      overlay: false,
      protocol: "wss",
      clientPort: 3010,
    },
    proxy: {
      // `ws: true` is required for the live screen. Without it Vite answers the upgrade request with
      // the app's HTML and the socket fails with an opaque error that looks like a server problem.
      "/api": {
        target: `http://localhost:${process.env.SERVER_PORT ?? "3001"}`,
        ws: true,
      },
    },
  },
});
