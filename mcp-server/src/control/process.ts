import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import {
  createGuardHostCoordinateAuthority,
  type GuardHostCoordinateAuthority,
} from "./guard-coordinate.js";
import { openSecureStateDirectory, type SecureStateDirectory, type SecureStateDirectoryHooks } from "./journal.js";
import type { ErrorReason } from "./schemas.js";
import { isSensitiveEnvironmentKey } from "./sensitive-data.js";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
const MAX_PROCESS_TIMEOUT_MS = 600_000;
const PROCESS_STOP_GRACE_MS = 100;
const LOCK_HELPER_TIMEOUT_MS = 5_000;
const GUARD_REGISTRY_WAIT_SECONDS = 5;
const GUARD_REGISTRY_ADMISSION_LIMIT = 16;

export interface ProcessResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type GhCredential = "project" | "repo";

/** Removes credentials before spawning ordinary host subprocesses. */
export function sanitizedChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = Object.fromEntries(Object.entries(env).filter(([key]) => !isSensitiveEnvironmentKey(key)));
  const configuredSsh = sanitized.GIT_SSH_COMMAND?.trim() || "ssh";
  return {
    ...sanitized,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_SSH_COMMAND: /(?:^|\s)-o\s*BatchMode=|(?:^|\s)-oBatchMode=/.test(configuredSsh)
      ? configuredSsh
      : `${configuredSsh} -oBatchMode=yes`,
  };
}

function timeoutMs(options: ProcessRunOptions): number {
  const value = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PROCESS_TIMEOUT_MS) {
    throw new ControlError("INVALID_PROCESS_TIMEOUT", "Process timeout must be a bounded positive integer");
  }
  return value;
}

interface ChildExit {
  exitCode: number | null;
  cause?: string;
  stopped?: "timeout" | "aborted";
}

function killChildTree(child: ChildProcess): void {
  let groupKilled = false;
  if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, "SIGKILL");
      groupKilled = true;
    } catch {
      // Fall back to the direct child below. Capture streams are closed in
      // either case so an escaped descendant cannot retain our completion.
    }
  }
  if (!groupKilled) child.kill("SIGKILL");
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/** Waits for close while forcing a deterministic hard stop at either boundary. */
function waitForChild(child: ChildProcess, options: ProcessRunOptions): Promise<ChildExit> {
  const deadline = timeoutMs(options);
  return new Promise((resolve) => {
    let settled = false;
    let stopped: ChildExit["stopped"];
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: ChildExit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ ...result, ...(stopped ? { stopped } : {}) });
    };
    const stop = (reason: NonNullable<ChildExit["stopped"]>) => {
      if (settled || stopped) return;
      stopped = reason;
      killChildTree(child);
      stopTimer = setTimeout(() => settle({ exitCode: null }), PROCESS_STOP_GRACE_MS);
    };
    const abort = () => stop("aborted");
    const timer = setTimeout(() => stop("timeout"), deadline);
    child.once("error", (cause) => settle({
      exitCode: null,
      cause: cause instanceof Error ? cause.message : String(cause),
    }));
    child.once("close", (exitCode) => settle({ exitCode }));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface ProcessRunnerRuntime {
  spawn: typeof spawn;
}

const productionProcessRunnerRuntime: ProcessRunnerRuntime = { spawn };

function stoppedError(stopped: ChildExit["stopped"], command: string, deadline: number): ControlError | undefined {
  if (stopped === "timeout") {
    return new ControlError("COMMAND_TIMEOUT", "Command exceeded its bounded execution time", {
      command,
      timeout_ms: deadline,
    });
  }
  if (stopped === "aborted") return new ControlError("COMMAND_ABORTED", "Command was aborted", { command });
  return undefined;
}

