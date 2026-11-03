// All browser calls go to /api/v1/* on the web origin; Next proxies them to the API, so the session cookie stays same-origin
// and the API's Origin check (WEB_ORIGIN) passes. The API is never exposed to the browser directly.
/** @type {import('next').NextConfig} */
export default {
  poweredByHeader: false,
  async rewrites() { return [{ source: "/api/v1/:path*", destination: `${process.env.API_URL ?? "http://localhost:4000"}/api/v1/:path*` }]; },
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Frame-Options", value: "DENY" }, { key: "X-Content-Type-Options", value: "nosniff" }, { key: "Referrer-Policy", value: "no-referrer" },
    ] }];
  },
};
