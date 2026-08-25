import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ControlConfig } from "../config.js";
import type { CanonicalOperation } from "../guard-protocol.js";
import {
  GuardDigestKey,
  GuardRequestStore,
  type GuardRequest,
  type GuardStateHooks,
} from "../guard-state.js";
import { GuardJournal, type GuardJournalEvent, type GuardJournalPort } from "../guard-journal.js";
import { openSecureStateDirectory, type SecureStateDirectory } from "../journal.js";
import { MutationLock, type MutationLockRuntime } from "../process.js";

const TASK_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000001";
const CLAIM_ID = "clm-018f21e0-7b2c-7a00-8000-000000000002";
const OPERATION_ID = "op-018f21e0-7b2c-7a00-8000-000000000003";
const START = Date.parse("2026-08-25T01:00:00.000Z");
const SECRET = "unmistakably-fake-guard-secret";
const roots: string[] = [];

function configFor(stateDir: string): ControlConfig {
  return {
    registryDir: "/srv/registry",
    registryRemote: "origin",
    registryBranch: "main",
    worktreeRoot: "/srv/worktrees",
    buildHost: "build-host",
    githubOwner: "owner",
    projectNumber: 1,
    registryRepository: "owner/registry",
    preflightProjectItemId: "PVTI_trial",
    preflightRegistryIssueNumber: 1,
    stateDir,
  };
}

function operation(overrides: Partial<CanonicalOperation> = {}): CanonicalOperation {
  return {
    protocol_version: 1,
    operation_id: OPERATION_ID,
    origin_adapter: "codex",
    evaluation_stage: "hook",
    session_id: "codex-task-scope-guard",
    task_id: TASK_ID,
    claim_id: CLAIM_ID,
    cwd_worktree_ref: "wt-task-scope-guard",
    tool: "edit",
    requirements: [{
      capability: "repo.modify",
      resource: { kind: "repository", id: "repo-jhw-notion" },
    }],
    risk: "medium",
    execution_boundary: "hook",
    summary: "Modify the claimed repository",
    digest: "1".repeat(64),
    ...overrides,
  };
}

function completedAcquisition(status = 0) {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  queueMicrotask(() => child.emit("close", status));
  return child;
}

const immediateLockRuntime: MutationLockRuntime = {
  spawn: () => completedAcquisition(),
};

class MemoryJournal implements GuardJournalPort {
  readonly events: GuardJournalEvent[] = [];

