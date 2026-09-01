// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createReleaseBanner,
  normalizeReleaseBannerOptions,
  prependReleaseBanners,
} from "./release-banner.mjs";
import { validateStaticPwaRelease } from "./static-pwa-validator.mjs";

export const SERVICE_WORKER_FILE = "sw.js";
export const CACHE_PREFIX = "chooser-web-release";
export const STAGING_CACHE_PREFIX = `${CACHE_PREFIX}-staging`;

export const APP_NAVIGATION_PATHS = Object.freeze([
  "/",
  "/settings",
  "/settings/legal",
]);

export const LEGAL_DOCUMENT_PATHS = Object.freeze([
  "/legal/gpl-3.0.txt",
  "/legal/notice.txt",
  "/legal/third-party-notices.txt",
  "/legal/asset-provenance.txt",
]);

export const REQUIRED_RELEASE_FILES = Object.freeze([
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
]);

export const REQUIRED_PRECACHE_URLS = Object.freeze([
  "/",
  "/settings/",
  "/settings/legal/",
  "/404",
  "/manifest.webmanifest",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192-maskable.png",
  "/icons/icon-192.png",
  "/icons/icon-512-maskable.png",
  "/icons/icon-512.png",
  ...LEGAL_DOCUMENT_PATHS,
]);

const RESERVED_PREFIXES = Object.freeze(["/legal/", "/source/"]);
const NON_CANONICAL_RELEASE_URLS = new Set([
  "/index.html",
  "/settings/index.html",
  "/settings/legal/index.html",
  "/404.html",
]);
const DEPLOYMENT_CONTROL_FILES = new Set([
  ".assetsignore",
  "_headers",
  "_redirects",
  "_routes.json",
  "_worker.js",
  "wrangler.toml",
]);

