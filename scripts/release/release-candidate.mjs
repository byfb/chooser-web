// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  computeDirectoryDigest,
  createCorrespondingSourceArchive,
  getReleaseIdentity,
  PROJECT_ROOT,
  runIsolatedFrozenBuilds,
  runReleaseCommand,
  sha256,
  sourceArchiveName,
  validateSourceArchive,
} from "./artifacts.mjs";
import { validateStaticPwaRelease } from "../pwa/static-pwa-validator.mjs";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const RELEASE_LICENSE = "GPL-3.0-or-later";
export const SOURCE_APPROVAL_RELATIVE_PATH =
  ".artifacts/release/source-approval.json";
export const RELEASE_MANIFEST_RELATIVE_PATH =
  ".artifacts/release/release-manifest.json";
export const LEGAL_ARTIFACT_PATH = "/settings/legal/index.html";
export const LEGAL_DOCUMENT_PATHS = Object.freeze([
  "/legal/gpl-3.0.txt",
  "/legal/notice.txt",
  "/legal/third-party-notices.txt",
  "/legal/asset-provenance.txt",
]);

const FULL_SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_FILE_SYSTEM = Object.freeze({
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
});
const RELEASE_METADATA_FILE_NAMES = new Set([
  ".assetsignore",
  ".artifacts",
  "_redirects",
  "_routes.json",
  "_worker.js",
  "release-manifest.json",
  "source-approval.json",
  "wrangler.toml",
]);

/**
 * Error raised when a release candidate cannot be proven safe and
 * deterministic.  The error code is intentionally stable for local release
 * wrappers and tests; no mutating deployment command belongs in this module.
 */
export class ReleaseCandidateError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ReleaseCandidateError";
    this.code = code;
    this.details = options.details ?? {};
  }
}

/**
 * Build one deterministic, locally deployable release candidate.
 *
 * The default command/artifact boundaries execute the real Git, pnpm, tar,
 * gzip, and PWA validators. Tests and other local release tooling can inject
 * `runCommand`, `runBuilds`, `createArchive`, `validateArchive`, and
 * `validatePwa` without mocking application code or network services.
 */
