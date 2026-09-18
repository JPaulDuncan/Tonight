import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // The simulation is headless by design, so the tests need no DOM. Only the
    // render layer touches three.js or the browser.
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
