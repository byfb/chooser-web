// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const SOURCE_ARCHIVE_PREFIX = "chooser-web-";
export const SOURCE_ARCHIVE_SUFFIX = ".tar.gz";

/**
 * These paths are not preferred source. They are build output, local state,
 * or machine metadata and therefore must never enter Corresponding Source.
 */
export const DEFAULT_SOURCE_EXCLUDES = Object.freeze([
  ".git",
  ".astro",
  ".artifacts",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);

const MACHINE_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

const MACHINE_FILE_PATTERNS = [
  /^\.env(?:\.|$)/u,
  /(?:^|[-_])(debug|error)\.log$/iu,
  /^pnpm-debug\.log$/u,
  /^npm-debug\.log$/u,
  /^yarn-(?:debug|error)\.log$/u,
];

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_EXECUTABLE_MODE = 0o755;
const DEFAULT_DIRECTORY_MODE = 0o755;
const DEFAULT_SYMLINK_MODE = 0o777;
const TAR_BLOCK_SIZE = 512;
const MAX_ARCHIVE_OUTPUT_BYTES = 512 * 1024 * 1024;
const FULL_SHA_PATTERN = /^[0-9a-f]{40,64}$/u;

const defaultFileSystem = Object.freeze({
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
});

export class ReleaseArtifactError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ReleaseArtifactError";
    this.code = code;
  }
}

/**
 * Run a release command without a shell. Keeping this small makes command
 * execution an injectable boundary in tests and prevents release arguments
 * from being interpreted as shell syntax.
 */
export async function runReleaseCommand(
  command,
  args,
  {
    cwd = PROJECT_ROOT,
    env,
    encoding = "utf8",
    maxBuffer = 16 * 1024 * 1024,
  } = {},
) {
  return execFileAsync(command, args, {
    cwd,
    encoding,
    env,
    maxBuffer,
  });
}

/**
 * Read the one commit that is eligible to become a release. Any worktree
 * status output, abbreviated object name, invalid timestamp, or command
 * failure stops the operation before it can create an artifact.
 */
export async function getReleaseIdentity({
  cwd = PROJECT_ROOT,
  runCommand = runReleaseCommand,
} = {}) {
  const statusResult = await runCommand(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd, encoding: "utf8" },
  );
  const status = readCommandText(statusResult.stdout);
  if (status.trim() !== "") {
    throw new ReleaseArtifactError(
      "GIT_TREE_DIRTY",
      "The release requires a clean Git worktree",
    );
  }

  const shaResult = await runCommand(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { cwd, encoding: "utf8" },
  );
  const commitSha = parseSingleLine(readCommandText(shaResult.stdout));
  assertFullCommitSha(commitSha);

  const epochResult = await runCommand(
    "git",
    ["show", "-s", "--format=%ct", commitSha],
    { cwd, encoding: "utf8" },
  );
  const sourceDateEpoch = parseSourceDateEpoch(
    readCommandText(epochResult.stdout),
  );

  return { commitSha, sourceDateEpoch };
}

/**
 * Compute a stable SHA-256 tree identity from relative POSIX paths and file
 * bytes. Directory order and filesystem metadata are deliberately ignored;
 * the digest describes the bytes that can be uploaded.
 */
export async function computeDirectoryDigest(
  rootDirectory,
  { fsApi = defaultFileSystem, ignorePath = () => false } = {},
) {
  fsApi = resolveFileSystem(fsApi);
  const entries = await collectDirectoryEntries({
    rootDirectory,
    fsApi,
    ignorePath,
  });
  return sha256(serializeDirectoryEntries(entries));
}

export async function compareDirectoryTrees(
  leftDirectory,
  rightDirectory,
  { fsApi = defaultFileSystem, ignorePath = () => false } = {},
) {
  fsApi = resolveFileSystem(fsApi);
  const [left, right] = await Promise.all([
    collectDirectoryEntries({
      rootDirectory: leftDirectory,
      fsApi,
      ignorePath,
    }),
    collectDirectoryEntries({
      rootDirectory: rightDirectory,
      fsApi,
      ignorePath,
    }),
  ]);
  const leftDigest = sha256(serializeDirectoryEntries(left));
  const rightDigest = sha256(serializeDirectoryEntries(right));
  const differences = diffDirectoryEntries(left, right);
  return {
    equal: differences.length === 0,
    leftDigest,
    rightDigest,
    differences,
  };
}

export async function assertDirectoryByteIdentical(
  leftDirectory,
  rightDirectory,
  options = {},
) {
  const comparison = await compareDirectoryTrees(
    leftDirectory,
    rightDirectory,
    options,
  );
  if (!comparison.equal) {
    throw new ReleaseArtifactError(
      "DIRECTORIES_DIFFER",
      `Release directories differ: ${comparison.differences
        .slice(0, 5)
        .join(", ")}`,
    );
  }
  return comparison;
}

export function sourceArchiveName(commitSha) {
  assertFullCommitSha(commitSha);
  return `${SOURCE_ARCHIVE_PREFIX}${commitSha}${SOURCE_ARCHIVE_SUFFIX}`;
}

export function isExcludedSourcePath(
  pathname,
  excludes = DEFAULT_SOURCE_EXCLUDES,
) {
  const normalized = normalizeRelativePath(pathname);
  const segments = normalized.split("/");
  if (
    segments.some((segment) =>
      excludes.some((excluded) => segment === normalizeRelativePath(excluded)),
    )
  ) {
    return true;
  }
  const fileName = segments.at(-1) ?? "";
  return (
    MACHINE_FILE_NAMES.has(fileName) ||
    MACHINE_FILE_PATTERNS.some((pattern) => pattern.test(fileName))
  );
}

/**
 * Generate a normalized Corresponding Source archive for one exact commit.
 * Git supplies the committed tree; the tar bytes are then rewritten into a
 * small canonical USTAR representation before system gzip creates the final
 * archive. This avoids inheriting checkout permissions, owner names, clock
 * time, or gzip filenames from the machine running the release.
 */