export async function buildReleaseCandidate(options = {}) {
  const cwd = resolve(options.cwd ?? PROJECT_ROOT);
  const distDirectory = resolve(cwd, options.distDirectory ?? "dist");
  const manifestPath = resolve(
    cwd,
    options.manifestPath ?? RELEASE_MANIFEST_RELATIVE_PATH,
  );
  const sourceApprovalPath = resolve(
    cwd,
    options.sourceApprovalPath ?? SOURCE_APPROVAL_RELATIVE_PATH,
  );
  const fsApi = resolveFileSystem(options.fsApi ?? options.fileSystem);
  const runCommand = options.runCommand ?? runReleaseCommand;

  assertManifestOutsideDist(manifestPath, distDirectory);

  // Resolve identity before reading any release metadata or starting a build.
  // A dirty tree can otherwise make an approval and generated output describe
  // different source revisions.
  const identity = await getReleaseIdentity({ cwd, runCommand });
  const sourceApproval = await readSourceApproval({
    path: sourceApprovalPath,
    commitSha: identity.commitSha,
    fsApi,
  });
  const sourceArchiveFileName = sourceArchiveName(identity.commitSha);
  const sourceArchivePath = `/source/${sourceArchiveFileName}`;
  const sourceArchiveFile = join(distDirectory, sourceArchivePath.slice(1));
  const buildEnvironment = {
    ...(options.buildEnvironment ?? {}),
    CHOOSER_BUILD_ID: identity.commitSha,
    CHOOSER_SOURCE_STATUS: sourceApproval.status,
    CHOOSER_SOURCE_URL: sourceApproval.sourceUrl,
  };

  const runBuilds =
    options.runBuilds ?? options.buildRunner ?? runIsolatedFrozenBuilds;
  const buildResult = await runBuilds({
    cwd,
    commitSha: identity.commitSha,
    sourceDateEpoch: identity.sourceDateEpoch,
    distDirectory,
    buildCommand: options.buildCommand,
    installCommand: options.installCommand,
    runCommand,
    fsApi,
    buildEnvironment,
    keepBuilds: options.keepBuilds,
  });
  assertBuildResultIdentity(buildResult, identity);
  await assertDirectory(distDirectory, fsApi, "DIST_MISSING");

  const createArchive =
    options.createArchive ??
    options.createSourceArchive ??
    createCorrespondingSourceArchive;
  const archiveResult = await createArchive({
    cwd,
    outputPath: sourceArchiveFile,
    commitSha: identity.commitSha,
    sourceDateEpoch: identity.sourceDateEpoch,
    runCommand,
    fsApi,
    sourceEntries: options.sourceEntries,
    excludes: options.sourceExcludes,
  });
  const archiveBytes = await readFileChecked(
    fsApi,
    sourceArchiveFile,
    "SOURCE_ARCHIVE_MISSING",
  );
  const archiveSha256 = sha256(archiveBytes);
  if (
    archiveResult?.archiveSha256 &&
    archiveResult.archiveSha256 !== archiveSha256
  ) {
    throw new ReleaseCandidateError(
      "SOURCE_ARCHIVE_MISMATCH",
      "Generated source archive digest does not match its bytes",
      {
        details: {
          expected: archiveResult.archiveSha256,
          actual: archiveSha256,
        },
      },
    );
  }

  const validateArchive =
    options.validateArchive ??
    options.validateSourceArchiveArtifact ??
    validateSourceArchive;
  const validationResult = await validateArchive({
    cwd,
    archivePath: sourceArchiveFile,
    commitSha: identity.commitSha,
    sourceDateEpoch: identity.sourceDateEpoch,
    runCommand,
    fsApi,
    sourceEntries: options.sourceEntries,
    excludes: options.sourceExcludes,
  });
  if (validationResult?.valid === false) {
    throw new ReleaseCandidateError(
      "SOURCE_ARCHIVE_INVALID",
      "The generated source archive failed validation",
    );
  }
  if (
    validationResult?.archiveSha256 &&
    validationResult.archiveSha256 !== archiveSha256
  ) {
    throw new ReleaseCandidateError(
      "SOURCE_ARCHIVE_MISMATCH",
      "Validated source archive digest does not match its bytes",
      {
        details: {
          expected: validationResult.archiveSha256,
          actual: archiveSha256,
        },
      },
    );
  }

  await validateLegalRelease({
    distDirectory,
    commitSha: identity.commitSha,
    sourceUrl: sourceApproval.sourceUrl,
    sourceArchivePath,
    fsApi,
  });

  const validatePwa =
    options.validatePwa ??
    options.validatePwaRelease ??
    validateStaticPwaRelease;
  try {
    await validatePwa(distDirectory, {
      buildId: identity.commitSha,
      commitSha: identity.commitSha,
      sourceStatus: sourceApproval.status,
      sourceUrl: sourceApproval.sourceUrl,
      fsApi,
    });
  } catch (error) {
    if (error instanceof ReleaseCandidateError) {
      throw error;
    }
    throw new ReleaseCandidateError(
      "PWA_RELEASE_INVALID",
      "The generated dist does not satisfy the static PWA release contract",
      { cause: error },
    );
  }

  await assertNoReleaseMetadataInDist({
    distDirectory,
    sourceArchivePath: sourceArchivePath.slice(1),
    fsApi,
  });

  const distDigest = await computeDirectoryDigest(distDirectory, { fsApi });
  const legalArtifactFile = join(distDirectory, LEGAL_ARTIFACT_PATH.slice(1));
  const legalArtifactSha256 = sha256(
    await readFileChecked(fsApi, legalArtifactFile, "LEGAL_ARTIFACT_MISSING"),
  );
  const releaseManifest = createReleaseManifest({
    identity,
    sourceApproval,
    sourceArchivePath,
    archiveSha256,
    legalArtifactSha256,
    distDigest,
  });
  await fsApi.mkdir(dirname(manifestPath), { recursive: true });
  await fsApi.writeFile(
    manifestPath,
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    "utf8",
  );

  return {
    status: sourceApproval.status,
    commitSha: identity.commitSha,
    sourceDateEpoch: identity.sourceDateEpoch,
    source: {
      status: sourceApproval.status,
      sourceUrl: sourceApproval.sourceUrl,
      archivePath: sourceArchivePath,
      archiveSha256,
    },
    legal: {
      legalRevision: identity.commitSha,
      artifactPath: LEGAL_ARTIFACT_PATH,
      artifactSha256: legalArtifactSha256,
    },
    dist: {
      directory: distDirectory,
      digest: distDigest,
    },
    manifestPath,
    builds: buildResult?.builds ?? [],
  };
}

