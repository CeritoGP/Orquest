import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

function readDaemonToken(): string | undefined {
  const explicit = process.env.ORQUEST_DAEMON_TOKEN?.trim();
  if (explicit) return explicit;

  const stateRoot = process.env.ORQUEST_HOME ?? join(homedir(), "AppData", "Local", "OrquestBridge");
  const tokenPath = join(stateRoot, "daemon.token");
  if (!existsSync(tokenPath)) return undefined;
  const token = readFileSync(tokenPath, "utf8").trim();
  return token.length > 0 ? token : undefined;
}

function authenticatedProxy(): ProxyOptions {
  return {
    target: "http://127.0.0.1:4317",
    configure(proxy) {
      proxy.on("proxyReq", (proxyRequest) => {
        const token = readDaemonToken();
        if (token !== undefined) proxyRequest.setHeader("authorization", `Bearer ${token}`);
      });
      proxy.on("proxyRes", (proxyResponse, request, response) => {
        if (request.url?.startsWith("/api/events/stream")) {
          proxyResponse.once("close", () => {
            if ("destroy" in response && typeof response.destroy === "function") response.destroy();
          });
        }
      });
      proxy.on("error", (_error, request, response) => {
        if (request.url?.startsWith("/api/events/stream") && "destroy" in response && typeof response.destroy === "function") {
          response.destroy();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4318,
    // If 4318 is occupied, Vite selects the next loopback port and prints it.
    // The launcher keeps that terminal visible so the operator can open it.
    strictPort: false,
    proxy: {
      "/api": authenticatedProxy(),
      "/health": authenticatedProxy(),
    },
  },
});