  async append(event: GuardJournalEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

interface FixtureOptions {
  journal?: GuardJournalPort;
  realJournal?: boolean;
  stateHooks?: GuardStateHooks;
  lockRuntime?: MutationLockRuntime;
  environment?: NodeJS.ProcessEnv;
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "jhw-guard-state-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const journal = options.journal ?? (options.realJournal ? new GuardJournal(stateDir) : new MemoryJournal());
  const store = new GuardRequestStore(configFor(stateDir), {
    journal,
    stateHooks: options.stateHooks,
    lockRuntime: options.lockRuntime ?? immediateLockRuntime,
    environment: options.environment ?? { FAKE_API_TOKEN: SECRET },
  });
  return { root, stateDir, journal, store };
}

async function pending(store: GuardRequestStore, target = operation()): Promise<GuardRequest> {
  return (await store.createOrReusePending(target)).request;
}

async function approved(store: GuardRequestStore, target = operation()): Promise<GuardRequest> {
  const request = await pending(store, target);
  const result = await store.approveFromPrompt(target.origin_adapter, target.session_id, `/jhw:unlock ${request.request_id}`);
  if (result.status !== "APPROVED") throw new Error("expected approved request");
  return result.request;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runAgainstDirectory<T>(
  stateDir: string,
  callback: (directory: SecureStateDirectory) => Promise<T>,
): Promise<T> {
  const directory = await openSecureStateDirectory(stateDir);
  try {
    return await callback(directory);
  } finally {
    await directory.close();
  }
}

describe("Guard request deadlines", () => {
  it("approves PENDING at 9:59.999 and starts a fresh independent ten-minute window", async () => {
    const { store } = await fixture();
    const request = await pending(store);

    vi.setSystemTime(START + 599_999);
    const result = await store.approveFromPrompt("codex", operation().session_id, `/jhw:unlock ${request.request_id}`);

    expect(result).toMatchObject({
      status: "APPROVED",
      request: {
        state: "APPROVED",
        approved_at: "2026-08-25T01:09:59.999Z",
        start_by: "2026-08-25T01:19:59.999Z",
      },
    });
  });

  it("expires PENDING at exactly 10:00.000 and never creates a replacement", async () => {
    const { store } = await fixture();
    const request = await pending(store);

    vi.setSystemTime(START + 600_000);
    await expect(store.approveFromPrompt("codex", operation().session_id, `/jhw:unlock ${request.request_id}`))
      .rejects.toMatchObject({ code: "GUARD_REQUEST_EXPIRED" });

    const inspected = await store.inspect();
    expect(inspected.status).toBe("ready");
    if (inspected.status !== "ready") throw new Error("expected initialized state");
    expect(inspected.requests).toHaveLength(1);
    expect(inspected.requests[0]).toMatchObject({ request_id: request.request_id, state: "EXPIRED" });
  });

  it("consumes APPROVED at 9:59.999 and expires it at exactly 10:00.000", async () => {
    const first = await fixture();
    await approved(first.store);
    vi.setSystemTime(START + 599_999);
    await expect(first.store.consumeMatching(operation(), "call-before-boundary")).resolves.toMatchObject({
      status: "CONSUMED",
      request: { state: "CONSUMED", correlation_id: "call-before-boundary" },
    });

    vi.setSystemTime(START);
    const second = await fixture();
    await approved(second.store);
    vi.setSystemTime(START + 600_000);
    await expect(second.store.consumeMatching(operation(), "call-at-boundary"))
      .rejects.toMatchObject({ code: "GUARD_REQUEST_EXPIRED" });
  });

  it("keeps CONSUMED valid without a TTL until completion", async () => {
    const { store } = await fixture();
    await approved(store);
    await store.consumeMatching(operation(), "call-long-running");

    vi.setSystemTime(START + 72 * 60 * 60 * 1_000);
    await expect(store.complete("call-long-running", true)).resolves.toMatchObject({
      status: "COMPLETED",
      request: { state: "COMPLETED", correlation_id: "call-long-running" },
    });
  });
});

describe("Guard request transitions", () => {
  it("allows exactly one of two concurrent consumers to win", async () => {
    const { stateDir, store } = await fixture({ lockRuntime: undefined });
    const realStore = new GuardRequestStore(configFor(stateDir), { journal: new MemoryJournal() });
    const competingStore = new GuardRequestStore(configFor(stateDir), { journal: new MemoryJournal() });
    const request = await pending(store);
    await store.approveFromPrompt("codex", operation().session_id, `/jhw:unlock ${request.request_id}`);

    const outcomes = await Promise.allSettled([
      realStore.consumeMatching(operation(), "call-race-a"),
      competingStore.consumeMatching(operation(), "call-race-b"),
    ]);

    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    expect(rejection?.reason).toMatchObject({ code: "GUARD_PERMIT_CONSUMED" });
  });

  it("records spawn failure as terminal FAILED and creates a new request instead of reopening it", async () => {
    const { store } = await fixture();
    const first = await approved(store);
    await store.consumeMatching(operation(), "call-spawn-failed");
    await expect(store.complete("call-spawn-failed", false)).resolves.toMatchObject({
      status: "FAILED",
      request: { request_id: first.request_id, state: "FAILED" },
    });

    const replacement = await pending(store);
    expect(replacement.request_id).not.toBe(first.request_id);
    const inspected = await store.inspect();
    if (inspected.status !== "ready") throw new Error("expected initialized state");
    expect(inspected.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ request_id: first.request_id, state: "FAILED" }),
      expect.objectContaining({ request_id: replacement.request_id, state: "PENDING" }),
    ]));
  });

