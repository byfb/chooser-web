// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFile as nodeExecFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeDirectoryDigest,
  createCorrespondingSourceArchive,
  getReleaseIdentity,
  materializeCanonicalDist,
  runIsolatedFrozenBuilds,
  runReleaseCommand,
  validateSourceArchive,
} from "./artifacts.mjs";

const execFile = promisify(nodeExecFile);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("release identity", () => {
  it("derives a full clean commit and SOURCE_DATE_EPOCH from Git", async () => {
    const commitSha = "a".repeat(40);
    const calls = [];
    const runCommand = async (command, args) => {
      calls.push([command, args]);
      if (args[0] === "status") {
        return { stdout: "" };
      }
      if (args[0] === "rev-parse") {
        return { stdout: `${commitSha}\n` };
      }
      return { stdout: "1788267158\n" };
    };

    await expect(
      getReleaseIdentity({ cwd: "/project", runCommand }),
    ).resolves.toEqual({
      commitSha,
      sourceDateEpoch: 1788267158,
    });
    expect(calls).toEqual([
      ["git", ["status", "--porcelain=v1", "--untracked-files=all"]],
      ["git", ["rev-parse", "--verify", "HEAD^{commit}"]],
      ["git", ["show", "-s", "--format=%ct", commitSha]],
    ]);
  });

  it("refuses to produce an identity for a dirty tree", async () => {
    await expect(
      getReleaseIdentity({
        cwd: "/project",
        runCommand: async (_command, args) =>
          args[0] === "status" ? { stdout: " M src/app.ts\n" } : {},
      }),
    ).rejects.toThrow(/clean/i);
  });
});

describe("directory artifact digests", () => {
  it("is independent of file creation order and changes when bytes change", async () => {
    const first = await makeTemporaryDirectory("chooser-digest-a-");
    const second = await makeTemporaryDirectory("chooser-digest-b-");
    await writeFile(join(first, "z.txt"), "z");
    await writeFile(join(first, "a.txt"), "a");
    await writeFile(join(second, "a.txt"), "a");
    await writeFile(join(second, "z.txt"), "z");

    const firstDigest = await computeDirectoryDigest(first);
    const secondDigest = await computeDirectoryDigest(second);
    expect(firstDigest).toBe(secondDigest);

    await writeFile(join(second, "z.txt"), "changed");
    const changedDigest = await computeDirectoryDigest(second);
    expect(changedDigest).not.toBe(firstDigest);
  });
});

