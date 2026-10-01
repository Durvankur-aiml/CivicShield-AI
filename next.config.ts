import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo root is the project folder itself; prevents Turbopack from
  // picking up a stray parent package-lock.json outside the repository.
  turbopack: {
    root: __dirname,
  },
  // Baseline security headers (Phase 1 hardening). Deliberately conservative:
  // no CSP yet — it must be tuned against Firebase (popup auth, connect-src),
  // Leaflet/OSM tiles, and Google Fonts before it can ship safely.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), geolocation=(self)",
          },
        ],
      },
    ];
  },
  // Removed serverExternalPackages: ["firebase-admin"] to allow native bundling
};

export default nextConfig;
