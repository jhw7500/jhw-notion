import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { openSecureStateDirectory, type SecureStateDirectory, type SecureStateDirectoryHooks } from "./journal.js";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const SECRET_ENV_KEY = /_(?:TOKEN|KEY|SECRET)$/;

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
}

export type GhCredential = "project" | "repo";

/** Removes credentials before spawning ordinary host subprocesses. */
export function sanitizedChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SECRET_ENV_KEY.test(key)));
}

function secretValues(env: NodeJS.ProcessEnv): string[] {
  return [...new Set(
    Object.entries(env)
      .filter(([key, value]) => SECRET_ENV_KEY.test(key) && value)
      .map(([, value]) => value as string),
  )].sort((left, right) => right.length - left.length);
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value);
}

function partialSecretPrefixLength(value: string, secrets: readonly string[]): number {
  const longest = Math.max(0, ...secrets.map((secret) => secret.length - 1));
  for (let length = Math.min(longest, value.length); length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (secrets.some((secret) => secret.startsWith(suffix))) return length;
  }
  return 0;
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
function redactingCapture(stream: Readable | null, secrets: readonly string[]): Promise<Buffer> {
  if (!stream) return Promise.resolve(Buffer.alloc(0));

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const decoder = new StringDecoder("utf8");
    let captured = 0;
    let pending = "";

    const append = (value: string) => {
      if (captured >= MAX_CAPTURE_BYTES || !value) return;
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
    };
    const emitAvailable = () => {
      const spans = secretSpans(pending, secrets);
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
    stream.once("end", () => {
      pending += decoder.end();
      const spans = secretSpans(pending, secrets);
      const prefixLength = partialSecretPrefixLength(pending, secrets);
      if (prefixLength) spans.push({ start: pending.length - prefixLength, end: pending.length });
      append(renderMasked(pending, mergeSecretSpans(spans)));
      pending = "";
      resolve(Buffer.concat(chunks));
    });
    stream.once("error", reject);
  });
}