describe("Corresponding Source archives", () => {
  it("normalizes source tar entries and produces a stable SHA-named gzip archive", async () => {
    const outputA = await makeTemporaryDirectory("chooser-source-a-");
    const outputB = await makeTemporaryDirectory("chooser-source-b-");
    const commitSha = "b".repeat(40);
    const archiveA = join(outputA, `chooser-web-${commitSha}.tar.gz`);
    const archiveB = join(outputB, `chooser-web-${commitSha}.tar.gz`);
    const rawTar = await gitArchiveForPaths(
      ["package.json", "LICENSE"],
      commitSha,
    );
    const sourceDateEpoch = 1700000000;
    const runCommand = async (command, args) => {
      if (command === "git" && args[0] === "status") {
        return { stdout: "" };
      }
      if (command === "git" && args[0] === "rev-parse") {
        return { stdout: `${commitSha}\n` };
      }
      if (command === "git" && args[0] === "show") {
        return { stdout: `${sourceDateEpoch}\n` };
      }
      if (command === "git" && args[0] === "ls-tree") {
        return { stdout: "package.json\0LICENSE\0" };
      }
      if (command === "git" && args[0] === "archive") {
        return { stdout: rawTar };
      }
      if (command === "gzip") {
        return execFile("gzip", args, { encoding: "buffer" });
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };

    const first = await createCorrespondingSourceArchive({
      cwd: "/project",
      outputPath: archiveA,
      commitSha,
      sourceDateEpoch,
      runCommand,
      sourceEntries: ["package.json", "LICENSE"],
    });
    const second = await createCorrespondingSourceArchive({
      cwd: "/project",
      outputPath: archiveB,
      commitSha,
      sourceDateEpoch,
      runCommand,
      sourceEntries: ["package.json", "LICENSE"],
    });

    expect(first.archiveName).toBe(`chooser-web-${commitSha}.tar.gz`);
    expect(first.archiveSha256).toBe(second.archiveSha256);
    expect(await readFile(archiveA)).toEqual(await readFile(archiveB));
  });

  it("rejects an archive whose filename, revision, or contents do not agree", async () => {
    const output = await makeTemporaryDirectory("chooser-source-validation-");
    const commitSha = "c".repeat(40);
    const rawTar = await gitArchiveForPaths(["package.json"], commitSha);
    const sourceDateEpoch = 1700000000;
    const runCommand = async (command, args) => {
      if (command === "git" && args[0] === "ls-tree") {
        return { stdout: "package.json\0" };
      }
      if (command === "git" && args[0] === "archive") {
        return { stdout: rawTar };
      }
      if (command === "gzip") {
        return execFile("gzip", args, { encoding: "buffer" });
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };
    const archivePath = join(output, `chooser-web-${commitSha}.tar.gz`);
    await createCorrespondingSourceArchive({
      cwd: "/project",
      outputPath: archivePath,
      commitSha,
      sourceDateEpoch,
      runCommand,
      sourceEntries: ["package.json"],
      ensureClean: false,
    });

    await expect(
      validateSourceArchive({
        cwd: "/project",
        archivePath,
        commitSha,
        sourceDateEpoch,
        runCommand,
        sourceEntries: ["package.json"],
        ensureClean: false,
      }),
    ).resolves.toEqual(expect.objectContaining({ valid: true }));

    await expect(
      validateSourceArchive({
        cwd: "/project",
        archivePath: join(output, "chooser-web-wrong.tar.gz"),
        commitSha,
        sourceDateEpoch,
        runCommand,
        sourceEntries: ["package.json"],
        ensureClean: false,
      }),
    ).rejects.toThrow(/named|filename/i);
  });
});

describe("canonical dist materialization", () => {
  it("promotes a verified directory while preserving byte identity", async () => {
    const parent = await makeTemporaryDirectory("chooser-dist-");
    const sourceDist = join(parent, "isolated", "dist");
    const destinationDist = join(parent, "dist");
    await mkdirp(sourceDist);
    await mkdirp(destinationDist);
    await writeFile(join(sourceDist, "index.html"), "release");
    await writeFile(join(destinationDist, "stale.txt"), "stale");

    const result = await materializeCanonicalDist({
      sourceDist,
      destinationDist,
    });

    expect(result.destinationDist).toBe(destinationDist);
    expect(await readFile(join(destinationDist, "index.html"), "utf8")).toBe(
      "release",
    );
    await expect(
      readFile(join(destinationDist, "stale.txt")),
    ).rejects.toThrow();
  });
});

describe("isolated frozen builds", () => {
  it("runs two isolated frozen builds and promotes only the equal output", async () => {
    const root = await makeTemporaryDirectory("chooser-build-output-");
    const commitSha = (
      await execFile("git", ["rev-parse", "HEAD"], {
        cwd: process.cwd(),
        encoding: "utf8",
      })
    ).stdout.trim();
    const sourceDateEpoch = Number(
      (
        await execFile("git", ["show", "-s", "--format=%ct", commitSha], {
          cwd: process.cwd(),
          encoding: "utf8",
        })
      ).stdout.trim(),
    );
    const calls = [];
    const runCommand = async (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "" };
      }
      if (command === "pnpm" && args[0] === "install") {
        return { stdout: "", stderr: "" };
      }
      if (
        command === "pnpm" &&
        args[0] === "exec" &&
        args[1] === "astro" &&
        args[2] === "build"
      ) {
        await mkdirp(join(options.cwd, "dist"));
        await writeFile(join(options.cwd, "dist", "index.html"), "release");
        return { stdout: "", stderr: "" };
      }
      return runReleaseCommand(command, args, options);
    };

    const result = await runIsolatedFrozenBuilds({
      cwd: process.cwd(),
      commitSha,
      sourceDateEpoch,
      distDirectory: join(root, "dist"),
      runCommand,
      buildEnvironment: {
        CHOOSER_SOURCE_STATUS: "pending",
        CHOOSER_SOURCE_URL: "",
      },
    });

    expect(result.commitSha).toBe(commitSha);
    expect(result.sourceDateEpoch).toBe(sourceDateEpoch);
    expect(result.builds).toHaveLength(2);
    expect(result.builds[0].distDigest).toBe(result.builds[1].distDigest);
    expect(result.builds[0].archiveSha256).toBe(result.builds[1].archiveSha256);
    expect(
      calls.filter(
        ({ command, args }) => command === "pnpm" && args[0] === "install",
      ),
    ).toHaveLength(2);
    const buildCalls = calls.filter(
      ({ command, args }) =>
        command === "pnpm" &&
        args[0] === "exec" &&
        args[1] === "astro" &&
        args[2] === "build",
    );
    expect(buildCalls).toHaveLength(2);
    for (const { options } of buildCalls) {
      expect(options.env).toMatchObject({
        CHOOSER_BUILD_ID: commitSha,
        CHOOSER_SOURCE_STATUS: "pending",
        CHOOSER_SOURCE_URL: "",
        SOURCE_DATE_EPOCH: String(sourceDateEpoch),
      });
    }
    expect(await readFile(join(root, "dist", "index.html"), "utf8")).toBe(
      "release",
    );
  });
});

async function makeTemporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function mkdirp(directory) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
}

async function gitArchiveForPaths(paths, commitSha) {
  const result = await execFile(
    "git",
    [
      "archive",
      "--format=tar",
      `--prefix=chooser-web-${commitSha}/`,
      "HEAD",
      "--",
      ...paths,
    ],
    { cwd: process.cwd(), encoding: "buffer" },
  );
  return result.stdout;
}
