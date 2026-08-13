import { isAbsolute, normalize, sep } from "node:path";

import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { MAX_HANDOFF_BYTES } from "./handoff.js";
import type { ProcessResult, ProcessRunOptions } from "./process.js";

export interface RegistryMutationResult {
  /** Exact registry-relative paths that this mutation changed and must stage. */
  paths: readonly string[];
}

export type RegistryMutation = () => Promise<RegistryMutationResult>;

export interface ProcessRunnerLike {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult>;
}

interface RawProcessRunnerLike extends ProcessRunnerLike {
  runRaw(command: string, args: string[], options: ProcessRunOptions | undefined, maximumBytes: number): Promise<Buffer>;
}

export interface RegistryTransactionResult {
  commit: string;
  changed: boolean;
}

function nonEmptyLines(output: string): string[] {
  return output.split("\n").filter((line) => line.length > 0);
}

function changedPaths(status: string): string[] {
  return nonEmptyLines(status).map((line) => line.slice(3));
}

function isSafeRegistryRelativePath(path: string): boolean {
  if (!path || path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) return false;
  const normalized = normalize(path);
  return normalized !== "." && normalized !== ".." && !normalized.startsWith(`..${sep}`);
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
  ) {}

  /**
   * Requires an exact path in the current clean HEAD tree to be a regular file.
   * This deliberately consults Git metadata rather than trusting the worktree.
   */
  async assertHeadRegularFile(relativePath: string): Promise<void> {
    await this.headRegularBlobObject(relativePath);
  }

  /** Reads the exact regular blob object ID selected by HEAD tree metadata. */
  private async headRegularBlobObject(relativePath: string): Promise<string> {
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
  async readHeadRegularBlob(relativePath: string): Promise<Buffer> {
    const objectId = await this.headRegularBlobObject(relativePath);
    const rawRunner = this.runner as Partial<RawProcessRunnerLike>;
    if (typeof rawRunner.runRaw !== "function") {
      throw new ControlError("REGISTRY_CORRUPT", "Registry runner cannot read committed blob bytes", { relativePath });
    }
    try {
      const bytes = await rawRunner.runRaw(
        "git",
        ["cat-file", "blob", objectId],
        { cwd: this.config.registryDir },
        MAX_HANDOFF_BYTES,
      );
      if (bytes.length > MAX_HANDOFF_BYTES) {
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

  /** Reads a bounded, valid UTF-8 Handoff from a proven regular HEAD blob. */
  async readHeadRegularFile(relativePath: string): Promise<string> {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await this.readHeadRegularBlob(relativePath));
    } catch (cause) {
      if (cause instanceof ControlError && cause.code === "HANDOFF_MISSING") throw cause;
      throw new ControlError("REGISTRY_CORRUPT", "Registry HEAD blob is not valid UTF-8", { relativePath });
    }
  }

  async transact(message: string, mutate: RegistryMutation): Promise<RegistryTransactionResult> {
    const initialStatus = await this.git(["status", "--porcelain"]);
    if (initialStatus.stdout.trim()) {
      throw new ControlError("REGISTRY_DIRTY", "Registry checkout has pre-existing changes", {
        registryDir: this.config.registryDir,
      });
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

    const mutation = await mutate();
    const stagedPaths = [...mutation.paths];
    for (const path of stagedPaths) {
      if (!isSafeRegistryRelativePath(path)) {
        throw new ControlError("INVALID_MUTATION_PATH", "Registry mutations must return safe relative paths", { path });
      }
    }

    const statusAfterMutation = await this.git(["status", "--porcelain", "--untracked-files=all"]);
    const changed = changedPaths(statusAfterMutation.stdout);
    if (changed.length === 0) {
      return { commit: initialHead, changed: false };
    }

    const stagedPathSet = new Set(stagedPaths);
    const unreported = changed.filter((path) => !stagedPathSet.has(path));
    if (stagedPaths.length === 0 || unreported.length > 0) {
      throw new ControlError(
        "MUTATION_PATH_MISMATCH",
        "Registry mutation changed paths not explicitly returned for staging",
        { changed, stagedPaths, unreported },
      );
    }

    await this.git(["add", "--", ...stagedPaths]);
    await this.git(["commit", "-m", message]);
    const commit = await this.revision("HEAD");

    try {
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

  private async git(args: string[]): Promise<ProcessResult> {
    return this.runner.run("git", args, { cwd: this.config.registryDir });
  }

  private async revision(ref: string): Promise<string> {
    return (await this.git(["rev-parse", ref])).stdout.trim();
  }
}