  it("can approve and consume the fresh request after an older identical binding failed", async () => {
    const { store } = await fixture();
    const failed = await approved(store);
    await store.consumeMatching(operation(), "call-first-attempt");
    await store.complete("call-first-attempt", false);
    const replacement = await pending(store);

    await store.approveFromPrompt("codex", operation().session_id, `/jhw:unlock ${replacement.request_id}`);
    await expect(store.consumeMatching(operation(), "call-second-attempt")).resolves.toMatchObject({
      status: "CONSUMED",
      request: { request_id: replacement.request_id, state: "CONSUMED" },
    });

    const inspected = await store.inspect();
    if (inspected.status !== "ready") throw new Error("expected initialized state");
    expect(inspected.requests.find((entry) => entry.request_id === failed.request_id))
      .toMatchObject({ state: "FAILED" });
  });

  it.each([
    ["Task", { task_id: "tsk-018f21e0-7b2c-7a00-8000-000000000011" }],
    ["Claim", { claim_id: "clm-018f21e0-7b2c-7a00-8000-000000000012" }],
    ["origin adapter", { origin_adapter: "claude" as const }],
    ["session", { session_id: "different-session" }],
    ["worktree", { cwd_worktree_ref: "wt-different-worktree" }],
    ["requirement set", {
      requirements: [{ capability: "git.commit" as const, resource: { kind: "repository" as const, id: "repo-jhw-notion" } }],
    }],
    ["digest", { digest: "2".repeat(64) }],
  ])("rejects a wrong %s binding without mutating the approved request", async (_label, override) => {
    const { store } = await fixture();
    const request = await approved(store);

    await expect(store.consumeMatching(operation(override), "call-mismatch"))
      .rejects.toMatchObject({ code: "GUARD_PERMIT_MISMATCH" });

    const inspected = await store.inspect();
    if (inspected.status !== "ready") throw new Error("expected initialized state");
    const stored = inspected.requests.find((entry) => entry.request_id === request.request_id);
    expect(stored).toMatchObject({ state: "APPROVED" });
    expect(stored).not.toHaveProperty("correlation_id");
  });

  it("keys the session limit by exact origin adapter and session", async () => {
    const { store } = await fixture();
    for (let index = 0; index < 16; index += 1) {
      await pending(store, operation({ digest: index.toString(16).padStart(64, "0") }));
    }

    await expect(store.createOrReusePending(operation({ digest: "f".repeat(64) })))
      .rejects.toMatchObject({ code: "GUARD_STATE_LIMIT" });
    await expect(store.createOrReusePending(operation({
      origin_adapter: "claude",
      digest: "e".repeat(64),
    }))).resolves.toMatchObject({ request: { state: "PENDING" } });
  });

  it("rejects the 257th live request for the host", async () => {
    const { store } = await fixture();
    let sequence = 0;
    for (let session = 0; session < 16; session += 1) {
      for (let request = 0; request < 16; request += 1) {
        sequence += 1;
        await pending(store, operation({
          session_id: `session-${session}`,
          digest: sequence.toString(16).padStart(64, "0"),
        }));
      }
    }

    await expect(store.createOrReusePending(operation({
      session_id: "session-over-host-limit",
      digest: "f".repeat(64),
    }))).rejects.toMatchObject({ code: "GUARD_STATE_LIMIT" });
  }, 20_000);

  it("reports guard_state_lock on bounded contention without entering the transition", async () => {
    const lockRuntime: MutationLockRuntime = { spawn: () => completedAcquisition(75) };
    const { store } = await fixture({ lockRuntime });

    await expect(store.createOrReusePending(operation())).rejects.toMatchObject({
      code: "LOCK_CONTENDED",
      details: { reason: "guard_state_lock" },
    });
  });
});