function compareUrls(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Collect the complete static release as URL paths.
 *
 * The output is intentionally based only on regular files in `dist`, with
 * deterministic POSIX separators and lexical ordering. The worker itself,
 * Pages controls, and the exact-source archive are network-only resources and
 * are therefore excluded from the release cache.
 */
export async function collectPrecacheUrls(distDir) {
  const files = await collectFiles(distDir);
  const urls = files
    .filter((file) => !isExcludedPrecacheFile(file))
    .map((file) => precacheUrlForStaticFile(file))
    .sort(compareUrls);

  assertCompletePrecacheUrls(urls);

  return urls;
}

/**
 * Emit the stable service-worker URL for an Astro static build.
 */
export async function writeServiceWorker(distDir, options = {}) {
  const buildId = normalizeBuildId(options.buildId);
  const releaseBanner = normalizeReleaseBannerOptions({
    buildId,
    sourceStatus: options.sourceStatus,
    sourceUrl: options.sourceUrl,
  });
  await prependReleaseBanners(distDir, releaseBanner);
  const precacheUrls = await collectPrecacheUrls(distDir);
  assertValidPrecacheUrls(precacheUrls);

  const source = `${createReleaseBanner(releaseBanner)}\n${buildServiceWorkerSource(
    {
      buildId,
      precacheUrls,
    },
  )}`;
  const outputPath = join(distDir, SERVICE_WORKER_FILE);
  await writeFile(outputPath, source, "utf8");

  return {
    buildId,
    cacheName: cacheNameForBuild(buildId),
    outputPath,
    precacheUrls,
    source,
  };
}

/**
 * Build a deterministic worker source from a build identity and sorted URLs.
 *
 * A staging cache is populated during install. It is copied to the release
 * cache only during activation, after the waiting worker is allowed to take
 * over. This lets an install failure leave the currently active release
 * untouched.
 */
export function buildServiceWorkerSource({ buildId, precacheUrls }) {
  const normalizedBuildId = normalizeBuildId(buildId);
  const normalizedUrls = [...precacheUrls];
  assertValidPrecacheUrls(normalizedUrls);

  const routeCandidates = buildRouteCandidates(normalizedUrls);
  const legalPaths = LEGAL_DOCUMENT_PATHS.filter((path) =>
    normalizedUrls.includes(path),
  );
  const source = `// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

const BUILD_ID = ${JSON.stringify(normalizedBuildId)};
const CACHE_PREFIX = ${JSON.stringify(CACHE_PREFIX)};
const STAGING_CACHE_PREFIX = ${JSON.stringify(STAGING_CACHE_PREFIX)};
const CACHE_NAME = \`\${CACHE_PREFIX}-\${BUILD_ID}\`;
const STAGING_CACHE_NAME = \`\${STAGING_CACHE_PREFIX}-\${BUILD_ID}\`;
const PRECACHE_URLS = ${JSON.stringify(normalizedUrls, null, 2)};
const APP_NAVIGATION_PATHS = ${JSON.stringify(APP_NAVIGATION_PATHS)};
const LEGAL_DOCUMENT_PATHS = ${JSON.stringify(legalPaths)};
const RESERVED_PREFIXES = ${JSON.stringify(RESERVED_PREFIXES)};
const ROUTE_CANDIDATES = ${JSON.stringify(routeCandidates, null, 2)};

function sameOriginGetRequest(request) {
  return request.method === "GET" &&
    new URL(request.url).origin === self.location.origin;
}

function pathForRequest(request) {
  return new URL(request.url).pathname.replace(/\\/{2,}/g, "/") || "/";
}

function isReservedPath(pathname) {
  return RESERVED_PREFIXES.some(
    (prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix),
  );
}

function isDeploymentControlPath(pathname) {
  return pathname === "/${SERVICE_WORKER_FILE}" ||
    pathname === "/_headers" ||
    pathname === "/_redirects" ||
    pathname === "/_routes.json" ||
    pathname === "/_worker.js" ||
    pathname === "/wrangler.toml";
}

function applicationNavigationPath(pathname) {
  if (pathname === "/settings/") {
    return "/settings";
  }
  if (pathname === "/settings/legal/") {
    return "/settings/legal";
  }
  return pathname;
}

function isKnownApplicationNavigation(pathname) {
  return APP_NAVIGATION_PATHS.includes(applicationNavigationPath(pathname));
}

function cacheRequest(pathname) {
  return new Request(new URL(pathname, self.location.origin).href, {
    method: "GET",
  });
}

async function cachedResponse(cache, pathname) {
  return cache.match(cacheRequest(pathname));
}

async function verifyCache(cache) {
  const missing = [];
  for (const pathname of PRECACHE_URLS) {
    const response = await cachedResponse(cache, pathname);
    if (!response || !response.ok) {
      missing.push(pathname);
    }
  }
  return missing;
}

async function populateStagingCache() {
  await caches.delete(STAGING_CACHE_NAME);
  const staging = await caches.open(STAGING_CACHE_NAME);
  try {
    for (const pathname of PRECACHE_URLS) {
      const response = await fetch(cacheRequest(pathname), { cache: "no-store" });
      if (!response.ok || new URL(response.url).origin !== self.location.origin) {
        throw new Error(\`Chooser offline release asset failed: \${pathname}\`);
      }
      await staging.put(cacheRequest(pathname), response);
    }

    const missing = await verifyCache(staging);
    if (missing.length > 0) {
      throw new Error(\`Chooser offline release is incomplete: \${missing.join(", ")}\`);
    }
  } catch (error) {
    await caches.delete(STAGING_CACHE_NAME);
    throw error;
  }
}

async function activateRelease() {
  const staging = await caches.open(STAGING_CACHE_NAME);
  const stagedMissing = await verifyCache(staging);
  if (stagedMissing.length > 0) {
    await caches.delete(STAGING_CACHE_NAME);
    throw new Error(\`Chooser staged release is incomplete: \${stagedMissing.join(", ")}\`);
  }

  const release = await caches.open(CACHE_NAME);
  try {
    for (const pathname of PRECACHE_URLS) {
      const response = await cachedResponse(staging, pathname);
      if (!response) {
        throw new Error(\`Chooser staged release lost asset: \${pathname}\`);
      }
      await release.put(cacheRequest(pathname), response);
    }

    const missing = await verifyCache(release);
    if (missing.length > 0) {
      throw new Error(\`Chooser active release is incomplete: \${missing.join(", ")}\`);
    }

    await caches.delete(STAGING_CACHE_NAME);
    await self.clients.claim();

    try {
      const cacheKeys = await caches.keys();
      await Promise.all(
        cacheKeys
          .filter((key) =>
            key.startsWith(CACHE_PREFIX + "-") &&
            key !== CACHE_NAME &&
            !key.startsWith(STAGING_CACHE_PREFIX + "-"),
          )
          .map((key) => caches.delete(key)),
      );
    } catch {
      // The complete active release remains valid if old-cache pruning fails.
    }
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

async function cacheFirstKnownRequest(request, candidates = []) {
  const cache = await caches.open(CACHE_NAME);
  for (const pathname of candidates) {
    const response = await cachedResponse(cache, pathname);
    if (response) {
      return response;
    }
  }

  try {
    return await fetch(request);
  } catch {
    return Response.error();
  }
}

async function handleNavigation(request, pathname) {
  if (isReservedPath(pathname)) {
    if (LEGAL_DOCUMENT_PATHS.includes(pathname)) {
      return cacheFirstKnownRequest(request, [pathname]);
    }
    return fetch(request);
  }

  const applicationPath = applicationNavigationPath(pathname);
  if (isKnownApplicationNavigation(applicationPath)) {
    return cacheFirstKnownRequest(
      request,
      ROUTE_CANDIDATES[applicationPath] || ["/"],
    );
  }

  try {
    return await fetch(request);
  } catch {
    return cacheFirstKnownRequest(request, ROUTE_CANDIDATES["/"] || ["/"]);
  }
}

async function handleFetch(request) {
  const pathname = pathForRequest(request);
  if (
    isDeploymentControlPath(pathname) ||
    pathname === "/source" ||
    pathname.startsWith("/source/")
  ) {
    return fetch(request);
  }

  if (request.mode === "navigate") {
    return handleNavigation(request, pathname);
  }

  if (PRECACHE_URLS.includes(pathname) || LEGAL_DOCUMENT_PATHS.includes(pathname)) {
    return cacheFirstKnownRequest(request, [pathname]);
  }

  return fetch(request);
}

async function respondToHandshake(event) {
  const requestId = event.data?.requestId;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return;
  }

  const cache = await caches.open(CACHE_NAME);
  const missing = await verifyCache(cache);
  const payload = {
    type: "CHOOSER_PWA_HANDSHAKE_RESULT",
    requestId,
    buildId: BUILD_ID,
    cacheName: CACHE_NAME,
    complete: event.data?.buildId === BUILD_ID && missing.length === 0,
    missing,
  };
  const target = event.ports[0] || event.source;
  target?.postMessage(payload);
}

self.addEventListener("install", (event) => {
  event.waitUntil(populateStagingCache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(activateRelease());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "CHOOSER_PWA_HANDSHAKE") {
    event.waitUntil(respondToHandshake(event));
  }
});

self.addEventListener("fetch", (event) => {
  if (!sameOriginGetRequest(event.request)) {
    return;
  }
  event.respondWith(handleFetch(event.request));
});
`;

  validateServiceWorkerSource(source, {
    buildId: normalizedBuildId,
    precacheUrls: normalizedUrls,
  });
  return source;
}

/**
 * Astro integration factory. The hook receives Astro's output directory URL
 * and emits `dist/sw.js` after every static build.
 */
export function createChooserPwaIntegration(options = {}) {
  const buildId = normalizeBuildId(options.buildId);
  const releaseBanner = normalizeReleaseBannerOptions({
    buildId,
    sourceStatus: options.sourceStatus,
    sourceUrl: options.sourceUrl,
  });
  return {
    name: "chooser-pwa",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        const distDir = fileURLToPath(dir);
        await writeServiceWorker(distDir, {
          buildId,
          sourceStatus: releaseBanner.sourceStatus,
          sourceUrl: releaseBanner.sourceUrl,
        });
        await validateStaticPwaRelease(distDir, {
          buildId,
          sourceStatus: releaseBanner.sourceStatus,
          sourceUrl: releaseBanner.sourceUrl,
        });
      },
    },
  };
}

