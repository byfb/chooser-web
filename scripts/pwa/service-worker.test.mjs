// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  APP_NAVIGATION_PATHS,
  CACHE_PREFIX,
  LEGAL_DOCUMENT_PATHS,
  REQUIRED_RELEASE_FILES,
  assertCompletePrecacheUrls,
  assertValidPrecacheUrls,
  buildServiceWorkerSource,
  cacheNameForBuild,
  collectPrecacheUrls,
  createChooserPwaIntegration,
  validateServiceWorkerRelease,
  validateServiceWorkerSource,
  writeServiceWorker,
} from "./service-worker.mjs";
import {
  EXPECTED_HEADERS,
  PWA_ICON_CONTRACT,
  PWA_MANIFEST_IDENTITY,
} from "./static-pwa-validator.mjs";
import {
  createReleaseBanner,
  normalizeReleaseBannerOptions,
  prependReleaseBanners,
} from "./release-banner.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Chooser generated service worker", () => {
  it("collects a complete sorted release while excluding controls and source archives", async () => {
    const distDir = await createDist();
    await mkdir(join(distDir, "source"), { recursive: true });
    await writeFile(join(distDir, "source/chooser-web-demo.tar.gz"), "source");
    await writeFile(join(distDir, "sw.js"), "old worker");
    await writeFile(join(distDir, "_headers"), "headers");
    await writeFile(join(distDir, "nested/_worker.js"), "worker control");
    await writeFile(join(distDir, "nested/data.json"), "{}");

    await expect(collectPrecacheUrls(distDir)).resolves.toEqual([
      "/",
      "/404",
      "/assets/app.js",
      "/icons/apple-touch-icon.png",
      "/icons/icon-192-maskable.png",
      "/icons/icon-192.png",
      "/icons/icon-512-maskable.png",
      "/icons/icon-512.png",
      "/legal/asset-provenance.txt",
      "/legal/gpl-3.0.txt",
      "/legal/notice.txt",
      "/legal/third-party-notices.txt",
      "/manifest.webmanifest",
      "/nested/data.json",
      "/settings/",
      "/settings/legal/",
    ]);
  });

  it("emits stable identity in the worker, cache name, and handshake", async () => {
    const distDir = await createDist();
    const result = await writeServiceWorker(distDir, { buildId: "abc123" });

    expect(result.cacheName).toBe(`${CACHE_PREFIX}-abc123`);
    expect(result.source).toContain('const BUILD_ID = "abc123";');
    expect(result.source).toContain(
      "const CACHE_NAME = `${CACHE_PREFIX}-${BUILD_ID}`;",
    );
    expect(result.source).toContain("buildId: BUILD_ID");
    expect(result.source).toContain("requestId,");
    expect(result.source).toContain(
      'const STAGING_CACHE_PREFIX = "chooser-web-release-staging";',
    );
    expect(result.source).toContain(
      "const STAGING_CACHE_NAME = `${STAGING_CACHE_PREFIX}-${BUILD_ID}`;",
    );
    expect(await readFile(join(distDir, "sw.js"), "utf8")).toBe(result.source);
    await expect(
      validateServiceWorkerRelease(distDir, { buildId: "abc123" }),
    ).resolves.toMatchObject({
      buildId: "abc123",
      cacheName: cacheNameForBuild("abc123"),
      precacheUrls: result.precacheUrls,
    });
  });

  it("builds deterministic output for equivalent manifests", async () => {
    const urls = ["/", "/assets/app.js"];
    const first = buildServiceWorkerSource({
      buildId: "same-build",
      precacheUrls: urls,
    });
    const second = buildServiceWorkerSource({
      buildId: "same-build",
      precacheUrls: [...urls],
    });

    expect(second).toBe(first);
    expect(
      buildServiceWorkerSource({ buildId: "new-build", precacheUrls: urls }),
    ).not.toBe(first);
  });

  it("uses staging installation and activation without unsafe update behavior", () => {
    const source = buildServiceWorkerSource({
      buildId: "contract-test",
      precacheUrls: ["/", ...LEGAL_DOCUMENT_PATHS].sort(),
    });

    expect(source).toContain("event.waitUntil(populateStagingCache())");
    expect(source).toContain("await caches.delete(STAGING_CACHE_NAME)");
    expect(source).toContain("await self.clients.claim()");
    expect(source).toContain('pathname.startsWith("/source/")');
    expect(source).toContain('pathname === "/source"');
    expect(source).toContain('pathname === "/sw.js"');
    expect(source).toContain("event.data?.buildId === BUILD_ID");
    expect(source).not.toMatch(/skipWaiting/u);
    expect(source).not.toMatch(/BroadcastChannel/u);
    expect(source).not.toMatch(/cache\.put\(request/u);
    expect(source).not.toMatch(/event\.source.*reload/u);
  });

  it("exposes the Astro build hook and emits the stable worker URL", async () => {
    const distDir = await createDist();
    const integration = createChooserPwaIntegration({ buildId: "hook-build" });
    const buildDone = integration.hooks["astro:build:done"];

    await buildDone({ dir: pathToFileURL(`${distDir}/`) });

    await expect(
      validateServiceWorkerRelease(distDir, { buildId: "hook-build" }),
    ).resolves.toMatchObject({ buildId: "hook-build" });
    expect(await readFile(join(distDir, "assets/app.js"), "utf8")).toBe(
      `${createReleaseBanner({ buildId: "hook-build" })}\nconsole.log(1);`,
    );
    expect(await readFile(join(distDir, "sw.js"), "utf8")).toMatch(
      /^\/\*! Chooser Web \| GPL-3\.0-or-later \| Source revision: hook-build \| Corresponding Source: pending approval \*\//u,
    );
  });

  it("emits exact pending and approved banners for a full release SHA", () => {
    const buildId = "a".repeat(40);
    expect(createReleaseBanner({ buildId })).toBe(
      `/*! Chooser Web | GPL-3.0-or-later | Source revision: ${buildId} | Corresponding Source: pending approval */`,
    );
    expect(
      createReleaseBanner({
        buildId,
        sourceStatus: "approved",
        sourceUrl: `https://example.invalid/chooser/${buildId}.tar.gz`,
      }),
    ).toBe(
      `/*! Chooser Web | GPL-3.0-or-later | Source revision: ${buildId} | Corresponding Source: https://example.invalid/chooser/${buildId}.tar.gz */`,
    );
  });

  it("prefixes every JavaScript and CSS bundle exactly once", async () => {
    const distDir = await createDist();
    const buildId = "b".repeat(40);
    const oldBanner = createReleaseBanner({ buildId: "old-build" });
    await writeFile(
      join(distDir, "assets/app.css"),
      `${oldBanner}\n${oldBanner}\nbody { color: black; }`,
    );
    await writeFile(
      join(distDir, "nested/chunk.js"),
      "export const value = 1;",
    );
    await writeFile(
      join(distDir, "nested/theme.css"),
      "body { color: white; }",
    );
    await writeFile(join(distDir, "nested/chunk.js.map"), "{}");

    const options = { buildId, sourceStatus: "pending", sourceUrl: "" };
    const first = await prependReleaseBanners(distDir, options);
    const second = await prependReleaseBanners(distDir, options);
    const banner = createReleaseBanner(options);

    expect(first.files).toEqual([
      "/assets/app.css",
      "/assets/app.js",
      "/nested/chunk.js",
      "/nested/theme.css",
    ]);
    expect(second).toEqual(first);
    for (const file of first.files) {
      const contents = await readFile(join(distDir, file.slice(1)), "utf8");
      expect(contents.startsWith(`${banner}\n`)).toBe(true);
      expect(
        contents.match(/\/\*! Chooser Web \| GPL-3\.0-or-later/gu),
      ).toHaveLength(1);
    }
    expect(await readFile(join(distDir, "nested/chunk.js.map"), "utf8")).toBe(
      "{}",
    );
  });

  it("rejects invalid source status and approved source metadata", () => {
    const buildId = "c".repeat(40);
    expect(() =>
      normalizeReleaseBannerOptions({ buildId, sourceStatus: "unknown" }),
    ).toThrow(/pending or approved/i);
    expect(() =>
      normalizeReleaseBannerOptions({
        buildId,
        sourceStatus: "pending",
        sourceUrl: "https://example.invalid/source",
      }),
    ).toThrow(/must not include/i);
    expect(() =>
      normalizeReleaseBannerOptions({
        buildId,
        sourceStatus: "approved",
        sourceUrl: "http://example.invalid/source",
      }),
    ).toThrow(/immutable HTTPS/i);
    expect(() =>
      normalizeReleaseBannerOptions({
        buildId,
        sourceStatus: "approved",
        sourceUrl: "https://example.invalid/source?revision=latest",
      }),
    ).toThrow(/immutable HTTPS/i);
    expect(() =>
      normalizeReleaseBannerOptions({
        buildId,
        sourceStatus: "approved",
        sourceUrl: `https://example.invalid/source/${"d".repeat(40)}.tar.gz`,
      }),
    ).toThrow(/exact build identity/i);
  });

  it("rejects stale, unsorted, duplicate, and excluded precache manifests", () => {
    expect(() => assertValidPrecacheUrls(["/index.html", "/"])).toThrow(
      /sorted/i,
    );
    expect(() => assertValidPrecacheUrls(["/", "/"])).toThrow(/unique/i);
    expect(() => assertValidPrecacheUrls(["/sw.js"])).toThrow(/excluded/i);
    expect(() =>
      assertValidPrecacheUrls(["/", "/source/chooser-web.tar.gz"]),
    ).toThrow(/source archive/i);
    expect(() => assertValidPrecacheUrls(["/", "/index.html"])).toThrow(
      /non-canonical/i,
    );
  });

  it("declares only the exact application navigation paths", () => {
    expect(APP_NAVIGATION_PATHS).toEqual(["/", "/settings", "/settings/legal"]);
  });

  it("requires the route, legal, install, and 404 files for a complete release", () => {
    expect(REQUIRED_RELEASE_FILES).toEqual(
      expect.arrayContaining([
        "/index.html",
        "/settings/index.html",
        "/settings/legal/index.html",
        "/404.html",
        "/manifest.webmanifest",
        "/icons/apple-touch-icon.png",
        "/icons/icon-192-maskable.png",
        "/icons/icon-192.png",
        "/icons/icon-512-maskable.png",
        "/icons/icon-512.png",
        ...LEGAL_DOCUMENT_PATHS,
      ]),
    );
    expect(() => assertCompletePrecacheUrls(["/"])).toThrow(
      /missing required release files/i,
    );
  });

  it("rejects a worker whose identity or manifest no longer matches the build", () => {
    const precacheUrls = ["/"];
    const source = buildServiceWorkerSource({
      buildId: "expected",
      precacheUrls,
    });

    expect(() =>
      validateServiceWorkerSource(source, {
        buildId: "different",
        precacheUrls,
      }),
    ).toThrow(/identity/i);
    expect(() =>
      validateServiceWorkerSource(source, {
        buildId: "expected",
        precacheUrls: ["/", "/new.js"],
      }),
    ).toThrow(/manifest/i);
  });
});

