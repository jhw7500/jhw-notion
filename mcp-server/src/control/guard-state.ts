import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";

import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import {
  CanonicalOperationSchema,
  GuardAdapterSchema,
  GuardSessionSchema,
  GuardToolUseIdSchema,
  type CanonicalOperation,
  type GuardAdapter,
  type OperationRequirement,
} from "./guard-protocol.js";
import {
  GuardJournal,
  type GuardJournalEvent,
  type GuardJournalPort,
} from "./guard-journal.js";
import { newRequestId } from "./ids.js";
import {
  inspectSecureStateDirectory,
  openSecureStateDirectory,
  type SecureStateDirectory,
  type SecureStateDirectoryHooks,
} from "./journal.js";
import { MutationLock, type MutationLockRuntime } from "./process.js";
import {
  GuardRequestSchema,
  GuardRequestStateSchema,
  GUARD_REQUEST_TTL_MS,
  type GuardRequest,
  type GuardRequestState,
} from "./schemas.js";
import {
  assertNoAbsoluteHostPaths,
  createSensitiveDataPolicy,
  type SensitiveDataPolicy,
} from "./sensitive-data.js";

export type { GuardRequest } from "./schemas.js";

const GUARD_STATE_FILE = "guard-requests.yaml";
const GUARD_LOCK_FILE = "guard-requests.lock";
const GUARD_KEY_FILE = "guard-digest.key";
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1_000;
const SESSION_LIVE_LIMIT = 16;
const HOST_LIVE_LIMIT = 256;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const temporaryFlags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
  constants.O_NOFOLLOW | constants.O_NONBLOCK;
const keyCreateFlags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
  constants.O_NOFOLLOW;
