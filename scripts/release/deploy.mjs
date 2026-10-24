// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { computeDirectoryDigest, sha256 } from "./artifacts.mjs";

export { computeDirectoryDigest };

const execFileAsync = promisify(execFile);

export const DEPLOYMENT_CONTRACT = Object.freeze({
  projectName: "chooser-web",
  branch: "main",
  distributionDirectory: "dist",
  sourceApprovalPath: ".artifacts/release/source-approval.json",
  releaseManifestPath: ".artifacts/release/release-manifest.json",
  sourceArchivePrefix: "/source/chooser-web-",
  sourceArchiveSuffix: ".tar.gz",
  requiredLegalFiles: Object.freeze([
    "legal/gpl-3.0.txt",
    "legal/notice.txt",
    "legal/third-party-notices.txt",
    "legal/asset-provenance.txt",
  ]),
});

const FULL_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const DIRECT_UPLOAD_TYPES = new Set([
  "direct",
  "direct-upload",
  "direct_upload",
]);
const DEFAULT_FILE_SYSTEM = Object.freeze({
  mkdir,
  mkdtemp,
  readFile,
  rm,
});

/**
 * A typed error makes it possible for the local release command and its tests
 * to distinguish a safety rejection from a failed child process.
 */
export class DeployGuardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DeployGuardError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Run the local package manager/Wrangler binary without a shell. Keeping this
 * as a small public seam lets tests prove that no mutating command is reached.
 */
export async function defaultCommandRunner(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return result;
}

/**
 * Execute the guarded local production upload.
 *
 * `runCommand` is intentionally injectable. Production uses the direct
 * `execFile` runner above; tests can model verification, read-only Wrangler
 * inspection, and the exact single mutation without contacting Cloudflare.
 */
export async function deploy(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
  const contract = {
    ...DEPLOYMENT_CONTRACT,
    ...(options.contract ?? {}),
  };
  const environment = options.env ?? process.env;
  const readProjectDetails =
    options.readProjectDetails ?? readPagesProjectDetails;

  await runChecked(
    runCommand,
    "pnpm",
    ["verify"],
    { cwd, env: environment },
    "VERIFY_FAILED",
  );

  const candidate = await captureReleaseCandidate({
    cwd,
    runCommand,
    fileSystem,
    contract,
    env: environment,
    expectedHead: options.expectedHead,
  });

  const whoamiOutput = await runChecked(
    runCommand,
    "pnpm",
    ["exec", "wrangler", "whoami", "--json"],
    { cwd, env: environment },
    "WRANGLER_WHOAMI_FAILED",
  );
  const identity = parseJsonOutput(whoamiOutput.stdout);
  assertWranglerIdentity(identity, contract);

  const projectListOutput = await runChecked(
    runCommand,
    "pnpm",
    ["exec", "wrangler", "pages", "project", "list", "--json"],
    { cwd, env: environment },
    "WRANGLER_PROJECT_LIST_FAILED",
  );
  const projects = parsePagesProjectList(
    parseJsonOutput(projectListOutput.stdout),
  );
  const matchingProjects = projects.filter(
    (project) => getProjectName(project) === contract.projectName,
  );
  if (matchingProjects.length > 1) {
    throw new DeployGuardError(
      "WRANGLER_PROJECT_LIST_INVALID",
      `Wrangler returned duplicate Pages projects named ${contract.projectName}`,
    );
  }
  const existingProject = matchingProjects[0];
  let createdProject = false;

  if (existingProject) {
    const project = await readProjectDetails({
      cwd,
      env: environment,
      identity,
      projectName: contract.projectName,
    });
    validatePagesProject(project, contract);
  }

  if (!existingProject) {
    await assertCandidateUnchanged({
      candidate,
      cwd,
      runCommand,
      fileSystem,
      contract,
      env: environment,
    });
    await runChecked(
      runCommand,
      "pnpm",
      [
        "exec",
        "wrangler",
        "pages",
        "project",
        "create",
        contract.projectName,
        "--production-branch",
        contract.branch,
      ],
      { cwd, env: environment },
      "WRANGLER_PROJECT_CREATE_FAILED",
    );
    createdProject = true;
  }

  const outputDirectory = await createWranglerOutputDirectory(fileSystem);
  const outputPath = join(outputDirectory, "wrangler-output.json");
  const uploadEnvironment = {
    ...environment,
    WRANGLER_OUTPUT_FILE_PATH: outputPath,
  };

  let deploymentOutput;
  try {
    await assertCandidateUnchanged({
      candidate,
      cwd,
      runCommand,
      fileSystem,
      contract,
      env: environment,
    });

    const uploadOutput = await runChecked(
      runCommand,
      "pnpm",
      [
        "exec",
        "wrangler",
        "pages",
        "deploy",
        contract.distributionDirectory,
        "--project-name",
        contract.projectName,
        "--branch",
        contract.branch,
        "--commit-hash",
        candidate.head,
      ],
      { cwd, env: uploadEnvironment },
      "WRANGLER_UPLOAD_FAILED",
    );

    const outputFile = await readFileChecked(
      fileSystem,
      outputPath,
      "WRANGLER_OUTPUT_MISSING",
    );
    deploymentOutput = parseWranglerDeploymentOutput(
      outputFile,
      candidate.head,
      contract,
    );

    // Wrangler may return successfully while its status polling was unable to
    // determine a terminal state. Preserve the command output for diagnostics,
    // but only return the detailed record when its identity is proven above.
    void uploadOutput;
  } finally {
    await removeTemporaryDirectory(fileSystem, outputDirectory);
  }

  return {
    ...deploymentOutput,
    projectName: contract.projectName,
    createdProject,
    artifactDigest: candidate.distDigest,
  };
}

