// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { validateReleaseBanners } from "./release-banner.mjs";
import { validateServiceWorkerRelease } from "./service-worker.mjs";

export const PWA_MANIFEST_PATH = "/manifest.webmanifest";
export const INDEX_DOCUMENT_PATH = "/index.html";
export const NOT_FOUND_DOCUMENT_PATH = "/404.html";

export const PWA_MANIFEST_IDENTITY = Object.freeze({
  id: "/",
  start_url: "/",
  scope: "/",
  name: "Chooser",
  short_name: "Chooser",
  description: "Choose, group, or order people on one shared screen.",
  display: "standalone",
  theme_color: "#000000",
  background_color: "#000000",
});

export const PWA_ICON_CONTRACT = Object.freeze([
  Object.freeze({
    path: "/icons/icon-192.png",
    src: "/icons/icon-192.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "any",
    width: 192,
    height: 192,
  }),
  Object.freeze({
    path: "/icons/icon-512.png",
    src: "/icons/icon-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "any",
    width: 512,
    height: 512,
  }),
  Object.freeze({
    path: "/icons/icon-192-maskable.png",
    src: "/icons/icon-192-maskable.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "maskable",
    width: 192,
    height: 192,
  }),
  Object.freeze({
    path: "/icons/icon-512-maskable.png",
    src: "/icons/icon-512-maskable.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
    width: 512,
    height: 512,
  }),
  Object.freeze({
    path: "/icons/apple-touch-icon.png",
    src: "/icons/apple-touch-icon.png",
    sizes: "180x180",
    type: "image/png",
    purpose: undefined,
    width: 180,
    height: 180,
  }),
]);

export const EXPECTED_HEADERS = Object.freeze({
  "/*": Object.freeze([
    "X-Frame-Options: DENY",
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: strict-origin-when-cross-origin",
    "Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=(), fullscreen=(self)",
  ]),
  "/sw.js": Object.freeze([
    "Content-Type: application/javascript; charset=utf-8",
    "Cache-Control: no-cache, no-store, must-revalidate",
    "Service-Worker-Allowed: /",
  ]),
  "/manifest.webmanifest": Object.freeze([
    "Content-Type: application/manifest+json; charset=utf-8",
    "Cache-Control: no-cache",
  ]),
  "/legal/gpl-3.0.txt": Object.freeze([
    "Content-Type: text/plain; charset=utf-8",
  ]),
  "/legal/notice.txt": Object.freeze([
    "Content-Type: text/plain; charset=utf-8",
  ]),
  "/legal/third-party-notices.txt": Object.freeze([
    "Content-Type: text/plain; charset=utf-8",
  ]),
  "/legal/asset-provenance.txt": Object.freeze([
    "Content-Type: text/plain; charset=utf-8",
  ]),
});

const ICON_METADATA_KEYS = ["src", "sizes", "type", "purpose"];
const RESERVED_404_PREFIXES = ["/legal", "/source"];

/**
 * Validate the static PWA contract emitted into one `dist` directory.
 *
 * This validator reads only deterministic release files and throws before a
 * deployment can consume an incomplete or mismatched static output.
 */
export async function validateStaticPwaRelease(distDir, options = {}) {
  const manifest = await readJsonFile(
    join(distDir, PWA_MANIFEST_PATH.slice(1)),
  );
  validateManifest(manifest);

  const iconResults = await validateIcons(distDir, manifest);
  const indexHtml = await readFile(
    join(distDir, INDEX_DOCUMENT_PATH.slice(1)),
    "utf8",
  );
  validateIndexDocument(indexHtml);

  const headers = await readFile(join(distDir, "_headers"), "utf8");
  validateHeaders(headers);

  const notFoundHtml = await readFile(
    join(distDir, NOT_FOUND_DOCUMENT_PATH.slice(1)),
    "utf8",
  );
  validateNotFoundDocument(notFoundHtml);

  const worker = await validateServiceWorkerRelease(distDir, {
    buildId: options.buildId,
  });
  const banners = await validateReleaseBanners(distDir, {
    buildId: options.buildId,
    sourceStatus: options.sourceStatus,
    sourceUrl: options.sourceUrl,
  });

  return {
    manifest: PWA_MANIFEST_PATH,
    icons: iconResults,
    index: INDEX_DOCUMENT_PATH,
    headers: "/_headers",
    notFound: NOT_FOUND_DOCUMENT_PATH,
    worker,
    banners,
  };
}

export function validateManifest(manifest) {
  if (!isRecord(manifest)) {
    throw new Error("PWA manifest must be a JSON object");
  }

  for (const [key, expected] of Object.entries(PWA_MANIFEST_IDENTITY)) {
    if (manifest[key] !== expected) {
      throw new Error(
        `PWA manifest ${key} must be ${JSON.stringify(expected)}`,
      );
    }
  }

  if ("orientation" in manifest) {
    throw new Error("PWA manifest must not lock orientation");
  }

  if (!Array.isArray(manifest.icons) || manifest.icons.length !== 4) {
    throw new Error("PWA manifest must contain the four exact install icons");
  }

  const expectedIcons = PWA_ICON_CONTRACT.filter(
    (icon) => icon.path !== "/icons/apple-touch-icon.png",
  );
  for (const expected of expectedIcons) {
    const matching = manifest.icons.filter(
      (icon) =>
        isRecord(icon) &&
        icon.src === expected.src &&
        icon.sizes === expected.sizes &&
        icon.type === expected.type &&
        icon.purpose === expected.purpose,
    );
    if (matching.length !== 1) {
      throw new Error(`PWA manifest is missing exact icon ${expected.src}`);
    }
    if (
      Object.keys(matching[0]).some((key) => !ICON_METADATA_KEYS.includes(key))
    ) {
      throw new Error(
        `PWA manifest icon ${expected.src} contains extra metadata`,
      );
    }
  }

  return true;
}

