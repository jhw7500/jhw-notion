import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const SECRET_ENV_KEY = /_(?:TOKEN|KEY|SECRET)$/;
const DEFAULT_CLI_ENTRY_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

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
      let completeCharacters = encoded.subarray(0, remaining).toString("utf8");
      while (Buffer.byteLength(completeCharacters, "utf8") > remaining) {
        completeCharacters = completeCharacters.slice(0, -1);
      }
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

export interface MutationLockRuntime {
  environment: NodeJS.ProcessEnv;
  mkdirSync: (path: string, options: { recursive: true; mode: number }) => void;
  spawnSync: (
    command: string,
    args: string[],
    options: SpawnSyncOptions,
  ) => { status: number | null };
  exit: (code: number) => void;
}

const productionLockRuntime: MutationLockRuntime = {
  environment: process.env,
  mkdirSync,
  spawnSync,
  exit: (code) => process.exit(code),
};

/**
 * Replaces the current process with a flock-guarded CLI child before a mutation.
 * Runtime and CLI path are injectable to test construction without exiting Vitest.
 */
export function reexecUnderMutationLock(
  argv: string[],
  config: ControlConfig,
  runtime: MutationLockRuntime = productionLockRuntime,
  cliEntryPath = DEFAULT_CLI_ENTRY_PATH,
): void {
  if (runtime.environment.JHW_CONTROL_LOCK_HELD === "1") return;

  const lock = join(config.stateDir, "registry.lock");
  runtime.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const child = runtime.spawnSync(
    "flock",
    ["-n", "-E", "75", lock, process.execPath, cliEntryPath, ...argv],
    {
      stdio: "inherit",
      env: { ...sanitizedChildEnvironment(runtime.environment), JHW_CONTROL_LOCK_HELD: "1" },
    },
  );
  runtime.exit(child.status ?? 75);
}
