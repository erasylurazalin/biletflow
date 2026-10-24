import type { NextConfig } from "next";

// Same default as web/src/api.ts. Read here, on the server, so the browser never
// needs API_URL. The API sends no CORS headers, so auth calls stay on this origin.
const apiUrl = (process.env.API_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  // Next blocks dev resources when the page is opened as 127.0.0.1 instead of localhost.
  allowedDevOrigins: ["127.0.0.1"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