function secretValues(env: NodeJS.ProcessEnv): string[] {
  return [...new Set(
    Object.entries(env)
      .filter(([key, value]) => isSensitiveEnvironmentKey(key) && value && Buffer.byteLength(value, "utf8") >= 8)
      .map(([, value]) => value as string),
  )].sort((left, right) => right.length - left.length);
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value);
}

interface SecretSpan {
  start: number;
  end: number;
}

function secretSpans(value: string, secrets: readonly string[]): SecretSpan[] {
  const spans: SecretSpan[] = [];
  for (const secret of secrets) {
    let from = 0;
    while (from < value.length) {
      const start = value.indexOf(secret, from);
      if (start === -1) break;
      spans.push({ start, end: start + secret.length });
      from = start + 1;
    }
  }
  return mergeSecretSpans(spans);
}

function mergeSecretSpans(spans: readonly SecretSpan[]): SecretSpan[] {
  const ordered = [...spans].sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: SecretSpan[] = [];
  for (const span of ordered) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function renderMasked(value: string, spans: readonly SecretSpan[]): string {
  let cursor = 0;
  let rendered = "";
  for (const span of spans) {
    rendered += value.slice(cursor, span.start);
    rendered += "[REDACTED]";
    cursor = span.end;
  }
  return rendered + value.slice(cursor);
}

function pullBackFromSplitSurrogate(value: string, limit: number): number {
  if (limit <= 0 || limit >= value.length) return limit;
  const previous = value.charCodeAt(limit - 1);
  const next = value.charCodeAt(limit);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? limit - 1
    : limit;
}

/**
 * Redacts each stream incrementally, masking the union of all complete secret
 * spans before retaining a suffix that might complete in a later chunk.
 */
interface RedactedCapture {
  bytes: Buffer;
  sensitive: boolean;
  tooLarge: boolean;
}

function redactingCapture(stream: Readable | null, secrets: readonly string[]): Promise<RedactedCapture> {
  if (!stream) return Promise.resolve({ bytes: Buffer.alloc(0), sensitive: false, tooLarge: false });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const decoder = new StringDecoder("utf8");
    let captured = 0;
    let pending = "";
    let sensitive = false;
    let tooLarge = false;

    const append = (value: string) => {
      if (!value) return;
      if (captured >= MAX_CAPTURE_BYTES) {
        tooLarge = true;
        return;
      }
      const encoded = Buffer.from(value, "utf8");
      const remaining = MAX_CAPTURE_BYTES - captured;
      if (encoded.length <= remaining) {
        chunks.push(encoded);
        captured += encoded.length;
        return;
      }
      const completeCharacters = new StringDecoder("utf8").write(encoded.subarray(0, remaining));
      const bounded = Buffer.from(completeCharacters, "utf8");
      chunks.push(bounded);
      captured += bounded.length;
      tooLarge = true;
    };
    const emitAvailable = () => {
      const spans = secretSpans(pending, secrets);
      if (spans.length > 0) sensitive = true;
      const longest = Math.max(0, ...secrets.map((secret) => secret.length));
      let limit = Math.max(0, pending.length - Math.max(0, longest - 1));
      let changed = true;
      while (changed) {
        changed = false;
        const codePointBoundary = pullBackFromSplitSurrogate(pending, limit);
        if (codePointBoundary < limit) {
          limit = codePointBoundary;
          changed = true;
        }
        for (const span of spans) {
          if (span.start < limit && span.end > limit) {
            limit = span.start;
            changed = true;
          }
        }
      }
      append(renderMasked(pending.slice(0, limit), spans.filter((span) => span.end <= limit)));
      pending = pending.slice(limit);
    };

    stream.on("data", (chunk: Buffer | string) => {
      pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      emitAvailable();
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pending += decoder.end();
      const spans = secretSpans(pending, secrets);
      if (spans.length > 0) sensitive = true;
      append(renderMasked(pending, mergeSecretSpans(spans)));
      pending = "";
      resolve({ bytes: Buffer.concat(chunks), sensitive, tooLarge });
    };
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", reject);
  });
}