// Alias kept intentionally small for package-script integrations that prefer
// a verb matching the release runner rather than the deployment target.
export const runDeploy = deploy;

/**
 * Capture the clean SHA, exact release metadata, and canonical distribution
 * digest after `pnpm verify` has completed.
 */
export async function captureReleaseCandidate({
  cwd = process.cwd(),
  runCommand = defaultCommandRunner,
  fileSystem = DEFAULT_FILE_SYSTEM,
  contract = DEPLOYMENT_CONTRACT,
  env = process.env,
  expectedHead,
} = {}) {
  const statusOutput = await runChecked(
    runCommand,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd, env },
    "GIT_STATUS_FAILED",
  );
  const status = statusOutput.stdout.trim();
  if (status) {
    throw new DeployGuardError(
      "DIRTY_TREE",
      "Refusing deployment because the Git worktree is not clean",
      { status },
    );
  }

  const headOutput = await runChecked(
    runCommand,
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { cwd, env },
    "GIT_HEAD_FAILED",
  );
  const head = normalizeHead(headOutput.stdout);
  if (expectedHead && head !== normalizeHead(expectedHead)) {
    throw new DeployGuardError(
      "HEAD_MISMATCH",
      `Expected Git HEAD ${expectedHead}, but found ${head}`,
      { expectedHead, actualHead: head },
    );
  }

  const release = await validateReleaseIdentity({
    cwd,
    head,
    fileSystem,
    contract,
  });
  const distDigest = release.distDigest;

  return Object.freeze({
    head,
    distDigest,
    release,
  });
}

// Keep the assertion-oriented name available to callers that use this module
// as a public release gate rather than as a candidate factory.
export const assertReleaseCandidate = captureReleaseCandidate;

/**
 * Re-run every local identity check immediately before a mutating Wrangler
 * command. This catches a changed checkout, archive, legal file, or dist file
 * between verification/project inspection and upload.
 */
export async function assertCandidateUnchanged({
  candidate,
  cwd = process.cwd(),
  runCommand = defaultCommandRunner,
  fileSystem = DEFAULT_FILE_SYSTEM,
  contract = DEPLOYMENT_CONTRACT,
  env = process.env,
} = {}) {
  if (!candidate || typeof candidate.head !== "string") {
    throw new DeployGuardError(
      "CANDIDATE_MISSING",
      "Cannot recheck an absent local release candidate",
    );
  }

  let current;
  try {
    current = await captureReleaseCandidate({
      cwd,
      runCommand,
      fileSystem,
      contract,
      env,
      expectedHead: candidate.head,
    });
  } catch (error) {
    if (error instanceof DeployGuardError) {
      throw new DeployGuardError(
        "CANDIDATE_CHANGED",
        "The verified candidate no longer matches its release metadata",
        { cause: error, originalCode: error.code },
      );
    }
    throw error;
  }
  if (current.distDigest !== candidate.distDigest) {
    throw new DeployGuardError(
      "CANDIDATE_CHANGED",
      "The canonical dist changed after verification; refusing deployment",
      {
        expectedDigest: candidate.distDigest,
        actualDigest: current.distDigest,
      },
    );
  }

  return current;
}