/**
 * Parse optional local approval metadata. A missing file is a pending
 * candidate. A present file must be structurally meaningful; approved source
 * can only use a query/hash-free HTTPS URL containing the exact full SHA.
 */
export async function readSourceApproval({
  path,
  commitSha,
  fsApi = DEFAULT_FILE_SYSTEM,
} = {}) {
  fsApi = resolveFileSystem(fsApi);
  assertFullSha(commitSha, "commit SHA");

  let source;
  try {
    const contents = await fsApi.readFile(path, "utf8");
    try {
      source = JSON.parse(contents);
    } catch (error) {
      throw new ReleaseCandidateError(
        "SOURCE_APPROVAL_INVALID",
        "Source approval metadata is not valid JSON",
        { cause: error },
      );
    }
  } catch (error) {
    if (isNotFound(error)) {
      return Object.freeze({ status: "pending", sourceUrl: "" });
    }
    if (error instanceof ReleaseCandidateError) {
      throw error;
    }
    throw new ReleaseCandidateError(
      "SOURCE_APPROVAL_READ_FAILED",
      "Source approval metadata could not be read",
      { cause: error },
    );
  }

  if (!isRecord(source)) {
    throw new ReleaseCandidateError(
      "SOURCE_APPROVAL_INVALID",
      "Source approval metadata must be a JSON object",
    );
  }
  if (
    source.schemaVersion !== undefined &&
    source.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION
  ) {
    throw new ReleaseCandidateError(
      "SOURCE_APPROVAL_INVALID",
      "Source approval metadata has an unsupported schema",
    );
  }

  const record = isRecord(source.source) ? source.source : source;
  const status = source.status ?? record.status;
  if (status === "pending") {
    return Object.freeze({ status, sourceUrl: "" });
  }
  if (status !== "approved") {
    throw new ReleaseCandidateError(
      "SOURCE_APPROVAL_INVALID",
      "Source approval status must be pending or approved",
    );
  }
  if (record.immutable !== true) {
    throw new ReleaseCandidateError(
      "SOURCE_APPROVAL_NOT_IMMUTABLE",
      "Approved source metadata must explicitly mark its URL immutable",
    );
  }

  const sourceUrl = record.sourceUrl ?? record.url;
  if (typeof sourceUrl !== "string" || sourceUrl.trim() === "") {
    throw new ReleaseCandidateError(
      "SOURCE_APPROVAL_INVALID",
      "Approved source metadata has no source URL",
    );
  }
  assertImmutableSourceUrl(sourceUrl, commitSha);

  const sourceRevision =
    record.sourceRevision ?? record.revision ?? record.commitSha;
  if (sourceRevision === undefined) {
    throw new ReleaseCandidateError(
      "SOURCE_APPROVAL_INVALID",
      "Approved source metadata must name the exact source revision",
    );
  }
  assertFullSha(sourceRevision, "source approval revision");
  if (sourceRevision.toLowerCase() !== commitSha.toLowerCase()) {
    throw new ReleaseCandidateError(
      "SOURCE_APPROVAL_INVALID",
      "Approved source revision does not match clean Git HEAD",
    );
  }

  return Object.freeze({
    status,
    sourceUrl,
  });
}

