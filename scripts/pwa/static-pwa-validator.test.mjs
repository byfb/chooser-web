// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeServiceWorker } from "./service-worker.mjs";
import {
  EXPECTED_HEADERS,
  PWA_ICON_CONTRACT,
  PWA_MANIFEST_IDENTITY,
  validateHeaders,
  validateIndexDocument,
  validateManifest,
  validateNotFoundDocument,
  validateStaticPwaRelease,
} from "./static-pwa-validator.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("static PWA release validator", () => {
  it("accepts a complete manifest, icon set, document links, headers, 404, and worker", async () => {
    const distDir = await createStaticDist();

    await expect(
      validateStaticPwaRelease(distDir, { buildId: "build-a" }),
    ).resolves.toMatchObject({
      manifest: "/manifest.webmanifest",
      index: "/index.html",
      headers: "/_headers",
      notFound: "/404.html",
      worker: expect.objectContaining({ buildId: "build-a" }),
    });
  });

  it("rejects a stale GPL/source banner even when the worker contract still matches", async () => {
    const distDir = await createStaticDist();
    const workerPath = join(distDir, "sw.js");
    const worker = await readFile(workerPath, "utf8");
    await writeFile(
      workerPath,
      worker.replace(
        "Corresponding Source: pending approval",
        "Corresponding Source: stale",
      ),
    );

    await expect(
      validateStaticPwaRelease(distDir, { buildId: "build-a" }),
    ).rejects.toThrow(/GPL\/source banner/i);
  });

  it.each([
    ["id", (manifest) => ({ ...manifest, id: "/app" })],
    ["description", (manifest) => ({ ...manifest, description: "Chooser" })],
    ["display", (manifest) => ({ ...manifest, display: "browser" })],
    ["orientation", (manifest) => ({ ...manifest, orientation: "portrait" })],
  ])("rejects an invalid manifest %s", async (_name, mutate) => {
    const distDir = await createStaticDist();
    const manifest = JSON.parse(
      await readFile(join(distDir, "manifest.webmanifest"), "utf8"),
    );
    await writeFile(
      join(distDir, "manifest.webmanifest"),
      JSON.stringify(mutate(manifest)),
    );

    await expect(
      validateStaticPwaRelease(distDir, { buildId: "build-a" }),
    ).rejects.toThrow(/manifest/i);
  });

  it("rejects an invalid icon signature or IHDR dimension", async () => {
    const distDir = await createStaticDist();
    await writeFile(join(distDir, "icons/icon-192.png"), createPng(191, 192));

    await expect(
      validateStaticPwaRelease(distDir, { buildId: "build-a" }),
    ).rejects.toThrow(/192x192/i);

    await writeFile(join(distDir, "icons/icon-192.png"), "not png");
    await expect(
      validateStaticPwaRelease(distDir, { buildId: "build-a" }),
    ).rejects.toThrow(/not a PNG/i);
  });

  it("requires both generated install links in the root document", async () => {
    const validDocument = `<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">`;
    expect(() => validateIndexDocument(validDocument)).not.toThrow();
    expect(() =>
      validateIndexDocument(
        '<link rel="manifest" href="/manifest.webmanifest">',
      ),
    ).toThrow(/Apple touch/i);
    expect(() =>
      validateIndexDocument(
        '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">',
      ),
    ).toThrow(/manifest/i);
  });

  it("requires the exact security, MIME, and service-worker header policy", () => {
    const valid = Object.entries(EXPECTED_HEADERS)
      .map(
        ([path, directives]) =>
          `${path}\n${directives.map((line) => `  ${line}`).join("\n")}`,
      )
      .join("\n\n");
    expect(() => validateHeaders(valid)).not.toThrow();
    expect(() =>
      validateHeaders(
        valid.replace("X-Frame-Options: DENY", "X-Frame-Options: SAMEORIGIN"),
      ),
    ).toThrow(/exact/i);
    expect(() =>
      validateHeaders(`${valid}\n\n/extra\n  Cache-Control: public`),
    ).toThrow(/unexpected|missing/i);
  });

  it("requires a no-shell 404 that preserves both reserved legal and source paths", () => {
    const valid = `
      <body class="no-shell-404"><main>Not found</main></body>
      <script>
        const pathname = window.location.pathname;
        const isReservedPath = pathname === "/legal" || pathname.startsWith("/legal/") || pathname === "/source" || pathname.startsWith("/source/");
        if (!isReservedPath) { window.location.replace("/"); }
      </script>
    `;
    expect(() => validateNotFoundDocument(valid)).not.toThrow();
    expect(() =>
      validateNotFoundDocument(valid.replace("/source/", "/archive/")),
    ).toThrow(/reserved \/source/i);
    expect(() =>
      validateNotFoundDocument(`${valid}<div id="chooser-root"></div>`),
    ).toThrow(/application shell/i);
  });

  it("requires the accepted manifest identity and all five icon dimensions", () => {
    expect(() =>
      validateManifest({ ...PWA_MANIFEST_IDENTITY, icons: [] }),
    ).toThrow(/four exact/i);
    expect(
      PWA_ICON_CONTRACT.map(
        (icon) => `${icon.path}:${icon.width}x${icon.height}`,
      ),
    ).toEqual([
      "/icons/icon-192.png:192x192",
      "/icons/icon-512.png:512x512",
      "/icons/icon-192-maskable.png:192x192",
      "/icons/icon-512-maskable.png:512x512",
      "/icons/apple-touch-icon.png:180x180",
    ]);
  });
});

async function createStaticDist() {
  const directory = await mkdtemp(join(tmpdir(), "chooser-static-pwa-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "icons"), { recursive: true });
  await mkdir(join(directory, "legal"), { recursive: true });
  await mkdir(join(directory, "settings/legal"), { recursive: true });

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
    join(directory, "index.html"),
    '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">',
  );
  await writeFile(join(directory, "settings/index.html"), "settings");
  await writeFile(join(directory, "settings/legal/index.html"), "legal");
  await writeFile(
    join(directory, "404.html"),
    `
    <body class="no-shell-404"><main>Not found</main></body>
    <script>
      const pathname = window.location.pathname;
      const isReservedPath = pathname === "/legal" || pathname.startsWith("/legal/") || pathname === "/source" || pathname.startsWith("/source/");
      if (!isReservedPath) { window.location.replace("/"); }
    </script>
  `,
  );
  await writeFile(join(directory, "_headers"), headersText());

  for (const icon of PWA_ICON_CONTRACT) {
    await writeFile(
      join(directory, icon.path.slice(1)),
      createPng(icon.width, icon.height),
    );
  }
  for (const pathname of [
    "/legal/gpl-3.0.txt",
    "/legal/notice.txt",
    "/legal/third-party-notices.txt",
    "/legal/asset-provenance.txt",
  ]) {
    await writeFile(join(directory, pathname.slice(1)), pathname);
  }

  await writeServiceWorker(directory, { buildId: "build-a" });
  return directory;
}

function headersText() {
  return Object.entries(EXPECTED_HEADERS)
    .map(
      ([path, directives]) =>
        `${path}\n${directives.map((line) => `  ${line}`).join("\n")}`,
    )
    .join("\n\n");
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
  png.writeUInt8(0, 26);
  png.writeUInt8(0, 27);
  png.writeUInt8(0, 28);
  png.writeUInt32BE(0, 37);
  png.write("IEND", 41, 4, "ascii");
  return png;
}
