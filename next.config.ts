import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone with a self-contained server.js and a pruned
  // node_modules. Required by the runtime stage of the Dockerfile.
  output: "standalone",
};

export default nextConfig;
