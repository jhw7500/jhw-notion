import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { ControlError } from "./errors.js";
import { githubSlugFromRemote } from "./github-source.js";
import type { ProcessResult, ProcessRunOptions } from "./process.js";
import type { ClaimHistory } from "./schemas.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_COMMITS = 32;
const MAX_ARTIFACTS = 4096;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const safeRelative = z.string().min(1).max(4096).refine((value) => {
  if (value.includes("\0") || value.includes("\\") || isAbsolute(value)) return false;
  return normalize(value) === value && value !== "." && value !== ".." && !value.startsWith(`..${sep}`) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
});

const ManifestSchema = z.object({
  version: z.literal(1),
  policy: z.literal("historical-exact-patch-v1"),
  task_id: z.string(),
  claim_id: z.string(),
  project_id: z.string(),
  repo_id: z.string(),
  repository_slug: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/),
  host: z.string().min(1),
  branch: z.string().min(1),
  worktree_ref: z.string().min(1),
  registry_head: oid,
  history_sha256: digest,
  mapping_sha256: digest,
  source_ref: z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/),
  source_head: oid,
  worktree_head: oid,
  commits: z.array(z.object({
    worktree_commit: oid,
    integration_commit: oid,
  }).strict()).min(1).max(MAX_COMMITS),
  bundle: z.object({
    file: z.string().min(1),
    sha256: digest,
    bytes: z.number().int().positive().safe().max(MAX_ARTIFACT_BYTES),
  }).strict(),
  artifacts: z.array(z.object({
    path: safeRelative,
    file: z.string().min(1),
    sha256: digest,
    bytes: z.number().int().nonnegative().safe().max(MAX_ARTIFACT_BYTES),
    mode: z.string().regex(/^0[0-7]{3}$/),
  }).strict()).max(MAX_ARTIFACTS),
  inventory_sha256: digest,
}).strict();

export type HistoricalCleanupManifest = z.infer<typeof ManifestSchema>;

export interface CleanupProofRunner {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult>;
  runRaw?(command: string, args: string[], options: ProcessRunOptions | undefined, maximumBytes: number): Promise<Buffer>;
}

export interface SourceTrustPort {
  assertTrustedSource(input: {
    runner: CleanupProofRunner;
    sourcePath: string;
    repositorySlug: string;
    sourceRef: string;
    sourceHead: string;
  }): Promise<void>;
}

export interface HistoricalCleanupProofInput {
  proofPath: string;
  history: ClaimHistory;
  registryHead: string;
  historySha256: string;
  mappingSha256: string;
  sourcePath: string;
  worktreePath: string;
  commonGitDir: string;
  repositorySlug: string;
  managedRoots: readonly string[];
  runner: CleanupProofRunner;
  sourceTrust?: SourceTrustPort;
}

export interface VerifiedHistoricalCleanupProof {
  policy: "historical-exact-patch-v1";
  proofSha256: string;
  inventorySha256: string;
  sourceHead: string;
  sourceRef: string;
  worktreeHead: string;
  artifactPaths: readonly string[];
}

export interface VerifiedHistoricalCleanupProofScope {
  verified: VerifiedHistoricalCleanupProof;
  sourceArtifacts: ReadonlyArray<{ path: string; descriptor: number }>;
  assertArtifactsUnchanged(): Promise<void>;
  assertSourceTrusted(): Promise<void>;
}

interface RetainedParent {
  path: string;
  handle: FileHandle;
  info: BigIntStats;
}

interface RetainedFile {
  path: string;
  handle: FileHandle;
  info: BigIntStats;
  digest: string;
  parent: RetainedParent;
}

export async function historicalCleanupProofSha256(proofPath: string): Promise<string> {
  await assertPrivateParent(proofPath);
  const proof = await secureRegularFile(proofPath, 0o600);
  if (proof.bytes.length > MAX_MANIFEST_BYTES) throw unsafe("backup_invalid");
  return sha256(proof.bytes);
}

