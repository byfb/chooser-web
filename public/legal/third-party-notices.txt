<!--
SPDX-FileCopyrightText: 2026 byfb
SPDX-License-Identifier: GPL-3.0-or-later
-->

# Third-party notices

This is the reviewed foundation inventory for the exact versions in
`package.json` and `pnpm-lock.yaml` (`lockfileVersion: "9.0"`). It distinguishes
packages whose code can be bundled into the static browser runtime from
packages used only to develop, test, check, or publish the application.

The project is not permitted to ship a package or asset with unknown,
missing, or incompatible license metadata. The deterministic
[`legal/dependency-inventory.json`](legal/dependency-inventory.json)
records every package in this exact lockfile, including platform variants,
and separates packages whose code is installed or generated into the
browser release from build-only packages. Verification fails when the
lockfile or shipped package set changes without a regenerated and reviewed
inventory.

## Browser runtime and generated client

The current hydrated client can bundle the following package code. All are
compatible with this GPL application because their licenses permit
redistribution and modification:

| Package                                   | License | Source / copyright                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react@19.3.1`                            | MIT     | [facebook/react](https://github.com/facebook/react); Copyright (c) Meta Platforms, Inc. and affiliates.                                                                                                                                                                                         |
| `react-dom@19.3.1`                        | MIT     | [facebook/react](https://github.com/facebook/react); Copyright (c) Meta Platforms, Inc. and affiliates.                                                                                                                                                                                         |
| `scheduler@0.28.0`                        | MIT     | [facebook/react](https://github.com/facebook/react); Copyright (c) Meta Platforms, Inc. and affiliates.                                                                                                                                                                                         |
| `astro@7.4.0`                             | MIT     | [withastro/astro](https://github.com/withastro/astro); Copyright (c) 2021 Fred K. Schott; includes retained notices for Copyright (c) 2020 SvelteKit contributors and Copyright (c) 2019-present Yuxi (Evan) You and Vite contributors.                                                         |
| `@astrojs/react@6.0.6`                    | MIT     | [withastro/astro](https://github.com/withastro/astro); Copyright (c) 2021 Fred K. Schott; the package license retains the same SvelteKit and Vite contributor notices described above.                                                                                                          |
| `rolldown@1.2.14` generated bundle helper | MIT     | [rolldown/rolldown](https://github.com/rolldown/rolldown); Copyright (c) 2024-present VoidZero Inc. & Contributors. The package records externally maintained derived-library notices in its [third-party license file](https://github.com/rolldown/rolldown/blob/v1.2.14/THIRD-PARTY-LICENSE). |

Astro's island bootstrap and React integration client are emitted at build
time even though Astro and its integration are development dependencies. The
small shared bundler helper is emitted by Rolldown. These generated-code
classifications are kept in
[`legal/shipped-build-output-packages.json`](legal/shipped-build-output-packages.json).
If later bundle inspection finds code from another package, that declaration,
this section, and the reviewed inventory must all change before release.

### MIT License text

For the MIT-licensed packages listed above, the applicable permission notice
is:

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The package-specific copyright and source links above, together with the
committed lockfile, identify the notices to which this permission text applies.

### Rolldown derived-library notices

The emitted Rolldown helper also carries the following notices from the
derived-library record included with `rolldown@1.2.14`. They are reproduced
locally so the notice remains available offline.

#### Rollup contributors

```text
The MIT License (MIT)

Copyright (c) 2017 [these people](https://github.com/rollup/rollup/graphs/contributors)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### Evan Wallace

```text
MIT License

Copyright (c) 2020 Evan Wallace

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Build-only direct dependencies

These packages are pinned development tools. Their code is not intended to be
served from `dist`; they are included here so the preferred source form and
the reproducible local build remain auditable. A package moves to the runtime
section if a future bundle intentionally ships its code.

| Package                     |   Version | License           | Role                                      |
| --------------------------- | --------: | ----------------- | ----------------------------------------- |
| `@astrojs/check`            |  `0.9.10` | MIT               | Astro diagnostics and type checks         |
| `@eslint/js`                |  `10.0.1` | MIT               | ESLint defaults                           |
| `@types/node`               |  `26.4.0` | MIT               | Node.js types                             |
| `@types/react`              | `19.2.18` | MIT               | React types                               |
| `@types/react-dom`          |  `19.2.5` | MIT               | React DOM types                           |
| `@vitest/coverage-v8`       |  `4.1.11` | MIT               | Vitest coverage provider                  |
| `eslint`                    |  `10.9.1` | MIT               | Linting                                   |
| `eslint-config-prettier`    |  `10.1.8` | MIT               | ESLint/Prettier compatibility             |
| `eslint-plugin-react-hooks` |   `7.1.1` | MIT               | React Hooks lint rules                    |
| `fast-check`                |   `4.9.0` | MIT               | Property-based tests                      |
| `globals`                   | `17.11.0` | MIT               | ESLint global definitions                 |
| `prettier`                  |   `3.9.6` | MIT               | Formatting                                |
| `prettier-plugin-astro`     |  `0.14.1` | MIT               | Astro formatting                          |
| `typescript`                |   `5.9.3` | Apache-2.0        | TypeScript compiler                       |
| `typescript-eslint`         |  `8.69.0` | MIT               | TypeScript-aware ESLint                   |
| `vite`                      |   `8.2.2` | MIT               | Astro build engine                        |
| `vitest`                    |  `4.1.11` | MIT               | Unit and property tests                   |
| `wrangler`                  | `4.127.1` | MIT OR Apache-2.0 | Local Cloudflare Pages deployment tooling |

Source and full license texts for these packages are available from the exact
package-version locations in the reviewed dependency inventory. Build-only
transitive packages and platform variants are recorded there without being
misrepresented as code shipped to site visitors.

## Lockfile license families requiring review

The complete reviewed inventory contains transitive packages under these
reported SPDX or license expressions in addition to MIT: 0BSD, Apache-2.0,
Apache-2.0 AND LGPL-3.0-or-later, Apache-2.0 AND LGPL-3.0-or-later AND MIT,
MIT OR Apache-2.0, ISC, LGPL-3.0-or-later, CC0-1.0, Python-2.0, CC-BY-4.0,
BlueOak-1.0.0, BSD-2-Clause, BSD-3-Clause, MPL-2.0, and WTFPL. These are
build-only classifications, not runtime notices. The release checker retains
their exact metadata and requires a reviewed classification change before any
such package can enter `dist`. No LGPL, Creative Commons, or other non-MIT
package is intentionally bundled in the current browser client.

## Assets

The build ships no third-party images, fonts, icons, vectors, or audio. The
three mode icons are original editable SVGs authored by byfb in 2026
and released as part of this GPL work. Their source paths and license basis are
recorded in
[`legal/asset-provenance.md`](legal/asset-provenance.md). Planned
launcher derivatives and synthesized audio remain pending there.

The following reference materials are explicitly excluded and must not enter
source output or `dist`:

- Android vector and Material/AndroidX resources from the reference project;
- `finger_down.mp3`, `finger_up.mp3`, and `finger_chosen.mp3`;
- Tutorial GIFs, screenshots, store graphics, README badges, and download art;
- extracted build/intermediate resources from the Android project; and
- any third-party asset whose author, editable source, or compatible license is
  not known.

The original Chooser attribution is not a third-party package notice; it is
recorded in [`NOTICE.md`](NOTICE.md) and the provenance record.