/**
 * Validate the explicit human-approved source record and generated release
 * manifest, including the exact source archive and Legal artifact hashes.
 */
export async function validateReleaseIdentity({
  cwd = process.cwd(),
  head,
  fileSystem = DEFAULT_FILE_SYSTEM,
  contract = DEPLOYMENT_CONTRACT,
} = {}) {
  const normalizedHead = normalizeHead(head);
  const approvalPath = resolve(cwd, contract.sourceApprovalPath);
  const approval = await readJsonChecked(
    fileSystem,
    approvalPath,
    "SOURCE_APPROVAL_MISSING",
  );
  const source = approval.source ?? approval;

  if (approval.schemaVersion !== 1) {
    throw new DeployGuardError(
      "SOURCE_APPROVAL_INVALID",
      "Source approval metadata has an unsupported schema",
    );
  }
  if (approval.status !== "approved") {
    throw new DeployGuardError(
      "SOURCE_APPROVAL_UNRESOLVED",
      "The immutable public Corresponding Source path is not approved",
      { status: approval.status ?? "missing" },
    );
  }
  if (source.immutable !== true) {
    throw new DeployGuardError(
      "SOURCE_APPROVAL_NOT_IMMUTABLE",
      "Source approval must explicitly mark its public path immutable",
    );
  }

  const sourceUrl = requireString(
    source.sourceUrl ?? source.url,
    "SOURCE_APPROVAL_INVALID",
    "Source approval has no sourceUrl",
  );
  assertImmutableSourceUrl(sourceUrl, normalizedHead);
  const sourceRevision = requireSha(
    source.sourceRevision ?? source.revision ?? source.commitSha,
    "SOURCE_APPROVAL_INVALID",
    "Source approval has no source revision",
  );
  assertExactIdentity(
    "source approval revision",
    sourceRevision,
    normalizedHead,
  );

  const manifestPath = resolve(cwd, contract.releaseManifestPath);
  const manifest = await readJsonChecked(
    fileSystem,
    manifestPath,
    "RELEASE_MANIFEST_MISSING",
  );
  const build = manifest.build ?? manifest;
  const manifestSource = manifest.source ?? manifest;
  const legal = manifest.legal ?? manifest;
  const manifestBuildId = requireSha(
    build.buildId ?? build.id ?? build.commitSha ?? build.revision,
    "RELEASE_MANIFEST_INVALID",
    "Release manifest has no build identity",
  );
  assertExactIdentity(
    "release build identity",
    manifestBuildId,
    normalizedHead,
  );
  const manifestCommitSha = requireSha(
    manifest.commitSha ?? build.commitSha ?? build.revision,
    "RELEASE_MANIFEST_INVALID",
    "Release manifest has no commit SHA",
  );
  assertExactIdentity("release commit SHA", manifestCommitSha, normalizedHead);
  const manifestSourceRevision = requireSha(
    manifestSource.sourceRevision ??
      manifest.sourceRevision ??
      manifestSource.revision,
    "RELEASE_MANIFEST_INVALID",
    "Release manifest has no source revision",
  );
  assertExactIdentity(
    "release source revision",
    manifestSourceRevision,
    normalizedHead,
  );
  const manifestSourceUrl = requireString(
    manifestSource.sourceUrl ?? manifest.sourceUrl ?? manifestSource.url,
    "RELEASE_MANIFEST_INVALID",
    "Release manifest has no source URL",
  );
  if (manifestSourceUrl !== sourceUrl) {
    throw new DeployGuardError(
      "RELEASE_MANIFEST_MISMATCH",
      "Release manifest source URL does not match source approval",
    );
  }
  if (manifestSource.status !== "approved") {
    throw new DeployGuardError(
      "RELEASE_MANIFEST_MISMATCH",
      "Release manifest does not record approved Corresponding Source",
    );
  }
  const archivePath = normalizeArchivePath(
    manifestSource.archivePath ??
      manifest.sourceArchivePath ??
      manifestSource.archive?.path,
    normalizedHead,
    contract,
  );
  const archiveSha256 = requireSha256(
    manifestSource.archiveSha256 ??
      manifest.sourceArchiveSha256 ??
      manifestSource.archive?.sha256,
    "RELEASE_MANIFEST_INVALID",
    "Release manifest has no source archive SHA-256",
  );
  const archiveFile = resolveDistributionPath(
    cwd,
    archivePath,
    contract.distributionDirectory,
  );
  const archiveBytes = await readFileChecked(
    fileSystem,
    archiveFile,
    "SOURCE_ARCHIVE_MISSING",
  );
  const actualArchiveSha256 = sha256(archiveBytes);
  if (actualArchiveSha256 !== archiveSha256) {
    throw new DeployGuardError(
      "SOURCE_ARCHIVE_MISMATCH",
      `Source archive SHA-256 does not match release metadata: ${archivePath}`,
      { expected: archiveSha256, actual: actualArchiveSha256 },
    );
  }
  if (
    manifest.license !== "GPL-3.0-or-later" &&
    legal.license !== "GPL-3.0-or-later"
  ) {
    throw new DeployGuardError(
      "RELEASE_MANIFEST_INVALID",
      "Release manifest must identify GPL-3.0-or-later",
    );
  }

  const legalRevision = requireSha(
    legal.legalRevision ?? manifest.legalRevision ?? legal.revision,
    "RELEASE_MANIFEST_INVALID",
    "Release manifest has no Legal revision",
  );
  assertExactIdentity("Legal revision", legalRevision, normalizedHead);
  const legalArtifact = legal.artifact ?? manifest.legalArtifact;
  const legalArtifactPath = normalizeDistributionRelativePath(
    legalArtifact?.path,
    "RELEASE_MANIFEST_INVALID",
    "Release manifest has no Legal artifact path",
  );
  const legalArtifactSha256 = requireSha256(
    legalArtifact?.sha256,
    "RELEASE_MANIFEST_INVALID",
    "Release manifest has no Legal artifact SHA-256",
  );
  const legalArtifactFile = resolveDistributionPath(
    cwd,
    legalArtifactPath,
    contract.distributionDirectory,
  );
  const legalArtifactBytes = await readFileChecked(
    fileSystem,
    legalArtifactFile,
    "LEGAL_ARTIFACT_MISSING",
  );
  const actualLegalArtifactSha256 = sha256(legalArtifactBytes);
  if (actualLegalArtifactSha256 !== legalArtifactSha256) {
    throw new DeployGuardError(
      "LEGAL_ARTIFACT_MISMATCH",
      `Legal artifact SHA-256 does not match release metadata: ${legalArtifactPath}`,
      { expected: legalArtifactSha256, actual: actualLegalArtifactSha256 },
    );
  }
  const legalArtifactText = Buffer.from(legalArtifactBytes).toString("utf8");
  for (const marker of [normalizedHead, sourceUrl, archivePath]) {
    if (!legalArtifactText.includes(marker)) {
      throw new DeployGuardError(
        "LEGAL_ARTIFACT_MISMATCH",
        `Legal artifact is missing release identity marker: ${marker}`,
      );
    }
  }

  const distributionDirectory = resolve(cwd, contract.distributionDirectory);
  for (const requiredFile of contract.requiredLegalFiles) {
    await readFileChecked(
      fileSystem,
      join(distributionDirectory, requiredFile),
      "LEGAL_ARTIFACT_MISSING",
    );
  }

  const manifestDistDigest = requireSha256(
    manifest.dist?.sha256 ?? manifest.distSha256,
    "RELEASE_MANIFEST_INVALID",
    "Release manifest has no canonical dist SHA-256",
  );
  const distDigest = await computeDirectoryDigest(distributionDirectory, {
    fsApi: fileSystem,
  });
  if (manifestDistDigest !== distDigest) {
    throw new DeployGuardError(
      "RELEASE_MANIFEST_MISMATCH",
      "Release manifest dist digest does not match the canonical distribution",
      { expected: manifestDistDigest, actual: distDigest },
    );
  }

  return Object.freeze({
    sourceUrl,
    sourceRevision: normalizedHead,
    archivePath,
    archiveSha256,
    buildId: normalizedHead,
    legalRevision: normalizedHead,
    legalArtifactPath,
    legalArtifactSha256,
    distDigest,
  });
}

