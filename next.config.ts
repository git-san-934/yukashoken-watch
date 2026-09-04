import type { NextConfig } from "next";

// Served from https://git-san-934.github.io/yukashoken-watch/ as a GitHub
// Pages project site, so the build needs a "/yukashoken-watch" base path.
// Local dev/preview builds keep the root path (GITHUB_PAGES unset).
const isGithubPagesBuild = process.env.GITHUB_PAGES === "true";
const basePath = isGithubPagesBuild ? "/yukashoken-watch" : "";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath,
  assetPrefix: basePath,
  // Inlined into client code so a manual fetch() of a public/ asset (e.g.
  // edinet-filings.json) can build the right same-origin URL — Next does
  // NOT rewrite plain fetch() calls the way it does <Image>/<Script>.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