export async function verifyHistoricalCleanupBackupOnly(input: {
  proofPath: string;
  sourcePath: string;
  worktreePath: string;
  commonGitDir: string;
  managedRoots: readonly string[];
  runner: CleanupProofRunner;
}): Promise<{ proofSha256: string; manifest: HistoricalCleanupManifest }> {
  await assertPrivateParent(input.proofPath);
  const proof = await secureRegularFile(input.proofPath, 0o600);
  if (proof.bytes.length > MAX_MANIFEST_BYTES) throw unsafe("backup_invalid");
  let manifest: HistoricalCleanupManifest;
  try { manifest = ManifestSchema.parse(JSON.parse(proof.bytes.toString("utf8"))); } catch { throw unsafe("backup_invalid"); }
  await verifyBundle(input.runner, manifest, input.sourcePath, input.worktreePath, input.commonGitDir, input.managedRoots);
  let total = 0;
  for (const artifact of manifest.artifacts) {
    total += artifact.bytes;
    if (total > MAX_ARTIFACT_BYTES) throw unsafe("backup_invalid");
    await assertPrivateParent(artifact.file);
    const backup = await secureRegularFile(await realpath(artifact.file), Number.parseInt(artifact.mode, 8));
    if (backup.bytes.length !== artifact.bytes || sha256(backup.bytes) !== artifact.sha256) throw unsafe("backup_invalid");
  }
  const inventory = manifest.artifacts.map(({ file: _file, ...entry }) => entry);
  if (sha256(JSON.stringify(inventory)) !== manifest.inventory_sha256) throw unsafe("backup_invalid");
  return { proofSha256: sha256(proof.bytes), manifest };
}

function unsafe(reason: "scope_unsupported" | "patch_mismatch" | "integration_untrusted" | "backup_invalid" | "snapshot_changed"): ControlError {
  return new ControlError("WORKTREE_EQUIVALENCE_UNSAFE", "Historical cleanup proof did not satisfy the exact safety policy", { reason });
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function secureRegularFile(path: string, mode?: number): Promise<{ bytes: Buffer; ino: bigint }> {
  if (!isAbsolute(path)) throw unsafe("backup_invalid");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat({ bigint: true });
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : info.uid;
    if (!info.isFile() || info.nlink !== 1n || info.uid !== uid || (mode !== undefined && (info.mode & 0o777n) !== BigInt(mode))) {
      throw unsafe("backup_invalid");
    }
    return { bytes: await handle.readFile(), ino: info.ino };
  } catch (cause) {
    if (cause instanceof ControlError) throw cause;
    throw unsafe("backup_invalid");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function currentUid(info: BigIntStats): bigint {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : info.uid;
}

function sameFileObservation(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;
}

async function readRetained(handle: FileHandle, size: bigint): Promise<Buffer> {
  if (size < 0n || size > BigInt(MAX_ARTIFACT_BYTES)) throw unsafe("backup_invalid");
  const bytes = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) throw unsafe("backup_invalid");
    offset += result.bytesRead;
  }
  return bytes;
}

async function openRetainedFile(path: string, mode: number, privateParent: boolean): Promise<{ retained: RetainedFile; bytes: Buffer }> {
  if (!isAbsolute(path) || await realpath(path).catch(() => "") !== resolve(path)) throw unsafe("backup_invalid");
  const parentPath = dirname(path);
  let parent: FileHandle | undefined;
  let handle: FileHandle | undefined;
  try {
    parent = await open(parentPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    const parentInfo = await parent.stat({ bigint: true });
    if (!parentInfo.isDirectory() || parentInfo.uid !== currentUid(parentInfo) || parentInfo.nlink < 1n ||
      (privateParent && (parentInfo.mode & 0o777n) !== 0o700n)) throw unsafe("backup_invalid");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== currentUid(before) ||
      (before.mode & 0o777n) !== BigInt(mode)) throw unsafe("backup_invalid");
    const bytes = await readRetained(handle, before.size);
    const after = await handle.stat({ bigint: true });
    if (!sameFileObservation(before, after)) throw unsafe("backup_invalid");
    return {
      retained: {
        path,
        handle,
        info: before,
        digest: sha256(bytes),
        parent: { path: parentPath, handle: parent, info: parentInfo },
      },
      bytes,
    };
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    await parent?.close().catch(() => undefined);
    if (cause instanceof ControlError) throw cause;
    throw unsafe("backup_invalid");
  }
}