export class ProcessRunner {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly runtime: ProcessRunnerRuntime = productionProcessRunnerRuntime,
  ) {}

  async run(command: string, args: string[], options: ProcessRunOptions = {}): Promise<ProcessResult> {
    const rawEnvironment = { ...this.environment, ...options.env };
    return this.runWithEnvironment(
      command,
      args,
      options,
      sanitizedChildEnvironment(rawEnvironment),
      secretValues(rawEnvironment),
    );
  }

  /**
   * Reads a small, committed binary object without decoding or redacting it.
   * This is deliberately separate from `run`: Registry evidence is data, not
   * diagnostic output, so applying output redaction would silently mutate it.
   */
  async runRaw(
    command: string,
    args: string[],
    options: ProcessRunOptions = {},
    maximumBytes: number,
  ): Promise<Buffer> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new ControlError("RAW_OUTPUT_LIMIT_INVALID", "Raw command output limit must be a non-negative integer", {
        maximumBytes,
      });
    }

    const rawEnvironment = { ...this.environment, ...options.env };
    const deadline = timeoutMs(options);
    const secrets = secretValues(rawEnvironment);
    const safeCommand = redact(command, secrets);
    const safeArgs = args.map((arg) => redact(arg, secrets));
    let child: ReturnType<typeof spawn>;
    try {
      child = this.runtime.spawn(command, args, {
        cwd: options.cwd,
        env: sanitizedChildEnvironment(rawEnvironment),
        detached: process.platform !== "win32",
        // stderr is intentionally not captured: an arbitrary blob error must
        // never become an unredacted diagnostic payload.
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      throw new ControlError("RAW_COMMAND_FAILED", "Unable to start raw command", {
        command: safeCommand,
        args: safeArgs,
        exitCode: null,
      });
    }

    const output = new Promise<{ bytes: Buffer; tooLarge: boolean }>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let captured = 0;
      let tooLarge = false;
      const snapshot = () => ({ bytes: Buffer.concat(chunks), tooLarge });
      child.stdout?.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = maximumBytes - captured;
        if (remaining <= 0) {
          if (bytes.length > 0) tooLarge = true;
          return;
        }
        if (bytes.length > remaining) {
          chunks.push(bytes.subarray(0, remaining));
          captured += remaining;
          tooLarge = true;
          return;
        }
        chunks.push(bytes);
        captured += bytes.length;
      });
      child.stdout?.once("end", () => resolve(snapshot()));
      child.stdout?.once("close", () => resolve(snapshot()));
      child.stdout?.once("error", reject);
      // A failed spawn is not guaranteed to emit stdout's `end`; settle this
      // capture as well so the stable command error below can be returned.
      child.once("error", () => resolve(snapshot()));
      if (!child.stdout) resolve({ bytes: Buffer.alloc(0), tooLarge: false });
    });
    const exit = await waitForChild(child, options);
    let captured: { bytes: Buffer; tooLarge: boolean };
    try {
      captured = await output;
    } catch {
      throw new ControlError("RAW_COMMAND_FAILED", "Unable to read raw command output", {
        command: safeCommand,
        args: safeArgs,
        exitCode: exit.exitCode,
      });
    }
    const stopError = stoppedError(exit.stopped, safeCommand, deadline);
    if (stopError) throw stopError;
    if (captured.tooLarge) {
      throw new ControlError("RAW_OUTPUT_TOO_LARGE", "Raw command output exceeds its byte bound", {
        command: safeCommand,
        args: safeArgs,
        exitCode: exit.exitCode,
        maximumBytes,
      });
    }
    if (exit.exitCode !== 0) {
      throw new ControlError("RAW_COMMAND_FAILED", "Raw command failed", {
        command: safeCommand,
        args: safeArgs,
        exitCode: exit.exitCode,
      });
    }
    return captured.bytes;
  }

  /** Executes `gh` with only the selected host credential exposed as GH_TOKEN. */
  async runGh(args: string[], credential: GhCredential, options: ProcessRunOptions = {}): Promise<ProcessResult> {
    const rawEnvironment = { ...this.environment, ...options.env };
    const credentialKey = credential === "project" ? "GH_PROJECT_TOKEN" : "GH_REPO_TOKEN";
    const token = rawEnvironment[credentialKey];
    if (!token) {
      throw new ControlError("MISSING_CREDENTIAL", `Missing host credential: ${credentialKey}`, {
        key: credentialKey,
      });
    }
    return this.runWithEnvironment(
      "gh",
      args,
      options,
      { ...sanitizedChildEnvironment(rawEnvironment), GH_TOKEN: token },
      secretValues(rawEnvironment),
    );
  }

  private async runWithEnvironment(
    command: string,
    args: string[],
    options: ProcessRunOptions,
    env: NodeJS.ProcessEnv,
    secrets: readonly string[],
  ): Promise<ProcessResult> {
    const safeCommand = redact(command, secrets);
    const safeArgs = args.map((arg) => redact(arg, secrets));
    const deadline = timeoutMs(options);
    let child: ReturnType<typeof spawn>;

    try {
      child = this.runtime.spawn(command, args, {
        cwd: options.cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new ControlError("COMMAND_FAILED", `Unable to start command: ${safeCommand}`, {
        command: safeCommand,
        args: safeArgs,
        exitCode: null,
        cause: redact(message, secrets),
      });
    }

    const stdout = redactingCapture(child.stdout, secrets);
    const stderr = redactingCapture(child.stderr, secrets);
    const exit = await waitForChild(child, options);
    const [stdoutCapture, stderrCapture] = await Promise.all([stdout, stderr]);
    const stopError = stoppedError(exit.stopped, safeCommand, deadline);
    if (stopError) throw stopError;
    if (exit.exitCode === 0 && (stdoutCapture.sensitive || stderrCapture.sensitive)) {
      throw new ControlError(
        "SENSITIVE_OUTPUT_REJECTED",
        "Successful command output contained protected host data",
      );
    }
    if (stdoutCapture.tooLarge || stderrCapture.tooLarge) {
      throw new ControlError(
        "COMMAND_OUTPUT_TOO_LARGE",
        "Command output exceeded its bounded capture size",
        { command: safeCommand, maximum_bytes: MAX_CAPTURE_BYTES },
      );
    }
    const result = {
      command: safeCommand,
      args: safeArgs,
      stdout: stdoutCapture.bytes.toString("utf8"),
      stderr: stderrCapture.bytes.toString("utf8"),
      exitCode: exit.exitCode,
    };

    if (result.exitCode !== 0) {
      throw new ControlError(
        "COMMAND_FAILED",
        `Command failed (${result.exitCode ?? "unknown"}): ${safeCommand}`,
        { ...result, cause: exit.cause ? redact(exit.cause, secrets) : undefined },
      );
    }

    return { ...result, exitCode: 0 };
  }
}

const lockOpenFlags = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW;
const strictLockCreateFlags = lockOpenFlags | constants.O_EXCL;
const existingLockOpenFlags = constants.O_RDWR | constants.O_NOFOLLOW;

export interface MutationLockPort {
  run<T>(callback: () => Promise<T>): Promise<T>;
}

export interface MutationLockChild {
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  kill?(signal?: NodeJS.Signals | number): unknown;
}

export interface MutationLockRuntime {
  spawn: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "ignore", "ignore", number] },
  ) => MutationLockChild;
}

