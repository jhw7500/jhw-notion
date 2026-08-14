import { isAbsolute, normalize, sep } from "node:path";
import { realpath } from "node:fs/promises";

import type { ControlConfig } from "./config.js";
import { MAX_REGISTRY_RECORD_BYTES, type RegistryDirectoryEntry } from "./codec.js";
import { ControlError } from "./errors.js";
import { MAX_HANDOFF_BYTES } from "./handoff.js";
import type { ProcessResult, ProcessRunOptions } from "./process.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";
import { githubSlugFromRemote } from "./github-source.js";

export interface RegistryMutationResult {
  /** Exact registry-relative paths that this mutation changed and must stage. */
  paths: readonly string[];
}

export type RegistryMutation = () => Promise<RegistryMutationResult>;

export interface ProcessRunnerLike {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult>;
  runRaw?(command: string, args: string[], options: ProcessRunOptions | undefined, maximumBytes: number): Promise<Buffer>;
}

interface RawProcessRunnerLike extends ProcessRunnerLike {
  runRaw(command: string, args: string[], options: ProcessRunOptions | undefined, maximumBytes: number): Promise<Buffer>;
}

const MAX_HEAD_DIRECTORY_ENTRIES = 10_000;
const MAX_HEAD_TREE_ROW_BYTES = 384;

export interface RegistryTransactionResult {
  commit: string;
  changed: boolean;
}

function isSafeRegistryRelativePath(path: string): boolean {
  if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) return false;
  const normalized = normalize(path);
  return normalized === path && normalized !== "." && normalized !== ".." && !normalized.startsWith(`..${sep}`) &&
    path.split("/").every((component) => component.length > 0 && component !== "." && component !== "..");
}

function isNonFastForwardPushFailure(error: ControlError): boolean {
  const stderr = typeof error.details.stderr === "string" ? error.details.stderr : "";
  return /(?:non-fast-forward|\(fetch first\)|Updates were rejected because the remote contains work)/i.test(stderr);
}

/**
 * Serializes a registry mutation into one local commit and one non-forced
 * fast-forward push. Callers must already hold the host mutation lock.
 */
export class RegistryGit {
  constructor(
    private readonly config: ControlConfig,
    private readonly runner: ProcessRunnerLike,
    private readonly sensitiveData: SensitiveDataPolicy = createSensitiveDataPolicy(process.env, [
      config.registryDir,
      config.stateDir,
      config.worktreeRoot,
    ]),
    private readonly isolatedFixtureRemote?: () => Promise<void>,
  ) {}

  /**
   * Requires an exact path in the current clean HEAD tree to be a regular file.
   * This deliberately consults Git metadata rather than trusting the worktree.
   */
  async assertHeadRegularFile(relativePath: string): Promise<void> {
    await this.headRegularBlobObjectId(relativePath);
  }

  /** Reads the exact regular blob object ID selected by HEAD tree metadata. */
  async headRegularBlobObjectId(relativePath: string): Promise<string> {
    if (!isSafeRegistryRelativePath(relativePath)) {
      throw new ControlError("INVALID_REGISTRY_PATH", "Registry file path must be a safe relative path", { relativePath });
    }

    let output: string;
    try {
      output = (await this.git(["ls-tree", "-z", "HEAD", "--", relativePath])).stdout;
    } catch {
      throw new ControlError("REGISTRY_CORRUPT", "Unable to inspect Registry HEAD file", { relativePath });
    }

    const entries = output.split("\0").filter((entry) => entry.length > 0);
    if (entries.length === 0) {
      throw new ControlError("HANDOFF_MISSING", "Registry HEAD does not contain the required file", { relativePath });
    }
    if (entries.length !== 1) {
      throw new ControlError("REGISTRY_CORRUPT", "Registry HEAD returned an ambiguous file entry", { relativePath });
    }

    const tab = entries[0].indexOf("\t");
    const metadata = tab >= 0 ? entries[0].slice(0, tab).split(" ") : [];
    const entryPath = tab >= 0 ? entries[0].slice(tab + 1) : "";
    const [mode, type, objectId] = metadata;
    if (
      entryPath !== relativePath ||
      (mode !== "100644" && mode !== "100755") ||
      type !== "blob" ||
      !/^[0-9a-f]{40,64}$/.test(objectId ?? "")
    ) {
      throw new ControlError("REGISTRY_CORRUPT", "Registry HEAD path is not a regular file", { relativePath });
    }
    return objectId as string;
  }

