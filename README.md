<!--
SPDX-FileCopyrightText: 2026 byfb
SPDX-License-Identifier: GPL-3.0-or-later
-->

# Chooser Web

[![CI](https://github.com/byfb/chooser-web/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/byfb/chooser-web/actions/workflows/ci.yml)

Choose people, make groups, or decide an order on one shared screen.

**[Try Chooser Web](https://chooser-web.pages.dev/)**

## What you can do

- **Single:** randomly choose one or more participants.
- **Group:** divide participants into groups.
- **Order:** reveal a random order, one participant at a time.
- **Touch or click:** hold fingers on a shared touchscreen, or place participants with a mouse or trackpad.
- **Make it yours:** adjust selection timing, circle size, sound, vibration, and screen padding.
- **Use it offline:** install the app where supported and wait for Settings to report **Offline: Ready**. Updates wait until an active round finishes.

## How to use it

1. Tap the mode icon to switch between Single, Group, and Order. Tap the number to change the winner or group count.
2. Add participants to the screen and wait for the selection. The number of simultaneous touches depends on your device.
3. Hold the mode icon to open Settings. With a keyboard, focus that button and press **Shift+Enter**.

Sound, vibration, fullscreen, and installation depend on browser support and permissions. Settings shows which capabilities are available. Multi-touch works best on a phone or tablet.

## Privacy

Selections run in your browser. The app has no account system or analytics integration. Preferences are saved in browser local storage; selection rounds are not stored. Offline files are held in the browser cache. Clearing site data removes the saved preferences and cached app.

## Run locally

Use **Node.js 24 or later** and the pinned **pnpm 10.12.1** version.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open the local URL printed by Astro. To run formatting, lint, type, architecture, license, coverage, and release-build checks:

```sh
pnpm verify
```

The release build requires a clean Git commit and checks that two isolated builds produce identical files. See [DEVELOPMENT.md](DEVELOPMENT.md) for individual checks and Cloudflare deployment instructions.

## License and credits

**Web adaptation; modified 2026.** Copyright (C) 2026 byfb.
Adapted from [Chooser](https://github.com/UrAvgCode/Chooser), Copyright (C) 2025 UrAvgCode, with contributor attribution to Patch4Code.

Licensed under **GPL-3.0-or-later**, without warranty. See [LICENSE](LICENSE), [NOTICE.md](NOTICE.md), and [third-party notices](THIRD_PARTY_NOTICES.md).

Each release includes its exact Corresponding Source at `/source/chooser-web-<full-sha>.tar.gz`, also linked from Settings → Legal. The private GitHub repository is separate from this public release-source archive. Original icons and synthesized sounds are documented in the [asset provenance record](legal/asset-provenance.md).
