import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const daemonUrl = process.env.ORQUEST_ACCEPTANCE_DAEMON_URL ?? "http://127.0.0.1:4417";
const token = process.env.ORQUEST_ACCEPTANCE_DAEMON_TOKEN;
const interruptFirstSseAfterMs = Number.parseInt(process.env.ORQUEST_ACCEPTANCE_INTERRUPT_FIRST_SSE_AFTER_MS ?? "0", 10);
let interruptedFirstSse = false;

function authenticatedAcceptanceProxy(): ProxyOptions {
  return {
    target: daemonUrl,
    configure(proxy) {
      proxy.on("proxyReq", (proxyRequest) => {
        if (token !== undefined && token.length > 0) {
          proxyRequest.setHeader("authorization", `Bearer ${token}`);
        }
      });
      proxy.on("proxyRes", (proxyResponse, request, response) => {
        if (request.url?.startsWith("/api/events/stream")) {
          proxyResponse.once("close", () => {
            if ("destroy" in response && typeof response.destroy === "function") response.destroy();
          });
          if (!interruptedFirstSse && Number.isFinite(interruptFirstSseAfterMs) && interruptFirstSseAfterMs > 0) {
            interruptedFirstSse = true;
            const timer = setTimeout(() => {
              if ("destroy" in response && typeof response.destroy === "function") response.destroy();
            }, interruptFirstSseAfterMs);
            response.once("close", () => clearTimeout(timer));
          }
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

// Dedicated test-only Vite config. It keeps acceptance traffic away from the
// user's daemon (4317) and dashboard (4318).
export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4418,
    strictPort: true,
    proxy: {
      "/api": authenticatedAcceptanceProxy(),
      "/health": authenticatedAcceptanceProxy(),
    },
  },
});
