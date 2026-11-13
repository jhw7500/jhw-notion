#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

import { z } from "zod";

import { Catalog } from "./catalog.js";
import { ClaimService } from "./claim-service.js";
import { createCliDependencies, isCliEntrypointInvocation } from "./cli.js";
import { ControlContractAuthority } from "./contract-authority.js";
import { encodeCanonicalJson, MAX_TOOL_INPUT_BYTES, type GuardCommonEvent } from "./guard-protocol.js";
import { loadControlConfig } from "./config.js";
import {
  createGuardServiceComposition,
  GuardSideEventResultSchema,
  screenSelfApproval,
  type GuardSideEventResult,
} from "./guard-service.js";
import { appendGuardHookDiagnostic, type GuardDiagnosticKind, type GuardDiagnosticRow } from "./guard-diagnostics.js";
import { createProductionGuardJournal } from "./guard-journal.js";
import { resolveGuardEnvironment, type GuardEnvironmentResolution } from "./guard-policy.js";
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
import {
  createProductionSessionEndRecorder,
  type SessionEndEvidenceResult,
} from "./session-end.js";

export const MAX_HOOK_STDIN_BYTES = MAX_TOOL_INPUT_BYTES;
export const MAX_HOOK_OUTPUT_BYTES = 12 * 1024;

const HookAdapterNameSchema = z.enum(["claude", "codex"]);
type HookAdapterName = z.infer<typeof HookAdapterNameSchema>;

export interface HookGuardPort {
  submitUserPrompt(event: unknown): Promise<GuardSideEventResult>;
  evaluatePreTool(event: unknown): Promise<GuardDecision>;
  completePostTool(event: unknown): Promise<GuardSideEventResult>;
  recordSessionEnd(event: unknown): Promise<SessionEndEvidenceResult>;
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
    event === "PreToolUse" && !(
      "hookSpecificOutput" in parsed && parsed.hookSpecificOutput.hookEventName === "PreToolUse"
    ) ||
    event === "UserPromptSubmit" && !(
      "hookSpecificOutput" in parsed && parsed.hookSpecificOutput.hookEventName === "UserPromptSubmit"
    ) ||
    (event === "PostToolUse" || event === "SessionEnd") && "hookSpecificOutput" in parsed
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
  code: HookFailureCode,
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

async function resolveGuard(
  provider: HookGuardPort | ((event: HookEventName, gate?: DecisionGate) => Promise<HookGuardPort>),
  event: HookEventName,
  gate?: DecisionGate,
): Promise<HookGuardPort> {
  return typeof provider === "function" ? provider(event, gate) : provider;
}

/**
 * The decision must be on stdout before the runner's 8,000 ms watchdog, which
 * starts after it spawns this process, so its clock starts slightly later than
 * the `performance.now()` clock used here. Deadline output plus the bounded
 * diagnostics write finish by about 7.0 s. After a decision that was slow or
 * attempted a diagnostics append, the core requests exit itself once the
 * bounded diagnostic is done, so a slow append cannot keep it alive into the
 * kill. The deadline stays above the Registry lock wait (5 s) plus 1 s and
 * below the watchdog minus 1 s.
 */
export const HOOK_DECISION_DEADLINE_MS = 6_500;
export const HOOK_LATENCY_WARNING_MS = HOOK_DECISION_DEADLINE_MS / 2;
// A diagnostics write may not start after this point, so it cannot delay a
// committed enforce decision into the runner's kill.
const HOOK_DIAGNOSTICS_CUTOFF_MS = 7_000;
const HOOK_DIAGNOSTICS_RACE_MS = 250;
// Runs (keyed by their io seam) in which a diagnostics append was started; the
// append may outlive its race, so such a run must end by an explicit exit.
const diagnosticsAttempted = new WeakSet<HookDeadlineIo>();

/** Known host mode and control state directory; absent when the policy could not be resolved. */
export interface HookRunContext {
  stateDir: string;
  mode: "enforce" | "observe";
}

export interface HookDeadlineTimer {
  clear(): void;
}

/** Process seams of the PreToolUse deadline; production wires the real clock, timers, stdout and exit. */
export interface HookDeadlineIo {
  /** Milliseconds since process start. */
  now(): number;
  setTimer(callback: () => void, delayMs: number): HookDeadlineTimer;
  write(stdout: string): Promise<void>;
  exit(): void;
}

/** One stdout emission per process: the first outcome wins, every later one is dropped. */
class SingleEmission {
  private done = false;

