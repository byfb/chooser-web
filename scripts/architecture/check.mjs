// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { access, readdir, readFile } from "node:fs/promises";
import { relative } from "node:path";

const root = new URL("../../", import.meta.url);
const sourceRoot = new URL("src/", root);

const requiredDirectories = ["app", "_pages", "pages", "shared"];
const forbiddenDirectories = [
  "assets",
  "entities",
  "features",
  "processes",
  "widgets",
];

for (const directory of requiredDirectories) {
  await access(new URL(`${directory}/`, sourceRoot));
}

const sourceEntries = await readdir(sourceRoot, { withFileTypes: true });
for (const directory of forbiddenDirectories) {
  if (
    sourceEntries.some(
      (entry) => entry.isDirectory() && entry.name === directory,
    )
  ) {
    throw new Error(`Speculative FSD layer is forbidden: src/${directory}`);
  }
}

const routeRoot = new URL("pages/", sourceRoot);
for (const routeFile of await collectAstroFiles(routeRoot)) {
  const source = await readFile(routeFile, "utf8");
  if (/<script(?:\s|>)/i.test(source)) {
    throw new Error(
      `Astro route wrappers must not contain client scripts: ${display(routeFile)}`,
    );
  }
}

console.log("FSD and Astro route boundaries are valid.");

async function collectAstroFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = new URL(entry.name, directory);
      if (entry.isDirectory()) {
        return collectAstroFiles(new URL(`${entry.name}/`, directory));
      }
      return entry.isFile() && entry.name.endsWith(".astro") ? [path] : [];
    }),
  );
  return files.flat();
}

function display(file) {
  return relative(new URL(".", root).pathname, file.pathname);
}