export async function createCorrespondingSourceArchive({
  cwd = PROJECT_ROOT,
  outputPath,
  commitSha,
  sourceDateEpoch,
  sourceEntries,
  excludes = DEFAULT_SOURCE_EXCLUDES,
  runCommand = runReleaseCommand,
  fsApi = defaultFileSystem,
  ensureClean = true,
} = {}) {
  fsApi = resolveFileSystem(fsApi);
  if (!outputPath) {
    throw new ReleaseArtifactError(
      "ARCHIVE_OUTPUT_MISSING",
      "A Corresponding Source archive output path is required",
    );
  }

  let identity;
  if (ensureClean) {
    identity = await getReleaseIdentity({ cwd, runCommand });
    if (commitSha !== undefined && commitSha !== identity.commitSha) {
      throw new ReleaseArtifactError(
        "COMMIT_MISMATCH",
        `Requested source commit ${commitSha} does not match clean HEAD ${identity.commitSha}`,
      );
    }
    if (
      sourceDateEpoch !== undefined &&
      sourceDateEpoch !== identity.sourceDateEpoch
    ) {
      throw new ReleaseArtifactError(
        "SOURCE_DATE_EPOCH_MISMATCH",
        "SOURCE_DATE_EPOCH does not match the clean commit timestamp",
      );
    }
    commitSha = identity.commitSha;
    sourceDateEpoch = identity.sourceDateEpoch;
  }

  assertFullCommitSha(commitSha);
  assertSourceDateEpoch(sourceDateEpoch);

  const archiveName = sourceArchiveName(commitSha);
  if (basename(outputPath) !== archiveName) {
    throw new ReleaseArtifactError(
      "ARCHIVE_NAME_MISMATCH",
      `Source archive must be named ${archiveName}`,
    );
  }

  const entries = await resolveSourceEntries({
    cwd,
    commitSha,
    sourceEntries,
    excludes,
    runCommand,
  });
  if (entries.length === 0) {
    throw new ReleaseArtifactError(
      "SOURCE_EMPTY",
      "Corresponding Source cannot be created from an empty preferred source tree",
    );
  }

  const prefix = `${SOURCE_ARCHIVE_PREFIX}${commitSha}/`;
  const archiveResult = await runCommand(
    "git",
    ["archive", "--format=tar", `--prefix=${prefix}`, commitSha],
    { cwd, encoding: "buffer", maxBuffer: MAX_ARCHIVE_OUTPUT_BYTES },
  );
  const rawTar = readCommandBuffer(archiveResult.stdout);
  if (rawTar.length === 0) {
    throw new ReleaseArtifactError(
      "SOURCE_ARCHIVE_EMPTY",
      "git archive returned no bytes",
    );
  }

  const canonicalTar = canonicalizeTarArchive(rawTar, {
    prefix,
    sourceEntries: entries,
    sourceDateEpoch,
  });
  const compressed = await gzipTarBuffer({
    tarBuffer: canonicalTar,
    cwd,
    runCommand,
    fsApi,
  });

  await fsApi.mkdir(dirname(outputPath), { recursive: true });
  await fsApi.writeFile(outputPath, compressed);

  return {
    archiveName,
    archivePath: outputPath,
    archiveSha256: sha256(compressed),
    tarSha256: sha256(canonicalTar),
    commitSha,
    sourceDateEpoch,
    sourceEntries: entries,
  };
}

/**
 * Validate the full source identity and byte content of an existing archive.
 * The expected tar is regenerated from the exact Git commit and compared as
 * canonical bytes, so a valid filename alone can never pass this gate.
 */
export async function validateSourceArchive({
  cwd = PROJECT_ROOT,
  archivePath,
  commitSha,
  sourceDateEpoch,
  sourceEntries,
  excludes = DEFAULT_SOURCE_EXCLUDES,
  runCommand = runReleaseCommand,
  fsApi = defaultFileSystem,
  ensureClean = true,
} = {}) {
  fsApi = resolveFileSystem(fsApi);
  if (!archivePath) {
    throw new ReleaseArtifactError(
      "ARCHIVE_INPUT_MISSING",
      "A Corresponding Source archive path is required",
    );
  }

  if (ensureClean) {
    const identity = await getReleaseIdentity({ cwd, runCommand });
    if (commitSha !== undefined && commitSha !== identity.commitSha) {
      throw new ReleaseArtifactError(
        "COMMIT_MISMATCH",
        `Archive commit ${commitSha} does not match clean HEAD ${identity.commitSha}`,
      );
    }
    if (
      sourceDateEpoch !== undefined &&
      sourceDateEpoch !== identity.sourceDateEpoch
    ) {
      throw new ReleaseArtifactError(
        "SOURCE_DATE_EPOCH_MISMATCH",
        "Archive SOURCE_DATE_EPOCH does not match the clean commit timestamp",
      );
    }
    commitSha = identity.commitSha;
    sourceDateEpoch = identity.sourceDateEpoch;
  }

  assertFullCommitSha(commitSha);
  assertSourceDateEpoch(sourceDateEpoch);
  const archiveName = sourceArchiveName(commitSha);
  if (basename(archivePath) !== archiveName) {
    throw new ReleaseArtifactError(
      "ARCHIVE_NAME_MISMATCH",
      `Source archive must be named ${archiveName}`,
    );
  }

  const entries = await resolveSourceEntries({
    cwd,
    commitSha,
    sourceEntries,
    excludes,
    runCommand,
  });
  const compressed = readCommandBuffer(await fsApi.readFile(archivePath));
  assertNormalizedGzipHeader(compressed);
  let actualTar;
  try {
    actualTar = gunzipSync(compressed);
  } catch (error) {
    throw new ReleaseArtifactError(
      "ARCHIVE_GZIP_INVALID",
      "Corresponding Source is not a valid gzip stream",
      { cause: error },
    );
  }

  const prefix = `${SOURCE_ARCHIVE_PREFIX}${commitSha}/`;
  const actualEntries = parseTarArchive(actualTar);
  validateCanonicalTarEntries(actualEntries, {
    prefix,
    sourceEntries: entries,
    sourceDateEpoch,
  });

  const archiveResult = await runCommand(
    "git",
    ["archive", "--format=tar", `--prefix=${prefix}`, commitSha],
    { cwd, encoding: "buffer", maxBuffer: MAX_ARCHIVE_OUTPUT_BYTES },
  );
  const expectedTar = canonicalizeTarArchive(
    readCommandBuffer(archiveResult.stdout),
    {
      prefix,
      sourceEntries: entries,
      sourceDateEpoch,
    },
  );
  if (!actualTar.equals(expectedTar)) {
    throw new ReleaseArtifactError(
      "ARCHIVE_CONTENT_MISMATCH",
      "Corresponding Source contents do not match the exact Git commit",
    );
  }

  return {
    valid: true,
    archiveName,
    archivePath,
    archiveSha256: sha256(compressed),
    tarSha256: sha256(actualTar),
    commitSha,
    sourceDateEpoch,
    sourceEntries: entries,
  };
}

