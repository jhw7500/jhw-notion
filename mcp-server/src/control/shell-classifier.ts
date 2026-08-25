import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { OperationRequirement } from "./guard-protocol.js";
import type { ResourceRef } from "./work-contract.js";

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_ARGV_ENTRIES = 256;
const MAX_ARG_BYTES = 8 * 1024;
const MAX_LOCAL_SCRIPT_BYTES = 1024 * 1024;
const scriptOpenFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export type ExecutionBoundary = "hook" | "guarded_command" | "tracker" | "notion" | "board";
export type OperationRisk = "low" | "medium" | "high";
export type UnresolvedCapability =
  | "git.commit"
  | "git.publish"
  | "tracker.mutate"
  | "notion.mutate"
  | "board.observe"
  | "board.execute"
  | "remote.execute"
  | "firmware.change"
  | "deploy.execute";

export interface ShellBoundarySignal {
  capability: UnresolvedCapability;
  boundary: Exclude<ExecutionBoundary, "hook">;
}

export interface ShellClassifierContext {
  trusted_worktree_path: string;
  cwd: string;
  repository: Extract<ResourceRef, { kind: "repository" }>;
  issue?: Extract<ResourceRef, { kind: "issue" }>;
  notion_database?: Extract<ResourceRef, { kind: "notion_database" }>;
  board?: Extract<ResourceRef, { kind: "board" }>;
  remote_host?: Extract<ResourceRef, { kind: "remote_host" }>;
  firmware_target?: Extract<ResourceRef, { kind: "firmware_target" }>;
  deployment_target?: Extract<ResourceRef, { kind: "deployment_target" }>;
}

export interface ShellClassification {
  requirements: OperationRequirement[];
  unresolved_signals: ShellBoundarySignal[];
  risk: OperationRisk;
  execution_boundary: ExecutionBoundary;
  ambiguous: boolean;
  direct_high_risk: boolean;
  self_approval: boolean;
  owned_wrapper?: "guard" | "board";
  /** In-memory digest input only. It must never be copied to a canonical operation or persisted. */
  digest_argv?: string[];
  /** Content identity only; no local script path or bytes leave this boundary. */
  script_content_sha256?: string;
}

export class ShellClassificationError extends Error {
  readonly code: "invalid_shell_input" | "unsafe_local_script";

  constructor(code: ShellClassificationError["code"]) {
    super(code === "unsafe_local_script" ? "Local executable script failed closed" : "Shell input is not bounded");
    this.name = "ShellClassificationError";
    this.code = code;
  }
}

interface Detection {
  capability:
    | "git.commit"
    | "git.publish"
    | "tracker.mutate"
    | "board.execute"
    | "remote.execute"
    | "firmware.change"
    | "deploy.execute";
  boundary: ExecutionBoundary;
  risk: OperationRisk;
  repository_target?: "current" | "unresolved";
}

interface ParseResult {
  argv?: string[];
  ambiguous: boolean;
}

const boundaryRank: Record<ExecutionBoundary, number> = {
  hook: 0,
  guarded_command: 1,
  tracker: 2,
  notion: 2,
  board: 3,
};
const riskRank: Record<OperationRisk, number> = { low: 0, medium: 1, high: 2 };

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requirementKey(requirement: OperationRequirement): string {
  return `${requirement.capability}\u0000${requirement.resource.kind}\u0000${requirement.resource.id}`;
}

function signalKey(signal: ShellBoundarySignal): string {
  return `${signal.capability}\u0000${signal.boundary}`;
}

function sortRequirements(requirements: readonly OperationRequirement[]): OperationRequirement[] {
  return [...new Map(requirements.map((requirement) => [requirementKey(requirement), requirement])).values()]
    .sort((left, right) => compare(requirementKey(left), requirementKey(right)));
}

function sortSignals(signals: readonly ShellBoundarySignal[]): ShellBoundarySignal[] {
  return [...new Map(signals.map((signal) => [signalKey(signal), signal])).values()]
    .sort((left, right) => compare(signalKey(left), signalKey(right)));
}

function strongerBoundary(left: ExecutionBoundary, right: ExecutionBoundary): ExecutionBoundary {
  return boundaryRank[right] > boundaryRank[left] ? right : left;
}

function strongerRisk(left: OperationRisk, right: OperationRisk): OperationRisk {
  return riskRank[right] > riskRank[left] ? right : left;
}

