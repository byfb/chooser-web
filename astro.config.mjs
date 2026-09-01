// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import react from "@astrojs/react";
import { defineConfig } from "astro/config";

import { createChooserPwaIntegration } from "./scripts/pwa/index.mjs";

const buildIdentity = process.env.CHOOSER_BUILD_ID ?? "development";
const sourceStatus = process.env.CHOOSER_SOURCE_STATUS ?? "pending";
const sourceUrl = process.env.CHOOSER_SOURCE_URL ?? "";

export default defineConfig({
  output: "static",
  integrations: [
    react(),
    createChooserPwaIntegration({
      buildId: buildIdentity,
      sourceStatus,
      sourceUrl,
    }),
  ],
  vite: {
    define: {
      __CHOOSER_BUILD_ID__: JSON.stringify(buildIdentity),
      __CHOOSER_SOURCE_STATUS__: JSON.stringify(sourceStatus),
      __CHOOSER_SOURCE_URL__: JSON.stringify(sourceUrl),
    },
  },
});