  constructor(private readonly write: (stdout: string) => Promise<void>) {}

  async emit(stdout: string): Promise<boolean> {
    if (this.done) return false;
    this.done = true;
    await this.write(stdout);
    return true;
  }
}

/**
 * Armed once the digest key exists (key creation is not atomic, so the deadline
 * never cuts it). `tryCommit` is the permit boundary: after it returns true the
 * deadline is off for good and the authoritative decision is emitted.
 */
class DecisionGate {
  private state: "idle" | "armed" | "committed" | "expired" | "done" = "idle";
  private timer: HookDeadlineTimer | undefined;

  constructor(private readonly io: HookDeadlineIo, private readonly onExpire: () => void) {}

  arm(): void {
    if (this.state !== "idle") return;
    this.state = "armed";
    const remaining = HOOK_DECISION_DEADLINE_MS - this.io.now();
    if (remaining <= 0) {
      this.fire();
      return;
    }
    this.timer = this.io.setTimer(() => this.fire(), remaining);
  }

  tryCommit(): boolean {
    if (this.state === "expired") return false;
    this.state = "committed";
    this.timer?.clear();
    return true;
  }

  dispose(): void {
    this.timer?.clear();
    if (this.state === "armed") this.state = "done";
  }

  private fire(): void {
    if (this.state !== "armed") return;
    this.state = "expired";
    this.onExpire();
  }
}

interface DeadlineRun {
  io: HookDeadlineIo;
  emission: SingleEmission;
}

type HookFailureCode = "GUARD_UNAVAILABLE" | "GUARD_PROTOCOL_MISMATCH";

async function recordBoundedDiagnostic(
  context: HookRunContext | undefined,
  row: Omit<GuardDiagnosticRow, "mode">,
  io?: HookDeadlineIo,
): Promise<void> {
  if (!context || (io && io.now() > HOOK_DIAGNOSTICS_CUTOFF_MS)) return;
  if (io) diagnosticsAttempted.add(io);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      appendGuardHookDiagnostic(context.stateDir, { ...row, mode: context.mode }),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, HOOK_DIAGNOSTICS_RACE_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function executeHookAdapter(
  argv: readonly string[],
  raw: string | Uint8Array,
  provider: HookGuardPort | ((event: HookEventName, gate?: DecisionGate) => Promise<HookGuardPort>),
  context?: HookRunContext,
  deadline?: DeadlineRun,
): Promise<HookRunResult> {
  let selection: ReturnType<typeof parseHookCliArguments>;
  try {
    selection = parseHookCliArguments(argv);
  } catch {
    return failureResult(fallbackEvent(argv), "GUARD_PROTOCOL_MISMATCH");
  }
  const codec = codecFor(selection.adapter);
  let stdin: Record<string, unknown> | undefined;
  try {
    stdin = parseBoundedHookStdin(raw);
  } catch {
    stdin = undefined;
  }
  // In observe a Guard self-failure on PreToolUse is a recorded allow, but only
  // when the self-approval screen of the raw input is clear: unreadable,
  // unscannable and self-approving input stays denied.
  const observeAllowed = context?.mode === "observe" && selection.event === "PreToolUse" && stdin !== undefined &&
    screenSelfApproval(selection.adapter, stdin.tool_name, stdin.tool_input) === "clear";
  const neutralAllow = (): string => serializeNative(selection.event, { hookSpecificOutput: { hookEventName: "PreToolUse" } });
  const timed = deadline !== undefined && selection.event === "PreToolUse";
  let gate: DecisionGate | undefined;
  // A PreToolUse decision settles through here: it disarms the deadline, emits
  // once and, when it was slow, records the latency after stdout is written.
  let emitted = false;
  const finish = async (result: HookRunResult, exitAfter = true): Promise<HookRunResult> => {
    if (!timed) return result;
    gate?.dispose();
    if (await deadline.emission.emit(result.stdout)) {
      emitted = true;
      const elapsed = deadline.io.now();
      const slow = elapsed > HOOK_LATENCY_WARNING_MS;
      if (slow) {
        await recordBoundedDiagnostic(context, {
          adapter: selection.adapter, event: selection.event, kind: "latency", elapsed_ms: Math.round(elapsed),
        }, deadline.io);
      }
      // An append may outlive its race; exit 0 now that the decision is written.
      if (exitAfter && (slow || diagnosticsAttempted.has(deadline.io))) deadline.io.exit();
    }
    return result;
  };
  const failed = async (code: HookFailureCode, kind: GuardDiagnosticKind): Promise<HookRunResult> => {
    if (!observeAllowed) return finish(failureResult(selection.event, code));
    // The decision reaches stdout first; the diagnostic is bounded and skipped when late.
    const result = await finish({ exitCode: 0, stdout: neutralAllow(), stderr: "" }, false);
    await recordBoundedDiagnostic(context, { adapter: selection.adapter, event: selection.event, kind, code }, deadline?.io);
    if (emitted) deadline?.io.exit();
    return result;
  };
  let event: GuardCommonEvent;
  try {
    if (stdin === undefined) throw new TypeError("Invalid hook stdin");
    event = codec.decode(selection.event, stdin);
  } catch {
    return failed("GUARD_PROTOCOL_MISMATCH", "decode_failure");
  }

  if (timed) {
    gate = new DecisionGate(deadline.io, () => {
      void (async () => {
        const stdout = observeAllowed
          ? neutralAllow()
          : `${JSON.stringify(renderStaticHookFailure(selection.event, "GUARD_DEADLINE_EXCEEDED"))}\n`;
        if (!await deadline.emission.emit(stdout)) return;
        await recordBoundedDiagnostic(context, {
          adapter: selection.adapter, event: selection.event, kind: "deadline",
          code: "GUARD_DEADLINE_EXCEEDED", elapsed_ms: Math.round(deadline.io.now()),
        }, deadline.io);
        deadline.io.exit();
      })().catch(() => deadline.io.exit());
    });
  }
  let rawResult: unknown;
  try {
    const guard = await resolveGuard(provider, selection.event, gate);
    // A provider that creates the digest key arms the gate after it; a plain port arms here.
    gate?.arm();
    if (selection.event === "UserPromptSubmit") {
      rawResult = await guard.submitUserPrompt(event);
    } else if (selection.event === "PreToolUse") {
      rawResult = await guard.evaluatePreTool(event);
    } else if (selection.event === "PostToolUse") {
      rawResult = await guard.completePostTool(event);
    } else {
      rawResult = await guard.recordSessionEnd(event);
    }
  } catch {
    return failed("GUARD_UNAVAILABLE", "unrecorded_allow");
  }

  try {
    const rendered = selection.event === "UserPromptSubmit"
      ? codec.renderPrompt(parseSideResult(rawResult, "user_prompt_submit"))
      : selection.event === "PreToolUse"
        ? codec.renderPreTool(GuardDecisionSchema.parse(rawResult))
        : selection.event === "PostToolUse"
          ? codec.renderPostTool(parseSideResult(rawResult, "post_tool_use"))
          : codec.renderSessionEnd(rawResult);
    return await finish({ exitCode: 0, stdout: serializeNative(selection.event, rendered), stderr: "" });
  } catch {
    return failed("GUARD_PROTOCOL_MISMATCH", "unrecorded_allow");
  }
}

/** Runs one hook with an injected port and process seams; the deadline applies to PreToolUse only. */
export async function runHookAdapterWithDeadline(
  argv: readonly string[],
  raw: string | Uint8Array,
  guard: HookGuardPort,
  io: HookDeadlineIo,
  context?: HookRunContext,
): Promise<HookRunResult> {
  const deadline = { io, emission: new SingleEmission((stdout) => io.write(stdout)) };
  const result = await executeHookAdapter(argv, raw, guard, context, deadline);
  await deadline.emission.emit(result.stdout);
  return result;
}

export async function runHookAdapter(
  argv: readonly string[],
  raw: string | Uint8Array,
  guard: HookGuardPort,
): Promise<HookRunResult> {
  return executeHookAdapter(argv, raw, guard);
}

async function createProductionHookGuard(
  resolution: GuardEnvironmentResolution,
  context: HookRunContext | undefined,
  io: HookDeadlineIo | undefined,
  gate?: DecisionGate,
): Promise<HookGuardPort> {
  const environment = resolution.environment;
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
  gate?.arm();
  if (resolution.source === "private-policy") await requestStore.ensureInitialized();
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
    ...(gate ? { decision_gate: gate } : {}),
    record_diagnostic: (row) => recordBoundedDiagnostic(context, { ...row, event: "PreToolUse" }, io),
    inspect_guard_state: async () => {
      const [key, requests] = await Promise.all([digestKey.inspect(), requestStore.inspect()]);
      return key.status === "ready" && requests.status === "ready";
    },
  });
  const guard = composition.service;
  return Object.freeze({
    submitUserPrompt: (event: unknown) => guard.submitUserPrompt(event),
    evaluatePreTool: (event: unknown) => guard.evaluatePreTool(event),
    completePostTool: (event: unknown) => guard.completePostTool(event),
    recordSessionEnd: async () => {
      throw new TypeError("SessionEnd requires the evidence-only production composition");
    },
  });
}

