// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const RELEASE_BANNER_LICENSE = "GPL-3.0-or-later";
export const RELEASE_BANNER_PENDING_SOURCE = "pending approval";

const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const EXISTING_RELEASE_BANNER_PATTERN =
  /^\/\*! Chooser Web \| GPL-3\.0-or-later \| Source revision: [A-Za-z0-9][A-Za-z0-9._-]* \| Corresponding Source: [^\r\n]* \*\/\r?\n?/gmu;
const BUNDLE_FILE_PATTERN = /\.(?:css|js)$/u;

/**
 * Normalize and validate the release metadata embedded in emitted bundles.
 *
 * Pending builds intentionally carry no source URL. Approved builds must
 * point to an immutable HTTPS URL that names the exact build identity.
 */
export function normalizeReleaseBannerOptions(options = {}) {
  const buildId = normalizeReleaseBannerBuildId(options.buildId);
  const sourceStatus = options.sourceStatus ?? "pending";
  const sourceUrl = normalizeSourceUrl(options.sourceUrl);

  if (sourceStatus !== "pending" && sourceStatus !== "approved") {
    throw new Error("release banner source status must be pending or approved");
  }

  if (sourceStatus === "pending") {
    if (sourceUrl !== "") {
      throw new Error(
        "pending release banner source status must not include a source URL",
      );
    }
    return Object.freeze({
      buildId,
      sourceStatus,
      sourceUrl: "",
      sourceLabel: RELEASE_BANNER_PENDING_SOURCE,
    });
  }

  assertApprovedSourceUrl(sourceUrl, buildId);
  return Object.freeze({
    buildId,
    sourceStatus,
    sourceUrl,
    sourceLabel: sourceUrl,
  });
}

/**
 * Return the exact short GPL/source-revision comment for one release.
 */
export function createReleaseBanner(options = {}) {
  const normalized = normalizeReleaseBannerOptions(options);
  return `/*! Chooser Web | ${RELEASE_BANNER_LICENSE} | Source revision: ${normalized.buildId} | Corresponding Source: ${normalized.sourceLabel} */`;
}

/**
 * Prefix one emitted JavaScript or CSS asset with its deterministic banner.
 * Existing Chooser release banners are removed first, so repeated builds or
 * hook invocations cannot accumulate duplicate metadata.
 */
export function prependReleaseBanner(contents, options = {}) {
  if (typeof contents !== "string") {
    throw new TypeError("release banner contents must be a string");
  }

  const banner = createReleaseBanner(options);
  const withoutExistingBanners = contents.replace(
    EXISTING_RELEASE_BANNER_PATTERN,
    "",
  );
  return `${banner}\n${withoutExistingBanners}`;
}

/**
 * Prefix every emitted `.js` and `.css` file below `distDir`.
 */
export async function prependReleaseBanners(distDir, options = {}) {
  const normalized = normalizeReleaseBannerOptions(options);
  const banner = createReleaseBanner(normalized);
  const files = (await collectFiles(distDir))
    .filter(isBundleFile)
    .sort(comparePaths);

  await Promise.all(
    files.map(async (file) => {
      const path = join(distDir, file);
      const contents = await readFile(path, "utf8");
      const nextContents = prependReleaseBanner(contents, normalized);
      if (nextContents !== contents) {
        await writeFile(path, nextContents, "utf8");
      }
    }),
  );

  return {
    ...normalized,
    banner,
    files: files.map((file) => `/${file.split(sep).join("/")}`),
  };
}

/**
 * Prove that every emitted JavaScript and CSS file carries exactly the banner
 * for this release. This is a release gate, not merely a build side effect.
 */
export async function validateReleaseBanners(distDir, options = {}) {
  const normalized = normalizeReleaseBannerOptions(options);
  const expectedBanner = createReleaseBanner(normalized);
  const files = (await collectFiles(distDir))
    .filter(isBundleFile)
    .sort(comparePaths);

  if (files.length === 0) {
    throw new Error("release contains no JavaScript or CSS assets to validate");
  }

  for (const file of files) {
    const contents = await readFile(join(distDir, file), "utf8");
    const banners = contents.match(EXISTING_RELEASE_BANNER_PATTERN) ?? [];
    if (
      banners.length !== 1 ||
      contents.split(/\r?\n/u)[0] !== expectedBanner
    ) {
      throw new Error(
        `release asset /${file.split(sep).join("/")} has a missing, duplicate, or stale GPL/source banner`,
      );
    }
  }

  return {
    banner: expectedBanner,
    files: files.map((file) => `/${file.split(sep).join("/")}`),
  };
}

export function assertApprovedSourceUrl(sourceUrl, buildId) {
  const normalizedBuildId = normalizeReleaseBannerBuildId(buildId);
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) {
    throw new Error("approved release banner requires a source URL");
  }
  if (/\s/u.test(sourceUrl) || sourceUrl.includes("*/")) {
    throw new Error(
      "approved release banner source URL must not contain whitespace or comment terminators",
    );
  }

  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("approved release banner source URL must be a valid URL");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.hostname === ""
  ) {
    throw new Error(
      "approved release banner source URL must be an immutable HTTPS URL without credentials, query, or hash",
    );
  }

  if (!sourceUrl.toLowerCase().includes(normalizedBuildId.toLowerCase())) {
    throw new Error(
      "approved release banner source URL must identify the exact build identity",
    );
  }
  return true;
}

export function normalizeReleaseBannerBuildId(buildId = "development") {
  if (typeof buildId !== "string" || !BUILD_ID_PATTERN.test(buildId)) {
    throw new Error(
      "release banner build identity must be a non-empty safe token",
    );
  }
  return buildId;
}

export function isBundleFile(file) {
  return BUNDLE_FILE_PATTERN.test(file.split(sep).join("/"));
}

function normalizeSourceUrl(sourceUrl) {
  if (sourceUrl === undefined || sourceUrl === null) {
    return "";
  }
  if (typeof sourceUrl !== "string") {
    throw new Error("release banner source URL must be a string");
  }
  return sourceUrl.trim();
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collectFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(root, absolutePath);
      }
      if (!entry.isFile()) {
        return [];
      }
      return [relative(root, absolutePath)];
    }),
  );
  return files.flat();
}