async function assertRetainedFileUnchanged(snapshot: RetainedFile): Promise<void> {
  try {
    const parentInfo = await snapshot.parent.handle.stat({ bigint: true });
    if (!sameFileObservation(snapshot.parent.info, parentInfo)) throw unsafe("snapshot_changed");
    const currentParent = await open(snapshot.parent.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      const currentParentInfo = await currentParent.stat({ bigint: true });
      if (!sameFileObservation(parentInfo, currentParentInfo)) throw unsafe("snapshot_changed");
    } finally {
      await currentParent.close().catch(() => undefined);
    }

    const info = await snapshot.handle.stat({ bigint: true });
    if (!sameFileObservation(snapshot.info, info)) throw unsafe("snapshot_changed");
    const bytes = await readRetained(snapshot.handle, info.size);
    if (sha256(bytes) !== snapshot.digest) throw unsafe("snapshot_changed");
    const current = await open(snapshot.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const currentInfo = await current.stat({ bigint: true });
      if (!sameFileObservation(info, currentInfo)) throw unsafe("snapshot_changed");
    } finally {
      await current.close().catch(() => undefined);
    }
  } catch (cause) {
    if (cause instanceof ControlError) throw cause;
    throw unsafe("snapshot_changed");
  }
}

async function closeRetainedFiles(files: readonly RetainedFile[]): Promise<void> {
  await Promise.all(files.flatMap((file) => [
    file.handle.close().catch(() => undefined),
    file.parent.handle.close().catch(() => undefined),
  ]));
}

async function assertPrivateParent(path: string): Promise<void> {
  if (!isAbsolute(path) || await realpath(path).catch(() => "") !== resolve(path)) throw unsafe("backup_invalid");
  const parent = dirname(path);
  const info = await lstat(parent).catch(() => undefined);
  const uid = typeof process.getuid === "function" ? process.getuid() : info?.uid;
  if (!info?.isDirectory() || info.isSymbolicLink() || info.nlink < 1 || info.uid !== uid || (info.mode & 0o777) !== 0o700) {
    throw unsafe("backup_invalid");
  }
}

async function git(runner: CleanupProofRunner, cwd: string, args: string[]): Promise<string> {
  return (await runner.run("git", ["--no-optional-locks", ...args], { cwd })).stdout.trim();
}

async function gitRaw(runner: CleanupProofRunner, cwd: string, args: string[], maximumBytes = 16 * 1024 * 1024): Promise<Buffer> {
  if (!runner.runRaw) throw unsafe("scope_unsupported");
  return runner.runRaw("git", ["--no-optional-locks", ...args], { cwd }, maximumBytes);
}

function nulFields(bytes: Buffer, allowEmpty = false): Buffer[] {
  if (bytes.length === 0) {
    if (allowEmpty) return [];
    throw unsafe("scope_unsupported");
  }
  if (bytes.at(-1) !== 0) throw unsafe("scope_unsupported");
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    fields.push(bytes.subarray(start, index));
    start = index + 1;
  }
  return fields;
}

