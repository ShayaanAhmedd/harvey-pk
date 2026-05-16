import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },
  serverExternalPackages: [
    "pdfjs-dist",
    "tesseract.js",
    "@napi-rs/canvas",
  ],
};

export default nextConfig;