export class ProcessRunner {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async run(command: string, args: string[], options: ProcessRunOptions = {}): Promise<ProcessResult> {
    const rawEnvironment = { ...this.environment, ...options.env };
    return this.runWithEnvironment(
      command,
      args,
      options.cwd,
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
    const secrets = secretValues(rawEnvironment);
    const safeCommand = redact(command, secrets);
    const safeArgs = args.map((arg) => redact(arg, secrets));
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: sanitizedChildEnvironment(rawEnvironment),
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
      child.stdout?.once("error", reject);
      // A failed spawn is not guaranteed to emit stdout's `end`; settle this
      // capture as well so the stable command error below can be returned.
      child.once("error", () => resolve(snapshot()));
      if (!child.stdout) resolve({ bytes: Buffer.alloc(0), tooLarge: false });
    });
    const exit = await new Promise<number | null>((resolve) => {
      let settled = false;
      const settle = (value: number | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once("error", () => settle(null));
      child.once("close", (exitCode) => settle(exitCode));
    });
    let captured: { bytes: Buffer; tooLarge: boolean };
    try {
      captured = await output;
    } catch {
      throw new ControlError("RAW_COMMAND_FAILED", "Unable to read raw command output", {
        command: safeCommand,
        args: safeArgs,
        exitCode: exit,
      });
    }
    if (captured.tooLarge) {
      throw new ControlError("RAW_OUTPUT_TOO_LARGE", "Raw command output exceeds its byte bound", {
        command: safeCommand,
        args: safeArgs,
        exitCode: exit,
        maximumBytes,
      });
    }
    if (exit !== 0) {
      throw new ControlError("RAW_COMMAND_FAILED", "Raw command failed", {
        command: safeCommand,
        args: safeArgs,
        exitCode: exit,
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
      options.cwd,
      { ...sanitizedChildEnvironment(rawEnvironment), GH_TOKEN: token },
      secretValues(rawEnvironment),
    );
  }

  private async runWithEnvironment(
    command: string,
    args: string[],
    cwd: string | undefined,
    env: NodeJS.ProcessEnv,
    secrets: readonly string[],
  ): Promise<ProcessResult> {
    const safeCommand = redact(command, secrets);
    const safeArgs = args.map((arg) => redact(arg, secrets));
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
    const exit = await new Promise<{ exitCode: number | null; cause?: string }>((resolve) => {
      let settled = false;
      const settle = (result: { exitCode: number | null; cause?: string }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.once("error", (cause) => settle({
        exitCode: null,
        cause: cause instanceof Error ? cause.message : String(cause),
      }));
      child.once("close", (exitCode) => settle({ exitCode }));
    });
    const [stdoutBuffer, stderrBuffer] = await Promise.all([stdout, stderr]);
    const result = {
      command: safeCommand,
      args: safeArgs,
      stdout: stdoutBuffer.toString("utf8"),
      stderr: stderrBuffer.toString("utf8"),
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
const READY = "READY\n";
const HOLDER_COMMAND = ["/bin/sh", "-c", "printf 'READY\\n'; cat >/dev/null"] as const;

export interface MutationLockPort {
  run<T>(callback: () => Promise<T>): Promise<T>;
}

export interface MutationLockChild {
  stdin: Writable | null;
  stdout: Readable | null;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface MutationLockRuntime {
  spawn: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "ignore", number] },
  ) => MutationLockChild;
}

const productionLockRuntime: MutationLockRuntime = {
  spawn: (command, args, options) => spawn(command, args, options),
};

interface HolderExit {
  kind: "close" | "spawn-error";
  status?: number | null;
}

interface HolderObservation {
  ready: Promise<void>;
  closed: Promise<HolderExit>;
}

function lockFailure(exit: HolderExit): ControlError {
  if (exit.kind === "spawn-error") {
    return new ControlError("LOCK_SPAWN_FAILED", "Unable to start host lock holder");
  }
  if (exit.status === 75) {
    return new ControlError("LOCK_CONTENDED", "Host mutation lock is already held");
  }
  return new ControlError("LOCK_READY_FAILED", "Host lock holder did not acknowledge acquisition");
}

function observeHolder(child: MutationLockChild): HolderObservation {
  let resolveClose: (exit: HolderExit) => void = () => undefined;
  const closed = new Promise<HolderExit>((resolve) => { resolveClose = resolve; });
  let closedOnce = false;
  const settleClose = (exit: HolderExit) => {
    if (closedOnce) return;
    closedOnce = true;
    resolveClose(exit);
  };
  child.once("error", () => settleClose({ kind: "spawn-error" }));
  child.once("close", (status) => settleClose({
    kind: "close",
    status: typeof status === "number" ? status : null,
  }));

  const ready = new Promise<void>((resolve, reject) => {
    if (!child.stdout) {
      reject(new ControlError("LOCK_READY_FAILED", "Host lock holder has no ready stream"));
      return;
    }
    let settled = false;
    let output = "";
    const fail = (cause: ControlError) => {
      if (settled) return;
      settled = true;
      reject(cause);
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (output === READY) {
        settled = true;
        resolve();
      } else if (!READY.startsWith(output) || output.length >= READY.length) {
        fail(new ControlError("LOCK_READY_FAILED", "Host lock holder emitted an invalid ready acknowledgement"));
      }
    });
    child.stdout.once("error", () => fail(new ControlError("LOCK_READY_FAILED", "Host lock holder ready stream failed")));
    child.stdout.once("end", () => {
      if (!settled) fail(new ControlError("LOCK_READY_FAILED", "Host lock holder closed before ready"));
    });
    void closed.then((exit) => {
      if (!settled) fail(lockFailure(exit));
    });
  });
  return { ready, closed };
}

/**
 * Holds the host-global flock in a credential-sanitized helper while the
 * callback remains in this original process. The helper receives no CLI
 * arguments or credentials and has no mutation dispatcher to invoke.
 */
export class MutationLock implements MutationLockPort {
  constructor(
    private readonly config: ControlConfig,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly runtime: MutationLockRuntime = productionLockRuntime,
    private readonly secureDirectoryHooks: SecureStateDirectoryHooks = {},
  ) {}

  async run<T>(callback: () => Promise<T>): Promise<T> {
    let directory: SecureStateDirectory | undefined;
    let lockFile: FileHandle | undefined;
    let observation: HolderObservation | undefined;
    let child: MutationLockChild | undefined;
    try {
      try {
        directory = await openSecureStateDirectory(this.config.stateDir, this.secureDirectoryHooks);
        lockFile = await directory.openFile("registry.lock", lockOpenFlags, 0o600);
        const info = await lockFile.stat();
        if (!info.isFile()) throw new ControlError("UNSAFE_STATE_PATH", "Host lock is not a regular file");
        await lockFile.chmod(0o600);
      } catch (cause) {
        if (cause instanceof ControlError && cause.code === "UNSAFE_STATE_PATH") throw cause;
        if (typeof cause === "object" && cause !== null && "code" in cause && (cause.code === "ELOOP" || cause.code === "ENOTDIR")) {
          throw new ControlError("UNSAFE_STATE_PATH", "Host lock path is unsafe");
        }
        throw new ControlError("LOCK_SETUP_FAILED", "Unable to prepare host mutation lock");
      }

      const helperEnvironment = sanitizedChildEnvironment(this.environment);
      // Deliberately ignore the retired marker; it is neither an authority nor
      // forwarded to the helper process.
      delete helperEnvironment.JHW_CONTROL_LOCK_HELD;
      try {
        child = this.runtime.spawn(
          "flock",
          ["-n", "-E", "75", "/proc/self/fd/3", ...HOLDER_COMMAND],
          { env: helperEnvironment, stdio: ["pipe", "pipe", "ignore", lockFile.fd] },
        );
      } catch {
        throw new ControlError("LOCK_SPAWN_FAILED", "Unable to start host lock holder");
      }
      observation = observeHolder(child);
      await observation.ready;
      // If the holder dies while callback work is pending, fail rather than
      // returning a result that may have run after the flock was released.
      let callbackSettled = false;
      const callbackResult = callback().then(
        (value) => {
          callbackSettled = true;
          return value;
        },
        (cause: unknown) => {
          callbackSettled = true;
          throw cause;
        },
      );
      return await Promise.race([
        callbackResult,
        observation.closed.then((exit) => {
          if (!callbackSettled) throw lockFailure(exit);
          return new Promise<T>(() => undefined);
        }),
      ]);
    } finally {
      if (child?.stdin) {
        try {
          child.stdin.end();
        } catch {
          // The ready/close observation supplies the stable error mapping.
        }
      }
      if (observation) await observation.closed;
      await lockFile?.close();
      await directory?.close();
    }
  }
}
