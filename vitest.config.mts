import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Lets a test render a component to HTML (react-dom/server) without importing React in every component.
  // tsconfig keeps "jsx": "preserve" for Next; this only affects the test transform.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Some tests talk to the real (remote) database; several files run in parallel. Offline tests
    // finish in milliseconds, so a roomier limit only matters for the live ones.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
