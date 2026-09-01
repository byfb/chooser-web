<!--
SPDX-FileCopyrightText: 2026 byfb
SPDX-License-Identifier: GPL-3.0-or-later
-->

# Chooser Web

Chooser Web is a static single-page progressive web app that adapts the
interaction of the Android [Chooser project](https://github.com/UrAvgCode/Chooser)
for current browsers. It keeps the shared-surface selection experience
wordless while adding browser-compatible Settings, Legal, offline, and
capability behavior.

Copyright (C) 2026 byfb

SPDX-License-Identifier: GPL-3.0-or-later

## Status

This repository is being developed locally first. The current tree is not an
external publication or a conveyed production release until its guarded local
deployment completes. No GitHub repository is created or required.

**Web adaptation; modified 2026.** The upstream project
is Copyright (C) 2025 UrAvgCode and is available at
<https://github.com/UrAvgCode/Chooser>. The upstream Settings screen records
`UrAvgCode, Patch4Code` as its authors; that attribution is preserved whenever
the corresponding Settings expression is adapted. See
[`NOTICE.md`](NOTICE.md) and
[`legal/asset-provenance.md`](legal/asset-provenance.md) for the
complete attribution and asset record.

## License and source

Chooser Web is distributed under the GNU General Public License, version 3 or
any later version (`GPL-3.0-or-later`). The complete license text is in
[`LICENSE`](LICENSE). Recipients may copy, modify, and redistribute the
program under that license. The program comes without warranty, to the extent
permitted by applicable law; see the license for the controlling terms. This
project adds no EULA or term that restricts GPL rights.

Each deployment serves its complete, normalized Corresponding Source archive
at `/source/chooser-web-<full-sha>.tar.gz` on the same origin. The archive,
Legal page, service worker, and emitted JavaScript/CSS banners identify the
same full Git SHA. A moving branch, mutable landing page, or unrelated source
snapshot is not Corresponding Source for a release.

## Development

Use Node.js `>=22.13.0` and pnpm `>=10.12.1`. The repository pins pnpm through
`packageManager` and commits `pnpm-lock.yaml` so the toolchain can be recreated
without dependency ranges.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Useful local checks and builds are:

```sh
pnpm format:check
pnpm lint
pnpm check
pnpm fsd:check
pnpm legal:check
pnpm test
pnpm test:coverage
pnpm build
pnpm verify
```

`pnpm build` requires a clean Git commit. It performs two isolated
frozen-lockfile Astro builds, proves their outputs and source archives are
byte-identical, and materializes the verified candidate into `dist`.
`pnpm verify` runs the complete local, non-mutating quality gate and finishes
with that deterministic release build. Release metadata stays outside the
deployable tree under ignored `.artifacts/release/`; `dist` contains only the
static application and its SHA-named source archive.

## Deployment

Deployment is local and does not use GitHub or a workflow. For the clean commit
being released, create ignored `.artifacts/release/source-approval.json` with
the exact full SHA and its same-origin archive URL:

```json
{
  "schemaVersion": 1,
  "status": "approved",
  "immutable": true,
  "sourceRevision": "<full-sha>",
  "sourceUrl": "https://chooser-web.pages.dev/source/chooser-web-<full-sha>.tar.gz"
}
```

Then run `pnpm deploy`. The command executes `pnpm verify`, rechecks the clean
SHA and canonical artifact digest, safely creates or reuses the `chooser-web`
Direct Upload Pages project, and uploads `dist` once on production branch
`main`. It refuses unresolved or mismatched source, Legal, manifest, archive,
worktree, project, and Wrangler state. Custom-domain association is a separate
Cloudflare Pages setting; the application does not add rollback or GitHub
deployment machinery.

The source follows Feature-Sliced Design: application concerns live under
`src/app`, page slices under `src/_pages`, shared configuration under
`src/shared`, and Astro route wrappers under `src/pages`. Fixed public assets
and offline legal documents belong under `public` when they are introduced.

## Asset policy

Mode and launcher icons are independently authored, editable SVGs. Their
install raster sizes are generated from those sources. Finger feedback uses
original Web Audio oscillator/envelope definitions; no reference MP3 is
distributed. The reference Android vectors, extracted Android/Material
resources, Tutorial media, screenshots, badges, store graphics, README art,
and other excluded media are not copied into this project. The status and
license basis of each planned asset is recorded in
[`legal/asset-provenance.md`](legal/asset-provenance.md).

Third-party package and asset notices are maintained in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The complete reviewed
package set is recorded in
[`legal/dependency-inventory.json`](legal/dependency-inventory.json),
and the packages known to contribute generated browser code are declared in
[`legal/shipped-build-output-packages.json`](legal/shipped-build-output-packages.json).
Those records must be regenerated and reviewed whenever the lockfile, shipped
code, or asset inventory changes. Run `pnpm legal:inventory` to regenerate the
package record; this command may query registry metadata for platform-specific
packages that are locked but not installed on the current machine.

## Legal records

The repository legal record consists of:

- [`LICENSE`](LICENSE), the complete unmodified GPLv3 text;
- [`NOTICE.md`](NOTICE.md), program and upstream attribution, modification,
  rights, and warranty notices;
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), reviewed dependency and
  asset notices; and
- [`legal/asset-provenance.md`](legal/asset-provenance.md), the
  editable-source and license record for every included or excluded asset.

The captured upstream reset change is kept separately at
`legal/upstream/chooser-041dd0c-reset.patch` so the reference working-tree
state can be audited without copying its uncommitted change into the web
application.