  /**
   * Reads exact committed blob bytes. This bypasses the text/redacting process
   * path because a Handoff is immutable evidence and must survive restoration
   * byte-for-byte (including content that happens to equal a host secret).
   */
  async readHeadRegularBlob(relativePath: string, maximumBytes = MAX_REGISTRY_RECORD_BYTES): Promise<Buffer> {
    const objectId = await this.headRegularBlobObjectId(relativePath);
    const rawRunner = this.runner as Partial<RawProcessRunnerLike>;
    if (typeof rawRunner.runRaw !== "function") {
      throw new ControlError("REGISTRY_CORRUPT", "Registry runner cannot read committed blob bytes", { relativePath });
    }
    await this.assertHeadBlobSize(relativePath, objectId, maximumBytes);
    try {
      const bytes = await rawRunner.runRaw(
        "git",
        ["cat-file", "blob", objectId],
        { cwd: this.config.registryDir },
        maximumBytes,
      );
      if (bytes.length > maximumBytes) {
        // Defend the contract even for alternate ProcessRunner implementations.
        throw new ControlError("RAW_OUTPUT_TOO_LARGE", "Raw blob exceeds the Handoff byte limit");
      }
      return bytes;
    } catch {
      // In particular, never attach a Buffer or raw subprocess output here.
      throw new ControlError("REGISTRY_CORRUPT", "Unable to read Registry HEAD blob", {
        relativePath,
        object_id: objectId,
      });
    }
  }

