// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertReleaseCandidate,
  computeDirectoryDigest,
  deploy,
  parseWranglerDeploymentOutput,
  validatePagesProject,
} from "./deploy.mjs";

const TEST_SHA = "a".repeat(40);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Cloudflare deployment guard", () => {
  it("rejects an unresolved source approval before release validation can pass", async () => {
    const root = await makeFixture({ sourceStatus: "pending" });

    await expect(
      assertReleaseCandidate({
        cwd: root.root,
        head: TEST_SHA,
        runCommand: async (command, args) => {
          if (command === "git" && args[0] === "status") {
            return { stdout: "", stderr: "" };
          }
          if (command === "git" && args[0] === "rev-parse") {
            return { stdout: `${TEST_SHA}\n`, stderr: "" };
          }
          throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        },
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_APPROVAL_UNRESOLVED",
    });
  });

  it("computes a stable digest from sorted paths and file bytes", async () => {
    const root = await makeTemporaryDirectory();
    await mkdir(join(root, "dist", "nested"), { recursive: true });
    await writeFile(join(root, "dist", "z.txt"), "z");
    await writeFile(join(root, "dist", "nested", "a.txt"), "a");

    const first = await computeDirectoryDigest(join(root, "dist"));
    await writeFile(join(root, "dist", "a.txt"), "a");
    const second = await computeDirectoryDigest(join(root, "dist"));

    expect(second).not.toBe(first);
    expect(await computeDirectoryDigest(join(root, "dist"))).toBe(second);
  });

  it("rejects a stale release-manifest digest", async () => {
    const fixture = await makeFixture({ sourceStatus: "approved" });
    const manifestPath = join(
      fixture.root,
      ".artifacts",
      "release",
      "release-manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dist.sha256 = "0".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(
      assertReleaseCandidate({
        cwd: fixture.root,
        runCommand: createCleanGitRunner(),
      }),
    ).rejects.toMatchObject({ code: "RELEASE_MANIFEST_MISMATCH" });
  });

  it("does not invoke Wrangler when the approval remains unresolved", async () => {
    const root = await makeFixture({ sourceStatus: "pending" });
    const calls = [];

    await expect(
      deploy({
        cwd: root.root,
        runCommand: async (command, args, options) => {
          calls.push({ command, args, options });
          if (command === "pnpm" && args[0] === "verify") {
            return { stdout: "", stderr: "" };
          }
          if (command === "git" && args[0] === "status") {
            return { stdout: "", stderr: "" };
          }
          if (command === "git" && args[0] === "rev-parse") {
            return { stdout: `${TEST_SHA}\n`, stderr: "" };
          }
          throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_APPROVAL_UNRESOLVED" });

    expect(calls.some(({ command }) => command === "wrangler")).toBe(false);
    expect(calls.some(({ args }) => args.includes("pages"))).toBe(false);
  });

  it("creates an absent Direct Upload project and uploads exactly once", async () => {
    const fixture = await makeFixture({ sourceStatus: "approved" });
    const calls = [];

    const result = await deploy({
      cwd: fixture.root,
      runCommand: async (command, args, options) => {
        calls.push({ command, args, options });
        if (command === "pnpm" && args[0] === "verify") {
          return { stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "status") {
          return { stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse") {
          return { stdout: `${TEST_SHA}\n`, stderr: "" };
        }
        if (command === "pnpm" && args[0] === "exec") {
          if (args.includes("whoami")) {
            return {
              stdout: JSON.stringify({
                success: true,
                result: { accounts: [{ id: "account" }] },
              }),
              stderr: "",
            };
          }
          if (args.includes("list")) {
            return {
              stdout: JSON.stringify([
                {
                  "Project Name": "quick-qr-scan",
                  "Project Domains": "quick-qr-scan.pages.dev, qr.example.com",
                  "Git Provider": "No",
                },
                {
                  "Project Name": "draw-card-simulator",
                  "Project Domains":
                    "draw-card-simulator.pages.dev, draw.example.com",
                  "Git Provider": "No",
                },
              ]),
              stderr: "",
            };
          }
          if (args.includes("create")) {
            return { stdout: "created chooser-web", stderr: "" };
          }
          if (args.includes("deploy")) {
            const outputPath = options.env.WRANGLER_OUTPUT_FILE_PATH;
            expect(outputPath).toBeTruthy();
            await writeFile(
              outputPath,
              `${JSON.stringify({ type: "wrangler-session", version: 1 })}\n${JSON.stringify(
                deploymentOutput(),
              )}\n`,
            );
            return { stdout: "deployed", stderr: "" };
          }
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    const createCalls = calls.filter((call) => call.args.includes("create"));
    const uploadCalls = calls.filter((call) => call.args.includes("deploy"));
    expect(createCalls).toHaveLength(1);
    expect(uploadCalls).toHaveLength(1);
    expect(createCalls[0].args).toEqual([
      "exec",
      "wrangler",
      "pages",
      "project",
      "create",
      "chooser-web",
      "--production-branch",
      "main",
    ]);
    expect(uploadCalls[0].args).toEqual([
      "exec",
      "wrangler",
      "pages",
      "deploy",
      "dist",
      "--project-name",
      "chooser-web",
      "--branch",
      "main",
      "--commit-hash",
      TEST_SHA,
    ]);
    expect(result).toMatchObject({
      projectName: "chooser-web",
      deploymentId: "deployment-id",
      url: "https://abc.chooser-web.pages.dev",
      alias: "https://chooser-web.pages.dev",
      environment: "production",
      branch: "main",
      commitHash: TEST_SHA,
    });
  });

  it("reuses only a proven Direct Upload project", async () => {
    expect(() =>
      validatePagesProject({
        name: "chooser-web",
        production_branch: "main",
        source: { type: "github", config: { owner: "someone" } },
      }),
    ).toThrow(/Git integration/i);

    expect(() =>
      validatePagesProject({
        name: "chooser-web",
        production_branch: "main",
        source: { type: "direct_upload" },
        bindings: { API: { type: "secret_text" } },
      }),
    ).toThrow(/binding/i);

    expect(() =>
      validatePagesProject({
        name: "chooser-web",
        production_branch: "main",
        source: { type: "direct_upload" },
      }),
    ).not.toThrow();
  });

  it("fails before upload when the canonical dist changes after verification", async () => {
    const fixture = await makeFixture({ sourceStatus: "approved" });
    const calls = [];
    let statusReads = 0;

    await expect(
      deploy({
        cwd: fixture.root,
        runCommand: async (command, args, options) => {
          calls.push({ command, args, options });
          if (command === "pnpm" && args[0] === "verify") {
            return { stdout: "", stderr: "" };
          }
          if (command === "git" && args[0] === "status") {
            statusReads += 1;
            if (statusReads === 2) {
              await writeFile(join(fixture.root, "dist", "app.js"), "changed");
            }
            return { stdout: "", stderr: "" };
          }
          if (command === "git" && args[0] === "rev-parse") {
            return { stdout: `${TEST_SHA}\n`, stderr: "" };
          }
          if (
            command === "pnpm" &&
            args[0] === "exec" &&
            args.includes("whoami")
          ) {
            return {
              stdout: JSON.stringify({ success: true, result: {} }),
              stderr: "",
            };
          }
          if (
            command === "pnpm" &&
            args[0] === "exec" &&
            args.includes("list")
          ) {
            return {
              stdout: JSON.stringify({
                success: true,
                result: [
                  {
                    name: "chooser-web",
                    production_branch: "main",
                    source: { type: "direct_upload" },
                  },
                ],
              }),
              stderr: "",
            };
          }
          throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        },
      }),
    ).rejects.toMatchObject({ code: "CANDIDATE_CHANGED" });

    expect(calls.some(({ args }) => args.includes("deploy"))).toBe(false);
  });

  it("requires the detailed Wrangler result to identify the exact production commit", () => {
    expect(() =>
      parseWranglerDeploymentOutput(
        JSON.stringify({
          type: "pages-deploy-detailed",
          pages_project: "chooser-web",
          deployment_id: "id",
          url: "https://abc.chooser-web.pages.dev",
          alias: null,
          environment: "production",
          production_branch: "main",
          deployment_trigger: { metadata: { commit_hash: "b".repeat(40) } },
        }),
        TEST_SHA,
      ),
    ).toThrow(/commit/i);
  });
});

async function makeFixture({ sourceStatus }) {
  const root = await makeTemporaryDirectory();
  const dist = join(root, "dist");
  const source = join(root, ".artifacts", "release");
  await mkdir(join(dist, "source"), { recursive: true });
  await mkdir(join(dist, "legal"), { recursive: true });
  await mkdir(join(dist, "settings", "legal"), { recursive: true });
  await mkdir(source, { recursive: true });

  const archive = Buffer.from(`source:${TEST_SHA}`);
  const archivePath = `/source/chooser-web-${TEST_SHA}.tar.gz`;
  const archiveSha256 = sha256(archive);
  await writeFile(join(dist, archivePath.slice(1)), archive);

  const legalArtifact = Buffer.from(
    `revision=${TEST_SHA}\nsource=https://example.test/chooser/commit/${TEST_SHA}\narchive=${archivePath}\n`,
  );
  const legalArtifactPath = "/settings/legal/index.html";
  const legalArtifactSha256 = sha256(legalArtifact);
  await writeFile(join(dist, legalArtifactPath.slice(1)), legalArtifact);
  for (const name of [
    "gpl-3.0.txt",
    "notice.txt",
    "third-party-notices.txt",
    "asset-provenance.txt",
  ]) {
    await writeFile(join(dist, "legal", name), `legal ${name}`);
  }
  await writeFile(join(dist, "app.js"), "console.log('chooser')");

  await writeFile(
    join(source, "source-approval.json"),
    JSON.stringify({
      schemaVersion: 1,
      status: sourceStatus,
      immutable: true,
      sourceUrl: `https://example.test/chooser/commit/${TEST_SHA}`,
      sourceRevision: TEST_SHA,
    }),
  );

  const distSha256 = await computeDirectoryDigest(dist);
  await writeFile(
    join(source, "release-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      license: "GPL-3.0-or-later",
      build: {
        buildId: TEST_SHA,
        commitSha: TEST_SHA,
        sourceDateEpoch: 1_700_000_000,
      },
      commitSha: TEST_SHA,
      source: {
        status: sourceStatus,
        sourceRevision: TEST_SHA,
        sourceUrl:
          sourceStatus === "approved"
            ? `https://example.test/chooser/commit/${TEST_SHA}`
            : "",
        archivePath,
        archiveSha256,
      },
      legal: {
        legalRevision: TEST_SHA,
        artifact: {
          path: legalArtifactPath,
          sha256: legalArtifactSha256,
        },
      },
      dist: {
        sha256: distSha256,
      },
    }),
  );

  return { root, dist };
}

function createCleanGitRunner() {
  return async (command, args) => {
    if (command === "git" && args[0] === "status") {
      return { stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "rev-parse") {
      return { stdout: `${TEST_SHA}\n`, stderr: "" };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "chooser-web-deploy-"));
  temporaryDirectories.push(directory);
  return directory;
}

function deploymentOutput() {
  return {
    type: "pages-deploy-detailed",
    version: 1,
    pages_project: "chooser-web",
    deployment_id: "deployment-id",
    url: "https://abc.chooser-web.pages.dev",
    alias: "https://chooser-web.pages.dev",
    environment: "production",
    production_branch: "main",
    deployment_trigger: { metadata: { commit_hash: TEST_SHA } },
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