/**
 * Validate an existing Pages project before it can be reused. The API object
 * must prove Direct Upload, production branch `main`, and the absence of Git,
 * Functions, or bindings; ambiguous state is rejected closed.
 */
export function validatePagesProject(project, contract = DEPLOYMENT_CONTRACT) {
  if (!project || typeof project !== "object") {
    throw new DeployGuardError(
      "PAGES_PROJECT_INVALID",
      "Cloudflare Pages project metadata is not an object",
    );
  }
  const projectName = getProjectName(project);
  if (projectName !== contract.projectName) {
    throw new DeployGuardError(
      "PAGES_PROJECT_INVALID",
      `Unexpected Pages project: ${projectName ?? "unnamed"}`,
    );
  }
  if (project.production_branch !== contract.branch) {
    throw new DeployGuardError(
      "PAGES_PROJECT_INVALID",
      `Pages project production branch must be ${contract.branch}`,
      { actual: project.production_branch },
    );
  }

  const source = project.source;
  const sourceType = normalizeSourceType(source);
  if (sourceType && !DIRECT_UPLOAD_TYPES.has(sourceType)) {
    throw new DeployGuardError(
      "PAGES_PROJECT_GIT_INTEGRATION",
      "Existing Pages project has Git integration; refusing reuse",
      { sourceType },
    );
  }
  const sourceIsProvenDirect =
    DIRECT_UPLOAD_TYPES.has(sourceType) ||
    (source == null &&
      ("source" in project || "deployment_configs" in project));
  if (!sourceIsProvenDirect) {
    throw new DeployGuardError(
      "PAGES_PROJECT_NOT_DIRECT_UPLOAD",
      "Existing Pages project is not provably a Direct Upload project; refusing reuse",
      { sourceType: sourceType || null },
    );
  }
  if (
    hasConfiguredValue(project.git_integration) ||
    hasConfiguredValue(project.gitIntegration)
  ) {
    throw new DeployGuardError(
      "PAGES_PROJECT_GIT_INTEGRATION",
      "Existing Pages project has Git integration; refusing reuse",
    );
  }
  if (Object.values(project.build_config ?? {}).some(hasConfiguredValue)) {
    throw new DeployGuardError(
      "PAGES_PROJECT_BUILD_CONFIG",
      "Existing Pages project has an unexpected build configuration; refusing reuse",
    );
  }

  const forbiddenConfiguration = [
    ["Functions", project.functions],
    ["bindings", project.bindings],
    ["production Functions", project.deployment_configs?.production?.functions],
    ["production bindings", project.deployment_configs?.production?.bindings],
    ["preview Functions", project.deployment_configs?.preview?.functions],
    ["preview bindings", project.deployment_configs?.preview?.bindings],
  ];
  for (const [environment, config] of Object.entries(
    project.deployment_configs ?? {},
  )) {
    for (const field of [
      "env_vars",
      "kv_namespaces",
      "durable_object_namespaces",
      "d1_databases",
      "r2_buckets",
      "services",
      "analytics_engine_datasets",
      "ai_bindings",
      "queue_producers",
      "hyperdrive_bindings",
      "vectorize_bindings",
      "mtls_certificates",
      "browser",
      "images",
    ]) {
      forbiddenConfiguration.push([`${environment} ${field}`, config?.[field]]);
    }
  }
  for (const [label, value] of forbiddenConfiguration) {
    if (hasConfiguredValue(value)) {
      throw new DeployGuardError(
        "PAGES_PROJECT_RUNTIME_CONFIGURATION",
        `Existing Pages project has ${label}; refusing reuse`,
      );
    }
  }

  return project;
}

