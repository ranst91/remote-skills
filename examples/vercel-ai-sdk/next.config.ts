import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: [
    "@remote-skills/ai-sdk",
    "@remote-skills/client",
    "bash-tool",
    "just-bash",
  ],
};
export default config;