async function exactDiff(runner: CleanupProofRunner, repository: string, commit: string): Promise<Buffer> {
  const parents = (await git(runner, repository, ["rev-list", "--parents", "-n", "1", commit])).split(/\s+/);
  if (parents.length !== 2) throw unsafe("scope_unsupported");
  const output = await gitRaw(runner, repository, [
    "diff-tree", "--raw", "-r", "-z", "--no-renames", "--no-abbrev", "--format=", `${parents[1]}..${commit}`,
  ]);
  const fields = nulFields(output);
  if (fields.length === 0 || fields.length % 2 !== 0) throw unsafe("scope_unsupported");
  for (let index = 0; index < fields.length; index += 2) {
    const metadata = fields[index]!;
    const path = fields[index + 1]!;
    if (metadata[0] !== 0x3a || path.length === 0) throw unsafe("scope_unsupported");
    const row = metadata.toString("ascii");
    const values = row.slice(1).split(/\s+/);
    const [oldMode, newMode, oldOid, newOid] = values;
    if (![oldMode, newMode].every((mode) => mode === "000000" || mode === "100644" || mode === "100755")) {
      throw unsafe("scope_unsupported");
    }
    for (const objectId of [oldOid, newOid]) {
      if (!objectId || /^0+$/.test(objectId)) continue;
      if (await git(runner, repository, ["cat-file", "-t", objectId]) !== "blob") throw unsafe("scope_unsupported");
    }
  }
  return output;
}

const productionSourceTrust: SourceTrustPort = {
  async assertTrustedSource({ runner, sourcePath, repositorySlug, sourceRef, sourceHead }): Promise<void> {
    const fetch = (await git(runner, sourcePath, ["remote", "get-url", "--all", "origin"])).split("\n").filter(Boolean);
    const push = (await git(runner, sourcePath, ["remote", "get-url", "--push", "--all", "origin"])).split("\n").filter(Boolean);
    let fetchSlug = "";
    let pushSlug = "";
    try {
      fetchSlug = githubSlugFromRemote(fetch[0] ?? "");
      pushSlug = githubSlugFromRemote(push[0] ?? "");
    } catch {
      throw unsafe("integration_untrusted");
    }
    if (fetch.length !== 1 || push.length !== 1 ||
      fetchSlug.toLowerCase() !== repositorySlug.toLowerCase() ||
      pushSlug.toLowerCase() !== repositorySlug.toLowerCase()) throw unsafe("integration_untrusted");
    const remoteHead = await git(runner, sourcePath, ["ls-remote", "--symref", "origin", "HEAD"]);
    if (!remoteHead.split("\n").some((line) => line === `ref: ${sourceRef}\tHEAD`)) throw unsafe("integration_untrusted");
    const branchRemote = await git(runner, sourcePath, ["ls-remote", "--exit-code", "origin", sourceRef]);
    if (branchRemote !== `${sourceHead}\t${sourceRef}`) throw unsafe("integration_untrusted");
  },
};

async function verifyMaterializedBundle(
  runner: CleanupProofRunner,
  manifest: HistoricalCleanupManifest,
  sourcePath: string,
  bytes: Buffer,
): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "jhw-cleanup-proof-"));
  await chmod(scratch, 0o700);
  const inputDirectory = join(scratch, "input");
  await mkdir(inputDirectory, { mode: 0o700 });
  await chmod(inputDirectory, 0o700);
  const bundlePath = join(inputDirectory, "verified.bundle");
  let writer: FileHandle | undefined;
  let snapshot: RetainedFile | undefined;
  try {
    writer = await open(
      bundlePath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await writer.chmod(0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await writer.write(bytes, offset, bytes.length - offset, offset);
      if (result.bytesWritten === 0) throw unsafe("backup_invalid");
      offset += result.bytesWritten;
    }
    await writer.sync();
    const materialized = await openRetainedFile(bundlePath, 0o600, true);
    snapshot = materialized.retained;
    if (!materialized.bytes.equals(bytes) || snapshot.digest !== manifest.bundle.sha256) throw unsafe("backup_invalid");
    await writer.close();
    writer = undefined;

    const assertScratch = async () => {
      try {
        await assertRetainedFileUnchanged(snapshot!);
      } catch {
        throw unsafe("backup_invalid");
      }
    };
    await assertScratch();
    await git(runner, sourcePath, ["bundle", "verify", bundlePath]).catch(() => { throw unsafe("backup_invalid"); });
    await assertScratch();
    await git(runner, scratch, ["clone", "--mirror", bundlePath, join(scratch, "restored.git")]).catch(() => {
      throw unsafe("backup_invalid");
    });
    await assertScratch();
    const restored = join(scratch, "restored.git");
    for (const objectId of [manifest.source_head, manifest.worktree_head]) {
      if (await git(runner, restored, ["cat-file", "-t", objectId]).catch(() => "") !== "commit") throw unsafe("backup_invalid");
    }
    await git(runner, restored, ["fsck", "--full", "--no-dangling"]);
  } finally {
    await writer?.close().catch(() => undefined);
    if (snapshot) await closeRetainedFiles([snapshot]);
    await rm(scratch, { recursive: true, force: true });
  }
}

