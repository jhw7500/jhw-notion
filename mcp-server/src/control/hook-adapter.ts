#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

import { z } from "zod";

import { Catalog } from "./catalog.js";
import { ClaimService } from "./claim-service.js";
import { createCliDependencies, isCliEntrypointInvocation } from "./cli.js";
import { ControlContractAuthority } from "./contract-authority.js";
import { encodeCanonicalJson, type GuardCommonEvent } from "./guard-protocol.js";
import {
  createGuardServiceComposition,
  GuardSideEventResultSchema,
  type GuardService,
  type GuardSideEventResult,
} from "./guard-service.js";
import { createProductionGuardJournal } from "./guard-journal.js";
import {
  GuardDigestKey,
  GuardRequestStore,
} from "./guard-state.js";
import {
  claudeHookCodec,
  codexHookCodec,
  HookEventNameSchema,
  NativeHookOutputSchema,
  renderStaticHookFailure,
  type HookCodec,
  type HookEventName,
} from "./hook-codecs.js";
import { MutationLock } from "./process.js";
import { GuardDecisionSchema, type GuardDecision } from "./schemas.js";
import { TaskService } from "./task-service.js";

export const MAX_HOOK_STDIN_BYTES = 128 * 1024;
export const MAX_HOOK_OUTPUT_BYTES = 12 * 1024;

const HookAdapterNameSchema = z.enum(["claude", "codex"]);
type HookAdapterName = z.infer<typeof HookAdapterNameSchema>;

export interface HookGuardPort {
  submitUserPrompt(event: unknown): Promise<GuardSideEventResult>;
  evaluatePreTool(event: unknown): Promise<GuardDecision>;
  completePostTool(event: unknown): Promise<GuardSideEventResult>;
}

export interface HookRunResult {
  exitCode: 0;
  stdout: string;
  stderr: "";
}

export function parseHookCliArguments(argv: readonly string[]): {
  adapter: HookAdapterName;
  event: HookEventName;
} {
  if (
    argv.length !== 4 ||
    argv[0] !== "--adapter" ||
    argv[2] !== "--event"
  ) throw new TypeError("Invalid hook arguments");
  return {
    adapter: HookAdapterNameSchema.parse(argv[1]),
    event: HookEventNameSchema.parse(argv[3]),
  };
}

export function parseBoundedHookStdin(raw: string | Uint8Array): Record<string, unknown> {
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
  if (bytes.length === 0 || bytes.length > MAX_HOOK_STDIN_BYTES) {
    throw new TypeError("Invalid hook stdin size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("Invalid hook stdin JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) throw new TypeError("Hook stdin must be one JSON object");
  return parsed as Record<string, unknown>;
}

async function readBoundedHookStdin(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    total += chunk.length;
    if (total > MAX_HOOK_STDIN_BYTES) throw new TypeError("Hook stdin exceeds byte boundary");
    chunks.push(chunk);
  }
  if (total === 0) throw new TypeError("Hook stdin is empty");
  return Buffer.concat(chunks, total);
}

function codecFor(adapter: HookAdapterName): HookCodec {
  return adapter === "claude" ? claudeHookCodec : codexHookCodec;
}

function fallbackEvent(argv: readonly string[]): HookEventName {
  const candidate = argv[2] === "--event" ? argv[3] : undefined;
  const parsed = HookEventNameSchema.safeParse(candidate);
  return parsed.success ? parsed.data : "PreToolUse";
}

function serializeNative(event: HookEventName, value: unknown): string {
  const parsed = NativeHookOutputSchema.parse(value);
  if (
    event === "PreToolUse" && !("hookSpecificOutput" in parsed) ||
    event === "UserPromptSubmit" && !(
      "hookSpecificOutput" in parsed && parsed.hookSpecificOutput.hookEventName === "UserPromptSubmit"
    ) ||
    event === "PostToolUse" && "hookSpecificOutput" in parsed
  ) throw new TypeError("Native output does not match hook event");
  encodeCanonicalJson(parsed, { maximumBytes: MAX_HOOK_OUTPUT_BYTES - 1 });
  const line = `${JSON.stringify(parsed)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_HOOK_OUTPUT_BYTES) {
    throw new TypeError("Native output exceeds byte boundary");
  }
  return line;
}

function failureResult(
  event: HookEventName,
  code: "GUARD_UNAVAILABLE" | "GUARD_PROTOCOL_MISMATCH",
): HookRunResult {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(renderStaticHookFailure(event, code))}\n`,
    stderr: "",
  };
}

function parseSideResult(value: unknown, expected: "user_prompt_submit" | "post_tool_use"): GuardSideEventResult {
  const result = GuardSideEventResultSchema.parse(value);
  if (result.event !== undefined && result.event !== expected) {
    throw new TypeError("Guard side-event result mismatch");
  }
  return result;
}

async function resolveGuard(provider: HookGuardPort | (() => Promise<HookGuardPort>)): Promise<HookGuardPort> {
  return typeof provider === "function" ? provider() : provider;
}