const productionLockRuntime: MutationLockRuntime = {
  spawn: (command, args, options) => spawn(command, args, options),
};

const directlyConstructedMutationLocks = new WeakSet<object>();

type GuardMutationRunner = <T>(callback: () => Promise<T>) => Promise<T>;

interface DirectMutationLockAuthority {
  coordinate: string;
  hostCoordinate: GuardHostCoordinateAuthority;
  guardEligible: boolean;
  runGuard: GuardMutationRunner;
}

const directMutationLockAuthorities = new WeakMap<MutationLock, DirectMutationLockAuthority>();
const guardMutationAuthorityBrand = Symbol("guard-mutation-lock-authority");
const guardMutationAuthorityRunners = new WeakMap<object, GuardMutationRunner>();
const activeGuardMutationCoordinates = new AsyncLocalStorage<ReadonlySet<string>>();

interface GuardAdmission {
  admitted: number;
  tail: Promise<void>;
}

const guardAdmissions = new Map<string, GuardAdmission>();

export interface GuardMutationLockAuthority {
  readonly [guardMutationAuthorityBrand]: true;
}

/** Non-default lock identity: a second host-global lock that must not contend with registry.lock. */
export interface MutationLockOptions {
  lockFileName?: string;
  /** Present switches the helper from non-blocking `-n` to a bounded blocking `-w` wait. */
  waitSeconds?: number;
  /**
   * Registered reason emitted with LOCK_CONTENDED so the two lock files stay
   * distinguishable. Typed to the closed vocabulary: a bare string here would
   * bypass both the compiler and the literal sweep (the value flows through a
   * variable), and an unregistered synonym would be silently dropped at
   * emission — exactly the regression the vocabulary closure exists to block.
   */
  contendedReason?: ErrorReason;
  /** Refuse, rather than chmod-repair, an already-existing non-0700 state directory. */
  strictExistingStateDirectory?: boolean;
  /** Refuse, rather than chmod-repair, an already-existing non-0600 lock file. */
  strictExistingLockFileMode?: boolean;
}