function sessionEndOnlyGuard(environment: NodeJS.ProcessEnv): HookGuardPort {
  const recorder = createProductionSessionEndRecorder(environment);
  const unavailable = async (): Promise<never> => {
    throw new TypeError("Enforcement event reached the SessionEnd-only composition");
  };
  return Object.freeze({
    submitUserPrompt: unavailable,
    evaluatePreTool: unavailable,
    completePostTool: unavailable,
    recordSessionEnd: (event: unknown) => recorder.record(event),
  });
}

export async function runProductionHookAdapter(
  argv: readonly string[],
  raw: string | Uint8Array,
  environment: NodeJS.ProcessEnv = process.env,
  io?: HookDeadlineIo,
): Promise<HookRunResult> {
  // Resolved once and shared with the provider. SessionEnd never needs it.
  let resolution: GuardEnvironmentResolution | undefined;
  let resolutionError: unknown;
  let context: HookRunContext | undefined;
  if (fallbackEvent(argv) !== "SessionEnd") {
    try {
      resolution = resolveGuardEnvironment(environment);
      context = { stateDir: loadControlConfig(resolution.environment).stateDir, mode: resolution.mode };
    } catch (cause) {
      // Mode unknown: every failure stays denied.
      resolutionError = cause;
    }
  }
  const deadline = io ? { io, emission: new SingleEmission((stdout) => io.write(stdout)) } : undefined;
  const result = await executeHookAdapter(argv, raw, async (event, gate) => {
    if (event === "SessionEnd") return sessionEndOnlyGuard(environment);
    if (!resolution) throw resolutionError;
    return createProductionHookGuard(resolution, context, io, gate);
  }, context, deadline);
  // Events without a deadline, and failures before one, emit here; the latch drops a second emission.
  await deadline?.emission.emit(result.stdout);
  return result;
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
  const result = await runProductionHookAdapter(argv, raw, process.env, {
    now: () => performance.now(),
    setTimer: (callback, delayMs) => {
      // Unref'd so a fast decision never waits on it; cleared on every normal outcome.
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return { clear: () => clearTimeout(timer) };
    },
    write: (stdout) => writeResult(process.stdout, stdout),
    exit: () => process.exit(0),
  });
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