async function verifyBundle(
  runner: CleanupProofRunner,
  manifest: HistoricalCleanupManifest,
  sourcePath: string,
  worktreePath: string,
  commonGitDir: string,
  managedRoots: readonly string[],
): Promise<void> {
  await assertPrivateParent(manifest.bundle.file);
  const bundlePath = await realpath(manifest.bundle.file).catch(() => "");
  const forbidden = [sourcePath, worktreePath, commonGitDir, ...managedRoots];
  if (!bundlePath || forbidden.some((root) => within(resolve(root), bundlePath))) throw unsafe("backup_invalid");
  const bundle = await secureRegularFile(bundlePath, 0o600);
  if (bundle.bytes.length !== manifest.bundle.bytes || sha256(bundle.bytes) !== manifest.bundle.sha256) throw unsafe("backup_invalid");
  await verifyMaterializedBundle(runner, manifest, sourcePath, bundle.bytes);
}

async function verifyBundleRetained(
  runner: CleanupProofRunner,
  manifest: HistoricalCleanupManifest,
  sourcePath: string,
  worktreePath: string,
  commonGitDir: string,
  managedRoots: readonly string[],
  retained: RetainedFile[],
): Promise<void> {
  await assertPrivateParent(manifest.bundle.file);
  const bundlePath = await realpath(manifest.bundle.file).catch(() => "");
  const forbidden = [sourcePath, worktreePath, commonGitDir, ...managedRoots];
  if (!bundlePath || forbidden.some((root) => within(resolve(root), bundlePath))) throw unsafe("backup_invalid");
  const bundle = await openRetainedFile(bundlePath, 0o600, true);
  retained.push(bundle.retained);
  if (bundle.bytes.length !== manifest.bundle.bytes || bundle.retained.digest !== manifest.bundle.sha256) {
    throw unsafe("backup_invalid");
  }
  await verifyMaterializedBundle(runner, manifest, sourcePath, bundle.bytes);
}

