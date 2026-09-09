import { defineConfig } from "vite";

const appPort = Number(process.env.APP_PORT || "5174");
const agentOrigin = process.env.AGENT_ORIGIN || "http://127.0.0.1:3002";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: appPort,
    strictPort: true,
    proxy: { "/api": { target: agentOrigin } },
  },
});