function acquisitionFailure(status: number | null, contendedReason?: string): ControlError {
  if (status === 75) {
    return new ControlError(
      "LOCK_CONTENDED",
      "Host mutation lock is already held",
      contendedReason ? { reason: contendedReason } : {},
    );
  }
  return new ControlError("LOCK_ACQUIRE_FAILED", "Host lock acquisition command failed");
}

/** Waits for one flock acquisition process; it owns no long-lived child streams. */
function acquireLock(child: MutationLockChild, helperTimeoutMs: number, contendedReason?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result();
    };
    const timer = setTimeout(() => settle(() => {
      try { child.kill?.("SIGKILL"); } catch { /* stable timeout below */ }
      reject(new ControlError("LOCK_ACQUIRE_TIMEOUT", "Host lock acquisition exceeded its bounded execution time"));
    }), helperTimeoutMs);
    child.once("error", () => settle(() => reject(new ControlError("LOCK_SPAWN_FAILED", "Unable to start host lock acquisition"))));
    child.once("close", (status) => settle(() => {
      const code = typeof status === "number" ? status : null;
      if (code === 0) resolve();
      else reject(acquisitionFailure(code, contendedReason));
    }));
  });
}

/**
 * Acquires flock on the same inherited open-file-description as the retained
 * parent FileHandle. Linux keeps that flock active after this short child exits
 * until the parent finally closes its descriptor after the callback completes.
 */
export class MutationLock implements MutationLockPort {
  readonly #stateDir: string;

