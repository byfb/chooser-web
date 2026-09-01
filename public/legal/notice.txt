<!--
SPDX-FileCopyrightText: 2026 byfb
SPDX-License-Identifier: GPL-3.0-or-later
-->

# Chooser Web notices

Chooser Web adapts the Android Chooser project.

**Web adaptation; modified 2026.**

The web adaptation and its original source files are:

```text
Copyright (C) 2026 byfb
SPDX-License-Identifier: GPL-3.0-or-later
```

The complete terms are in [`LICENSE`](LICENSE). Under those terms, recipients
may copy, modify, and redistribute the program under GPL-3.0-or-later. This
program comes with no warranty, to the extent permitted by applicable law. No
EULA or additional restriction is intended to narrow those rights.

## Upstream Chooser attribution

The behavior and visual concepts being adapted come from the original
[Chooser project](https://github.com/UrAvgCode/Chooser):

```text
Copyright (C) 2025 UrAvgCode
```

The upstream source is GPL-3.0-or-later. Its source headers identify `UrAvgCode`
as the author of the application modules. The upstream
`app/src/main/java/com/uravgcode/chooser/settings/presentation/SettingsScreen.kt`
header additionally records:

```text
@author UrAvgCode, Patch4Code
```

Chooser Web preserves the `Patch4Code` contributor attribution wherever the
corresponding Settings expression is adapted. This attribution does not imply
that reference Android vector paths, MP3 recordings, or excluded Tutorial and
store media are included. Those materials remain excluded; the asset decisions
are documented in [`legal/asset-provenance.md`](legal/asset-provenance.md).

The upstream repository state used for behavior review is commit
`041dd0c31f9a2fe0586ef226dfeb49bc5b043b61` (`work v1`, 2025-06-20). Its
uncommitted reset change is captured as
`legal/upstream/chooser-041dd0c-reset.patch` in the corresponding source tree.

## Corresponding Source

This repository is local-first. There is currently no approved immutable
public Corresponding Source URL and no external production release. Before a
release is deployed, the release record must identify a public immutable
location for the exact full Git commit and serve the matching preferred-form
source archive at:

```text
/source/chooser-web-<full-sha>.tar.gz
```

The Legal surface and emitted application bundles must carry the same exact
revision. A mutable branch or unrelated source snapshot is not a substitute.
The eventual local `pnpm deploy` gate must refuse promotion while this source
location is unresolved or any revision/archive/legal record disagrees.

## Third-party and asset notices

The pinned package set and its license classifications are recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and the complete generated
[`legal/dependency-inventory.json`](legal/dependency-inventory.json).
Those records distinguish code bundled or emitted into the browser runtime
from build-only tooling. They must be reviewed and regenerated from
`pnpm-lock.yaml`, the shipped-build-output declaration, and the explicit asset
inventory before every conveyed release.

No third-party font, icon, image, vector, audio file, or other media is shipped.
The three original 2026 mode-icon SVG sources are included and recorded in the
asset provenance inventory. Launcher derivatives and synthesized audio sources
remain pending and must receive complete provenance entries before they enter
`dist`.