  /** Lists the exact direct children selected by a proven regular HEAD tree. */
  async listHeadDirectoryEntries(relativeDirectory: string, maximumEntries: number): Promise<RegistryDirectoryEntry[]> {
    if (!isSafeRegistryRelativePath(relativeDirectory) || !Number.isSafeInteger(maximumEntries) ||
      maximumEntries < 1 || maximumEntries > MAX_HEAD_DIRECTORY_ENTRIES) {
      throw new ControlError("INVALID_REGISTRY_PATH", "Registry directory path or bound is invalid");
    }
    let roots: string[];
    try {
      const selected = await this.rawGit(
        ["ls-tree", "-z", "HEAD", "--", relativeDirectory],
        Buffer.byteLength(relativeDirectory, "utf8") + 128,
      );
      roots = this.decodeNulRows(selected);
    } catch {
      throw new ControlError("REGISTRY_CORRUPT", "Unable to inspect Registry HEAD directory");
    }
    if (roots.length === 0) return [];
    if (roots.length !== 1) throw new ControlError("REGISTRY_CORRUPT", "Registry HEAD directory is ambiguous");
    const rootTab = (roots[0] as string).indexOf("\t");
    const [rootMode, rootType, treeId] = rootTab >= 0 ? (roots[0] as string).slice(0, rootTab).split(" ") : [];
    const rootPath = rootTab >= 0 ? (roots[0] as string).slice(rootTab + 1) : "";
    if (rootMode !== "040000" || rootType !== "tree" || rootPath !== relativeDirectory || !/^[0-9a-f]{40,64}$/.test(treeId ?? "")) {
      throw new ControlError("REGISTRY_CORRUPT", "Registry HEAD path is not a directory tree");
    }
    let rows: string[];
    try {
      const output = await this.rawGit(
        ["ls-tree", "-z", treeId as string],
        (maximumEntries + 1) * MAX_HEAD_TREE_ROW_BYTES,
      );
      rows = this.decodeNulRows(output);
    } catch {
      throw new ControlError("REGISTRY_CORRUPT", "Unable to enumerate Registry HEAD directory");
    }
    if (rows.length > maximumEntries) throw new ControlError("REGISTRY_CORRUPT", "Registry HEAD directory exceeds its bound");
    const entries = rows.map((row): RegistryDirectoryEntry => {
      const tab = row.indexOf("\t");
      const [mode, type] = tab >= 0 ? row.slice(0, tab).split(" ") : [];
      const name = tab >= 0 ? row.slice(tab + 1) : "";
      if (!name || name.includes("/") || name === "." || name === "..") {
        throw new ControlError("REGISTRY_CORRUPT", "Registry HEAD directory contains an unsafe name");
      }
      if (mode === "040000" && type === "tree") return { name, kind: "directory" };
      if ((mode === "100644" || mode === "100755") && type === "blob") return { name, kind: "file" };
      throw new ControlError("REGISTRY_CORRUPT", "Registry HEAD directory contains a non-regular entry");
    });
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  private async rawGit(args: string[], maximumBytes: number): Promise<Buffer> {
    const rawRunner = this.runner as Partial<RawProcessRunnerLike>;
    if (typeof rawRunner.runRaw !== "function") {
      throw new ControlError("REGISTRY_CORRUPT", "Registry runner cannot capture exact HEAD tree bytes");
    }
    return rawRunner.runRaw("git", args, { cwd: this.config.registryDir }, maximumBytes);
  }

  private decodeNulRows(bytes: Buffer): string[] {
    if (bytes.length === 0) return [];
    if (bytes.at(-1) !== 0) throw new ControlError("REGISTRY_CORRUPT", "Registry HEAD tree output is truncated");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const rows = text.slice(0, -1).split("\0");
    if (rows.some((row) => row.length === 0)) {
      throw new ControlError("REGISTRY_CORRUPT", "Registry HEAD tree output contains an empty row");
    }
    this.sensitiveData.assertSafe(rows);
    return rows;
  }

  /** Proves a HEAD-selected blob is bounded before requesting its content. */
  private async assertHeadBlobSize(relativePath: string, objectId: string, maximumBytes: number): Promise<void> {
    let output: string;
    try {
      output = (await this.git(["cat-file", "-s", objectId])).stdout;
    } catch {
      throw new ControlError("REGISTRY_CORRUPT", "Unable to inspect Registry HEAD blob size", {
        relativePath,
        object_id: objectId,
      });
    }
    if (!/^(?:0|[1-9][0-9]*)\n?$/.test(output)) {
      throw new ControlError("REGISTRY_CORRUPT", "Registry HEAD blob size is invalid", {
        relativePath,
        object_id: objectId,
      });
    }
    const size = BigInt(output.endsWith("\n") ? output.slice(0, -1) : output);
    if (size > BigInt(maximumBytes)) {
      throw new ControlError("REGISTRY_CORRUPT", "Registry HEAD blob exceeds the Handoff byte limit", {
        relativePath,
        object_id: objectId,
      });
    }
  }

  /** Reads a bounded, valid UTF-8 Handoff from a proven regular HEAD blob. */
  async readHeadRegularFile(relativePath: string): Promise<string> {
    try {
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await this.readHeadRegularBlob(relativePath, MAX_HANDOFF_BYTES),
      );
      this.sensitiveData.assertSafe(content);
      return content;
    } catch (cause) {
      if (cause instanceof ControlError && (cause.code === "HANDOFF_MISSING" || cause.code.startsWith("SENSITIVE_"))) throw cause;
      throw new ControlError("REGISTRY_CORRUPT", "Registry HEAD blob is not valid UTF-8", { relativePath });
    }
  }

