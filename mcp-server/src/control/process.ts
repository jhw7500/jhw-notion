import { spawn } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { ensureSecureStateDirectory, PilotJournal } from "./journal.js";

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

const MAX_CREDENTIAL_ENVELOPE_BYTES = 16 * 1024;
const DEFAULT_LOCKED_CLI_ENTRY_PATH = fileURLToPath(new URL("./locked-cli.js", import.meta.url));
const stableExitCodes = new Set([0, 1, 2, 4, 75, 78]);

export interface MutationLockChild {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface MutationLockRuntime {
  spawn: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
  ) => MutationLockChild;
}

export interface MutationLockResult {
  exitCode: 0 | 1 | 2 | 4 | 75 | 78;
  stdout: string;
  stderr: string;
}

const productionLockRuntime: MutationLockRuntime = {
  spawn: (command, args, options) => spawn(command, args, options),
};

function safeCommandName(argv: readonly string[]): string {
  if (argv[0] === "task" && ["start", "status", "finish", "recover", "assert-owner"].includes(argv[1] ?? "")) {
    return `task ${argv[1]}`;
  }
  if (argv[0] === "portfolio" && ["status", "export"].includes(argv[1] ?? "")) return `portfolio ${argv[1]}`;
  if (argv[0] === "project" && argv[1] === "register") return "project register";
  if (argv[0] === "preflight") return "preflight";
  return "invalid";
}

function lockError(code: string, exitCode: 1 | 75): MutationLockResult {
  return {
    exitCode,
    stdout: "",
    stderr: `${JSON.stringify({ error: { code } })}\n`,
  };
}

async function recordLockFailure(config: ControlConfig, argv: readonly string[], result: MutationLockResult): Promise<void> {
  const now = new Date();
  const error = JSON.parse(result.stderr) as { error: { code: string } };
  await new PilotJournal(config.stateDir).append({
    command: safeCommandName(argv),
    started_at: now.toISOString(),
    finished_at: now.toISOString(),
    elapsed_ms: 0,
    ok: false,
    error_code: error.error.code,
    payload_bytes: Buffer.byteLength(result.stderr, "utf8"),
  }).catch(() => undefined);
}

function credentialsFromEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const key of ["GH_PROJECT_TOKEN", "GH_REPO_TOKEN"] as const) {
    const value = env[key];
    if (typeof value === "string") credentials[key] = value;
  }
  return credentials;
}

/** Serializes the only credentials permitted across the flock boundary. */
export function privateCredentialEnvelope(env: NodeJS.ProcessEnv): string {
  const envelope = JSON.stringify(credentialsFromEnvironment(env));
  if (Buffer.byteLength(envelope, "utf8") > MAX_CREDENTIAL_ENVELOPE_BYTES) {
    throw new ControlError("CREDENTIAL_ENVELOPE_TOO_LARGE", "Credential envelope exceeds its private input bound");
  }
  return envelope;
}

/** Reads one bounded private credential envelope from the locked child stdin. */
export async function readPrivateCredentialEnvelope(stream: AsyncIterable<Buffer | string>): Promise<NodeJS.ProcessEnv> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    length += bytes.length;
    if (length > MAX_CREDENTIAL_ENVELOPE_BYTES) {
      throw new ControlError("CREDENTIAL_ENVELOPE_TOO_LARGE", "Credential envelope exceeds its private input bound");
    }
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new ControlError("CREDENTIAL_ENVELOPE_INVALID", "Credential envelope is invalid");
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new ControlError("CREDENTIAL_ENVELOPE_INVALID", "Credential envelope is invalid");
  }
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(candidate)) {
    if ((key !== "GH_PROJECT_TOKEN" && key !== "GH_REPO_TOKEN") || typeof value !== "string") {
      throw new ControlError("CREDENTIAL_ENVELOPE_INVALID", "Credential envelope is invalid");
    }
    output[key] = value;
  }
  return output;
}

function captureLockStream(stream: Readable | null): Promise<{ value: string; tooLarge: boolean }> {
  if (!stream) return Promise.resolve({ value: "", tooLarge: false });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let tooLarge = false;
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (length + bytes.length > MAX_CAPTURE_BYTES) {
        tooLarge = true;
        const remaining = Math.max(0, MAX_CAPTURE_BYTES - length);
        if (remaining) {
          chunks.push(bytes.subarray(0, remaining));
          length += remaining;
        }
        return;
      }
      chunks.push(bytes);
      length += bytes.length;
    });
    stream.once("end", () => resolve({ value: Buffer.concat(chunks).toString("utf8"), tooLarge }));
    stream.once("error", () => resolve({ value: "", tooLarge: true }));
  });
}