/**
 * Rewrite a Git-generated tar stream to deterministic USTAR bytes. This pure
 * function is also the test seam for archive ordering and metadata.
 */
export function canonicalizeTarArchive(
  rawTar,
  { prefix, sourceEntries, sourceDateEpoch } = {},
) {
  if (!prefix || !prefix.endsWith("/")) {
    throw new ReleaseArtifactError(
      "ARCHIVE_PREFIX_INVALID",
      "A slash-terminated source archive prefix is required",
    );
  }
  assertSourceDateEpoch(sourceDateEpoch);
  const expectedPaths = expectedArchivePaths(prefix, sourceEntries);
  const parsed = parseTarArchive(readCommandBuffer(rawTar));
  const selected = new Map();

  for (const entry of parsed) {
    if (entry.type === "pax-global" || entry.type === "pax") {
      continue;
    }
    const path = normalizeArchiveEntryPath(entry);
    if (!expectedPaths.has(path)) {
      continue;
    }
    if (selected.has(path)) {
      throw new ReleaseArtifactError(
        "ARCHIVE_DUPLICATE_PATH",
        `Source archive contains duplicate path ${path}`,
      );
    }
    selected.set(path, entry);
  }

  for (const path of expectedPaths) {
    if (path === prefix || selected.has(path)) {
      continue;
    }
    if (path.endsWith("/")) {
      selected.set(path, {
        path,
        type: "directory",
        mode: DEFAULT_DIRECTORY_MODE,
        uid: 0,
        gid: 0,
        mtime: sourceDateEpoch,
        data: Buffer.alloc(0),
        linkname: "",
      });
      continue;
    }
    throw new ReleaseArtifactError(
      "ARCHIVE_MISSING_PATH",
      `git archive did not contain preferred source path ${path.slice(prefix.length)}`,
    );
  }

  const canonicalEntries = [...selected.entries()]
    .sort(([left], [right]) => compareByteStrings(left, right))
    .map(([, entry]) => normalizeTarEntry(entry, sourceDateEpoch));
  return encodeTarArchive(canonicalEntries, sourceDateEpoch);
}

export function parseTarArchive(tarBuffer) {
  const buffer = readCommandBuffer(tarBuffer);
  if (buffer.length < TAR_BLOCK_SIZE * 2) {
    throw new ReleaseArtifactError(
      "ARCHIVE_TAR_INVALID",
      "A tar archive must contain at least two end blocks",
    );
  }
  const entries = [];
  let offset = 0;
  let pendingPax = null;

  while (offset + TAR_BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const rawType = String.fromCharCode(header[156] || 0);
    const headerSize = parseTarNumber(header.subarray(124, 136));
    const dataEnd = offset + headerSize;
    const paddedEnd = offset + roundUpTarSize(headerSize);
    if (dataEnd > buffer.length || paddedEnd > buffer.length) {
      throw new ReleaseArtifactError(
        "ARCHIVE_TAR_TRUNCATED",
        "Tar entry extends beyond the archive boundary",
      );
    }
    const data = Buffer.from(buffer.subarray(offset, dataEnd));
    offset = paddedEnd;

    const rawPath = joinTarPath(
      decodeTarString(header.subarray(345, 500)),
      decodeTarString(header.subarray(0, 100)),
    );
    if (rawType === "g") {
      parsePaxData(data);
      entries.push({
        path: rawPath,
        type: "pax-global",
        mode: parseTarNumber(header.subarray(100, 108)),
        uid: parseTarNumber(header.subarray(108, 116)),
        gid: parseTarNumber(header.subarray(116, 124)),
        mtime: parseTarNumber(header.subarray(136, 148)),
        data,
        linkname: "",
      });
      continue;
    }
    if (rawType === "x") {
      const paxValues = parsePaxData(data);
      pendingPax = paxValues;
      entries.push({
        path: rawPath,
        type: "pax",
        mode: parseTarNumber(header.subarray(100, 108)),
        uid: parseTarNumber(header.subarray(108, 116)),
        gid: parseTarNumber(header.subarray(116, 124)),
        mtime: parseTarNumber(header.subarray(136, 148)),
        data,
        linkname: "",
      });
      continue;
    }

    const type = tarType(rawType);
    const path = pendingPax?.path ?? rawPath;
    const size = pendingPax?.size ?? headerSize;
    if (size !== headerSize) {
      throw new ReleaseArtifactError(
        "ARCHIVE_TAR_PAX_UNSUPPORTED",
        "PAX size overrides are not supported in release source archives",
      );
    }
    const entry = {
      path,
      type,
      mode: parseTarNumber(header.subarray(100, 108)),
      uid: parseTarNumber(header.subarray(108, 116)),
      gid: parseTarNumber(header.subarray(116, 124)),
      mtime: pendingPax?.mtime ?? parseTarNumber(header.subarray(136, 148)),
      data,
      linkname: decodeTarString(header.subarray(157, 257)),
    };
    entries.push(entry);
    pendingPax = null;
  }

  if (offset > buffer.length || entries.length === 0) {
    throw new ReleaseArtifactError(
      "ARCHIVE_TAR_INVALID",
      "Tar archive contains no readable entries",
    );
  }
  return entries;
}

