import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    // Every page carries private room content or a posting secret in its URL:
    // keep it out of search indexes, shared caches and outgoing Referer headers.
    return [{
      source: "/((?!_next/static).*)",
      headers: [
        { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "private, no-store" },
      ],
    }];
  },
};

export default nextConfig;
