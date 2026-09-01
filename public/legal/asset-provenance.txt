<!--
SPDX-FileCopyrightText: 2026 byfb
SPDX-License-Identifier: GPL-3.0-or-later
-->

# Asset provenance

This record covers every asset planned for Chooser Web, including generated
derivatives and intentionally excluded reference materials. It is part of the
GPL source record and must agree with the explicit asset inventory used by the
release checker.

**Web adaptation; modified 2026.** The original
Chooser project is Copyright (C) 2025 UrAvgCode and is available at
<https://github.com/UrAvgCode/Chooser>. The upstream Settings source records
`@author UrAvgCode, Patch4Code`; that contributor attribution is retained in
the legal notices when the related Settings expression is adapted.

## Included and planned original assets

These entries describe independently authored assets. “Present” means the
editable source is included in this repository. “Pending” means the editable
source or release derivative does not exist yet. No reference file is copied
or traced.

| Asset                                     | Preferred editable source                                                  | Author        | Creation/adaptation date | License basis                                                                                         | Status  |
| ----------------------------------------- | -------------------------------------------------------------------------- | ------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- | ------- |
| Single-mode icon                          | `src/_pages/chooser/ui/icons/single.svg`                                   | byfb | 2026-09-01               | GPL-3.0-or-later; original editable SVG preserving only the Single-selection concept                  | Present |
| Group-mode icon                           | `src/_pages/chooser/ui/icons/group.svg`                                    | byfb | 2026-09-01               | GPL-3.0-or-later; original editable SVG preserving only the Group-selection concept                   | Present |
| Order-mode icon                           | `src/_pages/chooser/ui/icons/order.svg`                                    | byfb | 2026-09-01               | GPL-3.0-or-later; original editable SVG preserving only the Order-selection concept                   | Present |
| Launcher icon                             | `src/app/branding/launcher.svg`                                            | byfb | 2026-09-01               | GPL-3.0-or-later; original SVG preserving the Chooser concept without copying the Android vector path | Present |
| Regular install rasters (192 px, 512 px)  | `public/icons/icon-192.png`; `public/icons/icon-512.png`                   | byfb | 2026-09-01               | GPL-3.0-or-later as original derivatives of the launcher source                                       | Present |
| Maskable install rasters (192 px, 512 px) | `public/icons/icon-192-maskable.png`; `public/icons/icon-512-maskable.png` | byfb | 2026-09-01               | GPL-3.0-or-later as original derivatives of the launcher source with a safe maskable field            | Present |
| iOS touch icon                            | `public/icons/apple-touch-icon.png`                                        | byfb | 2026-09-01               | GPL-3.0-or-later as an original derivative of the launcher source                                     | Present |
| Finger-down cue                           | `src/_pages/chooser/model/chooser-feedback.ts`                             | byfb | 2026-09-01               | GPL-3.0-or-later; original Web Audio oscillator/envelope definition                                   | Present |
| Finger-up cue                             | `src/_pages/chooser/model/chooser-feedback.ts`                             | byfb | 2026-09-01               | GPL-3.0-or-later; original Web Audio oscillator/envelope definition                                   | Present |
| Chosen cue                                | `src/_pages/chooser/model/chooser-feedback.ts`                             | byfb | 2026-09-01               | GPL-3.0-or-later; original Web Audio oscillator/envelope definition                                   | Present |

The audio entries are source-code assets, not copied recordings. The release
must document waveform parameters, duration, peak bound, and generated
browser behavior in the implementation source. Group selection remains
silent under the accepted behavior contract.

## Legal and configuration assets

These text/configuration files are authored project assets rather than
third-party media. Their provenance is the repository history and the
accepted release contract:

| Asset                         | Source                                                              | Author/date                                                                                          | License basis                                          | Status                                                  |
| ----------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| GPL license text              | `LICENSE`                                                           | Free Software Foundation, Inc.; canonical GPLv3 text, preserved unmodified                           | GPLv3 license text; no project modification            | Required foundation artifact                            |
| Program notice                | `NOTICE.md`                                                         | byfb, 2026; preserves UrAvgCode 2025 and Patch4Code attribution                             | GPL-3.0-or-later                                       | Present in this foundation commit                       |
| Dependency notices            | `THIRD_PARTY_NOTICES.md` and `legal/dependency-inventory.json` | byfb, 2026; deterministically derived and reviewed from `package.json` and `pnpm-lock.yaml` | Per-package licenses, recorded in the notice inventory | Present; six shipped and 670 build-only package records |
| Asset provenance record       | `legal/asset-provenance.md`                                    | byfb, 2026                                                                                  | GPL-3.0-or-later                                       | Present in this foundation commit                       |
| Captured upstream reset patch | `legal/upstream/chooser-041dd0c-reset.patch`                         | Derived from UrAvgCode Chooser commit `041dd0c31f9a2fe0586ef226dfeb49bc5b043b61`                     | Upstream GPL-3.0-or-later source record                | Present; exact working-tree delta preserved             |

The deployed offline Legal route will expose these records through local
`text/plain; charset=utf-8` links. The same-release source archive is online
and SHA-named; it is not treated as a precached asset.

## Explicitly excluded reference materials

The following files and categories were inspected for provenance but are not
part of Chooser Web. They remain excluded because the adaptation does not need
them, their individual ownership/license basis is not recorded by the
reference repository, or copying them would conflict with the accepted
original-asset policy.

| Reference material                                             | Reference location                                                                                     | Decision and reason                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Android vector drawables and extracted Material/AndroidX icons | Upstream `app/src/main/res/drawable*/` and related Android resources at `041dd0c`                      | Exclude. Mode and launcher icons are independently authored SVGs; no vector path is copied or traced. |
| Finger audio recordings                                        | Upstream `app/src/main/res/raw/finger_down.mp3`, `finger_up.mp3`, and `finger_chosen.mp3` at `041dd0c` | Exclude. Browser cues are synthesized from original Web Audio definitions; no MP3 is shipped.         |
| Tutorial animation previews                                    | Upstream `readme/*.gif` and Tutorial resources at `041dd0c`                                            | Exclude. Tutorial is outside the accepted web scope and no tutorial media is needed.                  |
| README/store graphics, badges, screenshots, and download art   | Upstream `readme/`, `fastlane/metadata/`, and linked badge URLs at `041dd0c`                           | Exclude. These are reference presentation assets, not application assets.                             |
| Android build/intermediate resources                           | Local reference `app/build/` and `cache/` outputs                                                      | Exclude. Generated/intermediate files are neither source nor web release assets.                      |

No third-party fonts or remote image/audio URLs are planned. Any later asset
that does not have an identified author, editable source, creation/adaptation
date, and compatible license must block the release until reviewed and added
here.

## Corresponding Source status

The local source tree is not yet tied to an approved public immutable
Corresponding Source location. Before external deployment, this record,
`NOTICE.md`, the Legal route, emitted source-revision banner, and the
SHA-named source archive must all identify the same clean full commit. The
future source archive is expected at
`/source/chooser-web-<full-sha>.tar.gz`; its exact public host remains an
explicit release-time decision.