  constructor(
    config: ControlConfig,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly runtime: MutationLockRuntime = productionLockRuntime,
    private readonly secureDirectoryHooks: SecureStateDirectoryHooks = {},
    private readonly options: MutationLockOptions = {},
  ) {
    this.#stateDir = resolve(config.stateDir);
    if (new.target === MutationLock) {
      directlyConstructedMutationLocks.add(this);
      const lockFileName = options.lockFileName ?? "registry.lock";
      directMutationLockAuthorities.set(this, {
        coordinate: `${resolve(this.#stateDir)}\u0000${lockFileName}`,
        hostCoordinate: createGuardHostCoordinateAuthority(this.#stateDir),
        guardEligible: lockFileName === "registry.lock" && options.waitSeconds === undefined,
        runGuard: <T>(callback: () => Promise<T>) =>
          this.#runLocked(async () => callback(), GUARD_REGISTRY_WAIT_SECONDS),
      });
    }
  }

  async run<T>(callback: () => Promise<T>): Promise<T> {
    return this.#runLocked(async () => callback());
  }

  /** Runs against the exact retained directory inode whose child lock FD is flocked. */
  async runInStateDirectory<T>(callback: (directory: SecureStateDirectory) => Promise<T>): Promise<T> {
    return this.#runLocked(callback);
  }

  async #runLocked<T>(
    callback: (directory: SecureStateDirectory) => Promise<T>,
    waitOverride?: number,
  ): Promise<T> {
    let directory: SecureStateDirectory | undefined;
    let lockFile: FileHandle | undefined;
    try {
      try {
        directory = await openSecureStateDirectory(
          this.#stateDir,
          this.secureDirectoryHooks,
          { strictExistingMode: this.options.strictExistingStateDirectory },
        );
        const lockFileName = this.options.lockFileName ?? "registry.lock";
        let lockCreated = false;
        if (this.options.strictExistingLockFileMode) {
          try {
            lockFile = await directory.openFile(lockFileName, strictLockCreateFlags, 0o600);
            lockCreated = true;
          } catch (cause) {
            if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")) {
              throw cause;
            }
            lockFile = await directory.openFile(lockFileName, existingLockOpenFlags);
          }
        } else {
          lockFile = await directory.openFile(lockFileName, lockOpenFlags, 0o600);
        }
        const info = await lockFile.stat();
        if (!info.isFile() || info.nlink !== 1) {
          throw new ControlError("UNSAFE_STATE_PATH", "Host lock is not a private single-link regular file");
        }
        if (this.options.strictExistingLockFileMode && !lockCreated) {
          if ((info.mode & 0o777) !== 0o600) {
            throw new ControlError("UNSAFE_STATE_PATH", "Host lock mode is not private");
          }
        } else {
          await lockFile.chmod(0o600);
        }
      } catch (cause) {
        if (cause instanceof ControlError && cause.code === "UNSAFE_STATE_PATH") throw cause;
        if (typeof cause === "object" && cause !== null && "code" in cause && (cause.code === "ELOOP" || cause.code === "ENOTDIR")) {
          throw new ControlError("UNSAFE_STATE_PATH", "Host lock path is unsafe");
        }
        throw new ControlError("LOCK_SETUP_FAILED", "Unable to prepare host mutation lock");
      }

      const helperEnvironment = sanitizedChildEnvironment(this.environment);
      // The historic marker has no authority and is never passed to the helper.
      delete helperEnvironment.JHW_CONTROL_LOCK_HELD;
      const wait = waitOverride ?? this.options.waitSeconds;
      if (wait !== undefined && (!Number.isSafeInteger(wait) || wait <= 0 || wait > 60)) {
        throw new ControlError("LOCK_SETUP_FAILED", "Lock wait must be a bounded positive integer");
      }
      let child: MutationLockChild;
      try {
        child = this.runtime.spawn(
          "flock",
          wait === undefined ? ["-n", "-E", "75", "3"] : ["-w", String(wait), "-E", "75", "3"],
          { env: helperEnvironment, stdio: ["ignore", "ignore", "ignore", lockFile.fd] },
        );
      } catch {
        throw new ControlError("LOCK_SPAWN_FAILED", "Unable to start host lock acquisition");
      }
      // A blocking helper legitimately runs for its full wait; the watchdog
      // must outlive it or every contended blocking acquire reports a timeout.
      await acquireLock(
        child,
        wait === undefined ? LOCK_HELPER_TIMEOUT_MS : Math.max(LOCK_HELPER_TIMEOUT_MS, (wait + 2) * 1000),
        this.options.contendedReason,
      );
      return await callback(directory);
    } finally {
      await lockFile?.close();
      await directory?.close();
    }
  }
}