export const chooserPwa = createChooserPwaIntegration;

/**
 * Validate a generated worker's public, deterministic contract.
 */
export function validateServiceWorkerSource(
  source,
  { buildId, precacheUrls, requireComplete = false } = {},
) {
  const normalizedBuildId = normalizeBuildId(buildId);
  const normalizedUrls = [...precacheUrls];
  assertValidPrecacheUrls(normalizedUrls);

  if (
    !source.includes(`const BUILD_ID = ${JSON.stringify(normalizedBuildId)};`)
  ) {
    throw new Error("service worker build identity is missing or stale");
  }
  if (!source.includes("const CACHE_NAME = `${CACHE_PREFIX}-${BUILD_ID}`;")) {
    throw new Error(
      "service worker cache name does not use the build identity",
    );
  }
  if (!source.includes("buildId: BUILD_ID")) {
    throw new Error(
      "service worker handshake does not expose the build identity",
    );
  }

  const precacheLiteral = source.match(
    /const PRECACHE_URLS = (\[[\s\S]*?\]);\nconst APP_NAVIGATION_PATHS/u,
  )?.[1];
  if (!precacheLiteral) {
    throw new Error("service worker precache manifest is missing");
  }
  const emittedUrls = JSON.parse(precacheLiteral);
  if (JSON.stringify(emittedUrls) !== JSON.stringify(normalizedUrls)) {
    throw new Error("service worker precache manifest is stale");
  }
  if (requireComplete) {
    assertCompletePrecacheUrls(normalizedUrls);
  }

  const forbiddenPatterns = [
    /skipWaiting/u,
    /BroadcastChannel/u,
    /cache\.put\(request/u,
    /clients\.(?:matchAll|openWindow).*reload/u,
  ];
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(source)) {
      throw new Error(`service worker contains forbidden behavior: ${pattern}`);
    }
  }

  return {
    buildId: normalizedBuildId,
    cacheName: cacheNameForBuild(normalizedBuildId),
    precacheUrls: normalizedUrls,
  };
}