/**
 * Run two clean, frozen-lockfile builds in isolated directories and compare
 * both their static output and source archive bytes. The first output is
 * atomically promoted to the requested canonical dist only after equality is
 * proven.
 */
export async function runIsolatedFrozenBuilds({
  cwd = PROJECT_ROOT,
  commitSha,
  sourceDateEpoch,
  distDirectory = join(cwd, "dist"),
  buildCommand = ["pnpm", "exec", "astro", "build"],
  installCommand = ["pnpm", "install", "--frozen-lockfile"],
  runCommand = runReleaseCommand,
  fsApi = defaultFileSystem,
  keepBuilds = false,
  buildEnvironment = {},
} = {}) {
  fsApi = resolveFileSystem(fsApi);
  const identity = await getReleaseIdentity({ cwd, runCommand });
  if (commitSha !== undefined && commitSha !== identity.commitSha) {
    throw new ReleaseArtifactError(
      "COMMIT_MISMATCH",
      "Isolated build commit does not match clean HEAD",
    );
  }
  if (
    sourceDateEpoch !== undefined &&
    sourceDateEpoch !== identity.sourceDateEpoch
  ) {
    throw new ReleaseArtifactError(
      "SOURCE_DATE_EPOCH_MISMATCH",
      "Isolated build SOURCE_DATE_EPOCH does not match clean HEAD",
    );
  }
  commitSha = identity.commitSha;
  sourceDateEpoch = identity.sourceDateEpoch;

  const buildRoot = await fsApi.mkdtemp(join(tmpdir(), "chooser-build-"));
  const buildResults = [];
  try {
    for (const index of [1, 2]) {
      const isolatedRoot = join(buildRoot, `build-${index}`);
      await fsApi.mkdir(isolatedRoot, { recursive: true });
      await materializeCommitWorkspace({
        cwd,
        targetDirectory: isolatedRoot,
        commitSha,
        runCommand,
        fsApi,
      });

      const env = {
        ...process.env,
        ...buildEnvironment,
        CHOOSER_BUILD_ID: commitSha,
        SOURCE_DATE_EPOCH: String(sourceDateEpoch),
        TZ: "UTC",
        LANG: "C",
        LC_ALL: "C",
        NODE_ENV: "production",
      };
      await runCommand(installCommand[0], installCommand.slice(1), {
        cwd: isolatedRoot,
        env,
        encoding: "utf8",
      });
      await runCommand(buildCommand[0], buildCommand.slice(1), {
        cwd: isolatedRoot,
        env,
        encoding: "utf8",
      });

      const isolatedDist = join(isolatedRoot, "dist");
      await assertDirectoryExists(isolatedDist, fsApi);
      const archivePath = join(isolatedRoot, sourceArchiveName(commitSha));
      const sourceArchive = await createCorrespondingSourceArchive({
        cwd,
        outputPath: archivePath,
        commitSha,
        sourceDateEpoch,
        runCommand,
        fsApi,
      });
      buildResults.push({
        index,
        isolatedRoot,
        distDirectory: isolatedDist,
        archivePath,
        distDigest: await computeDirectoryDigest(isolatedDist, { fsApi }),
        archiveSha256: sourceArchive.archiveSha256,
      });
    }

    const distComparison = await assertDirectoryByteIdentical(
      buildResults[0].distDirectory,
      buildResults[1].distDirectory,
      { fsApi },
    );
    const archiveA = readCommandBuffer(
      await fsApi.readFile(buildResults[0].archivePath),
    );
    const archiveB = readCommandBuffer(
      await fsApi.readFile(buildResults[1].archivePath),
    );
    if (!archiveA.equals(archiveB)) {
      throw new ReleaseArtifactError(
        "ARCHIVES_DIFFER",
        "Isolated builds produced different Corresponding Source archives",
      );
    }

    const canonical = await materializeCanonicalDist({
      sourceDist: buildResults[0].distDirectory,
      destinationDist: distDirectory,
      fsApi,
    });
    return {
      commitSha,
      sourceDateEpoch,
      distDirectory,
      distDigest: distComparison.leftDigest,
      archiveName: sourceArchiveName(commitSha),
      archiveSha256: sha256(archiveA),
      builds: buildResults.map(({ index, distDigest, archiveSha256 }) => ({
        index,
        distDigest,
        archiveSha256,
      })),
      materialized: canonical,
    };
  } finally {
    if (!keepBuilds) {
      await fsApi.rm(buildRoot, { recursive: true, force: true });
    }
  }
}

/**
 * Materialize a verified dist without exposing a partially copied tree. The
 * staging and backup names are digest-derived, so they cannot affect the
 * release identity or introduce wall-clock/random values into output.
 */
