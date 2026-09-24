import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next blocks dev resources when the page is opened as 127.0.0.1 instead of localhost.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