function waitForLockChild(child: MutationLockChild): Promise<{ kind: "close"; status: number | null } | { kind: "spawn-error" }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: { kind: "close"; status: number | null } | { kind: "spawn-error" }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", () => settle({ kind: "spawn-error" }));
    child.once("close", (status) => settle({ kind: "close", status: typeof status === "number" ? status : null }));
  });
}

function validForwardedResult(status: number | null, stdout: string, stderr: string): MutationLockResult | undefined {
  if (status === null || !stableExitCodes.has(status)) return undefined;
  try {
    if (status === 0 && !stderr) {
      const parsed = JSON.parse(stdout) as { command?: unknown; result?: unknown };
      if (typeof parsed === "object" && parsed !== null && typeof parsed.command === "string" && "result" in parsed) {
        return { exitCode: 0, stdout, stderr: "" };
      }
    }
    if (status !== 0 && !stdout) {
      const parsed = JSON.parse(stderr) as { error?: { code?: unknown } };
      if (typeof parsed?.error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(parsed.error.code)) {
        return { exitCode: status as MutationLockResult["exitCode"], stdout: "", stderr };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Executes the private locked entrypoint under flock. The installed caller never
 * trusts an environment marker: every mutation passes through this boundary.
 * Credentials are removed from flock's argv/environment and cross only stdin.
 */
export async function runUnderMutationLock(
  argv: string[],
  config: ControlConfig,
  environment: NodeJS.ProcessEnv = process.env,
  runtime: MutationLockRuntime = productionLockRuntime,
  lockedCliEntryPath = DEFAULT_LOCKED_CLI_ENTRY_PATH,
): Promise<MutationLockResult> {
  try {
    await ensureSecureStateDirectory(config.stateDir);
  } catch {
    return lockError("LOCK_SETUP_FAILED", 1);
  }

  let envelope: string;
  try {
    envelope = privateCredentialEnvelope(environment);
  } catch {
    const result = lockError("CREDENTIAL_ENVELOPE_TOO_LARGE", 1);
    await recordLockFailure(config, argv, result);
    return result;
  }
  const childEnvironment = sanitizedChildEnvironment(environment);
  delete childEnvironment.JHW_CONTROL_LOCK_HELD;
  const lock = join(config.stateDir, "registry.lock");
  let child: MutationLockChild;
  try {
    child = runtime.spawn(
      "flock",
      ["-n", "-E", "75", lock, process.execPath, lockedCliEntryPath, ...argv],
      { stdio: ["pipe", "pipe", "pipe"], env: childEnvironment },
    );
  } catch {
    const result = lockError("LOCK_SPAWN_FAILED", 1);
    await recordLockFailure(config, argv, result);
    return result;
  }

  if (!child.stdin) {
    const result = lockError("LOCK_STDIN_FAILED", 1);
    await recordLockFailure(config, argv, result);
    return result;
  }
  let stdinFailed = false;
  child.stdin.once("error", () => { stdinFailed = true; });
  try {
    child.stdin.end(envelope);
  } catch {
    stdinFailed = true;
  }
  const stdoutCapture = captureLockStream(child.stdout);
  const stderrCapture = captureLockStream(child.stderr);
  const outcome = await waitForLockChild(child);
  if (outcome.kind === "spawn-error") {
    const result = lockError("LOCK_SPAWN_FAILED", 1);
    await recordLockFailure(config, argv, result);
    return result;
  }
  const [stdout, stderr] = await Promise.all([stdoutCapture, stderrCapture]);
  if (stdinFailed || stdout.tooLarge || stderr.tooLarge) {
    const result = lockError(stdinFailed ? "LOCK_STDIN_FAILED" : "LOCK_OUTPUT_INVALID", 1);
    await recordLockFailure(config, argv, result);
    return result;
  }
  const forwarded = validForwardedResult(outcome.status, stdout.value, stderr.value);
  if (forwarded) return forwarded;
  if (outcome.status === 75 && !stdout.value && !stderr.value) {
    const result = lockError("LOCK_CONTENDED", 75);
    await recordLockFailure(config, argv, result);
    return result;
  }
  const result = lockError("LOCK_EXEC_FAILED", 1);
  await recordLockFailure(config, argv, result);
  return result;
}