export async function materializeCanonicalDist({
  sourceDist,
  destinationDist,
  fsApi = defaultFileSystem,
} = {}) {
  fsApi = resolveFileSystem(fsApi);
  if (
    !sourceDist ||
    !destinationDist ||
    resolve(sourceDist) === resolve(destinationDist)
  ) {
    throw new ReleaseArtifactError(
      "DIST_PATH_INVALID",
      "Source and destination dist paths must be distinct",
    );
  }
  await assertDirectoryExists(sourceDist, fsApi);
  const sourceDigest = await computeDirectoryDigest(sourceDist, { fsApi });
  const stagingDist = `${destinationDist}.staging-${sourceDigest}`;
  const backupDist = `${destinationDist}.previous-${sourceDigest}`;
  if (
    (await pathExists(stagingDist, fsApi)) ||
    (await pathExists(backupDist, fsApi))
  ) {
    throw new ReleaseArtifactError(
      "DIST_STAGING_EXISTS",
      "A digest-matched canonical dist staging path already exists",
    );
  }

  try {
    await fsApi.cp(sourceDist, stagingDist, { recursive: true, force: false });
    const stagedDigest = await computeDirectoryDigest(stagingDist, { fsApi });
    if (stagedDigest !== sourceDigest) {
      throw new ReleaseArtifactError(
        "DIST_DIGEST_MISMATCH",
        "Verified dist bytes changed while staging the canonical tree",
      );
    }
  } catch (error) {
    if (await pathExists(stagingDist, fsApi)) {
      await fsApi.rm(stagingDist, { recursive: true, force: true });
    }
    if (error instanceof ReleaseArtifactError) {
      throw error;
    }
    throw new ReleaseArtifactError(
      "DIST_MATERIALIZE_FAILED",
      "Could not stage the verified dist atomically",
      { cause: error },
    );
  }

  let movedPrevious = false;
  try {
    if (await pathExists(destinationDist, fsApi)) {
      await fsApi.rename(destinationDist, backupDist);
      movedPrevious = true;
    }
    await fsApi.rename(stagingDist, destinationDist);
  } catch (error) {
    if (await pathExists(stagingDist, fsApi)) {
      await fsApi.rm(stagingDist, { recursive: true, force: true });
    }
    if (movedPrevious && !(await pathExists(destinationDist, fsApi))) {
      await fsApi.rename(backupDist, destinationDist);
    }
    throw new ReleaseArtifactError(
      "DIST_MATERIALIZE_FAILED",
      "Could not promote the verified dist atomically",
      { cause: error },
    );
  }

  let destinationDigest;
  try {
    destinationDigest = await computeDirectoryDigest(destinationDist, {
      fsApi,
    });
    if (destinationDigest !== sourceDigest) {
      throw new ReleaseArtifactError(
        "DIST_DIGEST_MISMATCH",
        "Canonical dist changed while it was being materialized",
      );
    }
  } catch (error) {
    if (await pathExists(destinationDist, fsApi)) {
      await fsApi.rm(destinationDist, { recursive: true, force: true });
    }
    if (movedPrevious && (await pathExists(backupDist, fsApi))) {
      await fsApi.rename(backupDist, destinationDist);
    }
    if (error instanceof ReleaseArtifactError) {
      throw error;
    }
    throw new ReleaseArtifactError(
      "DIST_MATERIALIZE_FAILED",
      "Could not validate the materialized canonical dist",
      { cause: error },
    );
  }
  if (movedPrevious) {
    await fsApi.rm(backupDist, { recursive: true, force: true });
  }
  return {
    destinationDist,
    digest: destinationDigest,
  };
}

export async function materializeCommitWorkspace({
  cwd = PROJECT_ROOT,
  targetDirectory,
  commitSha,
  runCommand = runReleaseCommand,
  fsApi = defaultFileSystem,
} = {}) {
  fsApi = resolveFileSystem(fsApi);
  assertFullCommitSha(commitSha);
  if (!targetDirectory) {
    throw new ReleaseArtifactError(
      "WORKSPACE_PATH_MISSING",
      "An isolated workspace directory is required",
    );
  }
  const temporaryTarDirectory = await fsApi.mkdtemp(
    join(tmpdir(), "chooser-source-tree-"),
  );
  const archivePath = join(temporaryTarDirectory, "tree.tar");
  try {
    const archiveResult = await runCommand(
      "git",
      ["archive", "--format=tar", "--prefix=source/", commitSha],
      { cwd, encoding: "buffer", maxBuffer: MAX_ARCHIVE_OUTPUT_BYTES },
    );
    const rawTar = readCommandBuffer(archiveResult.stdout);
    if (rawTar.length === 0) {
      throw new ReleaseArtifactError(
        "SOURCE_TREE_EMPTY",
        "git archive returned no isolated build source",
      );
    }
    await fsApi.writeFile(archivePath, rawTar);
    await runCommand(
      "tar",
      ["-xf", archivePath, "-C", targetDirectory, "--strip-components=1"],
      { cwd, encoding: "utf8" },
    );
  } finally {
    await fsApi.rm(temporaryTarDirectory, { recursive: true, force: true });
  }
  return targetDirectory;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveFileSystem(fsApi) {
  return { ...defaultFileSystem, ...(fsApi ?? {}) };
}

function readCommandText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function readCommandBuffer(value) {
  if (value === undefined || value === null) {
    return Buffer.alloc(0);
  }
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function parseSingleLine(value) {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    throw new ReleaseArtifactError(
      "GIT_OUTPUT_INVALID",
      "Git did not return one unambiguous release identity value",
    );
  }
  return lines[0];
}

function parseSourceDateEpoch(value) {
  const parsed = Number.parseInt(parseSingleLine(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ReleaseArtifactError(
      "SOURCE_DATE_EPOCH_INVALID",
      "Git commit timestamp is not a non-negative safe integer",
    );
  }
  return parsed;
}

function assertFullCommitSha(commitSha) {
  if (typeof commitSha !== "string" || !FULL_SHA_PATTERN.test(commitSha)) {
    throw new ReleaseArtifactError(
      "COMMIT_SHA_INVALID",
      "A full lower-case Git commit SHA is required",
    );
  }
}

function assertSourceDateEpoch(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReleaseArtifactError(
      "SOURCE_DATE_EPOCH_INVALID",
      "SOURCE_DATE_EPOCH must be a non-negative safe integer",
    );
  }
}

function normalizeRelativePath(pathname) {
  if (typeof pathname !== "string" || pathname.length === 0) {
    throw new ReleaseArtifactError(
      "SOURCE_PATH_INVALID",
      "Source paths must be non-empty strings",
    );
  }
  const normalized = pathname.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new ReleaseArtifactError(
      "SOURCE_PATH_INVALID",
      `Unsafe relative source path: ${pathname}`,
    );
  }
  return normalized;
}

