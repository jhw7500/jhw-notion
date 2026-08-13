import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Readable } from "node:stream";

import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";

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

function boundedCapture(stream: Readable | null): Promise<Buffer> {
  if (!stream) return Promise.resolve(Buffer.alloc(0));

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let captured = 0;
    stream.on("data", (chunk: Buffer | string) => {
      if (captured >= MAX_CAPTURE_BYTES) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_CAPTURE_BYTES - captured;
      const bounded = buffer.subarray(0, remaining);
      chunks.push(bounded);
      captured += bounded.length;
    });
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
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

export class ProcessRunner {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async run(command: string, args: string[], options: ProcessRunOptions = {}): Promise<ProcessResult> {
    const env = { ...this.environment, ...options.env };
    const secrets = secretValues(env);
    const safeCommand = redact(command, secrets);
    const safeArgs = args.map((arg) => redact(arg, secrets));
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env,
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

    const stdout = boundedCapture(child.stdout);
    const stderr = boundedCapture(child.stderr);
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
      stdout: redact(stdoutBuffer.toString("utf8"), secrets),
      stderr: redact(stderrBuffer.toString("utf8"), secrets),
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
 * Replaces the current process with a flock-guarded child before a registry mutation.
 * The optional runtime keeps decision and spawn construction directly testable.
 */
export function reexecUnderMutationLock(
  argv: string[],
  config: ControlConfig,
  runtime: MutationLockRuntime = productionLockRuntime,
): void {
  if (runtime.environment.JHW_CONTROL_LOCK_HELD === "1") return;

  const lock = join(config.stateDir, "registry.lock");
  runtime.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const child = runtime.spawnSync(
    "flock",
    ["-n", lock, process.execPath, fileURLToPath(import.meta.url), ...argv],
    { stdio: "inherit", env: { ...runtime.environment, JHW_CONTROL_LOCK_HELD: "1" } },
  );
  runtime.exit(child.status ?? 75);
}