/** Wrangler's project table omits the branch, source, and runtime configuration. */
export async function readPagesProjectDetails({
  cwd,
  env,
  identity,
  projectName,
  readCredentials = readWranglerCredentials,
  fetchImpl = fetch,
}) {
  const accounts = (identity.result ?? identity).accounts ?? [];
  const accountId =
    env.CLOUDFLARE_ACCOUNT_ID ??
    env.CF_ACCOUNT_ID ??
    (accounts.length === 1 ? accounts[0].id : undefined);
  if (typeof accountId !== "string" || !accountId) {
    throw new DeployGuardError(
      "PAGES_ACCOUNT_AMBIGUOUS",
      "Set CLOUDFLARE_ACCOUNT_ID to select the Pages account",
    );
  }

  const credentials = await readCredentials({ cwd, env });
  let headers;
  if (typeof credentials.token === "string" && credentials.token) {
    headers = { Authorization: `Bearer ${credentials.token}` };
  } else if (
    credentials.type === "api_key" &&
    credentials.key &&
    credentials.email
  ) {
    headers = {
      "X-Auth-Key": credentials.key,
      "X-Auth-Email": credentials.email,
    };
  } else {
    throw new DeployGuardError(
      "WRANGLER_AUTH_INVALID",
      "Wrangler did not return usable credentials",
    );
  }

  try {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}`,
      { headers, redirect: "error", signal: AbortSignal.timeout(15_000) },
    );
    const data = await response.json();
    if (!response.ok || data.success !== true || !data.result) {
      throw new Error("Project details unavailable");
    }
    return data.result;
  } catch {
    throw new DeployGuardError(
      "PAGES_PROJECT_LOOKUP_FAILED",
      "Could not read complete Pages project metadata; refusing upload",
    );
  }
}

async function readWranglerCredentials({ cwd, env }) {
  try {
    // Wrangler also records stdout in debug logs unless disk logging is disabled.
    const { stdout } = await execFileAsync(
      "pnpm",
      ["exec", "wrangler", "auth", "token", "--json"],
      {
        cwd,
        env: { ...env, WRANGLER_WRITE_LOGS: "false" },
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
    );
    return JSON.parse(stdout);
  } catch {
    throw new DeployGuardError(
      "WRANGLER_AUTH_FAILED",
      "Could not retrieve Wrangler credentials for the Pages project lookup",
    );
  }
}

/** Parse the JSON shape emitted by `wrangler pages project list --json`. */
export function parsePagesProjectList(value) {
  const parsed = unwrapWranglerResult(value);
  if (!parsed || typeof parsed !== "object") {
    throw new DeployGuardError(
      "WRANGLER_PROJECT_LIST_INVALID",
      "Wrangler project list did not return an object or array",
    );
  }
  const projects = Array.isArray(parsed)
    ? parsed
    : (parsed.projects ?? parsed.result ?? parsed.data);
  if (!Array.isArray(projects)) {
    throw new DeployGuardError(
      "WRANGLER_PROJECT_LIST_INVALID",
      "Wrangler project list did not return an array",
    );
  }
  return projects;
}

/**
 * Parse Wrangler's newline-delimited output file and require its detailed
 * Pages deployment record to identify the exact production SHA.
 */
export function parseWranglerDeploymentOutput(
  value,
  expectedHead,
  contract = DEPLOYMENT_CONTRACT,
) {
  const normalizedHead = normalizeHead(expectedHead);
  const records = parseJsonRecords(value);
  const detailed = records.find(
    (record) => record?.type === "pages-deploy-detailed",
  );
  if (!detailed) {
    throw new DeployGuardError(
      "WRANGLER_OUTPUT_INVALID",
      "Wrangler output did not contain pages-deploy-detailed JSON",
    );
  }

  const projectName = detailed.pages_project ?? detailed.project_name;
  if (projectName !== contract.projectName) {
    throw new DeployGuardError(
      "WRANGLER_OUTPUT_INVALID",
      "Wrangler deployment output names an unexpected Pages project",
      { projectName },
    );
  }
  const deploymentId = detailed.deployment_id ?? detailed.deploymentId;
  if (typeof deploymentId !== "string" || deploymentId.length === 0) {
    throw new DeployGuardError(
      "WRANGLER_OUTPUT_INVALID",
      "Wrangler deployment output has no deployment ID",
    );
  }
  const url = detailed.url;
  assertPagesUrl(url, "deployment URL");
  const alias = detailed.alias ?? null;
  if (alias !== null) {
    assertPagesUrl(alias, "deployment alias URL");
  }
  if (detailed.environment !== "production") {
    throw new DeployGuardError(
      "WRANGLER_OUTPUT_NOT_PRODUCTION",
      "Wrangler deployment output is not a production deployment",
      { environment: detailed.environment },
    );
  }
  if (detailed.production_branch !== contract.branch) {
    throw new DeployGuardError(
      "WRANGLER_OUTPUT_INVALID",
      `Wrangler deployment output branch must be ${contract.branch}`,
      { branch: detailed.production_branch },
    );
  }
  const commitHash = normalizeHead(
    detailed.deployment_trigger?.metadata?.commit_hash ??
      detailed.commit_hash ??
      detailed.commitHash,
  );
  assertExactIdentity("deployment commit SHA", commitHash, normalizedHead);

  return Object.freeze({
    deploymentId,
    url,
    alias,
    environment: detailed.environment,
    branch: detailed.production_branch,
    commitHash,
  });
}

function assertWranglerIdentity(value) {
  const parsed = unwrapWranglerResult(value);
  if (!parsed || typeof parsed !== "object" || parsed.success === false) {
    throw new DeployGuardError(
      "WRANGLER_WHOAMI_INVALID",
      "Wrangler whoami did not prove an authenticated account",
    );
  }
}

async function runChecked(runCommand, command, args, options, code) {
  try {
    const result = await runCommand(command, args, options);
    const normalized = normalizeCommandResult(result);
    if (
      (typeof normalized.exitCode === "number" && normalized.exitCode !== 0) ||
      (typeof normalized.code === "number" && normalized.code !== 0)
    ) {
      throw new DeployGuardError(
        code,
        `${command} ${args.join(" ")} exited with ${normalized.exitCode ?? normalized.code}`,
        { result: normalized },
      );
    }
    return normalized;
  } catch (error) {
    if (error instanceof DeployGuardError) {
      throw error;
    }
    throw new DeployGuardError(
      code,
      `${command} ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function normalizeCommandResult(result) {
  if (typeof result === "string" || Buffer.isBuffer(result)) {
    return { stdout: result.toString(), stderr: "" };
  }
  if (!result || typeof result !== "object") {
    return { stdout: "", stderr: "" };
  }
  return {
    ...result,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function parseJsonOutput(value) {
  if (Buffer.isBuffer(value)) {
    return parseJsonOutput(value.toString("utf8"));
  }
  if (value && typeof value === "object") {
    return value;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        // Fall through to newline-delimited Wrangler output below.
      }
    }
  }

  const records = parseJsonRecords(value);
  if (records.length === 0) {
    throw new DeployGuardError(
      "WRANGLER_JSON_INVALID",
      "Wrangler returned no JSON output",
    );
  }
  return records.at(-1);
}

function parseJsonRecords(value) {
  if (Buffer.isBuffer(value)) {
    return parseJsonRecords(value.toString("utf8"));
  }
  if (value && typeof value === "object") {
    return Array.isArray(value) ? value : [value];
  }
  if (typeof value !== "string") {
    return [];
  }
  const text = value.trim();
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const records = [];
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // Wrangler can print human-readable lines around output-file JSON.
      }
    }
    return records;
  }
}