function normalizeArchivePath(pathname) {
  if (typeof pathname !== "string" || pathname.length === 0) {
    throw new ReleaseArtifactError(
      "ARCHIVE_PATH_INVALID",
      "Archive entries must have non-empty paths",
    );
  }
  const normalized = pathname.replaceAll("\\", "/");
  const hasTrailingSlash = normalized.endsWith("/");
  const pathWithoutTrailingSlash = hasTrailingSlash
    ? normalized.slice(0, -1)
    : normalized;
  if (
    pathWithoutTrailingSlash.startsWith("/") ||
    pathWithoutTrailingSlash.includes("\0") ||
    pathWithoutTrailingSlash
      .split("/")
      .some((segment) => segment === ".." || segment === "")
  ) {
    throw new ReleaseArtifactError(
      "ARCHIVE_PATH_INVALID",
      `Unsafe archive path: ${pathname}`,
    );
  }
  return `${pathWithoutTrailingSlash}${hasTrailingSlash ? "/" : ""}`;
}

async function resolveSourceEntries({
  cwd,
  commitSha,
  sourceEntries,
  excludes,
  runCommand,
}) {
  const rawEntries =
    sourceEntries ??
    parseNulSeparatedPaths(
      readCommandText(
        (
          await runCommand(
            "git",
            ["ls-tree", "-r", "-z", "--name-only", "--full-tree", commitSha],
            { cwd, encoding: "buffer" },
          )
        ).stdout,
      ),
    );
  const entries = rawEntries
    .map((entry) => normalizeRelativePath(entry))
    .filter((entry) => !isExcludedSourcePath(entry, excludes));
  const unique = [...new Set(entries)].sort(compareByteStrings);
  if (unique.length !== entries.length) {
    throw new ReleaseArtifactError(
      "SOURCE_PATH_DUPLICATE",
      "Git source entries must be unique",
    );
  }
  return unique;
}

