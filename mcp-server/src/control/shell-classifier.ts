import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

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
  return command.match(/--?[A-Za-z0-9][A-Za-z0-9_.-]*|[A-Za-z0-9_./:-]+/g)?.map((word) => word.toLowerCase()) ?? [];
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
  const words = rawWords(command);
  const detections: Detection[] = [];
  let selfApproval = false;
  const add = (detection: Detection): void => {
    const key = `${detection.capability}\u0000${detection.boundary}`;
    if (!detections.some((candidate) => `${candidate.capability}\u0000${candidate.boundary}` === key)) {
      detections.push(detection);
    }
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = executableName(words[index] as string);
    if (word === "git") {
      const action = findFollowing(words, index, new Set(["commit", "push"]));
      if (action === "commit") add({ capability: "git.commit", boundary: "hook", risk: "medium" });
      if (action === "push") add({ capability: "git.publish", boundary: "guarded_command", risk: "high" });
    }
    if (word === "gh") {
      const family = words[index + 1];
      const action = words[index + 2];
      if (family === "pr" && (action === "create" || action === "merge")) {
        add({ capability: "git.publish", boundary: "guarded_command", risk: "high" });
      }
      if (family === "release" && action === "create") {
        add({ capability: "git.publish", boundary: "guarded_command", risk: "high" });
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
        escaped = true;
      } else {
        if (character === "$" || character === "`") return { ambiguous: true };
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
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
    if (";&|<>()`".includes(character) || character === "$" || (character === "<" && next === "<")) {
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
      return { capability: detection.capability, resource: context.repository };
    case "tracker.mutate":
      return context.issue ? { capability: detection.capability, resource: context.issue } : undefined;
    case "board.execute":
      return wrapper?.kind === "board" && context.board?.id === wrapper.boardId
        ? { capability: detection.capability, resource: context.board }
        : undefined;
    case "remote.execute":
      return wrapper && context.remote_host ? { capability: detection.capability, resource: context.remote_host } : undefined;
    case "firmware.change":
      if (wrapper?.kind !== "board") return undefined;
      if (context.firmware_target) return { capability: detection.capability, resource: context.firmware_target };
      return context.board?.id === wrapper.boardId
        ? { capability: detection.capability, resource: context.board }
        : undefined;
    case "deploy.execute":
      return wrapper && context.deployment_target
        ? { capability: detection.capability, resource: context.deployment_target }
        : undefined;
  }
}

function signalFor(detection: Detection): ShellBoundarySignal | undefined {
  if (detection.capability === "git.commit" || detection.capability === "git.publish") return undefined;
  if (detection.boundary === "hook") return undefined;
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

function simpleKnownDetection(argv: readonly string[]): Detection | undefined {
  const executable = executableName(argv[0] as string);
  if (executable === "git") {
    const action = argv.find((argument, index) => index > 0 && (argument === "commit" || argument === "push"));
    if (action === "commit") return { capability: "git.commit", boundary: "hook", risk: "medium" };
    if (action === "push") return { capability: "git.publish", boundary: "guarded_command", risk: "high" };
  }
  if (executable === "gh") {
    if (argv[1] === "pr" && (argv[2] === "create" || argv[2] === "merge")) {
      return { capability: "git.publish", boundary: "guarded_command", risk: "high" };
    }
    if (argv[1] === "release" && argv[2] === "create") {
      return { capability: "git.publish", boundary: "guarded_command", risk: "high" };
    }
    if (argv[1] === "issue" && (argv[2] === "close" || argv[2] === "edit" || argv[2] === "comment")) {
      return { capability: "tracker.mutate", boundary: "tracker", risk: "high" };
    }
  }
  return undefined;
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
  let requirements: OperationRequirement[] = [];
  let unresolvedSignals: ShellBoundarySignal[] = [];
  let risk: OperationRisk = "low";
  let executionBoundary: ExecutionBoundary = "hook";
  for (const detection of raw.detections) {
    const requirement = requirementFor(detection, context, wrapper);
    const signal = requirement ? undefined : signalFor(detection);
    if (requirement) requirements.push(requirement);
    if (signal) unresolvedSignals.push(signal);
    risk = strongerRisk(risk, detection.risk);
    executionBoundary = strongerBoundary(executionBoundary, detection.boundary);
  }

  if (parsed.ambiguous || !parsed.argv) {
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

  const known = simpleKnownDetection(classifiedArgv);
  if (known) {
    const requirement = requirementFor(known, context, wrapper);
    const signal = requirement ? undefined : signalFor(known);
    if (requirement) requirements.push(requirement);
    if (signal) unresolvedSignals.push(signal);
    risk = strongerRisk(risk, known.risk);
    executionBoundary = strongerBoundary(executionBoundary, known.boundary);
  } else {
    requirements.push({ capability: "shell.unclassified", resource: context.repository });
    risk = strongerRisk(risk, "high");
  }

  const scriptContentSha256 = await localScriptDigest(classifiedArgv, context);
  return {
    requirements: sortRequirements(requirements),
    unresolved_signals: sortSignals(unresolvedSignals),
    risk,
    execution_boundary: executionBoundary,
    ambiguous: false,
    direct_high_risk: ownedWrapper === undefined && raw.detections.some((detection) => detection.risk === "high"),
    self_approval: raw.selfApproval,
    ...(ownedWrapper ? { owned_wrapper: ownedWrapper } : {}),
    digest_argv: [...argv],
    ...(scriptContentSha256 ? { script_content_sha256: scriptContentSha256 } : {}),
  };
}
