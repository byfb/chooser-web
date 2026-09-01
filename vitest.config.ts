// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts", "scripts/**/*.mjs"],
      exclude: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
      thresholds: {
        "src/_pages/settings/model/settings-capability-model.ts": {
          100: true,
        },
        "src/app/model/chooser-settings-store.ts": {
          100: true,
        },
      },
    },
  },
});
