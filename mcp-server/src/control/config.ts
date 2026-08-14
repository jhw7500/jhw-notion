import { isAbsolute, join, parse, resolve } from "node:path";

import { ControlError } from "./errors.js";

/** Non-secret coordinates required to operate the host-side project registry. */
export interface ControlConfig {
  registryDir: string;
  registryRemote: string;
  registryBranch: string;
  worktreeRoot: string;
  buildHost: string;
  githubOwner: string;
  projectNumber: number;
  registryRepository: string;
  preflightProjectItemId: string;
  preflightRegistryIssueNumber: number;
  stateDir: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ControlError("INVALID_CONFIG", `Missing required control configuration: ${key}`, { key });
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value || fallback;
}

function projectNumber(env: NodeJS.ProcessEnv): number {
  const value = required(env, "JHW_PROJECT_NUMBER");
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new ControlError("INVALID_CONFIG", "JHW_PROJECT_NUMBER must be a positive integer", {
      key: "JHW_PROJECT_NUMBER",
    });
  }
  return Number(value);
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string): number {
  const value = required(env, key);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ControlError("INVALID_CONFIG", `${key} must be a positive integer`, { key });
  }
  return Number(value);
}

function coordinate(env: NodeJS.ProcessEnv, key: string, pattern: RegExp, description: string): string {
  const value = required(env, key);
  if (!pattern.test(value)) throw new ControlError("INVALID_CONFIG", `${key} ${description}`, { key });
  return value;
}

function absolutePath(env: NodeJS.ProcessEnv, key: string, fallback?: string): string {
  const value = fallback === undefined ? required(env, key) : optional(env, key, fallback);
  if (!isAbsolute(value)) {
    throw new ControlError("INVALID_CONFIG", `${key} must be an absolute path`, { key });
  }
  if (resolve(value) === parse(resolve(value)).root) {
    throw new ControlError("INVALID_CONFIG", `${key} must not be a filesystem root`, { key });
  }
  return value;
}

function boundedText(value: string, key: string): string {
  if (Buffer.byteLength(value, "utf8") > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ControlError("INVALID_CONFIG", `${key} must be bounded single-line text`, { key });
  }
  return value;
}

function registryRemote(env: NodeJS.ProcessEnv): string {
  const value = optional(env, "JHW_REGISTRY_REMOTE", "origin");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new ControlError("INVALID_CONFIG", "JHW_REGISTRY_REMOTE must be a canonical remote name", {
      key: "JHW_REGISTRY_REMOTE",
    });
  }
  return value;
}

function registryBranch(env: NodeJS.ProcessEnv): string {
  const value = optional(env, "JHW_REGISTRY_BRANCH", "main");
  const components = value.split("/");
  if (
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".") ||
    components.some((component) => !component || component === "." || component === ".." || component.endsWith(".lock"))
  ) {
    throw new ControlError("INVALID_CONFIG", "JHW_REGISTRY_BRANCH must be a canonical branch name", {
      key: "JHW_REGISTRY_BRANCH",
    });
  }
  return value;
}

/**
 * Loads only non-secret host-control configuration. Credential tokens deliberately
 * remain in the process environment until a `gh` child environment is constructed.
 */
export function loadControlConfig(env: NodeJS.ProcessEnv = process.env): ControlConfig {
  const explicitStateDir = env.JHW_CONTROL_STATE_DIR?.trim();
  const stateDir = explicitStateDir
    ? absolutePath(env, "JHW_CONTROL_STATE_DIR")
    : absolutePath(env, "JHW_CONTROL_STATE_DIR", join(required(env, "HOME"), ".local/state/jhw-control"));
  const githubOwner = required(env, "JHW_GITHUB_OWNER");
  const registryRepository = coordinate(
    env,
    "JHW_REGISTRY_REPOSITORY",
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/,
    "must be an owner/name repository slug",
  );
  if (registryRepository.split("/", 1)[0]?.toLowerCase() !== githubOwner.toLowerCase()) {
    throw new ControlError("INVALID_CONFIG", "JHW_REGISTRY_REPOSITORY must be owned by JHW_GITHUB_OWNER", {
      key: "JHW_REGISTRY_REPOSITORY",
    });
  }
  return {
    registryDir: absolutePath(env, "JHW_REGISTRY_DIR"),
    registryRemote: registryRemote(env),
    registryBranch: registryBranch(env),
    worktreeRoot: absolutePath(env, "JHW_WORKTREE_ROOT"),
    buildHost: boundedText(required(env, "JHW_BUILD_HOST"), "JHW_BUILD_HOST"),
    githubOwner,
    projectNumber: projectNumber(env),
    registryRepository,
    preflightProjectItemId: boundedText(coordinate(
      env,
      "JHW_PREFLIGHT_PROJECT_ITEM_ID",
      /^PVTI_[A-Za-z0-9_-]+$/,
      "must be a ProjectV2 item node ID",
    ), "JHW_PREFLIGHT_PROJECT_ITEM_ID"),
    preflightRegistryIssueNumber: positiveInteger(env, "JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER"),
    stateDir,
  };
}