function parseNulSeparatedPaths(value) {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function expectedArchivePaths(prefix, sourceEntries) {
  if (!Array.isArray(sourceEntries)) {
    throw new ReleaseArtifactError(
      "SOURCE_ENTRIES_INVALID",
      "Source entries must be an array",
    );
  }
  const expected = new Set([prefix]);
  for (const sourceEntry of sourceEntries) {
    const normalized = normalizeRelativePath(sourceEntry);
    const path = `${prefix}${normalized}`;
    expected.add(path);
    let cursor = path;
    while (cursor.includes("/")) {
      cursor = cursor.slice(0, cursor.lastIndexOf("/"));
      if (!cursor.startsWith(prefix) || cursor === prefix) {
        break;
      }
      expected.add(`${cursor}/`);
    }
  }
  return expected;
}

function normalizeTarEntry(entry, sourceDateEpoch) {
  const path = normalizeArchiveEntryPath(entry);
  const type = entry.type;
  if (!["file", "directory", "symlink"].includes(type)) {
    throw new ReleaseArtifactError(
      "ARCHIVE_ENTRY_TYPE_INVALID",
      `Unsupported source archive entry type for ${path}`,
    );
  }
  const mode =
    type === "directory"
      ? DEFAULT_DIRECTORY_MODE
      : type === "symlink"
        ? DEFAULT_SYMLINK_MODE
        : entry.mode & 0o111
          ? DEFAULT_EXECUTABLE_MODE
          : DEFAULT_FILE_MODE;
  return {
    path,
    type,
    mode,
    uid: 0,
    gid: 0,
    mtime: sourceDateEpoch,
    data: type === "file" ? Buffer.from(entry.data) : Buffer.alloc(0),
    linkname: type === "symlink" ? entry.linkname : "",
  };
}

function validateCanonicalTarEntries(
  entries,
  { prefix, sourceEntries, sourceDateEpoch },
) {
  const expected = expectedArchivePaths(prefix, sourceEntries);
  const logicalEntries = entries.filter(
    (entry) => entry.type !== "pax-global" && entry.type !== "pax",
  );
  const paths = logicalEntries.map((entry) => normalizeArchiveEntryPath(entry));
  const expectedSorted = [...expected].sort(compareByteStrings);
  const actualSorted = [...paths].sort(compareByteStrings);
  if (
    expectedSorted.length !== actualSorted.length ||
    expectedSorted.some((path, index) => path !== actualSorted[index])
  ) {
    const missing = expectedSorted.filter(
      (path) => !actualSorted.includes(path),
    );
    const extra = actualSorted.filter((path) => !expectedSorted.includes(path));
    throw new ReleaseArtifactError(
      "ARCHIVE_CONTENT_MISMATCH",
      `Corresponding Source archive path set is incomplete or contains extras (missing: ${missing
        .slice(0, 3)
        .join(", ")}; extra: ${extra.slice(0, 3).join(", ")})`,
    );
  }
  for (const entry of logicalEntries) {
    if (entry.uid !== 0 || entry.gid !== 0 || entry.mtime !== sourceDateEpoch) {
      throw new ReleaseArtifactError(
        "ARCHIVE_METADATA_MISMATCH",
        `Archive metadata is not normalized for ${entry.path}`,
      );
    }
    const expectedMode =
      entry.type === "directory"
        ? DEFAULT_DIRECTORY_MODE
        : entry.type === "symlink"
          ? DEFAULT_SYMLINK_MODE
          : entry.mode & 0o111
            ? DEFAULT_EXECUTABLE_MODE
            : DEFAULT_FILE_MODE;
    if (entry.mode !== expectedMode) {
      throw new ReleaseArtifactError(
        "ARCHIVE_METADATA_MISMATCH",
        `Archive permissions are not normalized for ${entry.path}`,
      );
    }
  }
}

function normalizeArchiveEntryPath(entry) {
  const path = normalizeArchivePath(entry.path);
  return entry.type === "directory" && !path.endsWith("/") ? `${path}/` : path;
}

function encodeTarArchive(entries, sourceDateEpoch) {
  const blocks = [];
  let paxIndex = 0;
  for (const entry of entries) {
    const pathBytes = Buffer.byteLength(entry.path);
    if (pathBytes > 255) {
      const paxPath = `${entry.path.split("/")[0]}/.pax/${paxIndex}`;
      paxIndex += 1;
      const paxData = encodePaxRecord("path", entry.path);
      blocks.push(
        encodeTarHeader({
          path: paxPath,
          type: "pax",
          mode: DEFAULT_FILE_MODE,
          uid: 0,
          gid: 0,
          mtime: sourceDateEpoch,
          size: paxData.length,
          linkname: "",
        }),
        padTarData(paxData),
      );
      blocks.push(
        encodeTarHeader({
          path: paxPath,
          type: entry.type,
          mode: entry.mode,
          uid: entry.uid,
          gid: entry.gid,
          mtime: sourceDateEpoch,
          size: entry.data.length,
          linkname: entry.linkname,
        }),
      );
    } else {
      blocks.push(
        encodeTarHeader({
          path: entry.path,
          type: entry.type,
          mode: entry.mode,
          uid: entry.uid,
          gid: entry.gid,
          mtime: sourceDateEpoch,
          size: entry.data.length,
          linkname: entry.linkname,
        }),
      );
    }
    if (entry.data.length > 0) {
      blocks.push(padTarData(entry.data));
    }
  }
  blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return Buffer.concat(blocks);
}

function encodeTarHeader({
  path,
  type,
  mode,
  uid,
  gid,
  mtime,
  size,
  linkname,
}) {
  const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
  const { name, prefix } = splitTarPath(path);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, uid);
  writeTarOctal(header, 116, 8, gid);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  header[156] = tarTypeByte(type);
  writeTarString(header, 157, 100, linkname ?? "");
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  writeTarString(header, 265, 32, "");
  writeTarString(header, 297, 32, "");
  writeTarOctal(header, 329, 8, 0);
  writeTarOctal(header, 337, 8, 0);
  writeTarString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitTarPath(path) {
  const pathBytes = Buffer.byteLength(path);
  if (pathBytes <= 100) {
    return { name: path, prefix: "" };
  }
  const slashPositions = [...path.matchAll(/\//gu)].map((match) => match.index);
  for (const position of slashPositions.reverse()) {
    const prefix = path.slice(0, position);
    const name = path.slice(position + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new ReleaseArtifactError(
    "ARCHIVE_PATH_TOO_LONG",
    `Archive path cannot fit USTAR header: ${path}`,
  );
}

function writeTarString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new ReleaseArtifactError(
      "ARCHIVE_FIELD_TOO_LONG",
      "Tar metadata field is too long",
    );
  }
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReleaseArtifactError(
      "ARCHIVE_NUMBER_INVALID",
      "Tar numeric metadata must be a non-negative safe integer",
    );
  }
  const text = value.toString(8);
  if (text.length > length - 1) {
    throw new ReleaseArtifactError(
      "ARCHIVE_NUMBER_TOO_LARGE",
      "Tar numeric metadata does not fit its field",
    );
  }
  buffer.fill(0, offset, offset + length);
  buffer.write(text.padStart(length - 1, "0"), offset, length - 1, "ascii");
}

function encodePaxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 2;
  while (Buffer.byteLength(`${length} ${body}`) !== length) {
    length += 1;
  }
  return Buffer.from(`${length} ${body}`, "utf8");
}

function padTarData(data) {
  const padding = Buffer.alloc(roundUpTarSize(data.length) - data.length);
  return Buffer.concat([Buffer.from(data), padding]);
}

function parseTarNumber(value) {
  const text = value.toString("ascii").replaceAll("\0", "").trim();
  if (text === "") {
    return 0;
  }
  if (text.charCodeAt(0) & 0x80) {
    throw new ReleaseArtifactError(
      "ARCHIVE_NUMBER_INVALID",
      "Base-256 tar numbers are not supported in normalized source archives",
    );
  }
  const parsed = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ReleaseArtifactError(
      "ARCHIVE_NUMBER_INVALID",
      `Invalid tar numeric field: ${text}`,
    );
  }
  return parsed;
}

function parsePaxData(data) {
  const values = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) {
      break;
    }
    const length = Number.parseInt(
      data.subarray(offset, space).toString("ascii"),
      10,
    );
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      offset + length > data.length
    ) {
      throw new ReleaseArtifactError(
        "ARCHIVE_PAX_INVALID",
        "Invalid PAX record length",
      );
    }
    const record = data
      .subarray(space + 1, offset + length - 1)
      .toString("utf8");
    const separator = record.indexOf("=");
    if (separator > 0) {
      values[record.slice(0, separator)] = record.slice(separator + 1);
    }
    offset += length;
  }
  if (values.size !== undefined) {
    values.size = Number.parseInt(values.size, 10);
  }
  if (values.mtime !== undefined) {
    values.mtime = Math.trunc(Number.parseFloat(values.mtime));
  }
  return values;
}

function decodeTarString(value) {
  const end = value.indexOf(0);
  return value.subarray(0, end === -1 ? value.length : end).toString("utf8");
}

function joinTarPath(prefix, name) {
  if (!prefix) {
    return name;
  }
  if (!name) {
    return prefix;
  }
  return `${prefix}/${name}`;
}

function tarType(rawType) {
  if (rawType === "0" || rawType === "\0") {
    return "file";
  }
  if (rawType === "5") {
    return "directory";
  }
  if (rawType === "2") {
    return "symlink";
  }
  throw new ReleaseArtifactError(
    "ARCHIVE_ENTRY_TYPE_INVALID",
    `Unsupported tar entry type: ${JSON.stringify(rawType)}`,
  );
}

