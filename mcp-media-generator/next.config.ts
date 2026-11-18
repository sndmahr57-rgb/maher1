import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // نترك هذه الحزم خارجية كي تعمل عبر node runtime دون تجميع داخلي
  serverExternalPackages: ["@libsql/client", "@modelcontextprotocol/sdk"],
};

export default nextConfig;