export async function validateIcons(distDir, manifest) {
  const manifestIcons = new Map(manifest.icons.map((icon) => [icon.src, icon]));
  const results = [];

  for (const expected of PWA_ICON_CONTRACT) {
    const icon = expected.purpose ? manifestIcons.get(expected.src) : undefined;
    if (expected.purpose && !icon) {
      throw new Error(`PWA manifest icon is unavailable: ${expected.src}`);
    }

    const bytes = await readFile(join(distDir, expected.path.slice(1)));
    const dimensions = readPngDimensions(bytes, expected.path);
    if (
      dimensions.width !== expected.width ||
      dimensions.height !== expected.height
    ) {
      throw new Error(
        `PWA icon ${expected.path} must be ${expected.width}x${expected.height}`,
      );
    }
    results.push({
      path: expected.path,
      width: dimensions.width,
      height: dimensions.height,
    });
  }

  return results;
}

export function readPngDimensions(bytes, pathname) {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error(`PWA icon ${pathname} is not a PNG`);
  }

  const ihdrLength = bytes.readUInt32BE(8);
  const ihdrType = bytes.subarray(12, 16).toString("ascii");
  if (ihdrLength !== 13 || ihdrType !== "IHDR") {
    throw new Error(`PWA icon ${pathname} is missing a valid IHDR`);
  }

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

export function validateIndexDocument(html) {
  if (!hasLink(html, { rel: "manifest", href: PWA_MANIFEST_PATH })) {
    throw new Error("index.html must link the PWA manifest");
  }
  if (
    !hasLink(html, {
      rel: "apple-touch-icon",
      sizes: "180x180",
      href: "/icons/apple-touch-icon.png",
    })
  ) {
    throw new Error("index.html must link the 180px Apple touch icon");
  }
  return true;
}

export function validateHeaders(source) {
  const actual = parseHeaders(source);
  const actualPaths = Object.keys(actual).sort(compareStrings);
  const expectedPaths = Object.keys(EXPECTED_HEADERS).sort(compareStrings);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("_headers contains an unexpected or missing route block");
  }

  for (const [path, expected] of Object.entries(EXPECTED_HEADERS)) {
    if (JSON.stringify(actual[path]) !== JSON.stringify(expected)) {
      throw new Error(`_headers directives for ${path} are not exact`);
    }
  }
  return true;
}

export function parseHeaders(source) {
  const blocks = {};
  let currentPath;
  for (const rawLine of source.split(/\r?\n/u)) {
    if (rawLine.trim() === "") {
      continue;
    }
    if (/^\S/u.test(rawLine)) {
      currentPath = rawLine.trim();
      blocks[currentPath] = [];
      continue;
    }
    if (!currentPath) {
      throw new Error("_headers directive appears before a route block");
    }
    blocks[currentPath].push(rawLine.trim());
  }
  return blocks;
}

export function validateNotFoundDocument(html) {
  const lowerHtml = html.toLowerCase();
  if (!lowerHtml.includes("no-shell-404")) {
    throw new Error("404.html must identify itself as a no-shell 404");
  }
  if (
    lowerHtml.includes("chooser-root") ||
    lowerHtml.includes("chooserapp") ||
    lowerHtml.includes("astro-island") ||
    lowerHtml.includes("chooser-surface") ||
    lowerHtml.includes("data-phase=") ||
    lowerHtml.includes("data-route=")
  ) {
    throw new Error("404.html must not contain the application shell");
  }
  if (!html.includes('window.location.replace("/")')) {
    throw new Error("404.html must redirect unknown app paths to /");
  }
  for (const prefix of RESERVED_404_PREFIXES) {
    if (
      !html.includes(`pathname === "${prefix}"`) ||
      !html.includes(`pathname.startsWith("${prefix}/")`)
    ) {
      throw new Error(`404.html must preserve reserved ${prefix} paths`);
    }
  }
  if (!/if\s*\(\s*!isReservedPath\s*\)/u.test(html)) {
    throw new Error("404.html must redirect only non-reserved paths");
  }
  return true;
}

async function readJsonFile(pathname) {
  try {
    return JSON.parse(await readFile(pathname, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read JSON release file ${pathname}: ${error.message}`,
      { cause: error },
    );
  }
}

function hasLink(html, expected) {
  const links = html.match(/<link\b[^>]*>/giu) ?? [];
  return links.some((link) => {
    const attributes = Object.fromEntries(
      [...link.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/gu)].map((match) => [
        match[1].toLowerCase(),
        match[2],
      ]),
    );
    return Object.entries(expected).every(
      ([key, value]) => attributes[key] === value,
    );
  });
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