function tarTypeByte(type) {
  if (type === "file") return "0".charCodeAt(0);
  if (type === "directory") return "5".charCodeAt(0);
  if (type === "symlink") return "2".charCodeAt(0);
  if (type === "pax") return "x".charCodeAt(0);
  throw new ReleaseArtifactError(
    "ARCHIVE_ENTRY_TYPE_INVALID",
    `Unsupported tar entry type: ${type}`,
  );
}

function assertNormalizedGzipHeader(buffer) {
  if (
    buffer.length < 18 ||
    buffer[0] !== 0x1f ||
    buffer[1] !== 0x8b ||
    buffer[2] !== 0x08 ||
    buffer[3] !== 0 ||
    buffer.readUInt32LE(4) !== 0 ||
    buffer[8] !== 0 ||
    buffer[9] !== 3
  ) {
    throw new ReleaseArtifactError(
      "ARCHIVE_GZIP_METADATA_MISMATCH",
      "Gzip header is not normalized (expected no name, epoch zero, XFL zero, OS 3)",
    );
  }
}

async function gzipTarBuffer({ tarBuffer, cwd, runCommand, fsApi }) {
  const temporaryDirectory = await fsApi.mkdtemp(
    join(tmpdir(), "chooser-gzip-"),
  );
  const tarPath = join(temporaryDirectory, "source.tar");
  try {
    await fsApi.writeFile(tarPath, tarBuffer);
    const result = await runCommand("gzip", ["-n", "-9", "-c", tarPath], {
      cwd,
      encoding: "buffer",
      maxBuffer: MAX_ARCHIVE_OUTPUT_BYTES,
    });
    const compressed = readCommandBuffer(result.stdout);
    if (compressed.length === 0) {
      throw new ReleaseArtifactError(
        "ARCHIVE_GZIP_EMPTY",
        "gzip returned no Corresponding Source bytes",
      );
    }
    const normalized = Buffer.from(compressed);
    normalized.fill(0, 4, 8);
    normalized[8] = 0;
    normalized[9] = 3;
    normalized[3] = 0;
    assertNormalizedGzipHeader(normalized);
    return normalized;
  } finally {
    await fsApi.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function serializeDirectoryEntries(entries) {
  const chunks = [];
  for (const entry of entries) {
    if (entry.type === "file") {
      chunks.push(`file\0${entry.path}\0${entry.size}\0${entry.digest}\n`);
    } else if (entry.type === "directory") {
      chunks.push(`directory\0${entry.path}\n`);
    } else {
      chunks.push(`symlink\0${entry.path}\0${entry.target}\n`);
    }
  }
  return chunks.join("");
}

async function collectDirectoryEntries({ rootDirectory, fsApi, ignorePath }) {
  const root = resolve(rootDirectory);
  const entries = [];
  await collectDirectoryEntriesAt({
    root,
    current: root,
    relativeDirectory: "",
    fsApi,
    ignorePath,
    entries,
  });
  entries.sort((left, right) => compareByteStrings(left.path, right.path));
  return entries;
}

async function collectDirectoryEntriesAt({
  root,
  current,
  relativeDirectory,
  fsApi,
  ignorePath,
  entries,
}) {
  const children = await fsApi.readdir(current, { withFileTypes: true });
  const sortedChildren = [...children].sort((left, right) =>
    compareByteStrings(direntName(left), direntName(right)),
  );
  for (const child of sortedChildren) {
    const name = direntName(child);
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${name}`
      : name;
    if (ignorePath(relativePath)) {
      continue;
    }
    const absolutePath = join(current, name);
    const metadata = await fsApi.lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      const target = await fsApi.readlink(absolutePath);
      entries.push({ type: "symlink", path: relativePath, target });
      continue;
    }
    if (metadata.isDirectory()) {
      entries.push({ type: "directory", path: relativePath });
      await collectDirectoryEntriesAt({
        root,
        current: absolutePath,
        relativeDirectory: relativePath,
        fsApi,
        ignorePath,
        entries,
      });
      continue;
    }
    if (!metadata.isFile()) {
      throw new ReleaseArtifactError(
        "DIST_ENTRY_TYPE_INVALID",
        `Unsupported filesystem entry in artifact tree: ${relativePath}`,
      );
    }
    const data = readCommandBuffer(await fsApi.readFile(absolutePath));
    entries.push({
      type: "file",
      path: relativePath,
      size: data.length,
      digest: sha256(data),
    });
  }
}

function direntName(dirent) {
  return typeof dirent === "string" ? dirent : dirent.name;
}

function diffDirectoryEntries(left, right) {
  const leftByPath = new Map(left.map((entry) => [entry.path, entry]));
  const rightByPath = new Map(right.map((entry) => [entry.path, entry]));
  const paths = [
    ...new Set([...leftByPath.keys(), ...rightByPath.keys()]),
  ].sort(compareByteStrings);
  const differences = [];
  for (const path of paths) {
    const leftEntry = leftByPath.get(path);
    const rightEntry = rightByPath.get(path);
    if (!leftEntry || !rightEntry) {
      differences.push(path);
      continue;
    }
    if (JSON.stringify(leftEntry) !== JSON.stringify(rightEntry)) {
      differences.push(path);
    }
  }
  return differences;
}

function compareByteStrings(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.compare(rightBytes);
}

function roundUpTarSize(size) {
  return Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
}

async function assertDirectoryExists(pathname, fsApi) {
  const metadata = await fsApi.stat(pathname);
  if (!metadata.isDirectory()) {
    throw new ReleaseArtifactError(
      "DIRECTORY_REQUIRED",
      `Expected a directory at ${pathname}`,
    );
  }
}

async function pathExists(pathname, fsApi) {
  try {
    await fsApi.lstat(pathname);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