async function executeHookAdapter(
  argv: readonly string[],
  raw: string | Uint8Array,
  provider: HookGuardPort | (() => Promise<HookGuardPort>),
): Promise<HookRunResult> {
  let selection: ReturnType<typeof parseHookCliArguments>;
  try {
    selection = parseHookCliArguments(argv);
  } catch {
    return failureResult(fallbackEvent(argv), "GUARD_PROTOCOL_MISMATCH");
  }
  const codec = codecFor(selection.adapter);
  let event: GuardCommonEvent;
  try {
    event = codec.decode(selection.event, parseBoundedHookStdin(raw));
  } catch {
    return failureResult(selection.event, "GUARD_PROTOCOL_MISMATCH");
  }

  let rawResult: unknown;
  try {
    const guard = await resolveGuard(provider);
    if (selection.event === "UserPromptSubmit") {
      rawResult = await guard.submitUserPrompt(event);
    } else if (selection.event === "PreToolUse") {
      rawResult = await guard.evaluatePreTool(event);
    } else {
      rawResult = await guard.completePostTool(event);
    }
  } catch {
    return failureResult(selection.event, "GUARD_UNAVAILABLE");
  }

  try {
    const rendered = selection.event === "UserPromptSubmit"
      ? codec.renderPrompt(parseSideResult(rawResult, "user_prompt_submit"))
      : selection.event === "PreToolUse"
        ? codec.renderPreTool(GuardDecisionSchema.parse(rawResult))
        : codec.renderPostTool(parseSideResult(rawResult, "post_tool_use"));
    return { exitCode: 0, stdout: serializeNative(selection.event, rendered), stderr: "" };
  } catch {
    return failureResult(selection.event, "GUARD_PROTOCOL_MISMATCH");
  }
}

export async function runHookAdapter(
  argv: readonly string[],
  raw: string | Uint8Array,
  guard: HookGuardPort,
): Promise<HookRunResult> {
  return executeHookAdapter(argv, raw, guard);
}

async function createProductionHookGuard(environment: NodeJS.ProcessEnv): Promise<GuardService> {
  const dependencies = createCliDependencies(environment);
  const catalog = dependencies.catalog as unknown as Catalog;
  const claims = dependencies.guardClaims as unknown as ClaimService;
  const tasks = dependencies.taskService as unknown as TaskService;
  const mutationLock = dependencies.mutationLock as unknown as MutationLock;
  const requestStore = dependencies.guardRequests as unknown as GuardRequestStore;
  const digestKey = dependencies.guardDigestKey as unknown as GuardDigestKey;
  const authority = new ControlContractAuthority({
    getRepository: (repoId) => catalog.getRepository(repoId),
    getTask: (taskId) => catalog.getTask(taskId),
    boardStatus: (boardId) => dependencies.boardService.status(boardId),
  });
  const guardJournal = createProductionGuardJournal(dependencies.stateDir, environment);
  const digest = await digestKey.loadOrCreate();
  const composition = createGuardServiceComposition(mutationLock, {
    host: environment.JHW_BUILD_HOST ?? "",
    digest_key: digest,
    claims,
    tasks: {
      getTask: (taskId) => catalog.getTask(taskId),
      inspectForGuard: (taskId, claimId) => tasks.inspectForGuard(taskId, claimId),
      sourceRevisionForGuard: (task) => tasks.sourceRevisionForGuard(task),
    },
    authority,
    registry_view: claims,
    guard_request_store: requestStore,
    guard_journal: guardJournal,
    mode: dependencies.guardMode,
    inspect_guard_state: async () => {
      const [key, requests] = await Promise.all([digestKey.inspect(), requestStore.inspect()]);
      return key.status === "ready" && requests.status === "ready";
    },
  });
  return composition.service;
}

async function writeResult(stream: Writable, content: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error) => reject(cause);
    stream.once("error", onError);
    stream.write(content, (cause?: Error | null) => {
      stream.off("error", onError);
      if (cause) reject(cause);
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let raw: Buffer;
  try {
    raw = await readBoundedHookStdin(process.stdin);
  } catch {
    const result = failureResult(fallbackEvent(argv), "GUARD_PROTOCOL_MISMATCH");
    await writeResult(process.stdout, result.stdout);
    process.exitCode = 0;
    return;
  }
  const result = await executeHookAdapter(
    argv,
    raw,
    () => createProductionHookGuard(process.env),
  );
  await writeResult(process.stdout, result.stdout);
  process.exitCode = result.exitCode;
}

if (isCliEntrypointInvocation(process.argv[1], fileURLToPath(import.meta.url))) {
  void main().catch(async () => {
    try {
      await writeResult(process.stdout, failureResult(fallbackEvent(process.argv.slice(2)), "GUARD_UNAVAILABLE").stdout);
    } catch {
      // There is no writable transport left at this point.
    }
    process.exitCode = 0;
  });
}
