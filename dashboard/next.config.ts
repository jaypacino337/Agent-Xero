import type { NextConfig } from "next";

/**
 * Static export: `npm run build` writes ./out, which the agent's own HTTP
 * server (src/server/api.ts) serves next to the /api/* JSON it polls.
 * One Railway service, one origin, no CORS.
 */
const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // the agent repo has its own lockfile one level up; this app is its own root
  turbopack: { root: process.cwd() },
};

export default config;