function unwrapWranglerResult(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (value.success !== undefined || value.result === undefined) {
    return value;
  }
  return value.result;
}

function getProjectName(project) {
  return (
    project?.name ??
    project?.project_name ??
    project?.projectName ??
    project?.["Project Name"]
  );
}

function normalizeSourceType(source) {
  if (typeof source === "string") {
    return source.toLowerCase().replaceAll("_", "-");
  }
  if (!source || typeof source !== "object") {
    return "";
  }
  const value = source.type ?? source.provider ?? source.provider_type;
  return typeof value === "string"
    ? value.toLowerCase().replaceAll("_", "-")
    : "";
}

function hasConfiguredValue(value) {
  if (
    value === null ||
    value === undefined ||
    value === false ||
    value === ""
  ) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function requireString(value, code, message) {
  if (typeof value !== "string" || value.length === 0) {
    throw new DeployGuardError(code, message);
  }
  return value;
}

function requireSha(value, code, message) {
  const string = requireString(value, code, message);
  if (!FULL_SHA_PATTERN.test(string)) {
    throw new DeployGuardError(code, `${message}: expected a full Git SHA`);
  }
  return string.toLowerCase();
}

function requireSha256(value, code, message) {
  const string = requireString(value, code, message);
  if (!SHA256_PATTERN.test(string)) {
    throw new DeployGuardError(code, `${message}: expected a SHA-256 digest`);
  }
  return string.toLowerCase();
}

function normalizeHead(value) {
  const string = typeof value === "string" ? value.trim() : "";
  if (!FULL_SHA_PATTERN.test(string)) {
    throw new DeployGuardError(
      "GIT_HEAD_INVALID",
      "Git HEAD is not a full commit SHA",
      { value: string },
    );
  }
  return string.toLowerCase();
}

function assertExactIdentity(label, actual, expected) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new DeployGuardError(
      "RELEASE_IDENTITY_MISMATCH",
      `${label} does not match the verified commit SHA`,
      { actual, expected },
    );
  }
}

