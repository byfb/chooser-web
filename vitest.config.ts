import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts", "scripts/**/*.mjs"],
      exclude: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    },
  },
});