async function ignoredArtifactInventory(input: HistoricalCleanupProofInput): Promise<Buffer[]> {
  return nulFields(
    await gitRaw(input.runner, input.worktreePath, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
    true,
  );
}

function assertDeclaredInventory(
  ignored: Buffer[],
  manifest: HistoricalCleanupManifest,
  reason: "backup_invalid" | "snapshot_changed" = "backup_invalid",
): void {
  const declared = manifest.artifacts.map((entry) => Buffer.from(entry.path, "utf8"));
  const compare = (left: Buffer, right: Buffer) => Buffer.compare(left, right);
  ignored.sort(compare); declared.sort(compare);
  if (ignored.length !== declared.length || ignored.some((path, index) => !path.equals(declared[index]!)) ||
    new Set(manifest.artifacts.map((entry) => entry.path)).size !== manifest.artifacts.length) throw unsafe(reason);
}

async function verifyArtifactsRetained(
  input: HistoricalCleanupProofInput,
  manifest: HistoricalCleanupManifest,
  retained: RetainedFile[],
): Promise<RetainedFile[]> {
  assertDeclaredInventory(await ignoredArtifactInventory(input), manifest);
  const sources: RetainedFile[] = [];
  let total = 0;
  for (const artifact of manifest.artifacts) {
    total += artifact.bytes;
    if (total > MAX_ARTIFACT_BYTES) throw unsafe("backup_invalid");
    const mode = Number.parseInt(artifact.mode, 8);
    const source = await openRetainedFile(join(input.worktreePath, artifact.path), mode, false);
    retained.push(source.retained);
    sources.push(source.retained);
    await assertPrivateParent(artifact.file);
    const backupPath = await realpath(artifact.file).catch(() => "");
    if (!backupPath || [input.sourcePath, input.worktreePath, input.commonGitDir, ...input.managedRoots]
      .some((root) => within(resolve(root), backupPath))) throw unsafe("backup_invalid");
    const backup = await openRetainedFile(backupPath, mode, true);
    retained.push(backup.retained);
    if (
      (source.retained.info.dev === backup.retained.info.dev && source.retained.info.ino === backup.retained.info.ino) ||
      source.bytes.length !== artifact.bytes || backup.bytes.length !== artifact.bytes ||
      source.retained.digest !== artifact.sha256 || backup.retained.digest !== artifact.sha256 ||
      !source.bytes.equals(backup.bytes)
    ) throw unsafe("backup_invalid");
  }
  const inventory = manifest.artifacts.map(({ file: _file, ...entry }) => entry);
  if (sha256(JSON.stringify(inventory)) !== manifest.inventory_sha256) throw unsafe("backup_invalid");
  return sources;
}

export async function withVerifiedHistoricalCleanupProof<T>(
  input: HistoricalCleanupProofInput,
  use: (scope: VerifiedHistoricalCleanupProofScope) => Promise<T>,
): Promise<T> {
  const retained: RetainedFile[] = [];
  try {
    await assertPrivateParent(input.proofPath);
    const proof = await openRetainedFile(input.proofPath, 0o600, true);
    retained.push(proof.retained);
    if (proof.bytes.length > MAX_MANIFEST_BYTES) throw unsafe("backup_invalid");
    let manifest: HistoricalCleanupManifest;
    try {
      manifest = ManifestSchema.parse(JSON.parse(proof.bytes.toString("utf8")));
    } catch {
      throw unsafe("backup_invalid");
    }
    const history = input.history;
    if (
      manifest.task_id !== history.task_id || manifest.claim_id !== history.claim_id ||
      manifest.project_id !== history.project_id || manifest.repo_id !== history.repo_id || manifest.repository_slug.toLowerCase() !== input.repositorySlug.toLowerCase() ||
      manifest.host !== history.host || manifest.branch !== history.branch || manifest.worktree_ref !== history.worktree_ref ||
      manifest.registry_head !== input.registryHead || manifest.history_sha256 !== input.historySha256 ||
      manifest.mapping_sha256 !== input.mappingSha256
    ) throw unsafe("snapshot_changed");

    const [sourceRoot, worktreeRoot, commonRoot] = await Promise.all([
      realpath(input.sourcePath), realpath(input.worktreePath), realpath(input.commonGitDir),
    ]).catch(() => { throw unsafe("snapshot_changed"); });
    const sourceTop = await git(input.runner, sourceRoot, ["rev-parse", "--show-toplevel"]);
    const worktreeTop = await git(input.runner, worktreeRoot, ["rev-parse", "--show-toplevel"]);
    const sourceCommon = await realpath(resolve(sourceRoot, await git(input.runner, sourceRoot, ["rev-parse", "--git-common-dir"])));
    const worktreeCommon = await realpath(resolve(worktreeRoot, await git(input.runner, worktreeRoot, ["rev-parse", "--git-common-dir"])));
    if (sourceTop !== sourceRoot || worktreeTop !== worktreeRoot || sourceCommon !== commonRoot || worktreeCommon !== commonRoot) {
      throw unsafe("snapshot_changed");
    }
    const sourceBranch = await git(input.runner, sourceRoot, ["symbolic-ref", "-q", "HEAD"]);
    const sourceHead = await git(input.runner, sourceRoot, ["rev-parse", "HEAD"]);
    const worktreeHead = await git(input.runner, worktreeRoot, ["rev-parse", "HEAD"]);
    if (sourceBranch !== manifest.source_ref || sourceHead !== manifest.source_head || worktreeHead !== manifest.worktree_head || history.head_sha !== worktreeHead) {
      throw unsafe("snapshot_changed");
    }
    const assertSourceTrusted = () => (input.sourceTrust ?? productionSourceTrust).assertTrustedSource({
      runner: input.runner,
      sourcePath: sourceRoot,
      repositorySlug: input.repositorySlug,
      sourceRef: manifest.source_ref,
      sourceHead: manifest.source_head,
    });
    await assertSourceTrusted();

    const nonIntegrated = (await git(input.runner, worktreeRoot, ["rev-list", "--reverse", "--topo-order", `${sourceHead}..${worktreeHead}`]))
      .split("\n").filter(Boolean);
    if (nonIntegrated.length === 0 || nonIntegrated.length > MAX_COMMITS) {
      throw unsafe("scope_unsupported");
    }
    if (nonIntegrated.length !== manifest.commits.length) throw unsafe("patch_mismatch");
    if (nonIntegrated.some((commit, index) => commit !== manifest.commits[index]?.worktree_commit)) throw unsafe("patch_mismatch");
    const integrationCommits = manifest.commits.map((entry) => entry.integration_commit);
    if (new Set(integrationCommits).size !== integrationCommits.length) throw unsafe("integration_untrusted");
    for (let index = 0; index < manifest.commits.length; index += 1) {
      const pair = manifest.commits[index] as HistoricalCleanupManifest["commits"][number];
      const isAncestor = await input.runner.run("git", ["--no-optional-locks", "merge-base", "--is-ancestor", pair.integration_commit, sourceHead], { cwd: sourceRoot })
        .then(() => true, () => false);
      if (!isAncestor) throw unsafe("integration_untrusted");
      if (index > 0) {
        const ordered = await input.runner.run("git", ["--no-optional-locks", "merge-base", "--is-ancestor", integrationCommits[index - 1]!, pair.integration_commit], { cwd: sourceRoot })
          .then(() => true, () => false);
        if (!ordered) throw unsafe("integration_untrusted");
      }
      if (!((await exactDiff(input.runner, worktreeRoot, pair.worktree_commit)).equals(await exactDiff(input.runner, sourceRoot, pair.integration_commit)))) {
        throw unsafe("patch_mismatch");
      }
    }
    await verifyBundleRetained(input.runner, manifest, sourceRoot, worktreeRoot, commonRoot, input.managedRoots, retained);
    const sources = await verifyArtifactsRetained(input, manifest, retained);
    const verified: VerifiedHistoricalCleanupProof = {
      policy: manifest.policy,
      proofSha256: sha256(proof.bytes),
      inventorySha256: manifest.inventory_sha256,
      sourceHead,
      sourceRef: manifest.source_ref,
      worktreeHead,
      artifactPaths: manifest.artifacts.map((artifact) => artifact.path),
    };
    return await use({
      verified,
      sourceArtifacts: sources.map((source) => ({ path: source.path, descriptor: source.handle.fd })),
      assertSourceTrusted,
      assertArtifactsUnchanged: async () => {
        assertDeclaredInventory(await ignoredArtifactInventory(input), manifest, "snapshot_changed");
        for (const snapshot of retained) await assertRetainedFileUnchanged(snapshot);
      },
    });
  } finally {
    await closeRetainedFiles(retained);
  }
}

export async function verifyHistoricalCleanupProof(input: HistoricalCleanupProofInput): Promise<VerifiedHistoricalCleanupProof> {
  return withVerifiedHistoricalCleanupProof(input, async ({ verified }) => verified);
}
