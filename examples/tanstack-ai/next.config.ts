import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: [
    "@remote-skills/tanstack-ai",
    "@remote-skills/client",
    "@tanstack/ai",
    "@tanstack/ai-skills",
    "@tanstack/ai-openai",
  ],
};
export default config;
