import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: [
    "@remote-skills/langchain",
    "@remote-skills/client",
    "deepagents",
    "langchain",
    "@langchain/openai",
    "@langchain/langgraph",
  ],
};
export default config;
