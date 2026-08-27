import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "ffmpeg-static"],
  outputFileTracingIncludes: {
    "/api/uploads": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default nextConfig;
