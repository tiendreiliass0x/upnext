import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The floating dev-tools badge sits on top of the booth UI.
  devIndicators: false,
  // Traced, self-contained server output: the full node_modules tree is ~885MB,
  // most of it Next's own multi-platform SWC binaries, which is a lot to carry
  // onto a small VPS.
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "ffmpeg-static"],
  outputFileTracingIncludes: {
    "/api/uploads": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default nextConfig;
