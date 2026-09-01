// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { buildReleaseCandidate } from "./release-candidate.mjs";

/**
 * Package-build entrypoint for a deterministic local release candidate.
 * `runIsolatedFrozenBuilds` invokes `pnpm exec astro build` in each isolated
 * workspace, so making this file the package `build` script cannot recurse.
 */
export async function runReleaseBuild(options = {}) {
  return buildReleaseCandidate(options);
}

export async function main(options = {}) {
  const candidate = await runReleaseBuild(options);
  process.stdout.write(`${JSON.stringify(candidate, null, 2)}\n`);
  return candidate;
}

const entrypoint = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;

if (entrypoint) {
  try {
    await main();
  } catch (error) {
    const code = error?.code ? ` [${error.code}]` : "";
    process.stderr.write(`Release build failed${code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