function assertImmutableSourceUrl(sourceUrl, head) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new DeployGuardError(
      "SOURCE_APPROVAL_INVALID",
      "Source approval URL is not a valid URL",
    );
  }
  if (parsed.protocol !== "https:" || parsed.search || parsed.hash) {
    throw new DeployGuardError(
      "SOURCE_APPROVAL_NOT_IMMUTABLE",
      "Corresponding Source URL must be an HTTPS URL without query/hash mutability",
    );
  }
  if (!sourceUrl.toLowerCase().includes(head.toLowerCase())) {
    throw new DeployGuardError(
      "SOURCE_APPROVAL_NOT_IMMUTABLE",
      "Corresponding Source URL must identify the exact full commit SHA",
    );
  }
}

function normalizeArchivePath(value, head, contract) {
  const path = normalizeDistributionRelativePath(
    value,
    "SOURCE_APPROVAL_INVALID",
    "Source approval has no source archive path",
  );
  const expected = `${contract.sourceArchivePrefix}${head}${contract.sourceArchiveSuffix}`;
  if (path !== expected) {
    throw new DeployGuardError(
      "SOURCE_ARCHIVE_MISMATCH",
      `Source archive path must be ${expected}`,
      { actual: path, expected },
    );
  }
  return path;
}

function normalizeDistributionRelativePath(value, code, message) {
  const string = requireString(value, code, message);
  const withoutLeadingSlash = string.startsWith("/") ? string.slice(1) : string;
  const normalized = posix.normalize(withoutLeadingSlash.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.startsWith("/")
  ) {
    throw new DeployGuardError(code, `${message}: path escapes dist`);
  }
  return `/${normalized}`;
}

