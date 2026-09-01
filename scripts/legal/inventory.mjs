// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto";

const UNKNOWN_LICENSE = /^(?:unknown|unlicensed|see license in)/i;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseLockPackageIds(lockfileText) {
  const packagesStart = lockfileText.indexOf("\npackages:\n");
  const snapshotsStart = lockfileText.indexOf("\nsnapshots:\n");

  if (packagesStart === -1 || snapshotsStart === -1) {
    throw new Error(
      "pnpm-lock.yaml does not contain packages and snapshots sections",
    );
  }

  const packageSection = lockfileText.slice(packagesStart, snapshotsStart);
  const packageIds = [
    ...packageSection.matchAll(/^ {2}(?:"([^"]+)"|([^\s][^:]*)):\s*$/gm),
  ]
    .map((match) => match[1] ?? match[2])
    .sort(compareText);

  if (
    packageIds.length === 0 ||
    new Set(packageIds).size !== packageIds.length
  ) {
    throw new Error(
      "Could not derive a unique package inventory from pnpm-lock.yaml",
    );
  }

  return packageIds;
}

export function normalizePnpmLicenses(report) {
  const packages = [];

  for (const [license, entries] of Object.entries(report)) {
    for (const entry of entries) {
      for (const version of entry.versions) {
        packages.push({
          name: entry.name,
          version,
          license,
          ...(entry.homepage ? { homepage: entry.homepage } : {}),
          source: npmVersionUrl(entry.name, version),
        });
      }
    }
  }

  return packages.sort(comparePackage);
}

export function splitPackageId(packageId) {
  const separator = packageId.lastIndexOf("@");

  if (separator <= 0 || separator === packageId.length - 1) {
    throw new Error(`Unsupported pnpm package identity: ${packageId}`);
  }

  return {
    name: packageId.slice(0, separator),
    version: packageId.slice(separator + 1),
  };
}

export function packageId({ name, version }) {
  return `${name}@${version}`;
}

export function npmVersionUrl(name, version) {
  return `https://www.npmjs.com/package/${name}/v/${version}`;
}

export function assertInventoryCurrent({
  actualLockfileSha256,
  actualLockPackageIds,
  actualShippedPackages,
  reviewedInventory,
}) {
  if (reviewedInventory.schemaVersion !== 1) {
    throw new Error("Reviewed dependency inventory has an unsupported schema");
  }

  const reviewedPackages = [
    ...reviewedInventory.shipped,
    ...reviewedInventory.buildOnly,
  ];

  for (const reviewedPackage of reviewedPackages) {
    if (
      !reviewedPackage.license ||
      UNKNOWN_LICENSE.test(reviewedPackage.license.trim())
    ) {
      throw new Error(
        `Reviewed dependency has missing license metadata: ${packageId(reviewedPackage)}`,
      );
    }
    if (!reviewedPackage.source) {
      throw new Error(
        `Reviewed dependency has no exact source location: ${packageId(reviewedPackage)}`,
      );
    }
  }

  const reviewedLockPackageIds = reviewedPackages
    .map(packageId)
    .sort(compareText);
  const currentLockPackageIds = [...actualLockPackageIds].sort(compareText);
  const reviewedShipped = reviewedInventory.shipped
    .map(packageLicenseIdentity)
    .sort(compareText);
  const currentShipped = actualShippedPackages
    .map(packageLicenseIdentity)
    .sort(compareText);

  const isCurrent =
    actualLockfileSha256 === reviewedInventory.lockfileSha256 &&
    equalLists(reviewedLockPackageIds, currentLockPackageIds) &&
    equalLists(reviewedShipped, currentShipped);

  if (!isCurrent) {
    throw new Error(
      "Reviewed dependency inventory is stale; regenerate and review dependency notices",
    );
  }
}

function packageLicenseIdentity(packageRecord) {
  return `${packageId(packageRecord)} [${packageRecord.license}]`;
}

function equalLists(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function comparePackage(left, right) {
  return compareText(packageId(left), packageId(right));
}

function compareText(left, right) {
  return left.localeCompare(right, "en");
}
