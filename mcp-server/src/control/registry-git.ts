import { isAbsolute, normalize, sep } from "node:path";

import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import type { ProcessResult, ProcessRunOptions } from "./process.js";

export interface RegistryMutationResult {
  /** Exact registry-relative paths that this mutation changed and must stage. */
  paths: readonly string[];
}

export type RegistryMutation = () => Promise<RegistryMutationResult>;

export interface ProcessRunnerLike {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessResult>;
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