  async transact(message: string, mutate: RegistryMutation): Promise<RegistryTransactionResult> {
    const initialHead = await this.assertReady();
    const mutation = await mutate();
    const stagedPaths = [...mutation.paths];
    if (new Set(stagedPaths).size !== stagedPaths.length || stagedPaths.length > MAX_HEAD_DIRECTORY_ENTRIES) {
      throw new ControlError("INVALID_MUTATION_PATH", "Registry mutation paths must be unique and bounded");
    }
    for (const path of stagedPaths) {
      if (!isSafeRegistryRelativePath(path)) {
        throw new ControlError("INVALID_MUTATION_PATH", "Registry mutations must return safe relative paths");
      }
    }

    await this.assertVisibleIndex();
    const changed = (await this.registryStatus()).map((entry) => entry.path);
    if (changed.length === 0) {
      return { commit: initialHead, changed: false };
    }

    const stagedPathSet = new Set(stagedPaths);
    const unreported = changed.filter((path) => !stagedPathSet.has(path));
    if (stagedPaths.length === 0 || unreported.length > 0) {
      throw new ControlError(
        "MUTATION_PATH_MISMATCH",
        "Registry mutation changed paths not explicitly returned for staging",
      );
    }

    // Force-add only the caller-declared canonical paths. This prevents a
    // tracked/local exclude from turning a successful transaction into an
    // uncommitted worktree-only record while retaining the exact path audit.
    await this.git(["add", "-f", "--", ...stagedPaths]);
    await this.assertVisibleIndex();
    const staged = await this.nulPathList(["diff", "--cached", "--name-only", "-z", "HEAD", "--"]);
    const unreportedStaged = staged.filter((path) => !stagedPathSet.has(path));
    if (staged.length === 0 || unreportedStaged.length > 0) {
      throw new ControlError("MUTATION_PATH_MISMATCH", "Registry staged tree does not match declared mutation paths");
    }
    const remaining = await this.registryStatus();
    const remainingUnreported = remaining.map((entry) => entry.path).filter((path) => !stagedPathSet.has(path));
    if (remainingUnreported.length > 0) {
      throw new ControlError("MUTATION_PATH_MISMATCH", "Registry mutation left an unreported working-tree path");
    }
    await this.git(["commit", "-m", message]);
    const commit = await this.revision("HEAD");

    try {
      await this.assertRemoteIdentity();
      await this.git(["push", this.config.registryRemote, `HEAD:${this.config.registryBranch}`]);
    } catch (cause) {
      if (cause instanceof ControlError && cause.code === "COMMAND_FAILED" && isNonFastForwardPushFailure(cause)) {
        throw new ControlError("REMOTE_DIVERGED", "Registry push was rejected; no retry or force push was attempted", {
          local: commit,
          remote: `${this.config.registryRemote}/${this.config.registryBranch}`,
        });
      }
      throw cause;
    }

    try {
      await this.git(["fetch", this.config.registryRemote, this.config.registryBranch]);
      const verifiedHead = await this.revision("HEAD");
      const verifiedRemoteHead = await this.revision(`${this.config.registryRemote}/${this.config.registryBranch}`);
      if (verifiedHead !== verifiedRemoteHead) {
        throw new ControlError("REMOTE_VERIFY_FAILED", "Registry remote did not verify at the pushed commit", {
          local: verifiedHead,
          remote: verifiedRemoteHead,
        });
      }
    } catch (cause) {
      if (cause instanceof ControlError && cause.code === "REMOTE_VERIFY_FAILED") throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new ControlError("REMOTE_VERIFY_FAILED", "Registry remote verification failed", { cause: message });
    }

    return { commit, changed: true };
  }

  /** Proves the exact mutation precondition without changing Registry state. */
  async assertReady(): Promise<string> {
    await this.assertRemoteIdentity();
    await this.assertVisibleIndex();
    const initialStatus = await this.registryStatus();
    if (initialStatus.length > 0) {
      throw new ControlError("REGISTRY_DIRTY", "Registry checkout has pre-existing or ignored changes");
    }

    await this.git(["fetch", this.config.registryRemote, this.config.registryBranch]);
    const initialHead = await this.revision("HEAD");
    const initialRemoteHead = await this.revision(`${this.config.registryRemote}/${this.config.registryBranch}`);
    if (initialHead !== initialRemoteHead) {
      throw new ControlError("REMOTE_DIVERGED", "Registry checkout is not at the remote branch head", {
        local: initialHead,
        remote: initialRemoteHead,
      });
    }

    return initialHead;
  }

  private async assertRemoteIdentity(): Promise<void> {
    if (this.isolatedFixtureRemote) return this.isolatedFixtureRemote();
    const observedRoot = (await this.git(["rev-parse", "--show-toplevel"])).stdout.trim();
    let configuredRoot: string;
    let actualRoot: string;
    try {
      [configuredRoot, actualRoot] = await Promise.all([
        realpath(this.config.registryDir),
        realpath(observedRoot),
      ]);
    } catch {
      throw new ControlError("REGISTRY_ROOT_MISMATCH", "Registry directory is not the exact Git checkout root");
    }
    if (configuredRoot !== actualRoot) {
      throw new ControlError("REGISTRY_ROOT_MISMATCH", "Registry directory is not the exact Git checkout root");
    }
    const fetchUrls = (await this.git([
      "remote", "get-url", "--all", this.config.registryRemote,
    ])).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const pushUrls = (await this.git([
      "remote", "get-url", "--push", "--all", this.config.registryRemote,
    ])).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (fetchUrls.length !== 1 || pushUrls.length !== 1) {
      throw new ControlError("AMBIGUOUS_REGISTRY_REMOTE", "Registry remote must have exactly one fetch and push URL");
    }
    let fetchSlug: string;
    let pushSlug: string;
    try {
      fetchSlug = githubSlugFromRemote(fetchUrls[0] as string, true);
      pushSlug = githubSlugFromRemote(pushUrls[0] as string, true);
    } catch {
      throw new ControlError("REGISTRY_REMOTE_NOT_SSH", "Registry fetch and push URLs must be canonical GitHub SSH URLs");
    }
    if (
      fetchSlug.toLowerCase() !== this.config.registryRepository.toLowerCase() ||
      pushSlug.toLowerCase() !== this.config.registryRepository.toLowerCase()
    ) {
      throw new ControlError("REGISTRY_REMOTE_MISMATCH", "Registry fetch or push URL does not match configured repository identity");
    }
  }

