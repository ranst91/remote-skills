import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["@remote-skills/mastra", "@remote-skills/client", "@mastra/core"],
};
export default config;