describe("exact prompt approval", () => {
  it("returns ordinary prompts without creating or changing Guard state", async () => {
    const { stateDir, store } = await fixture();

    await expect(store.approveFromPrompt("codex", operation().session_id, "ok"))
      .resolves.toEqual({ status: "NOT_UNLOCK_PROMPT" });
    await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "/jhw:unlock req-018f21e0-7b2c-7a00-8000-000000000099\n",
    "/jhw:unlock req-018f21e0-7b2c-7a00-8000-000000000099\r\n",
    "/jhw:unlock REQ-018F21E0-7B2C-7A00-8000-000000000099",
    "/jhw:unlock req-018f21e0-7b2c-6a00-8000-000000000099",
    "/jhw:unlock req-018f21e0-7b2c-7a00-7000-000000000099",
    "/jhw:unlock req-018f21e0-7b2c-7a00-8000-000000000099 extra",
    "/jhw:unlock req-018f21e0-7b2c-7a00-8000-000000000099\u00a0",
  ])("rejects exact-looking invalid raw prompt %j with a stable code and no replacement", async (rawPrompt) => {
    const { store } = await fixture();
    const request = await pending(store);
    const before = await store.inspect();

    await expect(store.approveFromPrompt("codex", operation().session_id, rawPrompt))
      .rejects.toMatchObject({ code: "GUARD_REQUEST_NOT_FOUND" });

    expect(await store.inspect()).toEqual(before);
    const after = await store.inspect();
    if (after.status !== "ready") throw new Error("expected initialized state");
    expect(after.requests).toHaveLength(1);
    expect(after.requests[0]?.request_id).toBe(request.request_id);
  });

  it.each([
    " 진행",
    "승인",
    "`/jhw:unlock req-018f21e0-7b2c-7a00-8000-000000000099`",
    "```\n/jhw:unlock req-018f21e0-7b2c-7a00-8000-000000000099\n```",
    "\u2044jhw:unlock req-018f21e0-7b2c-7a00-8000-000000000099",
  ])("treats non-command prompt %j as ordinary and leaves state byte-identical", async (rawPrompt) => {
    const { stateDir, store } = await fixture();
    await pending(store);
    const before = await readFile(join(stateDir, "guard-requests.yaml"));

    await expect(store.approveFromPrompt("codex", operation().session_id, rawPrompt))
      .resolves.toEqual({ status: "NOT_UNLOCK_PROMPT" });

    expect(await readFile(join(stateDir, "guard-requests.yaml"))).toEqual(before);
  });

  it("requires the exact bound adapter and session", async () => {
    const { store } = await fixture();
    const request = await pending(store);
    const prompt = `/jhw:unlock ${request.request_id}`;

    await expect(store.approveFromPrompt("claude", operation().session_id, prompt))
      .rejects.toMatchObject({ code: "GUARD_PERMIT_MISMATCH" });
    await expect(store.approveFromPrompt("codex", "other-session", prompt))
      .rejects.toMatchObject({ code: "GUARD_PERMIT_MISMATCH" });
  });
});

