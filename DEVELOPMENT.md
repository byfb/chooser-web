<!--
SPDX-FileCopyrightText: 2026 byfb
SPDX-License-Identifier: GPL-3.0-or-later
-->

# Development and releases

## Quality checks

Install with `pnpm install --frozen-lockfile`. The `packageManager` field pins pnpm; Node.js 24 is used in CI.

| Command                         | Purpose                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `pnpm dev`                      | Start the development server                              |
| `pnpm format:check`             | Check formatting                                          |
| `pnpm lint`                     | Run ESLint                                                |
| `pnpm check`                    | Check Astro and TypeScript                                |
| `pnpm fsd:check`                | Check architecture boundaries                             |
| `pnpm legal:check`              | Validate licenses, notices, and dependency inventory      |
| `pnpm test`                     | Run unit and release-tooling tests                        |
| `pnpm test:coverage`            | Run tests and coverage thresholds                         |
| `pnpm build`                    | Produce a deterministic release candidate from clean HEAD |
| `pnpm verify`                   | Run every quality check and the deterministic build       |
| `pnpm audit --audit-level=high` | Check all dependencies for high and critical advisories   |
| `pnpm preview`                  | Preview the built app                                     |

GitHub Actions runs `pnpm verify` and a separate dependency audit on `main` pushes, pull requests, and manual runs. It does not deploy the site.

The source uses application modules in `src/app`, page slices in `src/_pages`, shared configuration in `src/shared`, and thin Astro routes in `src/pages`. Static assets and offline notices live in `public`.

## Dependency and asset records

When changing packages, update `pnpm-lock.yaml`, `legal/shipped-build-output-packages.json`, and the versions in `THIRD_PARTY_NOTICES.md` and `scripts/legal/check.mjs`. Run `pnpm legal:inventory` to regenerate `legal/dependency-inventory.json`, review licenses, and synchronize the public notice copies. This command may fetch registry metadata for packages not installed on the current platform.

The preferred editable sources for icons and synthesized audio are listed in `legal/asset-provenance.md`. Preserve upstream attribution and the unmodified GPL text. The upstream reset patch used for reference review is retained in `legal/upstream/`.

## Cloudflare Pages deployment

`pnpm build` creates two isolated frozen-lockfile builds and verifies that their outputs and normalized source archives are byte-identical. It places the verified candidate in `dist`; ignored metadata stays in `.artifacts/release/`.

Deployment uses local Wrangler authentication and the existing `chooser-web` Direct Upload Pages project. For the clean commit to release, create ignored `.artifacts/release/source-approval.json` with its exact full SHA and same-origin archive URL:

```json
{
  "schemaVersion": 1,
  "status": "approved",
  "immutable": true,
  "sourceRevision": "<full-sha>",
  "sourceUrl": "https://chooser-web.pages.dev/source/chooser-web-<full-sha>.tar.gz"
}
```

Then run:

```sh
pnpm run deploy
```

The explicit `run` selects this project's script instead of pnpm's unrelated built-in `deploy` command. The script runs `pnpm verify`, checks the clean SHA and artifact digest, validates the Pages project, and uploads `dist` on the production branch `main`. Custom-domain association remains a Cloudflare Pages setting.

The deployed Legal page, service worker, JavaScript/CSS banners, and downloadable Corresponding Source must identify the same full SHA. A Git history rewrite invalidates old local source approvals: prepare a new approval for the rewritten release commit before deploying. Publishing Git commits alone does not replace an existing deployment or its source archive.