async function createDist() {
  const directory = await mkdtemp(join(tmpdir(), "chooser-pwa-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "assets"), { recursive: true });
  await mkdir(join(directory, "nested"), { recursive: true });
  await mkdir(join(directory, "legal"), { recursive: true });
  await mkdir(join(directory, "icons"), { recursive: true });
  await mkdir(join(directory, "settings/legal"), { recursive: true });
  await writeFile(
    join(directory, "index.html"),
    '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">',
  );
  await writeFile(
    join(directory, "404.html"),
    '<body class="no-shell-404"><script>const pathname = window.location.pathname; const isReservedPath = pathname === "/legal" || pathname.startsWith("/legal/") || pathname === "/source" || pathname.startsWith("/source/"); if (!isReservedPath) { window.location.replace("/"); }</script></body>',
  );
  await writeFile(
    join(directory, "manifest.webmanifest"),
    JSON.stringify({
      ...PWA_MANIFEST_IDENTITY,
      icons: PWA_ICON_CONTRACT.filter((icon) => icon.purpose).map((icon) => ({
        src: icon.src,
        sizes: icon.sizes,
        type: icon.type,
        purpose: icon.purpose,
      })),
    }),
  );
  await writeFile(
    join(directory, "_headers"),
    Object.entries(EXPECTED_HEADERS)
      .map(
        ([path, directives]) =>
          `${path}\n${directives.map((line) => `  ${line}`).join("\n")}`,
      )
      .join("\n\n"),
  );
  for (const pathname of REQUIRED_RELEASE_FILES.filter((path) =>
    path.startsWith("/icons/"),
  )) {
    const icon = PWA_ICON_CONTRACT.find(
      (candidate) => candidate.path === pathname,
    );
    await writeFile(
      join(directory, pathname.slice(1)),
      createPng(icon.width, icon.height),
    );
  }
  await writeFile(join(directory, "assets/app.js"), "console.log(1);");
  await writeFile(join(directory, "settings/index.html"), "settings");
  await writeFile(join(directory, "settings/legal/index.html"), "legal page");
  for (const path of LEGAL_DOCUMENT_PATHS) {
    await writeFile(join(directory, path.slice(1)), path);
  }
  return directory;
}

function createPng(width, height) {
  const png = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, 4, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png.writeUInt8(8, 24);
  png.writeUInt8(6, 25);
  png.writeUInt32BE(0, 37);
  png.write("IEND", 41, 4, "ascii");
  return png;
}