describe("secure request state", () => {
  it("reports missing read-only inspection as not_initialized without creating the directory", async () => {
    const { stateDir, store } = await fixture();

    await expect(store.inspect()).resolves.toEqual({ status: "not_initialized", requests: [] });
    await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["symlink", "hardlink", "directory", "fifo", "unsafe-mode", "corrupt"])(
    "fails closed on %s request state",
    async (variant) => {
      const { root, stateDir, store } = await fixture();
      await mkdir(stateDir, { mode: 0o700 });
      const statePath = join(stateDir, "guard-requests.yaml");
      const external = join(root, "external-state");
      const empty = `${JSON.stringify({ version: 1, requests: [] })}\n`;
      if (variant === "symlink") {
        await writeFile(external, empty, { mode: 0o600 });
        await symlink(external, statePath);
      } else if (variant === "hardlink") {
        await writeFile(external, empty, { mode: 0o600 });
        await link(external, statePath);
      } else if (variant === "directory") {
        await mkdir(statePath);
      } else if (variant === "fifo") {
        execFileSync("mkfifo", [statePath]);
      } else if (variant === "unsafe-mode") {
        await writeFile(statePath, empty, { mode: 0o644 });
      } else {
        await writeFile(statePath, "{ not json", { mode: 0o600 });
      }

      await expect(store.inspect()).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
      await expect(store.createOrReusePending(operation())).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
      if (variant === "symlink" || variant === "hardlink") {
        expect(await readFile(external, "utf8")).toBe(empty);
      }
    },
  );

  it("rejects a schema-valid-looking but impossible expired-and-consumed row", async () => {
    const { stateDir, store } = await fixture();
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(join(stateDir, "guard-requests.yaml"), `${JSON.stringify({
      version: 1,
      requests: [{
        request_id: "req-018f21e0-7b2c-7a00-8000-000000000020",
        state: "EXPIRED",
        origin_adapter: "codex",
        session_id: operation().session_id,
        task_id: TASK_ID,
        claim_id: CLAIM_ID,
        cwd_worktree_ref: operation().cwd_worktree_ref,
        requirements: operation().requirements,
        operation_digest: operation().digest,
        summary: operation().summary,
        requested_at: "2026-08-25T01:00:00.000Z",
        approval_expires_at: "2026-08-25T01:10:00.000Z",
        approved_at: "2026-08-25T01:01:00.000Z",
        start_by: "2026-08-25T01:11:00.000Z",
        consumed_at: "2026-08-25T01:02:00.000Z",
        correlation_id: "call-impossible",
        finished_at: "2026-08-25T01:12:00.000Z",
      }],
    })}\n`, { mode: 0o600 });

    await expect(store.inspect()).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
  });

  it("rejects a persisted request whose exact ten-minute deadline was altered", async () => {
    const { stateDir, store } = await fixture();
    await pending(store);
    const path = join(stateDir, "guard-requests.yaml");
    const raw = JSON.parse(await readFile(path, "utf8")) as { requests: Array<{ approval_expires_at: string }> };
    raw.requests[0]!.approval_expires_at = "2026-08-25T01:10:00.001Z";
    await writeFile(path, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

    await expect(store.inspect()).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
  });

  it("rejects persisted requirements that are not in canonical order", async () => {
    const { stateDir, store } = await fixture();
    await pending(store, operation({
      requirements: [
        { capability: "git.commit", resource: { kind: "repository", id: "repo-jhw-notion" } },
        { capability: "repo.modify", resource: { kind: "repository", id: "repo-jhw-notion" } },
      ],
    }));
    const path = join(stateDir, "guard-requests.yaml");
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      requests: Array<{ requirements: unknown[] }>;
    };
    raw.requests[0]!.requirements.reverse();
    await writeFile(path, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

    await expect(store.inspect()).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
  });

  it("rejects two live requests with the same exact operation binding", async () => {
    const { stateDir, store } = await fixture();
    await pending(store);
    const path = join(stateDir, "guard-requests.yaml");
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      requests: Array<Record<string, unknown>>;
    };
    raw.requests.push({
      ...raw.requests[0],
      request_id: "req-018f21e0-7b2c-7a00-8000-000000000021",
    });
    await writeFile(path, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

    await expect(store.inspect()).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
  });

  it("rejects an existing non-private state directory instead of repairing its mode", async () => {
    const { stateDir, store } = await fixture();
    await mkdir(stateDir, { mode: 0o755 });

    await expect(store.createOrReusePending(operation())).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
    expect((await lstat(stateDir)).mode & 0o777).toBe(0o755);
    await expect(lstat(join(stateDir, "guard-requests.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an existing non-private Guard lock without repairing or publishing state", async () => {
    const { stateDir, store } = await fixture();
    await mkdir(stateDir, { mode: 0o700 });
    const lockPath = join(stateDir, "guard-requests.lock");
    await writeFile(lockPath, "", { mode: 0o600 });
    await chmod(lockPath, 0o644);

    await expect(store.createOrReusePending(operation())).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
    expect((await lstat(lockPath)).mode & 0o777).toBe(0o644);
    await expect(lstat(join(stateDir, "guard-requests.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps Guard state on the configured flock directory despite an instance method override", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-guard-lock-authority-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const decoyDir = join(root, "decoy");
    const runtime: MutationLockRuntime = { spawn: vi.fn(() => completedAcquisition()) };
    const store = new GuardRequestStore(configFor(stateDir), {
      journal: new MemoryJournal(),
      lockRuntime: runtime,
    });
    const redirect = async <T>(callback: (directory: SecureStateDirectory) => Promise<T>): Promise<T> =>
      runAgainstDirectory(decoyDir, callback);
    Object.defineProperty(store, "lock", {
      configurable: true,
      value: { runInStateDirectory: redirect },
    });

    await store.createOrReusePending(operation());

    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(stateDir, "guard-requests.yaml"), "utf8")))
      .toMatchObject({ requests: [expect.objectContaining({ state: "PENDING" })] });
    await expect(lstat(join(decoyDir, "guard-requests.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps Guard state on the configured flock directory despite a prototype method override", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-guard-lock-authority-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const decoyDir = join(root, "decoy");
    const runtime: MutationLockRuntime = { spawn: vi.fn(() => completedAcquisition()) };
    const redirect = async <T>(callback: (directory: SecureStateDirectory) => Promise<T>): Promise<T> =>
      runAgainstDirectory(decoyDir, callback);
    vi.spyOn(MutationLock.prototype, "runInStateDirectory")
      .mockImplementation(redirect as MutationLock["runInStateDirectory"]);
    const store = new GuardRequestStore(configFor(stateDir), {
      journal: new MemoryJournal(),
      lockRuntime: runtime,
    });

    await store.createOrReusePending(operation());

    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(stateDir, "guard-requests.yaml"), "utf8")))
      .toMatchObject({ requests: [expect.objectContaining({ state: "PENDING" })] });
    await expect(lstat(join(decoyDir, "guard-requests.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("mutates the same retained state-directory inode that owns guard-requests.lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-guard-anchor-"));
    roots.push(root);
    const originalParent = join(root, "original-parent");
    const stateDir = join(originalParent, "state");
    const movedParent = join(root, "moved-parent");
    const decoyParent = join(root, "decoy-parent");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(join(decoyParent, "state"), { recursive: true, mode: 0o700 });
    let opened = 0;
    const store = new GuardRequestStore(configFor(stateDir), {
      journal: new MemoryJournal(),
      lockRuntime: immediateLockRuntime,
      secureDirectoryHooks: {
        afterDirectoryOpen: async () => {
          opened += 1;
          if (opened !== 1) return;
          await rename(originalParent, movedParent);
          await rename(decoyParent, originalParent);
        },
      },
    });

    await store.createOrReusePending(operation());

    expect(JSON.parse(await readFile(join(movedParent, "state", "guard-requests.yaml"), "utf8")))
      .toMatchObject({ requests: [expect.objectContaining({ state: "PENDING" })] });
    await expect(lstat(join(originalParent, "state", "guard-requests.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed and removes its private temporary when rename fails", async () => {
    const { stateDir, store } = await fixture({
      stateHooks: { renameState: async () => { throw new Error("injected rename failure"); } },
    });

    await expect(store.createOrReusePending(operation())).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
    await expect(lstat(join(stateDir, "guard-requests.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await import("node:fs/promises")).readdir(stateDir).then((names) => names.filter((name) => name.endsWith(".tmp"))))
      .resolves.toEqual([]);
  });

  it("does not report a transition durable when directory fsync fails", async () => {
    const { stateDir, store } = await fixture({
      stateHooks: { syncStateDirectory: async () => { throw new Error("injected directory sync failure"); } },
    });

    await expect(store.createOrReusePending(operation())).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
    expect(JSON.parse(await readFile(join(stateDir, "guard-requests.yaml"), "utf8")))
      .toMatchObject({ version: 1, requests: [expect.objectContaining({ state: "PENDING" })] });
  });

  it("keeps state secret-safe and never persists raw prompt, command, script, environment, or absolute paths", async () => {
    const { stateDir, store } = await fixture();
    const request = await pending(store);
    await store.approveFromPrompt("codex", operation().session_id, `/jhw:unlock ${request.request_id}`);
    await store.consumeMatching(operation(), "call-secret-scan");

    const raw = await readFile(join(stateDir, "guard-requests.yaml"), "utf8");
    expect(raw).not.toContain("/jhw:unlock");
    expect(raw).not.toContain("git push");
    expect(raw).not.toContain("#!/bin/sh");
    expect(raw).not.toContain("FAKE_API_TOKEN");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toMatch(/\/(?:home|srv|tmp)\//);
  });

  it("rejects a private absolute path in a supposedly safe summary before state publication", async () => {
    const { stateDir, store } = await fixture();

    await expect(store.createOrReusePending(operation({ summary: "Modify /srv/private/secret.txt" })))
      .rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
    await expect(lstat(join(stateDir, "guard-requests.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes terminal rows older than 24 hours only on mutation while preserving journal rows", async () => {
    const { stateDir, store } = await fixture({ realJournal: true });
    const request = await approved(store);
    await store.consumeMatching(operation(), "call-cleanup");
    await store.complete("call-cleanup", true);
    const journalBefore = await readFile(join(stateDir, "guard-journal.jsonl"), "utf8");

    vi.setSystemTime(START + 24 * 60 * 60 * 1_000 + 1);
    const inspectedBeforeMutation = await store.inspect();
    if (inspectedBeforeMutation.status !== "ready") throw new Error("expected initialized state");
    expect(inspectedBeforeMutation.requests.some((entry) => entry.request_id === request.request_id)).toBe(true);

    await pending(store, operation({ digest: "3".repeat(64) }));
    const inspectedAfterMutation = await store.inspect();
    if (inspectedAfterMutation.status !== "ready") throw new Error("expected initialized state");
    expect(inspectedAfterMutation.requests.some((entry) => entry.request_id === request.request_id)).toBe(false);
    expect(await readFile(join(stateDir, "guard-journal.jsonl"), "utf8")).toContain(journalBefore.trim());
  });

  it("publishes authoritative state before journaling and returns a bounded warning on journal failure", async () => {
    const failingJournal: GuardJournalPort = { append: async () => { throw new Error("journal unavailable"); } };
    const { store } = await fixture({ journal: failingJournal });

    await expect(store.createOrReusePending(operation())).resolves.toMatchObject({
      request: { state: "PENDING" },
      journal_warning: "GUARD_JOURNAL_UNAVAILABLE",
    });
    await expect(store.inspect()).resolves.toMatchObject({
      status: "ready",
      requests: [expect.objectContaining({ state: "PENDING" })],
    });
  });

  it.each(["symlink", "directory", "hardlink", "unsafe-mode"])(
    "rejects an existing unsafe %s Guard lock during read-only inspection without changing metadata",
    async (variant) => {
      const { root, stateDir, store } = await fixture();
      await mkdir(stateDir, { mode: 0o700 });
      const lockPath = join(stateDir, "guard-requests.lock");
      const external = join(root, "external-lock");
      if (variant === "symlink") {
        await writeFile(external, "outside", { mode: 0o600 });
        await symlink(external, lockPath);
      } else if (variant === "directory") {
        await mkdir(lockPath, { mode: 0o700 });
      } else if (variant === "hardlink") {
        await writeFile(external, "outside", { mode: 0o600 });
        await link(external, lockPath);
      } else {
        await writeFile(lockPath, "", { mode: 0o600 });
        await chmod(lockPath, 0o644);
      }
      const directoryBefore = await lstat(stateDir);
      const lockBefore = await lstat(lockPath);

      await expect(store.inspect()).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });

      const directoryAfter = await lstat(stateDir);
      const lockAfter = await lstat(lockPath);
      expect(directoryAfter.mtimeMs).toBe(directoryBefore.mtimeMs);
      expect(lockAfter.mtimeMs).toBe(lockBefore.mtimeMs);
      expect(lockAfter.mode).toBe(lockBefore.mode);
      if (variant === "symlink" || variant === "hardlink") {
        expect(await readFile(external, "utf8")).toBe("outside");
      }
      await expect(lstat(join(stateDir, "guard-requests.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps a safe empty Guard namespace not_initialized during read-only inspection", async () => {
    const { stateDir, store } = await fixture();
    await mkdir(stateDir, { mode: 0o700 });
    const before = await lstat(stateDir);

    await expect(store.inspect()).resolves.toEqual({ status: "not_initialized", requests: [] });

    expect((await lstat(stateDir)).mtimeMs).toBe(before.mtimeMs);
    await expect(lstat(join(stateDir, "guard-requests.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Guard digest key", () => {
  it("creates exactly 32 private bytes and syncs the file before its directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-guard-key-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const order: string[] = [];
    const key = new GuardDigestKey(stateDir, {
      afterKeyFileSync: () => { order.push("file"); },
      afterKeyDirectorySync: () => { order.push("directory"); },
    });

    const bytes = await key.loadOrCreate();

    expect(bytes).toHaveLength(32);
    expect(await readFile(join(stateDir, "guard-digest.key"))).toEqual(bytes);
    expect((await lstat(join(stateDir, "guard-digest.key"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(stateDir, "guard-digest.key"))).nlink).toBe(1);
    expect(order).toEqual(["file", "directory"]);
  });

  it("inspects a missing key without creating its directory or key", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-guard-key-"));
    roots.push(root);
    const stateDir = join(root, "state");

    await expect(new GuardDigestKey(stateDir).inspect()).resolves.toEqual({ status: "not_initialized" });
    await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a missing key in an existing private state directory as not_initialized", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-guard-key-"));
    roots.push(root);
    const stateDir = join(root, "state");
    await mkdir(stateDir, { mode: 0o700 });

    await expect(new GuardDigestKey(stateDir).inspect()).resolves.toEqual({ status: "not_initialized" });
    await expect(lstat(join(stateDir, "guard-digest.key"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an existing non-private state directory when loading or creating a key", async () => {
    const root = await mkdtemp(join(tmpdir(), "jhw-guard-key-"));
    roots.push(root);
    const stateDir = join(root, "state");
    await mkdir(stateDir, { mode: 0o755 });

    await expect(new GuardDigestKey(stateDir).loadOrCreate()).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
    expect((await lstat(stateDir)).mode & 0o777).toBe(0o755);
    await expect(lstat(join(stateDir, "guard-digest.key"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["symlink", "hardlink", "directory", "fifo", "unsafe-mode", "wrong-length"])(
    "rejects an existing %s key without creating or repairing it",
    async (variant) => {
      const root = await mkdtemp(join(tmpdir(), "jhw-guard-key-"));
      roots.push(root);
      const stateDir = join(root, "state");
      const keyPath = join(stateDir, "guard-digest.key");
      const external = join(root, "external-key");
      await mkdir(stateDir, { mode: 0o700 });
      if (variant === "symlink") {
        await writeFile(external, Buffer.alloc(32, 7), { mode: 0o600 });
        await symlink(external, keyPath);
      } else if (variant === "hardlink") {
        await writeFile(external, Buffer.alloc(32, 7), { mode: 0o600 });
        await link(external, keyPath);
      } else if (variant === "directory") {
        await mkdir(keyPath);
      } else if (variant === "fifo") {
        execFileSync("mkfifo", [keyPath]);
      } else if (variant === "unsafe-mode") {
        await writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o644 });
      } else {
        await writeFile(keyPath, Buffer.alloc(31, 7), { mode: 0o600 });
      }
      const key = new GuardDigestKey(stateDir);

      await expect(key.inspect()).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
      await expect(key.loadOrCreate()).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
      if (variant === "symlink" || variant === "hardlink") {
        expect(await readFile(external)).toEqual(Buffer.alloc(32, 7));
      }
    },
  );
});
