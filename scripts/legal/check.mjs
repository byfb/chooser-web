// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";

import {
  assertInventoryCurrent,
  normalizePnpmLicenses,
  packageId,
  parseLockPackageIds,
  sha256,
} from "./inventory.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("../../", import.meta.url);
const expectedLicenseSha256 =
  "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986";
const expectedReferencePatchSha256 =
  "8cb468b50e8491d64c2bbdf41fcccc2bd92fad577c80ccce47ab2433f3d62248";

const requiredText = new Map([
  [
    "README.md",
    [
      "GPL-3.0-or-later",
      "https://github.com/UrAvgCode/Chooser",
      "Web adaptation; modified 2026.",
      "pnpm install --frozen-lockfile",
      "pnpm verify",
      "Corresponding Source",
    ],
  ],
  [
    "NOTICE.md",
    [
      "Copyright (C) 2026 byfb",
      "Copyright (C) 2025 UrAvgCode",
      "Patch4Code",
      "Web adaptation; modified 2026.",
      "GPL-3.0-or-later",
      "no warranty",
    ],
  ],
  [
    "THIRD_PARTY_NOTICES.md",
    [
      "react@19.3.1",
      "react-dom@19.3.1",
      "scheduler@0.28.0",
      "astro@7.4.0",
      "@astrojs/react@6.0.6",
      "rolldown@1.2.14",
      "Meta Platforms, Inc. and affiliates",
      "Copyright (c) 2017 [these people](https://github.com/rollup/rollup/graphs/contributors)",
      "Copyright (c) 2020 Evan Wallace",
      "MIT License",
    ],
  ],
  [
    "legal/asset-provenance.md",
    ["asset provenance", "2026", "reference", "MP3", "SVG"],
  ],
]);

const publicCopies = new Map([
  ["LICENSE", "public/legal/gpl-3.0.txt"],
  ["NOTICE.md", "public/legal/notice.txt"],
  ["THIRD_PARTY_NOTICES.md", "public/legal/third-party-notices.txt"],
  ["legal/asset-provenance.md", "public/legal/asset-provenance.txt"],
]);

await verifyLegalBaseline();
console.log("GPL, attribution, provenance, and dependency records are valid.");

async function verifyLegalBaseline() {
  const packageManifest = JSON.parse(await read("package.json"));
  if (packageManifest.license !== "GPL-3.0-or-later") {
    throw new Error("package.json must declare GPL-3.0-or-later");
  }

  const license = await read("LICENSE");
  if (sha256(license) !== expectedLicenseSha256) {
    throw new Error("LICENSE is not the complete, unmodified GPLv3 text");
  }

  for (const [file, markers] of requiredText) {
    const contents = await read(file);
    for (const marker of markers) {
      if (!contents.toLowerCase().includes(marker.toLowerCase())) {
        throw new Error(`${file} is missing required legal text: ${marker}`);
      }
    }
  }

  for (const [source, publicCopy] of publicCopies) {
    if ((await read(source)) !== (await read(publicCopy))) {
      throw new Error(`${publicCopy} must exactly match ${source}`);
    }
  }

  const referencePatch = await read(
    "legal/upstream/chooser-041dd0c-reset.patch",
  );
  if (sha256(referencePatch) !== expectedReferencePatchSha256) {
    throw new Error("The preserved reference reset patch changed unexpectedly");
  }

  await verifyDependencyInventory();
  await verifySpdxHeaders();
  await verifyExcludedReferenceAssets();
}

async function verifyDependencyInventory() {
  const lockfile = await read("pnpm-lock.yaml");
  const reviewedInventory = JSON.parse(
    await read("legal/dependency-inventory.json"),
  );
  const shippedBuildOutput = JSON.parse(
    await read("legal/shipped-build-output-packages.json"),
  );
  const { stdout } = await execFileAsync(
    "pnpm",
    ["licenses", "list", "--json", "--prod"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const installedPackages = normalizePnpmLicenses(
    JSON.parse(
      (
        await execFileAsync("pnpm", ["licenses", "list", "--json"], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        })
      ).stdout,
    ),
  );
  const installedById = new Map(
    installedPackages.map((dependency) => [packageId(dependency), dependency]),
  );
  const actualShippedPackages = [
    ...normalizePnpmLicenses(JSON.parse(stdout)),
    ...shippedBuildOutput.packages.map((id) => {
      const dependency = installedById.get(id);
      if (!dependency) {
        throw new Error(
          `Could not inspect shipped build-output package: ${id}`,
        );
      }
      return dependency;
    }),
  ];

  assertInventoryCurrent({
    actualLockfileSha256: sha256(lockfile),
    actualLockPackageIds: parseLockPackageIds(lockfile),
    actualShippedPackages,
    reviewedInventory,
  });

  const notices = await read("THIRD_PARTY_NOTICES.md");
  for (const dependency of reviewedInventory.shipped) {
    if (
      !notices.includes(packageId(dependency)) ||
      !notices.includes(dependency.license)
    ) {
      throw new Error(
        `THIRD_PARTY_NOTICES.md does not cover ${packageId(dependency)}`,
      );
    }
  }
}

async function verifySpdxHeaders() {
  const authoredFiles = [
    ...(await collectFiles(new URL("src/", root))),
    ...(await collectFiles(new URL("scripts/", root))),
    "astro.config.mjs",
    "eslint.config.mjs",
    "pnpm-workspace.yaml",
    "vitest.config.ts",
    "wrangler.toml",
    "README.md",
    "NOTICE.md",
    "THIRD_PARTY_NOTICES.md",
    "legal/asset-provenance.md",
  ];
  const supportedExtensions = new Set([
    ".astro",
    ".css",
    ".mjs",
    ".md",
    ".ts",
    ".tsx",
    ".yaml",
    ".toml",
  ]);

  for (const file of authoredFiles) {
    const path = typeof file === "string" ? file : file.pathname;
    if (!supportedExtensions.has(extname(path))) {
      continue;
    }
    const contents =
      typeof file === "string"
        ? await read(file)
        : await readFile(file, "utf8");
    if (
      !contents.includes("SPDX-FileCopyrightText: 2026 byfb") ||
      !contents.includes("SPDX-License-Identifier: GPL-3.0-or-later")
    ) {
      throw new Error(`Authored source is missing its SPDX header: ${path}`);
    }
  }
}

async function verifyExcludedReferenceAssets() {
  const roots = [new URL("src/", root), new URL("public/", root)];
  const forbiddenNames = new Set([
    "chooser-icon.svg",
    "finger_chosen.mp3",
    "finger_down.mp3",
    "finger_up.mp3",
    "group-mode.gif",
    "group_icon.xml",
    "order-mode.gif",
    "order_icon.xml",
    "single-mode.gif",
    "single_icon.xml",
  ]);

  for (const directory of roots) {
    for (const file of await collectFiles(directory)) {
      const name = file.pathname.split("/").at(-1);
      if (name && forbiddenNames.has(name)) {
        throw new Error(
          `Excluded reference asset entered the web app: ${name}`,
        );
      }
    }
  }
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryUrl = new URL(entry.name, directory);
      if (entry.isDirectory()) {
        return collectFiles(new URL(`${entry.name}/`, directory));
      }
      return entry.isFile() ? [entryUrl] : [];
    }),
  );
  return files.flat();
}

function read(path) {
  return readFile(new URL(path, root), "utf8");
}