function rawWords(command: string): string[] {
  // Removing quote delimiters reconstructs adjacent POSIX quote composition
  // for conservative detection only. It never produces executable argv.
  const dequoted = command.replace(/["']/gu, "");
  return dequoted.match(/--?[A-Za-z0-9][A-Za-z0-9_.-]*|[A-Za-z0-9_./:-]+/g)?.map((word) => word.toLowerCase()) ?? [];
}

function executableName(value: string): string {
  return basename(value).toLowerCase();
}

function findFollowing(words: readonly string[], start: number, values: ReadonlySet<string>, distance = 5): string | undefined {
  for (let index = start + 1; index < Math.min(words.length, start + distance + 1); index += 1) {
    const word = words[index];
    if (word && values.has(word)) return word;
  }
  return undefined;
}

function scanHighRisk(command: string): { detections: Detection[]; selfApproval: boolean } {
  const detections: Detection[] = [];
  let selfApproval = false;
  const add = (detection: Detection): void => {
    const key = `${detection.capability}\u0000${detection.boundary}\u0000${detection.repository_target ?? ""}`;
    if (!detections.some((candidate) =>
      `${candidate.capability}\u0000${candidate.boundary}\u0000${candidate.repository_target ?? ""}` === key)) {
      detections.push(detection);
    }
  };
  const riskCommand = command.replace(/["']/gu, "");
  // GNU env -S accepts its split string attached to the short option. Expose
  // only that opaque payload to the lexical risk scan; never split it as argv.
  const riskScanCommand = riskCommand.replace(/(^|\s)(-[^-\s]*?S)(\S+)/gu, "$1$2 $3");
  const words = rawWords(riskScanCommand);
  const hasWorkingDirectoryOverride = /(?:^|[;&|()\s])(?:cd|pushd|popd)(?:\s|$)|--chdir(?:=|\s|$)/u.test(riskScanCommand);
  const hasGitTargetOption =
    /(?:^|\s)-C(?:\S*)|--(?:git-dir|work-tree)(?:=|\s|$)|\b(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|GIT_INDEX_FILE)=/u
      .test(riskScanCommand) || hasWorkingDirectoryOverride;
  const hasGhRepositoryOption =
    /(?:^|\s)(?:--repo(?:=|\s|$)|-R(?:=|\s|$))|\b(?:GH_REPO|GH_HOST)=|--hostname(?:=|\s|$)/u
      .test(riskScanCommand) || hasWorkingDirectoryOverride;

  for (let index = 0; index < words.length; index += 1) {
    const word = executableName(words[index] as string);
    if (word === "git") {
      const action = findFollowing(words, index, new Set(["commit", "push"]));
      const repositoryTarget = hasGitTargetOption ? "unresolved" as const : "current" as const;
      if (action === "commit") add({
        capability: "git.commit",
        boundary: repositoryTarget === "current" ? "hook" : "guarded_command",
        risk: "medium",
        repository_target: repositoryTarget,
      });
      if (action === "push") add({
        capability: "git.publish",
        boundary: "guarded_command",
        risk: "high",
        repository_target: repositoryTarget,
      });
    }
    if (word === "gh") {
      const family = findFollowing(words, index, new Set(["pr", "release", "issue"]), 8);
      const familyIndex = family ? words.indexOf(family, index + 1) : -1;
      const action = familyIndex >= 0 ? words[familyIndex + 1] : undefined;
      const repositoryTarget = hasGhRepositoryOption ? "unresolved" as const : "current" as const;
      if (family === "pr" && (action === "create" || action === "merge")) {
        add({ capability: "git.publish", boundary: "guarded_command", risk: "high", repository_target: repositoryTarget });
      }
      if (family === "release" && action === "create") {
        add({ capability: "git.publish", boundary: "guarded_command", risk: "high", repository_target: repositoryTarget });
      }
      if (family === "issue" && (action === "close" || action === "edit" || action === "comment")) {
        add({ capability: "tracker.mutate", boundary: "tracker", risk: "high" });
      }
    }
    if (word === "ssh" || word === "scp" || word === "sftp") {
      add({ capability: "remote.execute", boundary: "guarded_command", risk: "high" });
    }
    if (new Set(["flashrom", "dfu-util", "openocd", "esptool", "esptool.py", "fwupdmgr"]).has(word)) {
      add({ capability: "firmware.change", boundary: "board", risk: "high" });
    }
    if (new Set(["iw", "iwconfig", "wpa_cli", "antcfg", "rmmod", "insmod"]).has(word)) {
      add({ capability: "board.execute", boundary: "board", risk: "high" });
    }
    if (word === "kubectl" && findFollowing(words, index, new Set(["apply", "delete", "replace", "patch"]), 3)) {
      add({ capability: "deploy.execute", boundary: "guarded_command", risk: "high" });
    }
    if (word === "helm" && findFollowing(words, index, new Set(["install", "upgrade", "uninstall", "rollback"]), 3)) {
      add({ capability: "deploy.execute", boundary: "guarded_command", risk: "high" });
    }
    if (word === "terraform" && findFollowing(words, index, new Set(["apply", "destroy"]), 3)) {
      add({ capability: "deploy.execute", boundary: "guarded_command", risk: "high" });
    }
    if (word === "jhw-control" && words[index + 1] === "board") {
      const action = words[index + 2];
      if (action && !new Set(["list", "status"]).has(action)) {
        add({ capability: "board.execute", boundary: "board", risk: "high" });
      }
    }
    if (
      word === "jhw-control" && words[index + 1] === "guard" &&
      new Set(["prompt", "approve", "consume"]).has(words[index + 2] ?? "")
    ) {
      selfApproval = true;
    }
  }
  return { detections, selfApproval };
}

function parseSimpleArgv(command: string): ParseResult {
  const argv: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;
  let escaped = false;

  const push = (): void => {
    if (!tokenStarted) return;
    if (Buffer.byteLength(token, "utf8") > MAX_ARG_BYTES || argv.length >= MAX_ARGV_ENTRIES) {
      throw new ShellClassificationError("invalid_shell_input");
    }
    argv.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] as string;
    const next = command[index + 1];
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        if (next === "\n") {
          index += 1;
        } else if (next === "$" || next === "`" || next === '"' || next === "\\") {
          escaped = true;
        } else {
          token += character;
        }
      } else {
        if (character === "$" || character === "`") return { ambiguous: true };
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      if (next === "\n") {
        index += 1;
        continue;
      }
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (character === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (character === "\n" || character === "\r") return { ambiguous: true };
      push();
      continue;
    }
    if (
      ";&|<>()`".includes(character) || character === "$" ||
      "*?[{}".includes(character) || (character === "~" && !tokenStarted) ||
      (character === "<" && next === "<")
    ) {
      return { ambiguous: true };
    }
    token += character;
    tokenStarted = true;
  }
  if (quote !== undefined || escaped) return { ambiguous: true };
  push();
  if (argv.length === 0) return { ambiguous: true };
  const executable = executableName(argv[0] as string);
  if (new Set(["bash", "sh", "zsh", "dash", "ksh"]).has(executable) && argv.includes("-c")) {
    return { ambiguous: true };
  }
  return { argv, ambiguous: false };
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function isAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

function executableArgv(argv: readonly string[]): string[] | undefined {
  let index = 0;
  while (index < argv.length && isAssignment(argv[index] as string)) index += 1;
  if (index >= argv.length) return undefined;
  if (executableName(argv[index] as string) !== "env") return argv.slice(index);

  index += 1;
  while (index < argv.length) {
    const argument = argv[index] as string;
    if (argument === "--") {
      index += 1;
      break;
    }
    if (isAssignment(argument)) {
      index += 1;
      continue;
    }
    if (argument === "-i" || argument === "--ignore-environment") {
      index += 1;
      continue;
    }
    if (argument === "-u" || argument === "--unset") {
      if (argv[index + 1] === undefined) return undefined;
      index += 2;
      continue;
    }
    if (
      argument === "-C" || /^-[^S\s]*C/u.test(argument) ||
      argument === "--chdir" || argument.startsWith("--chdir=") ||
      argument === "-S" || argument === "--split-string" || argument.startsWith("--split-string=")
    ) {
      // These options change how the following executable or its relative
      // path is interpreted. This layer deliberately does not emulate env.
      throw new ShellClassificationError("unsafe_local_script");
    }
    if (/^-[^-\s]*S.+/u.test(argument)) return undefined;
    if (argument.startsWith("--unset=")) {
      if (argument.length === "--unset=".length) return undefined;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) return undefined;
    break;
  }
  return index < argv.length ? argv.slice(index) : undefined;
}

function hasRepositoryEnvironmentOverride(
  classifiedArgv: readonly string[],
  commandArgv: readonly string[],
): boolean {
  const executable = executableName(commandArgv[0] as string);
  const prefixes = classifiedArgv.slice(0, classifiedArgv.length - commandArgv.length);
  const names = executable === "git"
    ? new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_INDEX_FILE"])
    : executable === "gh"
      ? new Set(["GH_REPO", "GH_HOST"])
      : new Set<string>();
  return prefixes.some((argument) => {
    const separator = argument.indexOf("=");
    return separator > 0 && names.has(argument.slice(0, separator));
  });
}

function hasExecutableResolutionOverride(
  classifiedArgv: readonly string[],
  commandArgv: readonly string[],
): boolean {
  if ((commandArgv[0] as string).includes("/") || (commandArgv[0] as string).includes("\\")) return true;
  const prefixes = classifiedArgv.slice(0, classifiedArgv.length - commandArgv.length);
  return prefixes.some((argument) =>
    argument === "-i" || argument === "--ignore-environment" || argument === "PATH" || argument.startsWith("PATH="));
}

async function trustedRepositoryRoot(context: ShellClassifierContext): Promise<string | undefined> {
  const trustedRoot = await realpath(context.trusted_worktree_path).catch(() => undefined);
  if (!trustedRoot) return undefined;
  const marker = join(trustedRoot, ".git");
  const markerStat = await lstat(marker).catch(() => undefined);
  if (!markerStat || markerStat.isSymbolicLink() || (!markerStat.isDirectory() && !markerStat.isFile())) return undefined;
  return trustedRoot;
}

async function isCurrentRepositoryDirectory(
  context: ShellClassifierContext,
  directory: string,
  trustedRoot?: string,
): Promise<boolean> {
  const root = trustedRoot ?? await trustedRepositoryRoot(context);
  if (!root) return false;
  const current = await realpath(directory).catch(() => undefined);
  if (!current || !isWithin(root, current)) return false;

  let cursor = current;
  while (cursor !== root) {
    const marker = await lstat(join(cursor, ".git")).catch(() => undefined);
    if (marker) return false;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  return true;
}

async function gitDetection(
  argv: readonly string[],
  context: ShellClassifierContext,
): Promise<Detection | undefined> {
  const arguments_ = argv.slice(1);
  const fallbackAction = arguments_.find((argument) => argument === "commit" || argument === "push");
  const unresolved = (action = fallbackAction): Detection | undefined => {
    if (action !== "commit" && action !== "push") return undefined;
    return {
      capability: action === "commit" ? "git.commit" : "git.publish",
      boundary: "guarded_command",
      risk: action === "commit" ? "medium" : "high",
      repository_target: "unresolved",
    };
  };

  const trustedRoot = await trustedRepositoryRoot(context);
  let effectiveDirectory = await realpath(context.cwd).catch(() => undefined);
  let gitDirectory: string | undefined;
  let workTree: string | undefined;
  let index = 0;
  let targetOptionSeen = false;
  if (!trustedRoot || !effectiveDirectory || !isWithin(trustedRoot, effectiveDirectory)) return unresolved();

  while (index < arguments_.length) {
    const argument = arguments_[index] as string;
    if (argument === "--") {
      index += 1;
      break;
    }
    if (!argument.startsWith("-")) break;

    if (argument === "-C" || argument.startsWith("-C")) {
      const value = argument === "-C" ? arguments_[index + 1] : argument.slice(2);
      if (!value) return unresolved();
      targetOptionSeen = true;
      const candidate = resolve(effectiveDirectory, value);
      effectiveDirectory = await realpath(candidate).catch(() => undefined);
      if (!effectiveDirectory || !isWithin(trustedRoot, effectiveDirectory)) return unresolved();
      index += argument === "-C" ? 2 : 1;
      continue;
    }
    if (argument === "--git-dir" || argument.startsWith("--git-dir=")) {
      const value = argument === "--git-dir" ? arguments_[index + 1] : argument.slice("--git-dir=".length);
      if (!value) return unresolved();
      targetOptionSeen = true;
      gitDirectory = resolve(effectiveDirectory, value);
      index += argument === "--git-dir" ? 2 : 1;
      continue;
    }
    if (argument === "--work-tree" || argument.startsWith("--work-tree=")) {
      const value = argument === "--work-tree" ? arguments_[index + 1] : argument.slice("--work-tree=".length);
      if (!value) return unresolved();
      targetOptionSeen = true;
      workTree = resolve(effectiveDirectory, value);
      index += argument === "--work-tree" ? 2 : 1;
      continue;
    }
    if (argument === "-c" || argument === "--config-env" || argument === "--namespace" || argument === "--exec-path") {
      if (arguments_[index + 1] === undefined) return unresolved();
      index += 2;
      continue;
    }
    if (
      argument.startsWith("-c=") || argument.startsWith("--config-env=") ||
      argument.startsWith("--namespace=") || argument.startsWith("--exec-path=") ||
      new Set(["-p", "-P", "--paginate", "--no-pager", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks"]).has(argument)
    ) {
      index += 1;
      continue;
    }
    if (argument === "--bare") return unresolved();
    return unresolved();
  }

  const action = arguments_[index];
  if (action !== "commit" && action !== "push") return targetOptionSeen ? unresolved() : undefined;
  if (!await isCurrentRepositoryDirectory(context, effectiveDirectory, trustedRoot)) return unresolved(action);

  if (workTree) {
    const resolvedWorkTree = await realpath(workTree).catch(() => undefined);
    if (resolvedWorkTree !== trustedRoot) return unresolved(action);
  }
  if (gitDirectory) {
    const expectedMarker = join(trustedRoot, ".git");
    if (gitDirectory !== expectedMarker) return unresolved(action);
    const marker = await lstat(gitDirectory).catch(() => undefined);
    if (!marker || marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) return unresolved(action);
  }

  return {
    capability: action === "commit" ? "git.commit" : "git.publish",
    boundary: action === "commit" ? "hook" : "guarded_command",
    risk: action === "commit" ? "medium" : "high",
    repository_target: "current",
  };
}

function ghDetection(argv: readonly string[]): Detection | undefined {
  const arguments_ = argv.slice(1);
  let explicitRepository = false;
  let uninterpretable = false;
  const skipped = new Set<number>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    if (argument === "--help" || argument === "--version") {
      skipped.add(index);
      continue;
    }
    if (argument === "--repo" || argument === "-R" || argument === "--hostname") {
      explicitRepository = true;
      skipped.add(index);
      const value = arguments_[index + 1];
      if (!value || value.startsWith("-")) {
        uninterpretable = true;
      } else {
        skipped.add(index + 1);
        index += 1;
      }
      continue;
    }
    if (
      argument.startsWith("--repo=") || argument.startsWith("--hostname=") ||
      (argument.startsWith("-R") && argument !== "-R")
    ) {
      explicitRepository = true;
      skipped.add(index);
      if (argument.endsWith("=")) uninterpretable = true;
      continue;
    }
  }

  const families = new Set(["pr", "release", "issue"]);
  const familyIndex = arguments_.findIndex((argument, index) => !skipped.has(index) && families.has(argument));
  if (familyIndex < 0) return undefined;
  const family = arguments_[familyIndex] as string;
  const actions = family === "pr"
    ? new Set(["create", "merge"])
    : family === "release"
      ? new Set(["create"])
      : new Set(["close", "edit", "comment"]);
  const actionIndex = arguments_.findIndex((argument, index) =>
    index > familyIndex && !skipped.has(index) && actions.has(argument));
  if (actionIndex < 0) return undefined;
  const action = arguments_[actionIndex] as string;
  if (arguments_.some((_argument, index) => index < familyIndex && !skipped.has(index))) uninterpretable = true;
  if (arguments_.some((_argument, index) =>
    index > familyIndex && index < actionIndex && !skipped.has(index))) uninterpretable = true;
  if (uninterpretable) explicitRepository = true;

  if (family === "pr" && (action === "create" || action === "merge")) {
    return {
      capability: "git.publish",
      boundary: "guarded_command",
      risk: "high",
      repository_target: explicitRepository ? "unresolved" : "current",
    };
  }
  if (family === "release" && action === "create") {
    return {
      capability: "git.publish",
      boundary: "guarded_command",
      risk: "high",
      repository_target: explicitRepository ? "unresolved" : "current",
    };
  }
  if (family === "issue" && (action === "close" || action === "edit" || action === "comment")) {
    return { capability: "tracker.mutate", boundary: "tracker", risk: "high" };
  }
  return undefined;
}

async function localScriptDigest(argv: readonly string[], context: ShellClassifierContext): Promise<string | undefined> {
  const executable = argv[0] as string;
  if (!executable.includes("/") && !executable.includes("\\")) return undefined;
  const trustedRoot = await realpath(context.trusted_worktree_path).catch(() => {
    throw new ShellClassificationError("unsafe_local_script");
  });
  const candidate = resolve(context.cwd, executable);
  if (!isWithin(trustedRoot, candidate)) throw new ShellClassificationError("unsafe_local_script");

  let handle;
  try {
    handle = await open(candidate, scriptOpenFlags);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_LOCAL_SCRIPT_BYTES) || (before.mode & 0o111n) === 0n) {
      throw new ShellClassificationError("unsafe_local_script");
    }
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!isWithin(trustedRoot, openedPath)) throw new ShellClassificationError("unsafe_local_script");
    const content = await handle.readFile();
    if (content.byteLength > MAX_LOCAL_SCRIPT_BYTES || BigInt(content.byteLength) !== before.size) {
      throw new ShellClassificationError("unsafe_local_script");
    }
    const after = await handle.stat({ bigint: true });
    const currentPath = await lstat(candidate, { bigint: true });
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.mode !== after.mode ||
      currentPath.isSymbolicLink() || currentPath.dev !== after.dev || currentPath.ino !== after.ino ||
      currentPath.size !== after.size || currentPath.mtimeNs !== after.mtimeNs || currentPath.mode !== after.mode
    ) {
      throw new ShellClassificationError("unsafe_local_script");
    }
    return createHash("sha256").update(content).digest("hex");
  } catch (cause) {
    if (cause instanceof ShellClassificationError) throw cause;
    throw new ShellClassificationError("unsafe_local_script");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function requirementFor(
  detection: Detection,
  context: ShellClassifierContext,
  wrapper?: { kind: "guard" } | { kind: "board"; boardId: string },
): OperationRequirement | undefined {
  switch (detection.capability) {
    case "git.commit":
    case "git.publish":
      return detection.repository_target === "current"
        ? { capability: detection.capability, resource: context.repository }
        : undefined;
    case "tracker.mutate":
      return undefined;
    case "board.execute":
      return wrapper?.kind === "board" && context.board?.id === wrapper.boardId
        ? { capability: detection.capability, resource: context.board }
        : undefined;
    case "remote.execute":
      return undefined;
    case "firmware.change":
      if (wrapper?.kind !== "board") return undefined;
      return context.board?.id === wrapper.boardId
        ? { capability: detection.capability, resource: context.board }
        : undefined;
    case "deploy.execute":
      return undefined;
  }
}

function signalFor(detection: Detection): ShellBoundarySignal | undefined {
  if (detection.boundary === "hook") {
    if (detection.repository_target !== "unresolved") return undefined;
    return { capability: detection.capability, boundary: "guarded_command" };
  }
  return { capability: detection.capability, boundary: detection.boundary };
}

function exactGuardWrapper(argv: readonly string[]): { separator: number } | undefined {
  if (argv[0] !== "jhw-control" || argv[1] !== "guard" || argv[2] !== "with") return undefined;
  const separator = argv.indexOf("--", 3);
  if (separator < 4 || separator === argv.length - 1) return undefined;
  const required = new Map([
    ["--task", /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/],
    ["--claim", /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/],
    ["--session", /^[^\u0000-\u001f\u007f]{1,255}$/u],
    ["--origin-adapter", /^(?:claude|codex|gemini|opencode)$/],
  ]);
  const seen = new Set<string>();
  for (let index = 3; index < separator; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const pattern = flag ? required.get(flag) : undefined;
    if (!pattern || value === undefined || !pattern.test(value) || seen.has(flag as string)) return undefined;
    seen.add(flag as string);
  }
  return seen.size === required.size ? { separator } : undefined;
}

function exactBoardWrapper(argv: readonly string[]): { separator: number; boardId: string } | undefined {
  if (argv[0] !== "jhw-control" || argv[1] !== "board" || argv[2] !== "with") return undefined;
  const separator = argv.indexOf("--", 3);
  if (separator < 5 || separator === argv.length - 1 || (separator - 3) % 2 !== 0) return undefined;
  const patterns = new Map<string, RegExp>([
    ["--board", /^[a-z0-9][a-z0-9-]{1,62}$/],
    ["--task", /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/],
    ["--claim", /^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/],
    ["--session", /^[^\u0000-\u001f\u007f]{1,255}$/u],
    ["--origin-adapter", /^(?:claude|codex|gemini|opencode)$/],
    ["--mode", /^(?:exclusive|shared)$/],
    ["--for", /^[1-9][0-9]{0,4}[mh]$/],
    ["--until", /^[^\u0000-\u001f\u007f]{1,64}$/u],
    ["--purpose", /^[^\u0000-\u001f\u007f]{1,255}$/u],
    ["--consume", /^rsv-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/],
    ["--use-holder", /^hld-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/],
    ["--long-lease", /^true$/],
    ["--cross-session", /^true$/],
    ["--json-fd", /^[1-9][0-9]{0,2}$/],
  ]);
  const seen = new Map<string, string>();
  for (let index = 3; index < separator; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const pattern = flag ? patterns.get(flag) : undefined;
    if (!flag || value === undefined || !pattern?.test(value) || seen.has(flag)) return undefined;
    seen.set(flag, value);
  }
  for (const required of ["--board", "--task", "--claim", "--session", "--origin-adapter"]) {
    if (!seen.has(required)) return undefined;
  }
  return { separator, boardId: seen.get("--board") as string };
}

async function simpleKnownDetection(
  argv: readonly string[],
  context: ShellClassifierContext,
): Promise<{ detection?: Detection; selfApproval: boolean }> {
  if ((argv[0] as string).includes("/") || (argv[0] as string).includes("\\")) {
    return { selfApproval: false };
  }
  const executable = executableName(argv[0] as string);
  if (executable === "git") {
    return { detection: await gitDetection(argv, context), selfApproval: false };
  }
  if (executable === "gh") {
    const detection = ghDetection(argv);
    if (detection?.repository_target === "current" && !await isCurrentRepositoryDirectory(context, context.cwd)) {
      return {
        detection: { ...detection, boundary: "guarded_command", repository_target: "unresolved" },
        selfApproval: false,
      };
    }
    return { detection, selfApproval: false };
  }
  if (executable === "ssh" || executable === "scp" || executable === "sftp") {
    return {
      detection: { capability: "remote.execute", boundary: "guarded_command", risk: "high" },
      selfApproval: false,
    };
  }
  if (new Set(["flashrom", "dfu-util", "openocd", "esptool", "esptool.py", "fwupdmgr"]).has(executable)) {
    return { detection: { capability: "firmware.change", boundary: "board", risk: "high" }, selfApproval: false };
  }
  if (new Set(["iw", "iwconfig", "wpa_cli", "antcfg", "rmmod", "insmod"]).has(executable)) {
    return { detection: { capability: "board.execute", boundary: "board", risk: "high" }, selfApproval: false };
  }
  if (executable === "kubectl" && argv.slice(1).some((argument) => new Set(["apply", "delete", "replace", "patch"]).has(argument))) {
    return { detection: { capability: "deploy.execute", boundary: "guarded_command", risk: "high" }, selfApproval: false };
  }
  if (executable === "helm" && argv.slice(1).some((argument) => new Set(["install", "upgrade", "uninstall", "rollback"]).has(argument))) {
    return { detection: { capability: "deploy.execute", boundary: "guarded_command", risk: "high" }, selfApproval: false };
  }
  if (executable === "terraform" && argv.slice(1).some((argument) => argument === "apply" || argument === "destroy")) {
    return { detection: { capability: "deploy.execute", boundary: "guarded_command", risk: "high" }, selfApproval: false };
  }
  if (executable === "jhw-control" && argv[1] === "board") {
    const action = argv[2];
    if (action && !new Set(["list", "status"]).has(action)) {
      return { detection: { capability: "board.execute", boundary: "board", risk: "high" }, selfApproval: false };
    }
  }
  const selfApproval = executable === "jhw-control" && argv[1] === "guard" &&
    new Set(["prompt", "approve", "consume"]).has(argv[2] ?? "");
  return { selfApproval };
}

export async function classifyShell(input: string, context: ShellClassifierContext): Promise<ShellClassification> {
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > MAX_COMMAND_BYTES || input.length === 0) {
    throw new ShellClassificationError("invalid_shell_input");
  }
  const raw = scanHighRisk(input);
  const parsed = parseSimpleArgv(input);
  const guardWrapper = parsed.argv ? exactGuardWrapper(parsed.argv) : undefined;
  const boardWrapper = parsed.argv ? exactBoardWrapper(parsed.argv) : undefined;
  const wrapper = guardWrapper
    ? { kind: "guard" as const }
    : boardWrapper
      ? { kind: "board" as const, boardId: boardWrapper.boardId }
      : undefined;
  const requirements: OperationRequirement[] = [];
  const unresolvedSignals: ShellBoundarySignal[] = [];
  let risk: OperationRisk = "low";
  let executionBoundary: ExecutionBoundary = "hook";
  const applyDetection = (detection: Detection): void => {
    const requirement = requirementFor(detection, context, wrapper);
    const signal = requirement ? undefined : signalFor(detection);
    if (requirement) requirements.push(requirement);
    if (signal) unresolvedSignals.push(signal);
    risk = strongerRisk(risk, detection.risk);
    executionBoundary = strongerBoundary(executionBoundary, detection.boundary);
  };

  if (parsed.ambiguous || !parsed.argv) {
    const repositoryIsCurrent = await isCurrentRepositoryDirectory(context, context.cwd);
    for (const rawDetection of raw.detections) {
      const detection = rawDetection.repository_target === "current" && !repositoryIsCurrent
        ? { ...rawDetection, boundary: "guarded_command" as const, repository_target: "unresolved" as const }
        : rawDetection;
      applyDetection(detection);
    }
    requirements.push({ capability: "shell.unclassified", resource: context.repository });
    return {
      requirements: sortRequirements(requirements),
      unresolved_signals: sortSignals(unresolvedSignals),
      risk: strongerRisk(risk, "high"),
      execution_boundary: executionBoundary,
      ambiguous: true,
      direct_high_risk: raw.detections.some((detection) => detection.risk === "high"),
      self_approval: raw.selfApproval,
    };
  }

  const argv = parsed.argv;
  let classifiedArgv = argv;
  let ownedWrapper: "guard" | "board" | undefined;
  if (guardWrapper) {
    classifiedArgv = argv.slice(guardWrapper.separator + 1);
    ownedWrapper = "guard";
  } else if (boardWrapper) {
    classifiedArgv = argv.slice(boardWrapper.separator + 1);
    ownedWrapper = "board";
    const resolvedBoard = context.board?.id === boardWrapper.boardId
      ? { capability: "board.execute" as const, resource: context.board }
      : undefined;
    if (resolvedBoard) requirements.push(resolvedBoard);
    else unresolvedSignals.push({ capability: "board.execute", boundary: "board" });
    risk = "high";
    executionBoundary = "board";
  }

  const commandArgv = executableArgv(classifiedArgv);
  const known = commandArgv
    ? await simpleKnownDetection(commandArgv, context)
    : { selfApproval: false };
  const repositoryBindingUnsafe = commandArgv !== undefined && (
    hasRepositoryEnvironmentOverride(classifiedArgv, commandArgv) ||
    hasExecutableResolutionOverride(classifiedArgv, commandArgv)
  );
  const environmentAdjustedDetection = known.detection?.repository_target === "current" && repositoryBindingUnsafe
    ? { ...known.detection, boundary: "guarded_command" as const, repository_target: "unresolved" as const }
    : known.detection;
  const rawRequiresUnresolvedRepository = commandArgv !== undefined && executableName(commandArgv[0] as string) === "gh" &&
    environmentAdjustedDetection !== undefined && raw.detections.some((detection) =>
    detection.capability === environmentAdjustedDetection.capability && detection.repository_target === "unresolved");
  const knownDetection = environmentAdjustedDetection?.repository_target === "current" && rawRequiresUnresolvedRepository
    ? { ...environmentAdjustedDetection, boundary: "guarded_command" as const, repository_target: "unresolved" as const }
    : environmentAdjustedDetection;
  const repositoryIsCurrent = await isCurrentRepositoryDirectory(context, context.cwd);
  const authoritativeCapability = knownDetection?.capability;
  const rawDetections = raw.detections
    .filter((rawDetection) => rawDetection.capability !== authoritativeCapability)
    .map((rawDetection) =>
    rawDetection.repository_target === "current" && (!repositoryIsCurrent || repositoryBindingUnsafe)
      ? { ...rawDetection, boundary: "guarded_command" as const, repository_target: "unresolved" as const }
      : rawDetection);
  for (const detection of rawDetections) applyDetection(detection);
  if (knownDetection) applyDetection(knownDetection);
  if (!knownDetection) {
    requirements.push({ capability: "shell.unclassified", resource: context.repository });
    risk = strongerRisk(risk, "high");
  }

  const scriptContentSha256 = commandArgv ? await localScriptDigest(commandArgv, context) : undefined;
  const highRiskDetected = [...rawDetections, ...(knownDetection ? [knownDetection] : [])]
    .some((detection) => detection.risk === "high");
  return {
    requirements: sortRequirements(requirements),
    unresolved_signals: sortSignals(unresolvedSignals),
    risk,
    execution_boundary: executionBoundary,
    ambiguous: false,
    direct_high_risk: ownedWrapper === undefined && highRiskDetected,
    self_approval: raw.selfApproval || known.selfApproval,
    ...(ownedWrapper ? { owned_wrapper: ownedWrapper } : {}),
    digest_argv: [...argv],
    ...(scriptContentSha256 ? { script_content_sha256: scriptContentSha256 } : {}),
  };
}
