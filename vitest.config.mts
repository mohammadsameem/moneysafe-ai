import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Some tests talk to the real (remote) database; several files run in parallel. Offline tests
    // finish in milliseconds, so a roomier limit only matters for the live ones.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