function resolveDistributionPath(cwd, publicPath, distributionDirectory) {
  const distributionRoot = resolve(cwd, distributionDirectory);
  const relativePath = publicPath.replace(/^\/+/, "");
  const resolved = resolve(distributionRoot, relativePath);
  const prefix = `${distributionRoot}${sep}`;
  if (resolved !== distributionRoot && !resolved.startsWith(prefix)) {
    throw new DeployGuardError(
      "RELEASE_PATH_INVALID",
      `Release path escapes ${distributionDirectory}`,
    );
  }
  return resolved;
}

async function readJsonChecked(fileSystem, path, code) {
  let contents;
  try {
    contents = await fileSystem.readFile(path, "utf8");
  } catch (error) {
    throw new DeployGuardError(
      code,
      `Required release metadata is unavailable: ${path}`,
      { path, cause: error },
    );
  }
  try {
    return JSON.parse(
      typeof contents === "string"
        ? contents
        : Buffer.from(contents).toString("utf8"),
    );
  } catch (error) {
    throw new DeployGuardError(
      code,
      `Required release metadata is not valid JSON: ${path}`,
      { path, cause: error },
    );
  }
}

async function readFileChecked(fileSystem, path, code) {
  try {
    return await fileSystem.readFile(path);
  } catch (error) {
    throw new DeployGuardError(
      code,
      `Required release file is unavailable: ${path}`,
      {
        path,
        cause: error,
      },
    );
  }
}

async function createWranglerOutputDirectory(fileSystem) {
  return fileSystem.mkdtemp(join(tmpdir(), "chooser-web-wrangler-"));
}

async function removeTemporaryDirectory(fileSystem, directory) {
  await fileSystem.rm(directory, { force: true, recursive: true });
}

function assertPagesUrl(value, label) {
  if (typeof value !== "string") {
    throw new DeployGuardError(
      "WRANGLER_OUTPUT_INVALID",
      `${label} is missing`,
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new DeployGuardError(
      "WRANGLER_OUTPUT_INVALID",
      `${label} is invalid`,
    );
  }
  if (
    parsed.protocol !== "https:" ||
    !(parsed.hostname === "pages.dev" || parsed.hostname.endsWith(".pages.dev"))
  ) {
    throw new DeployGuardError(
      "WRANGLER_OUTPUT_INVALID",
      `${label} must be an HTTPS pages.dev URL`,
    );
  }
}

function isMainModule() {
  const entry = process.argv[1];
  return entry && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  deploy()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Deployment refused: ${message}`);
      process.exitCode = 1;
    });
}