  private async assertVisibleIndex(): Promise<void> {
    let rows: string[];
    try {
      rows = this.decodeNulRows(await this.rawGit(
        ["ls-files", "-v", "-z", "--"],
        MAX_HEAD_DIRECTORY_ENTRIES * MAX_HEAD_TREE_ROW_BYTES,
      ));
    } catch {
      throw new ControlError("REGISTRY_INDEX_UNSAFE", "Registry index visibility could not be proven");
    }
    if (rows.length > MAX_HEAD_DIRECTORY_ENTRIES) {
      throw new ControlError("REGISTRY_INDEX_UNSAFE", "Registry index exceeds its bounded audit");
    }
    for (const row of rows) {
      if (!row.startsWith("H ") || !isSafeRegistryRelativePath(row.slice(2))) {
        throw new ControlError(
          "REGISTRY_INDEX_UNSAFE",
          "Registry index contains a hidden, sparse, or noncanonical entry",
        );
      }
    }
  }

  private async registryStatus(): Promise<Array<{ status: string; path: string }>> {
    let rows: string[];
    try {
      rows = this.decodeNulRows(await this.rawGit(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
        MAX_HEAD_DIRECTORY_ENTRIES * MAX_HEAD_TREE_ROW_BYTES,
      ));
    } catch {
      throw new ControlError("REGISTRY_DIRTY", "Registry checkout status could not be proven exactly");
    }
    if (rows.length > MAX_HEAD_DIRECTORY_ENTRIES) {
      throw new ControlError("REGISTRY_DIRTY", "Registry checkout status exceeds its bounded audit");
    }
    const entries: Array<{ status: string; path: string }> = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] as string;
      const status = row.slice(0, 2);
      const path = row.slice(3);
      if (row.length < 4 || row[2] !== " " || !isSafeRegistryRelativePath(path)) {
        throw new ControlError("REGISTRY_DIRTY", "Registry checkout status contains an ambiguous path");
      }
      entries.push({ status, path });
      if (/[RC]/.test(status)) {
        const originalPath = rows[index + 1];
        if (!originalPath || !isSafeRegistryRelativePath(originalPath)) {
          throw new ControlError("REGISTRY_DIRTY", "Registry checkout rename source is invalid");
        }
        index += 1;
        if (status.includes("R")) entries.push({ status, path: originalPath });
      }
    }
    return entries;
  }

  private async nulPathList(args: string[]): Promise<string[]> {
    let rows: string[];
    try {
      rows = this.decodeNulRows(await this.rawGit(args, MAX_HEAD_DIRECTORY_ENTRIES * MAX_HEAD_TREE_ROW_BYTES));
    } catch {
      throw new ControlError("MUTATION_PATH_MISMATCH", "Registry staged paths could not be proven exactly");
    }
    if (rows.length > MAX_HEAD_DIRECTORY_ENTRIES || rows.some((path) => !isSafeRegistryRelativePath(path))) {
      throw new ControlError("MUTATION_PATH_MISMATCH", "Registry staged path audit is invalid");
    }
    return rows;
  }

  private async git(args: string[]): Promise<ProcessResult> {
    return this.runner.run("git", args, { cwd: this.config.registryDir });
  }

  private async revision(ref: string): Promise<string> {
    return (await this.git(["rev-parse", ref])).stdout.trim();
  }
}