/** True only for instances constructed directly by this module's base class. */
export function isDirectMutationLock(value: unknown): value is MutationLock {
  return typeof value === "object"
    && value !== null
    && directlyConstructedMutationLocks.has(value);
}

/**
 * Creates opaque Guard-only acquisition authority for the exact direct
 * Registry-writer lock. The writer's public run() remains non-blocking; only
 * this captured authority uses bounded host-lock waiting.
 */
export function createGuardMutationLockAuthority(
  mutationLock: MutationLock,
): GuardMutationLockAuthority {
  const direct = directMutationLockAuthorities.get(mutationLock);
  if (
    !isDirectMutationLock(mutationLock) ||
    Object.getPrototypeOf(mutationLock) !== MutationLock.prototype ||
    mutationLock.run !== MutationLock.prototype.run ||
    mutationLock.runInStateDirectory !== MutationLock.prototype.runInStateDirectory ||
    !direct?.guardEligible
  ) {
    throw new TypeError("Guard mutation authority requires the concrete MutationLock non-blocking Registry implementation");
  }
  const authority = Object.freeze({
    [guardMutationAuthorityBrand]: true,
  }) as GuardMutationLockAuthority;
  guardMutationAuthorityRunners.set(authority, (callback) => runGuardAdmission(direct, callback));
  return authority;
}

/** Returns no path, only the immutable coordinate proof captured by a genuine lock. */
export function guardMutationLockHostCoordinate(
  mutationLock: MutationLock,
): GuardHostCoordinateAuthority | undefined {
  const direct = directMutationLockAuthorities.get(mutationLock);
  return isDirectMutationLock(mutationLock) &&
    Object.getPrototypeOf(mutationLock) === MutationLock.prototype &&
    mutationLock.run === MutationLock.prototype.run &&
    mutationLock.runInStateDirectory === MutationLock.prototype.runInStateDirectory &&
    direct?.guardEligible
    ? direct.hostCoordinate
    : undefined;
}

/** Runs one admitted Guard mutation without exposing its private host coordinate. */
export function runWithGuardMutationLockAuthority<T>(
  authority: GuardMutationLockAuthority,
  callback: () => Promise<T>,
): Promise<T> {
  const runner = guardMutationAuthorityRunners.get(authority);
  if (!runner) {
    return Promise.reject(new ControlError("LOCK_CONTENDED", "Guard mutation authority is unavailable"));
  }
  return runner(callback) as Promise<T>;
}

async function runGuardAdmission<T>(
  direct: DirectMutationLockAuthority,
  callback: () => Promise<T>,
): Promise<T> {
  const inherited = activeGuardMutationCoordinates.getStore();
  if (inherited?.has(direct.coordinate)) {
    throw new ControlError("LOCK_CONTENDED", "Reentrant Guard mutation is not allowed");
  }

  let admission = guardAdmissions.get(direct.coordinate);
  if (!admission) {
    admission = { admitted: 0, tail: Promise.resolve() };
    guardAdmissions.set(direct.coordinate, admission);
  }
  if (admission.admitted >= GUARD_REGISTRY_ADMISSION_LIMIT) {
    throw new ControlError("LOCK_CONTENDED", "Guard mutation admission limit was reached");
  }

  admission.admitted += 1;
  const previous = admission.tail;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  admission.tail = previous.catch(() => undefined).then(() => gate);
  await previous.catch(() => undefined);
  try {
    const active = new Set(inherited ?? []);
    active.add(direct.coordinate);
    return await activeGuardMutationCoordinates.run(active, () => direct.runGuard(callback));
  } finally {
    release();
    admission.admitted -= 1;
    if (admission.admitted === 0 && guardAdmissions.get(direct.coordinate) === admission) {
      guardAdmissions.delete(direct.coordinate);
    }
  }
}