/**
 * Validate the static output and generated worker together.
 */
export async function validateServiceWorkerRelease(distDir, options = {}) {
  const buildId = normalizeBuildId(options.buildId);
  const precacheUrls = await collectPrecacheUrls(distDir);
  const workerPath = join(distDir, SERVICE_WORKER_FILE);
  const source = await readFile(workerPath, "utf8");
  const result = validateServiceWorkerSource(source, {
    buildId,
    precacheUrls,
    requireComplete: true,
  });

  return {
    ...result,
    workerPath,
    workerBytes: Buffer.byteLength(source),
  };
}

export function assertValidPrecacheUrls(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error("service worker precache must contain at least one URL");
  }

  const sorted = [...urls].sort(compareUrls);
  if (JSON.stringify(sorted) !== JSON.stringify(urls)) {
    throw new Error("service worker precache URLs must be sorted");
  }

  if (new Set(urls).size !== urls.length) {
    throw new Error("service worker precache URLs must be unique");
  }

  for (const url of urls) {
    if (
      typeof url !== "string" ||
      !url.startsWith("/") ||
      url.startsWith("//") ||
      url.includes("\\") ||
      url.includes("?") ||
      url.includes("#")
    ) {
      throw new Error(`invalid service worker precache URL: ${url}`);
    }
    if (url === "/source" || url.startsWith("/source/")) {
      throw new Error(
        `service worker precache contains the source archive: ${url}`,
      );
    }
    if (NON_CANONICAL_RELEASE_URLS.has(url)) {
      throw new Error(
        `service worker precache contains a non-canonical route: ${url}`,
      );
    }
    if (
      url === `/${SERVICE_WORKER_FILE}` ||
      isExcludedPrecacheFile(url.slice(1))
    ) {
      throw new Error(
        `service worker precache contains an excluded file: ${url}`,
      );
    }
  }
}

export function assertCompletePrecacheUrls(urls) {
  assertValidPrecacheUrls(urls);
  const missing = REQUIRED_PRECACHE_URLS.filter(
    (pathname) => !urls.includes(pathname),
  );
  if (missing.length > 0) {
    throw new Error(
      `service worker precache is missing required release files: ${missing.join(", ")}`,
    );
  }
}

export function cacheNameForBuild(buildId) {
  return `${CACHE_PREFIX}-${normalizeBuildId(buildId)}`;
}

export function normalizeBuildId(buildId = "development") {
  if (
    typeof buildId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(buildId)
  ) {
    throw new Error(
      "service worker build identity must be a non-empty safe token",
    );
  }
  return buildId;
}

function buildRouteCandidates(precacheUrls) {
  const candidates = {};
  for (const pathname of APP_NAVIGATION_PATHS) {
    const canonicalPath = pathname === "/" ? "/" : `${pathname}/`;
    candidates[pathname] = precacheUrls.includes(canonicalPath)
      ? [canonicalPath]
      : [];
    if (candidates[pathname].length === 0 && precacheUrls.includes("/")) {
      candidates[pathname] = ["/"];
    }
  }
  return candidates;
}

function precacheUrlForStaticFile(file) {
  const normalized = file.split(sep).join("/");
  if (normalized === "index.html") {
    return "/";
  }
  if (normalized === "404.html") {
    return "/404";
  }
  if (normalized.endsWith("/index.html")) {
    return `/${normalized.slice(0, -"index.html".length)}`;
  }
  return `/${normalized}`;
}

function isExcludedPrecacheFile(file) {
  const normalized = file.split(sep).join("/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    basename === SERVICE_WORKER_FILE ||
    normalized === "source" ||
    normalized.startsWith("source/") ||
    DEPLOYMENT_CONTROL_FILES.has(basename) ||
    DEPLOYMENT_CONTROL_FILES.has(normalized)
  );
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

export async function createBuildIdFromDist(distDir, precacheUrls) {
  const urls = precacheUrls ?? (await collectPrecacheUrls(distDir));
  assertValidPrecacheUrls(urls);
  const hash = createHash("sha256");
  for (const url of urls) {
    hash.update(url);
    hash.update("\0");
    hash.update(await readFile(join(distDir, staticFileForPrecacheUrl(url))));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function staticFileForPrecacheUrl(url) {
  if (url === "/") {
    return "index.html";
  }
  if (url === "/404") {
    return "404.html";
  }
  if (url.endsWith("/")) {
    return `${url.slice(1)}index.html`;
  }
  return url.slice(1);
}
