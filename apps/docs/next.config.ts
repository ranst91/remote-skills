import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const config = {
  reactStrictMode: true,
  async rewrites() {
    return {
      beforeFiles: [{ source: "/docs/index.md", destination: "/markdown" }],
      afterFiles: [{ source: "/docs/:slug*.md", destination: "/markdown/:slug*" }],
      fallback: [],
    };
  },
  webpack(webpackConfig, { dev }) {
    // Fumadocs MDX evaluates generated modules by URL; disabling the production
    // filesystem cache avoids Webpack's unsupported dynamic-import cache warning.
    if (!dev) webpackConfig.cache = false;
    return webpackConfig;
  },
} satisfies NextConfig;

export default createMDX()(config);