/**
 * Return the deterministic manifest shape consumed by local verification and
 * deployment tooling. It contains no generated-at timestamps or random IDs.
 */
export function createReleaseManifest({
  identity,
  sourceApproval,
  sourceArchivePath,
  archiveSha256,
  legalArtifactSha256,
  distDigest,
} = {}) {
  assertFullSha(identity?.commitSha, "commit SHA");
  assertSourceDateEpoch(identity?.sourceDateEpoch);
  assertSha256(archiveSha256, "source archive SHA-256");
  assertSha256(legalArtifactSha256, "Legal artifact SHA-256");
  assertSha256(distDigest, "dist SHA-256");
  if (!isRecord(sourceApproval)) {
    throw new ReleaseCandidateError(
      "SOURCE_APPROVAL_INVALID",
      "Source approval result is missing",
    );
  }

  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    license: RELEASE_LICENSE,
    build: {
      buildId: identity.commitSha,
      commitSha: identity.commitSha,
      sourceDateEpoch: identity.sourceDateEpoch,
    },
    commitSha: identity.commitSha,
    source: {
      status: sourceApproval.status,
      sourceRevision: identity.commitSha,
      sourceUrl: sourceApproval.sourceUrl,
      archivePath: sourceArchivePath,
      archiveSha256,
    },
    legal: {
      legalRevision: identity.commitSha,
      artifactPath: LEGAL_ARTIFACT_PATH,
      artifactSha256: legalArtifactSha256,
      artifact: {
        path: LEGAL_ARTIFACT_PATH,
        sha256: legalArtifactSha256,
      },
    },
    dist: {
      sha256: distDigest,
    },
  };
}

async function validateLegalRelease({
  distDirectory,
  commitSha,
  sourceUrl,
  sourceArchivePath,
  fsApi,
}) {
  const legalArtifactFile = join(distDirectory, LEGAL_ARTIFACT_PATH.slice(1));
  const legalArtifactBytes = await readFileChecked(
    fsApi,
    legalArtifactFile,
    "LEGAL_ARTIFACT_MISSING",
  );
  const legalArtifactText = Buffer.from(legalArtifactBytes).toString("utf8");
  const markers = [commitSha, sourceArchivePath];
  if (sourceUrl) {
    markers.push(sourceUrl);
  }
  for (const marker of markers) {
    if (!legalArtifactText.includes(marker)) {
      throw new ReleaseCandidateError(
        "LEGAL_IDENTITY_INVALID",
        `Legal artifact is missing release identity marker: ${marker}`,
      );
    }
  }

  for (const legalPath of LEGAL_DOCUMENT_PATHS) {
    await readFileChecked(
      fsApi,
      join(distDirectory, legalPath.slice(1)),
      "LEGAL_ARTIFACT_MISSING",
    );
  }
}

async function assertNoReleaseMetadataInDist({
  distDirectory,
  sourceArchivePath,
  fsApi,
}) {
  const files = await collectFiles(distDirectory, fsApi);
  const sourceFiles = files.filter(
    (pathname) =>
      pathname === sourceArchivePath || pathname.startsWith("source/"),
  );
  if (sourceFiles.length !== 1 || sourceFiles[0] !== sourceArchivePath) {
    throw new ReleaseCandidateError(
      "SOURCE_DIRECTORY_INVALID",
      "dist/source must contain only the exact release source archive",
    );
  }

  for (const pathname of files) {
    if (pathname === sourceArchivePath) {
      continue;
    }
    const parts = pathname.split("/");
    if (
      parts.some((part) => RELEASE_METADATA_FILE_NAMES.has(part)) ||
      parts.includes("release")
    ) {
      throw new ReleaseCandidateError(
        "RELEASE_METADATA_IN_DIST",
        `dist contains release metadata control: ${pathname}`,
      );
    }
  }
}