const EXACT_UNLOCK =
  /^\/jhw:unlock (req-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export const GuardJournalWarning = "GUARD_JOURNAL_UNAVAILABLE" as const;
export type GuardJournalWarning = typeof GuardJournalWarning;

export interface GuardStateHooks {
  syncStateFile?(file: FileHandle): Promise<void> | void;
  afterStateFileSync?(): Promise<void> | void;
  renameState?(directory: SecureStateDirectory, from: string, to: string): Promise<void> | void;
  afterStateRename?(): Promise<void> | void;
  syncStateDirectory?(directory: SecureStateDirectory): Promise<void> | void;
  afterStateDirectorySync?(): Promise<void> | void;
}

export interface GuardDigestKeyHooks {
  syncKeyFile?(file: FileHandle): Promise<void> | void;
  afterKeyFileSync?(): Promise<void> | void;
  syncKeyDirectory?(directory: SecureStateDirectory): Promise<void> | void;
  afterKeyDirectorySync?(): Promise<void> | void;
  secureDirectoryHooks?: SecureStateDirectoryHooks;
}

export interface GuardRequestStoreOptions {
  journal?: GuardJournalPort;
  stateHooks?: GuardStateHooks;
  lockRuntime?: MutationLockRuntime;
  secureDirectoryHooks?: SecureStateDirectoryHooks;
  environment?: NodeJS.ProcessEnv;
}

export interface GuardRequestInspection {
  status: "not_initialized" | "ready";
  requests: GuardRequest[];
}

export interface GuardRequestResult {
  request: GuardRequest;
  journal_warning?: GuardJournalWarning;
}

export interface GuardPendingResult extends GuardRequestResult {
  reused: boolean;
}

export type GuardPromptApprovalResult =
  | { status: "NOT_UNLOCK_PROMPT" }
  | ({ status: "APPROVED" } & GuardRequestResult);

export type GuardConsumeResult = { status: "CONSUMED" } & GuardRequestResult;
export type GuardCompleteResult = { status: "COMPLETED" | "FAILED" } & GuardRequestResult;

type TransitionFailureCode =
  | "GUARD_REQUEST_NOT_FOUND"
  | "GUARD_REQUEST_EXPIRED"
  | "GUARD_PERMIT_MISMATCH"
  | "GUARD_PERMIT_CONSUMED"
  | "GUARD_STATE_LIMIT";

interface TransitionFailure {
  code: TransitionFailureCode;
}

interface Transition<T> {
  value?: T;
  failure?: TransitionFailure;
  changed: boolean;
  events: GuardJournalEvent[];
}

interface CommittedTransition<T> {
  transition: Transition<T>;
  events: GuardJournalEvent[];
}

function isErrno(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}

function unavailable(): ControlError {
  return new ControlError("GUARD_UNAVAILABLE", "Guard request state is unavailable");
}

function transitionError(code: TransitionFailureCode, warning?: GuardJournalWarning): ControlError {
  const messages: Record<TransitionFailureCode, string> = {
    GUARD_REQUEST_NOT_FOUND: "Guard request was not found",
    GUARD_REQUEST_EXPIRED: "Guard request has expired",
    GUARD_PERMIT_MISMATCH: "Guard permit binding does not match",
    GUARD_PERMIT_CONSUMED: "Guard permit was already consumed",
    GUARD_STATE_LIMIT: "Guard request state limit was reached",
  };
  return new ControlError(code, messages[code], warning ? { journal_warning: warning } : {});
}

function isLockError(cause: unknown): cause is ControlError {
  return cause instanceof ControlError && cause.code.startsWith("LOCK_");
}

function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

function at(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function terminal(request: GuardRequest): boolean {
  return request.state === "COMPLETED" || request.state === "FAILED" || request.state === "EXPIRED";
}

function live(request: GuardRequest): boolean {
  return request.state === "PENDING" || request.state === "APPROVED" || request.state === "CONSUMED";
}

function sameRequirements(left: readonly OperationRequirement[], right: readonly OperationRequirement[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameBinding(request: GuardRequest, operation: CanonicalOperation): boolean {
  return request.task_id === operation.task_id &&
    request.claim_id === operation.claim_id &&
    request.origin_adapter === operation.origin_adapter &&
    request.session_id === operation.session_id &&
    request.cwd_worktree_ref === operation.cwd_worktree_ref &&
    sameRequirements(request.requirements, operation.requirements) &&
    request.operation_digest === operation.digest;
}

function requestEvent(
  request: GuardRequest,
  event: GuardJournalEvent["event"],
  occurredAt: string,
  evaluationStage?: CanonicalOperation["evaluation_stage"],
): GuardJournalEvent {
  return {
    protocol_version: 1,
    origin_adapter: request.origin_adapter,
    ...(evaluationStage ? { evaluation_stage: evaluationStage } : {}),
    event,
    task_id: request.task_id,
    claim_id: request.claim_id,
    session_id: request.session_id,
    request_id: request.request_id,
    operation_digest: request.operation_digest,
    requirements: request.requirements,
    occurred_at: occurredAt,
    requested_at: request.requested_at,
    approval_expires_at: request.approval_expires_at,
    ...(request.approved_at ? { approved_at: request.approved_at } : {}),
    ...(request.start_by ? { start_by: request.start_by } : {}),
    ...(request.consumed_at ? { consumed_at: request.consumed_at } : {}),
    ...(request.finished_at ? { finished_at: request.finished_at } : {}),
    ...(event === "expired" ? { decision_code: "GUARD_REQUEST_EXPIRED" } : {}),
  };
}

function cleanupState(state: GuardRequestState, now: number): { changed: boolean; events: GuardJournalEvent[] } {
  let changed = false;
  const events: GuardJournalEvent[] = [];
  const kept: GuardRequest[] = [];
  for (const original of state.requests) {
    let request = original;
    const pendingExpired = request.state === "PENDING" && now >= Date.parse(request.approval_expires_at);
    const approvedExpired = request.state === "APPROVED" && request.start_by !== undefined && now >= Date.parse(request.start_by);
    if (pendingExpired || approvedExpired) {
      request = GuardRequestSchema.parse({
        ...request,
        state: "EXPIRED",
        finished_at: at(now),
      });
      changed = true;
      events.push(requestEvent(request, "expired", at(now)));
    }
    if (
      terminal(request) &&
      request.finished_at !== undefined &&
      now - Date.parse(request.finished_at) > TERMINAL_RETENTION_MS
    ) {
      changed = true;
      continue;
    }
    kept.push(request);
  }
  if (changed) state.requests = kept;
  return { changed, events };
}

async function readState(
  directory: SecureStateDirectory,
  sensitiveData: SensitiveDataPolicy,
): Promise<{ initialized: boolean; state: GuardRequestState }> {
  let file: FileHandle | undefined;
  try {
    try {
      file = await directory.openFile(GUARD_STATE_FILE, readFlags);
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return { initialized: false, state: { version: 1, requests: [] } };
      throw cause;
    }
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > MAX_STATE_BYTES) {
      throw unavailable();
    }
    const contents = await file.readFile("utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_STATE_BYTES) throw unavailable();
    let raw: unknown;
    try {
      raw = JSON.parse(contents);
    } catch {
      throw unavailable();
    }
    const parsed = GuardRequestStateSchema.safeParse(raw);
    if (!parsed.success) throw unavailable();
    sensitiveData.assertSafe(parsed.data);
    assertNoAbsoluteHostPaths(parsed.data);
    return { initialized: true, state: parsed.data };
  } catch (cause) {
    if (cause instanceof ControlError && cause.code === "GUARD_UNAVAILABLE") throw cause;
    throw unavailable();
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function writeState(
  directory: SecureStateDirectory,
  state: GuardRequestState,
  sensitiveData: SensitiveDataPolicy,
  hooks: GuardStateHooks,
): Promise<void> {
  const parsed = GuardRequestStateSchema.safeParse(state);
  if (!parsed.success) throw unavailable();
  sensitiveData.assertSafe(parsed.data);
  assertNoAbsoluteHostPaths(parsed.data);
  const serialized = `${JSON.stringify(parsed.data, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) throw unavailable();
  const temporaryName = `.guard-requests.${randomUUID()}.tmp`;
  let temporary: FileHandle | undefined;
  let published: FileHandle | undefined;
  try {
    temporary = await directory.openFile(temporaryName, temporaryFlags, 0o600);
    await temporary.chmod(0o600);
    const temporaryInfo = await temporary.stat();
    if (!temporaryInfo.isFile() || temporaryInfo.nlink !== 1 || (temporaryInfo.mode & 0o777) !== 0o600) {
      throw unavailable();
    }
    await temporary.writeFile(serialized, "utf8");
    if (hooks.syncStateFile) await hooks.syncStateFile(temporary);
    else await temporary.sync();
    await hooks.afterStateFileSync?.();
    await temporary.close();
    temporary = undefined;

    if (hooks.renameState) await hooks.renameState(directory, temporaryName, GUARD_STATE_FILE);
    else await directory.renameWithin(temporaryName, GUARD_STATE_FILE);
    await hooks.afterStateRename?.();

    published = await directory.openFile(GUARD_STATE_FILE, readFlags);
    const publishedInfo = await published.stat();
    if (!publishedInfo.isFile() || publishedInfo.nlink !== 1 || (publishedInfo.mode & 0o777) !== 0o600) {
      throw unavailable();
    }
    const actual = await published.readFile("utf8");
    if (actual !== serialized || !GuardRequestStateSchema.safeParse(JSON.parse(actual)).success) throw unavailable();
    await published.close();
    published = undefined;

    if (hooks.syncStateDirectory) await hooks.syncStateDirectory(directory);
    else await directory.sync();
    await hooks.afterStateDirectorySync?.();
  } catch {
    throw unavailable();
  } finally {
    await temporary?.close().catch(() => undefined);
    await published?.close().catch(() => undefined);
    await directory.unlinkWithin(temporaryName).catch(() => undefined);
  }
}

function validateOperation(operation: CanonicalOperation, sensitiveData: SensitiveDataPolicy): CanonicalOperation {
  try {
    const parsed = CanonicalOperationSchema.parse(operation);
    sensitiveData.assertSafe(parsed);
    assertNoAbsoluteHostPaths(parsed);
    return parsed;
  } catch {
    throw unavailable();
  }
}

function validateCorrelation(correlation: string, sensitiveData: SensitiveDataPolicy): string {
  try {
    const parsed = GuardToolUseIdSchema.parse(correlation);
    sensitiveData.assertSafe(parsed);
    assertNoAbsoluteHostPaths(parsed);
    return parsed;
  } catch {
    throw unavailable();
  }
}

export class GuardRequestStore {
  private readonly stateHooks: GuardStateHooks;
  private readonly secureDirectoryHooks: SecureStateDirectoryHooks;
  private readonly sensitiveData: SensitiveDataPolicy;
  private readonly journal: GuardJournalPort;
  private readonly lock: MutationLock;

  constructor(
    private readonly config: ControlConfig,
    options: GuardRequestStoreOptions = {},
  ) {
    const environment = options.environment ?? process.env;
    this.stateHooks = options.stateHooks ?? {};
    this.secureDirectoryHooks = options.secureDirectoryHooks ?? {};
    this.sensitiveData = createSensitiveDataPolicy(environment, [config.stateDir]);
    this.journal = options.journal ?? new GuardJournal(config.stateDir, this.secureDirectoryHooks, this.sensitiveData);
    this.lock = new MutationLock(
      config,
      environment,
      options.lockRuntime,
      this.secureDirectoryHooks,
      {
        lockFileName: GUARD_LOCK_FILE,
        waitSeconds: 5,
        contendedReason: "guard_state_lock",
        strictExistingStateDirectory: true,
      },
    );
  }

  async inspect(): Promise<GuardRequestInspection> {
    let directory: SecureStateDirectory | undefined;
    try {
      const inspected = await inspectSecureStateDirectory(this.config.stateDir);
      if (inspected.status === "not_initialized") return { status: "not_initialized", requests: [] };
      directory = inspected.directory;
      const loaded = await readState(directory, this.sensitiveData);
      return loaded.initialized
        ? { status: "ready", requests: loaded.state.requests }
        : { status: "not_initialized", requests: [] };
    } catch {
      throw unavailable();
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }

  async createOrReusePending(operationInput: CanonicalOperation): Promise<GuardPendingResult> {
    const operation = validateOperation(operationInput, this.sensitiveData);
    return this.runMutation<GuardPendingResult>((state, now) => {
      const exact = state.requests.find((request) => live(request) && sameBinding(request, operation));
      if (exact?.state === "PENDING" || exact?.state === "APPROVED") {
        return { value: { request: exact, reused: true }, changed: false, events: [] };
      }
      if (exact?.state === "CONSUMED") {
        return { failure: { code: "GUARD_PERMIT_CONSUMED" }, changed: false, events: [] };
      }
      const liveRequests = state.requests.filter(live);
      const sessionLive = liveRequests.filter((request) =>
        request.origin_adapter === operation.origin_adapter && request.session_id === operation.session_id).length;
      if (sessionLive >= SESSION_LIVE_LIMIT || liveRequests.length >= HOST_LIVE_LIMIT) {
        return { failure: { code: "GUARD_STATE_LIMIT" }, changed: false, events: [] };
      }
      let requestId = newRequestId(now);
      for (let attempts = 0; state.requests.some((request) => request.request_id === requestId); attempts += 1) {
        if (attempts >= 8) return { failure: { code: "GUARD_STATE_LIMIT" }, changed: false, events: [] };
        requestId = newRequestId(now);
      }
      const requestedAt = at(now);
      const request = GuardRequestSchema.parse({
        request_id: requestId,
        state: "PENDING",
        origin_adapter: operation.origin_adapter,
        session_id: operation.session_id,
        task_id: operation.task_id,
        claim_id: operation.claim_id,
        cwd_worktree_ref: operation.cwd_worktree_ref,
        requirements: operation.requirements,
        operation_digest: operation.digest,
        summary: operation.summary,
        requested_at: requestedAt,
        approval_expires_at: at(now + GUARD_REQUEST_TTL_MS),
      });
      state.requests.push(request);
      return {
        value: { request, reused: false },
        changed: true,
        events: [requestEvent(request, "requested", requestedAt, operation.evaluation_stage)],
      };
    });
  }

  async approveFromPrompt(
    originAdapterInput: GuardAdapter,
    sessionInput: string,
    rawPrompt: string,
  ): Promise<GuardPromptApprovalResult> {
    if (!rawPrompt.startsWith("/jhw:unlock")) return { status: "NOT_UNLOCK_PROMPT" };
    const match = EXACT_UNLOCK.exec(rawPrompt);
    if (!match || match[0] !== rawPrompt) throw transitionError("GUARD_REQUEST_NOT_FOUND");
    const adapter = GuardAdapterSchema.safeParse(originAdapterInput);
    if (!adapter.success) {
      throw new ControlError("GUARD_PROMPT_ORIGIN_UNSUPPORTED", "Prompt origin is unsupported");
    }
    const session = GuardSessionSchema.safeParse(sessionInput);
    if (!session.success) throw transitionError("GUARD_PERMIT_MISMATCH");
    const requestId = match[1] as string;

    return this.runMutation((state, now) => {
      const request = state.requests.find((candidate) => candidate.request_id === requestId);
      if (!request) return { failure: { code: "GUARD_REQUEST_NOT_FOUND" }, changed: false, events: [] };
      if (request.origin_adapter !== adapter.data || request.session_id !== session.data) {
        return { failure: { code: "GUARD_PERMIT_MISMATCH" }, changed: false, events: [] };
      }
      if (request.state === "EXPIRED") {
        return { failure: { code: "GUARD_REQUEST_EXPIRED" }, changed: false, events: [] };
      }
      if (request.state !== "PENDING") {
        return { failure: { code: "GUARD_PERMIT_CONSUMED" }, changed: false, events: [] };
      }
      const approvedAt = at(now);
      const approvedRequest = GuardRequestSchema.parse({
        ...request,
        state: "APPROVED",
        approved_at: approvedAt,
        start_by: at(now + GUARD_REQUEST_TTL_MS),
      });
      state.requests[state.requests.indexOf(request)] = approvedRequest;
      return {
        value: { status: "APPROVED" as const, request: approvedRequest },
        changed: true,
        events: [requestEvent(approvedRequest, "approved", approvedAt)],
      };
    });
  }

  async consumeMatching(operationInput: CanonicalOperation, correlationInput?: string): Promise<GuardConsumeResult> {
    const operation = validateOperation(operationInput, this.sensitiveData);
    const correlation = validateCorrelation(correlationInput ?? operation.operation_id, this.sensitiveData);
    return this.runMutation((state, now) => {
      const exactRequests = state.requests.filter((request) => sameBinding(request, operation));
      const exact = exactRequests.find(live) ?? exactRequests.at(-1);
      if (!exact) {
        const candidates = state.requests.some((request) => live(request));
        return {
          failure: { code: candidates ? "GUARD_PERMIT_MISMATCH" : "GUARD_REQUEST_NOT_FOUND" },
          changed: false,
          events: [],
        };
      }
      if (exact.state === "EXPIRED") {
        return { failure: { code: "GUARD_REQUEST_EXPIRED" }, changed: false, events: [] };
      }
      if (exact.state === "CONSUMED" || exact.state === "COMPLETED" || exact.state === "FAILED") {
        return { failure: { code: "GUARD_PERMIT_CONSUMED" }, changed: false, events: [] };
      }
      if (exact.state !== "APPROVED") {
        return { failure: { code: "GUARD_PERMIT_MISMATCH" }, changed: false, events: [] };
      }
      if (state.requests.some((request) => request.correlation_id === correlation)) {
        return { failure: { code: "GUARD_PERMIT_MISMATCH" }, changed: false, events: [] };
      }
      const consumedAt = at(now);
      const consumedRequest = GuardRequestSchema.parse({
        ...exact,
        state: "CONSUMED",
        consumed_at: consumedAt,
        correlation_id: correlation,
      });
      state.requests[state.requests.indexOf(exact)] = consumedRequest;
      return {
        value: { status: "CONSUMED" as const, request: consumedRequest },
        changed: true,
        events: [requestEvent(consumedRequest, "consumed", consumedAt, operation.evaluation_stage)],
      };
    });
  }

  async complete(correlationInput: string, ok: boolean): Promise<GuardCompleteResult> {
    const correlation = validateCorrelation(correlationInput, this.sensitiveData);
    return this.runMutation((state, now) => {
      const request = state.requests.find((candidate) => candidate.correlation_id === correlation);
      if (!request) return { failure: { code: "GUARD_REQUEST_NOT_FOUND" }, changed: false, events: [] };
      if (request.state !== "CONSUMED") {
        return { failure: { code: "GUARD_PERMIT_CONSUMED" }, changed: false, events: [] };
      }
      const finishedAt = at(now);
      const stateName = ok ? "COMPLETED" : "FAILED";
      const completedRequest = GuardRequestSchema.parse({
        ...request,
        state: stateName,
        finished_at: finishedAt,
      });
      state.requests[state.requests.indexOf(request)] = completedRequest;
      return {
        value: { status: stateName, request: completedRequest },
        changed: true,
        events: [requestEvent(completedRequest, ok ? "completed" : "failed", finishedAt)],
      };
    });
  }

  private async runMutation<T extends object>(
    transition: (state: GuardRequestState, now: number) => Transition<T>,
  ): Promise<T & { journal_warning?: GuardJournalWarning }> {
    let committed: CommittedTransition<T> | undefined;
    try {
      await this.lock.runInStateDirectory(async (directory) => {
        const loaded = await readState(directory, this.sensitiveData);
        const now = Date.now();
        const cleanup = cleanupState(loaded.state, now);
        const result = transition(loaded.state, now);
        if (cleanup.changed || result.changed) {
          await writeState(directory, loaded.state, this.sensitiveData, this.stateHooks);
        }
        committed = { transition: result, events: [...cleanup.events, ...result.events] };
      });
    } catch (cause) {
      // A published state transition is authoritative. A later lock-descriptor
      // cleanup error cannot truthfully report that the transition rolled back.
      if (!committed) {
        if (isLockError(cause)) throw cause;
        throw unavailable();
      }
    }
    if (!committed) throw unavailable();
    const warning = await this.appendJournal(committed.events);
    if (committed.transition.failure) throw transitionError(committed.transition.failure.code, warning);
    if (!committed.transition.value) throw unavailable();
    return {
      ...committed.transition.value,
      ...(warning ? { journal_warning: warning } : {}),
    };
  }

  private async appendJournal(events: readonly GuardJournalEvent[]): Promise<GuardJournalWarning | undefined> {
    let warning: GuardJournalWarning | undefined;
    for (const event of events) {
      try {
        await this.journal.append(event);
      } catch {
        warning = GuardJournalWarning;
      }
    }
    return warning;
  }
}

async function readKey(directory: SecureStateDirectory): Promise<Buffer> {
  let file: FileHandle | undefined;
  try {
    file = await directory.openFile(GUARD_KEY_FILE, readFlags);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size !== 32) {
      throw unavailable();
    }
    const key = await file.readFile();
    if (key.length !== 32) throw unavailable();
    return key;
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) throw cause;
    if (cause instanceof ControlError && cause.code === "GUARD_UNAVAILABLE") throw cause;
    throw unavailable();
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export class GuardDigestKey {
  constructor(
    private readonly stateDir: string,
    private readonly hooks: GuardDigestKeyHooks = {},
  ) {}

  async inspect(): Promise<{ status: "not_initialized" | "ready" }> {
    let directory: SecureStateDirectory | undefined;
    try {
      const inspected = await inspectSecureStateDirectory(this.stateDir);
      if (inspected.status === "not_initialized") return { status: "not_initialized" };
      directory = inspected.directory;
      try {
        await readKey(directory);
      } catch (cause) {
        if (isErrno(cause, "ENOENT")) return { status: "not_initialized" };
        throw cause;
      }
      return { status: "ready" };
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return { status: "not_initialized" };
      throw unavailable();
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }

  async loadOrCreate(): Promise<Buffer> {
    let directory: SecureStateDirectory | undefined;
    let file: FileHandle | undefined;
    try {
      directory = await openSecureStateDirectory(
        this.stateDir,
        this.hooks.secureDirectoryHooks,
        { strictExistingMode: true },
      );
      try {
        return await readKey(directory);
      } catch (cause) {
        if (!isErrno(cause, "ENOENT")) throw cause;
      }

      const key = randomBytes(32);
      try {
        file = await directory.openFile(GUARD_KEY_FILE, keyCreateFlags, 0o600);
      } catch (cause) {
        if (isErrno(cause, "EEXIST")) return await readKey(directory);
        throw cause;
      }
      await file.chmod(0o600);
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw unavailable();
      const written = await file.write(key, 0, key.length, 0);
      if (written.bytesWritten !== key.length) throw unavailable();
      if (this.hooks.syncKeyFile) await this.hooks.syncKeyFile(file);
      else await file.sync();
      await this.hooks.afterKeyFileSync?.();
      await file.close();
      file = undefined;
      if (this.hooks.syncKeyDirectory) await this.hooks.syncKeyDirectory(directory);
      else await directory.sync();
      await this.hooks.afterKeyDirectorySync?.();
      return Buffer.from(key);
    } catch {
      throw unavailable();
    } finally {
      await file?.close().catch(() => undefined);
      await directory?.close().catch(() => undefined);
    }
  }
}
