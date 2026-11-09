/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // postgres.js calls `new URL('.', import.meta.url)`. Bundled, webpack turns that into an
    // asset module and Terser then fails to parse the package's index.js ("import/export cannot be
    // used outside of module code"). Loading it from node_modules at runtime avoids that.
    serverComponentsExternalPackages: ["postgres"],
  },
};

export default nextConfig;
