// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  normalizePnpmLicenses,
  npmVersionUrl,
  packageId,
  parseLockPackageIds,
  sha256,
  splitPackageId,
} from "./inventory.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("../../", import.meta.url);
const lockfileUrl = new URL("pnpm-lock.yaml", root);
const inventoryUrl = new URL("legal/dependency-inventory.json", root);
const shippedBuildOutputUrl = new URL(
  "legal/shipped-build-output-packages.json",
  root,
);

const lockfile = await readFile(lockfileUrl, "utf8");
const lockPackageIds = parseLockPackageIds(lockfile);
const allInstalled = await readLicenseReport([]);
const shipped = await readLicenseReport(["--prod"]);
const shippedBuildOutput = JSON.parse(
  await readFile(shippedBuildOutputUrl, "utf8"),
);
if (shippedBuildOutput.schemaVersion !== 1) {
  throw new Error("Unsupported shipped build-output package schema");
}
const knownById = new Map(
  allInstalled.map((entry) => [packageId(entry), entry]),
);
const missingPackageIds = lockPackageIds.filter((id) => !knownById.has(id));

if (missingPackageIds.length > 0) {
  const missingRecords = await concurrentMap(
    missingPackageIds,
    16,
    fetchRegistryLicense,
  );
  for (const record of missingRecords) {
    knownById.set(packageId(record), record);
  }
}

const shippedIds = new Set([
  ...shipped.map(packageId),
  ...shippedBuildOutput.packages,
]);
for (const id of shippedIds) {
  if (!lockPackageIds.includes(id)) {
    throw new Error(
      `Shipped build-output package is absent from the lockfile: ${id}`,
    );
  }
}
const inventory = {
  schemaVersion: 1,
  lockfileSha256: sha256(lockfile),
  generatedBy: "scripts/legal/generate-dependency-inventory.mjs",
  shipped: lockPackageIds
    .filter((id) => shippedIds.has(id))
    .map((id) => knownById.get(id)),
  buildOnly: lockPackageIds
    .filter((id) => !shippedIds.has(id))
    .map((id) => knownById.get(id)),
};

const unresolved = [...inventory.shipped, ...inventory.buildOnly].filter(
  (entry) => !entry,
);
if (unresolved.length > 0) {
  throw new Error(`Could not resolve ${unresolved.length} dependency records`);
}

await writeFile(inventoryUrl, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(
  `Wrote ${inventory.shipped.length} shipped and ${inventory.buildOnly.length} build-only dependency records.`,
);

async function readLicenseReport(extraArguments) {
  const { stdout } = await execFileAsync(
    "pnpm",
    ["licenses", "list", "--json", ...extraArguments],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  return normalizePnpmLicenses(JSON.parse(stdout));
}

async function fetchRegistryLicense(id) {
  const { name, version } = splitPackageId(id);
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const response = await fetch(registryUrl);

  if (!response.ok) {
    throw new Error(
      `Registry metadata request failed for ${id}: ${response.status}`,
    );
  }

  const metadata = await response.json();
  const license = normalizeLicense(metadata.license);

  if (!license) {
    throw new Error(`Registry metadata has no license for ${id}`);
  }

  return {
    name,
    version,
    license,
    ...(metadata.homepage ? { homepage: metadata.homepage } : {}),
    source: npmVersionUrl(name, version),
  };
}

function normalizeLicense(license) {
  if (typeof license === "string") {
    return license;
  }
  if (license && typeof license.type === "string") {
    return license.type;
  }
  if (Array.isArray(license)) {
    return license.map(normalizeLicense).filter(Boolean).join(" OR ");
  }
  return "";
}

async function concurrentMap(items, concurrency, transform) {
  const results = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await transform(items[index]);
      }
    }),
  );

  return results;
}
