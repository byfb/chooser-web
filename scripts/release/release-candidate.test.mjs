// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "./artifacts.mjs";
import {
  buildReleaseCandidate,
  readSourceApproval,
} from "./release-candidate.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("buildReleaseCandidate", () => {
  it("builds a pending candidate and writes only an external release manifest", async () => {
    const cwd = await makeTemporaryDirectory("chooser-release-candidate-");
    const commitSha = "a".repeat(40);
    const sourceDateEpoch = 1_700_000_000;
    const calls = [];
    const buildEnvironments = [];
    const archiveBytes = Buffer.from("canonical source archive");
    const archiveSha256 = sha256(archiveBytes);

    const result = await buildReleaseCandidate({
      cwd,
      runCommand: createGitRunner({
        calls,
        commitSha,
        sourceDateEpoch,
      }),
      runBuilds: async (options) => {
        buildEnvironments.push(options.buildEnvironment);
        await createReleaseDist(options.distDirectory, {
          commitSha,
          sourceArchivePath: `/source/chooser-web-${commitSha}.tar.gz`,
        });
        return {
          commitSha,
          sourceDateEpoch,
          distDirectory: options.distDirectory,
          distDigest: "pre-archive-digest",
          archiveName: `chooser-web-${commitSha}.tar.gz`,
          archiveSha256,
          builds: [
            { index: 1, distDigest: "pre-archive-digest", archiveSha256 },
            { index: 2, distDigest: "pre-archive-digest", archiveSha256 },
          ],
        };
      },
      createArchive: async ({ outputPath }) => {
        await mkdir(join(outputPath, ".."), { recursive: true });
        await writeFile(outputPath, archiveBytes);
        return {
          archiveName: basename(outputPath),
          archivePath: outputPath,
          archiveSha256,
        };
      },
      validateArchive: async ({ archivePath }) => {
        expect(await readFile(archivePath)).toEqual(archiveBytes);
        return { valid: true, archiveSha256 };
      },
      validatePwa: async (_distDirectory, options) => ({
        buildId: options.buildId,
      }),
    });

    expect(result).toMatchObject({
      status: "pending",
      commitSha,
      sourceDateEpoch,
      source: {
        status: "pending",
        sourceUrl: "",
        archivePath: `/source/chooser-web-${commitSha}.tar.gz`,
        archiveSha256,
      },
    });
    expect(buildEnvironments).toHaveLength(1);
    expect(buildEnvironments[0]).toMatchObject({
      CHOOSER_BUILD_ID: commitSha,
      CHOOSER_SOURCE_STATUS: "pending",
      CHOOSER_SOURCE_URL: "",
    });
    expect(calls.filter(([command]) => command === "git")).not.toHaveLength(0);

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      license: "GPL-3.0-or-later",
      commitSha,
      source: {
        status: "pending",
        sourceUrl: "",
        archivePath: `/source/chooser-web-${commitSha}.tar.gz`,
        archiveSha256,
      },
      legal: {
        artifactPath: "/settings/legal/index.html",
      },
    });
    expect(manifest.dist.sha256).toBe(result.dist.digest);
    expect(result.manifestPath.startsWith(join(cwd, ".artifacts"))).toBe(true);
    await expect(
      readFile(join(cwd, "dist", "release-manifest.json")),
    ).rejects.toThrow();
    expect(
      await readFile(
        join(cwd, "dist", "source", basename(result.source.archivePath)),
      ),
    ).toEqual(archiveBytes);
  });

  it("requires an immutable HTTPS source URL containing the exact commit", async () => {
    const cwd = await makeTemporaryDirectory("chooser-release-approved-");
    const commitSha = "b".repeat(40);
    await mkdir(join(cwd, ".artifacts", "release"), { recursive: true });
    await writeFile(
      join(cwd, ".artifacts", "release", "source-approval.json"),
      JSON.stringify({
        status: "approved",
        immutable: true,
        sourceRevision: commitSha,
        sourceUrl: `https://example.invalid/source/${"c".repeat(40)}.tar.gz`,
      }),
    );
    let builds = 0;

    await expect(
      buildReleaseCandidate({
        cwd,
        runCommand: createGitRunner({
          commitSha,
          sourceDateEpoch: 1_700_000_001,
        }),
        runBuilds: async () => {
          builds += 1;
        },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_APPROVAL_NOT_IMMUTABLE" });
    expect(builds).toBe(0);
  });

  it("requires approved source metadata to name the exact revision", async () => {
    const cwd = await makeTemporaryDirectory("chooser-release-revision-");
    const commitSha = "e".repeat(40);
    const approvalPath = join(cwd, "source-approval.json");
    await writeFile(
      approvalPath,
      JSON.stringify({
        status: "approved",
        immutable: true,
        sourceUrl: `https://example.invalid/source/chooser-web-${commitSha}.tar.gz`,
      }),
    );

    await expect(
      readSourceApproval({ path: approvalPath, commitSha }),
    ).rejects.toMatchObject({ code: "SOURCE_APPROVAL_INVALID" });
  });

  it("fails closed when the generated dist contains release metadata controls", async () => {
    const cwd = await makeTemporaryDirectory("chooser-release-controls-");
    const commitSha = "c".repeat(40);
    const archiveBytes = Buffer.from("archive");

    await expect(
      buildReleaseCandidate({
        cwd,
        runCommand: createGitRunner({
          commitSha,
          sourceDateEpoch: 1_700_000_002,
        }),
        runBuilds: async ({ distDirectory }) => {
          await createReleaseDist(distDirectory, {
            commitSha,
            sourceArchivePath: `/source/chooser-web-${commitSha}.tar.gz`,
          });
          await writeFile(
            join(distDirectory, "release-manifest.json"),
            "must never be deployed",
          );
        },
        createArchive: async ({ outputPath }) => {
          await mkdir(join(outputPath, ".."), { recursive: true });
          await writeFile(outputPath, archiveBytes);
          return { archiveSha256: sha256(archiveBytes) };
        },
        validateArchive: async () => ({ valid: true }),
        validatePwa: async () => ({ valid: true }),
      }),
    ).rejects.toMatchObject({ code: "RELEASE_METADATA_IN_DIST" });
  });

  it("does not start a build when Git identity is dirty", async () => {
    const cwd = await makeTemporaryDirectory("chooser-release-dirty-");
    let builds = 0;

    await expect(
      buildReleaseCandidate({
        cwd,
        runCommand: async (_command, args) => {
          if (args[0] === "status") {
            return { stdout: " M src/app.ts\n" };
          }
          throw new Error("unexpected command after dirty status");
        },
        runBuilds: async () => {
          builds += 1;
        },
      }),
    ).rejects.toMatchObject({ code: "GIT_TREE_DIRTY" });
    expect(builds).toBe(0);
  });

  it("requires Legal identity markers in the generated artifact", async () => {
    const cwd = await makeTemporaryDirectory("chooser-release-legal-");
    const commitSha = "d".repeat(40);
    const archiveBytes = Buffer.from("archive");

    await expect(
      buildReleaseCandidate({
        cwd,
        runCommand: createGitRunner({
          commitSha,
          sourceDateEpoch: 1_700_000_003,
        }),
        runBuilds: async ({ distDirectory }) => {
          await createReleaseDist(distDirectory, {
            commitSha,
            sourceArchivePath: "wrong-archive-path",
          });
        },
        createArchive: async ({ outputPath }) => {
          await mkdir(join(outputPath, ".."), { recursive: true });
          await writeFile(outputPath, archiveBytes);
          return { archiveSha256: sha256(archiveBytes) };
        },
        validateArchive: async () => ({ valid: true }),
        validatePwa: async () => ({ valid: true }),
      }),
    ).rejects.toMatchObject({ code: "LEGAL_IDENTITY_INVALID" });
  });

  it("rejects symlinks from the deployable distribution", async () => {
    const cwd = await makeTemporaryDirectory("chooser-release-symlink-");
    const commitSha = "f".repeat(40);
    const archiveBytes = Buffer.from("archive");

    await expect(
      buildReleaseCandidate({
        cwd,
        runCommand: createGitRunner({
          commitSha,
          sourceDateEpoch: 1_700_000_004,
        }),
        runBuilds: async ({ distDirectory }) => {
          await createReleaseDist(distDirectory, {
            commitSha,
            sourceArchivePath: `/source/chooser-web-${commitSha}.tar.gz`,
          });
          await symlink("index.html", join(distDirectory, "linked.html"));
        },
        createArchive: async ({ outputPath }) => {
          await mkdir(join(outputPath, ".."), { recursive: true });
          await writeFile(outputPath, archiveBytes);
          return { archiveSha256: sha256(archiveBytes) };
        },
        validateArchive: async () => ({ valid: true }),
        validatePwa: async () => ({ valid: true }),
      }),
    ).rejects.toMatchObject({ code: "DIST_ENTRY_INVALID" });
  });
});

function createGitRunner({ calls = [], commitSha, sourceDateEpoch }) {
  return async (command, args, options = {}) => {
    calls.push([command, args, options]);
    if (command !== "git") {
      throw new Error(`unexpected command: ${command}`);
    }
    if (args[0] === "status") {
      return { stdout: "" };
    }
    if (args[0] === "rev-parse") {
      return { stdout: `${commitSha}\n` };
    }
    if (args[0] === "show") {
      return { stdout: `${sourceDateEpoch}\n` };
    }
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
}

async function createReleaseDist(
  distDirectory,
  { commitSha, sourceArchivePath },
) {
  await mkdir(join(distDirectory, "legal"), { recursive: true });
  await mkdir(join(distDirectory, "settings", "legal"), { recursive: true });
  await writeFile(join(distDirectory, "index.html"), "pwa");
  await writeFile(join(distDirectory, "settings", "index.html"), "settings");
  await writeFile(
    join(distDirectory, "settings", "legal", "index.html"),
    `${commitSha}\n${sourceArchivePath}\n`,
  );
  for (const file of [
    "gpl-3.0.txt",
    "notice.txt",
    "third-party-notices.txt",
    "asset-provenance.txt",
  ]) {
    await writeFile(join(distDirectory, "legal", file), file);
  }
}

async function makeTemporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