async function collectFiles(rootDirectory, fsApi, prefix = "") {
  const names = await fsApi.readdir(join(rootDirectory, prefix));
  const files = [];
  for (const name of [...names].sort(compareStrings)) {
    const pathname = prefix ? `${prefix}/${name}` : name;
    const absolutePath = join(rootDirectory, pathname);
    const entry = await fsApi.lstat(absolutePath);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(rootDirectory, fsApi, pathname)));
    } else if (entry.isFile()) {
      files.push(pathname);
    } else {
      throw new ReleaseCandidateError(
        "DIST_ENTRY_INVALID",
        `dist contains an unsupported filesystem entry: ${pathname}`,
      );
    }
  }
  return files;
}

function assertBuildResultIdentity(buildResult, identity) {
  if (!buildResult || typeof buildResult !== "object") {
    return;
  }
  if (
    buildResult.commitSha !== undefined &&
    buildResult.commitSha !== identity.commitSha
  ) {
    throw new ReleaseCandidateError(
      "BUILD_IDENTITY_MISMATCH",
      "Isolated build result does not match clean Git HEAD",
    );
  }
  if (
    buildResult.sourceDateEpoch !== undefined &&
    buildResult.sourceDateEpoch !== identity.sourceDateEpoch
  ) {
    throw new ReleaseCandidateError(
      "BUILD_IDENTITY_MISMATCH",
      "Isolated build SOURCE_DATE_EPOCH does not match clean Git HEAD",
    );
  }
}

function assertManifestOutsideDist(manifestPath, distDirectory) {
  const manifestRelativePath = relative(distDirectory, manifestPath);
  if (
    manifestRelativePath === "" ||
    (!manifestRelativePath.startsWith(`..${sep}`) &&
      manifestRelativePath !== "..")
  ) {
    throw new ReleaseCandidateError(
      "RELEASE_MANIFEST_PATH_INVALID",
      "Release manifest must be written outside the deployable dist directory",
    );
  }
}

async function assertDirectory(path, fsApi, code) {
  try {
    const entry = await fsApi.lstat(path);
    if (!entry.isDirectory()) {
      throw new Error("path is not a directory");
    }
  } catch (error) {
    throw new ReleaseCandidateError(
      code,
      `Required release directory is unavailable: ${path}`,
      { cause: error },
    );
  }
}

async function readFileChecked(fsApi, path, code) {
  try {
    return await fsApi.readFile(path);
  } catch (error) {
    throw new ReleaseCandidateError(
      code,
      `Required release file is unavailable: ${path}`,
      { cause: error },
    );
  }
}

function assertImmutableSourceUrl(sourceUrl, commitSha) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch (error) {
    throw new ReleaseCandidateError(
      "SOURCE_APPROVAL_INVALID",
      "Approved source URL is not a valid URL",
      { cause: error },
    );
  }
  if (parsed.protocol !== "https:" || parsed.search || parsed.hash) {
    throw new ReleaseCandidateError(
      "SOURCE_APPROVAL_NOT_IMMUTABLE",
      "Approved source URL must be HTTPS without query or hash mutability",
    );
  }
  if (!sourceUrl.toLowerCase().includes(commitSha.toLowerCase())) {
    throw new ReleaseCandidateError(
      "SOURCE_APPROVAL_NOT_IMMUTABLE",
      "Approved source URL must contain the exact full commit SHA",
    );
  }
}

function assertFullSha(value, label) {
  if (typeof value !== "string" || !FULL_SHA_PATTERN.test(value)) {
    throw new ReleaseCandidateError(
      "RELEASE_IDENTITY_INVALID",
      `${label} must be a full lowercase Git commit SHA`,
    );
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new ReleaseCandidateError(
      "RELEASE_DIGEST_INVALID",
      `${label} must be a 64-character SHA-256 digest`,
    );
  }
}

function assertSourceDateEpoch(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReleaseCandidateError(
      "SOURCE_DATE_EPOCH_INVALID",
      "SOURCE_DATE_EPOCH must be a non-negative safe integer",
    );
  }
}

function resolveFileSystem(fsApi) {
  return { ...DEFAULT_FILE_SYSTEM, ...(fsApi ?? {}) };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(error) {
  return error?.code === "ENOENT";
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
