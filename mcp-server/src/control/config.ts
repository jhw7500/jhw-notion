import { join } from "node:path";

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

/**
 * Loads only non-secret host-control configuration. Credential tokens deliberately
 * remain in the process environment until a `gh` child environment is constructed.
 */
export function loadControlConfig(env: NodeJS.ProcessEnv = process.env): ControlConfig {
  const home = required(env, "HOME");
  return {
    registryDir: required(env, "JHW_REGISTRY_DIR"),
    registryRemote: optional(env, "JHW_REGISTRY_REMOTE", "origin"),
    registryBranch: optional(env, "JHW_REGISTRY_BRANCH", "main"),
    worktreeRoot: required(env, "JHW_WORKTREE_ROOT"),
    buildHost: required(env, "JHW_BUILD_HOST"),
    githubOwner: required(env, "JHW_GITHUB_OWNER"),
    projectNumber: projectNumber(env),
    stateDir: optional(env, "JHW_CONTROL_STATE_DIR", join(home, ".local/state/jhw-control")),
  };
}
