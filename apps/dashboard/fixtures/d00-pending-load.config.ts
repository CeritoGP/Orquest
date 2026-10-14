// Isolated reviewer fixture: no production delays or transport controls.
import acceptance from "../vite.acceptance.config.js";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import type { ServerResponse } from "node:http";

let downstream: ServerResponse | null = null;
let delayed = false;
const originalProxy = acceptance.server!.proxy!["/api"] as ProxyOptions;
const proxy: ProxyOptions = {
  ...originalProxy,
  configure(server, options) {
    originalProxy.configure?.(server, options);
    server.on("proxyRes", (_upstream, request, response) => {
      if (request.url?.startsWith("/api/events/stream")) downstream = response as ServerResponse;
    });
  },
};
const pendingLoad: Plugin = {
  name: "d00-review-pending-load",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (delayed || !/^\/api\/jobs\/[^/]+\/events(?:\?|$)/.test(request.url ?? "")) {
        next();
        return;
      }
      delayed = true;
      const interrupt = setTimeout(() => downstream?.destroy(), 8000);
      const release = setTimeout(() => { if (!response.destroyed) next(); }, 30000);
      response.once("close", () => { clearTimeout(interrupt); clearTimeout(release); });
      console.log("D00 review: initial events request pending; SSE interruption in 8 seconds.");
    });
  },
};
export default defineConfig({
  ...acceptance,
  plugins: [...(acceptance.plugins ?? []), pendingLoad],
  server: { ...acceptance.server, proxy: { ...acceptance.server!.proxy, "/api": proxy } },
});
