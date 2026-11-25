import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardService, type LivenessProbe } from "../board-service.js";
import type { ControlConfig } from "../config.js";
import type { CanonicalOperation } from "../guard-protocol.js";
import { GuardDigestKey, GuardRequestStore, type GuardRequest } from "../guard-state.js";
import { computeOperationDigest } from "../operation-normalizer.js";
import {
  createObserveJournalLock,
  createProductionMutationLock,
  type MutationLockRuntime,
} from "../process.js";
import { RegistrationHintStore } from "../registration-hint.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(TEST_DIR, "__fixtures__", "persistent-contract");
const GENERATION_DIR = join(CONTRACT_DIR, "generation-2");
const GENERATION_MANIFEST = JSON.parse(
  await readFile(join(GENERATION_DIR, "manifest.json"), "utf8"),
) as { generation: number; declaration: unknown; corpus: string };
const CORPUS_DIR = join(GENERATION_DIR, GENERATION_MANIFEST.corpus);
const START = Date.parse("2026-08-25T01:00:00.000Z");
const REQUEST_ID = "req-018f21e0-7b2c-7a00-8000-000000000011";
const roots: string[] = [];

async function golden<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(CORPUS_DIR, name), "utf8")) as T;
}

function configFor(root: string): ControlConfig {
  return {
    registryDir: join(root, "registry"),
    registryRemote: "origin",
    registryBranch: "main",
    worktreeRoot: join(root, "worktrees"),
    buildHost: "build-host",
    githubOwner: "owner",
    projectNumber: 1,
    registryRepository: "owner/registry",
    preflightProjectItemId: "PVTI_trial",
    preflightRegistryIssueNumber: 1,
    stateDir: join(root, "state"),
    guardMode: "enforce",
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

const operation: CanonicalOperation = {
  protocol_version: 1,
  operation_id: "op-018f21e0-7b2c-7a00-8000-000000000003",
  origin_adapter: "codex",
  evaluation_stage: "hook",
  session_id: "codex-persistent-contract",
  task_id: "tsk-018f21e0-7b2c-7a00-8000-000000000001",
  claim_id: "clm-018f21e0-7b2c-7a00-8000-000000000002",
  cwd_worktree_ref: "wt-persistent-contract",
  tool: "file.modify",
  requirements: [{
    capability: "repo.modify",
    resource: { kind: "repository", id: "repo-jhw-notion" },
  }],
  risk: "medium",
  execution_boundary: "hook",
  summary: "Modify the claimed repository",
  digest: "1".repeat(64),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("persistent compatibility generation 2", () => {
  it("binds the repository declaration to the hand-reviewed generation corpus", async () => {
    const declaration = JSON.parse(
      await readFile(join(TEST_DIR, "..", "runtime-compatibility.json"), "utf8"),
    ) as { version: number; generation: number; guardFloor: number };
    const manifest = GENERATION_MANIFEST;

    expect(declaration).toEqual({ version: 1, generation: 2, guardFloor: 1 });
    expect(manifest).toEqual({
      generation: declaration.generation,
      declaration,
      corpus: "../generation-1",
    });
    const inherited = JSON.parse(await readFile(join(CORPUS_DIR, "manifest.json"), "utf8"));
    expect(inherited).toEqual(await golden("manifest.json"));
  });

  it("writes the pending Guard lifecycle golden and reads the corpus through the public store", async () => {
    const root = await temporaryRoot("jhw-persistent-guard-");
    const config = configFor(root);
    const store = new GuardRequestStore(config, {
      journal: { append: async () => undefined },
      lockRuntime: immediateLockRuntime,
      environment: {},
    });

    const created = await store.createOrReusePending(operation);
    const actual = JSON.parse(await readFile(join(config.stateDir, "guard-requests.yaml"), "utf8")) as {
      version: number;
      requests: GuardRequest[];
    };
    actual.requests[0] = { ...actual.requests[0], request_id: REQUEST_ID };
    const expected = await golden<typeof actual>("guard-requests.pending.json");

    expect(created.request.state).toBe("PENDING");
    expect(actual).toEqual(expected);
    expect((await readdir(config.stateDir)).sort()).toEqual([
      "guard-requests.lock",
      "guard-requests.yaml",
    ]);

    await writeFile(join(config.stateDir, "guard-requests.yaml"), `${JSON.stringify(expected, null, 2)}\n`, { mode: 0o600 });
    await expect(store.inspect()).resolves.toEqual({ status: "ready", requests: expected.requests });
  });

  it("rejects a corpus mutation that removes the Guard operation binding", async () => {
    const root = await temporaryRoot("jhw-persistent-guard-negative-");
    const config = configFor(root);
    const store = new GuardRequestStore(config, {
      journal: { append: async () => undefined },
      lockRuntime: immediateLockRuntime,
      environment: {},
    });
    await store.ensureInitialized();
    const expected = await golden<{ version: number; requests: Array<Record<string, unknown>> }>(
      "guard-requests.pending.json",
    );
    const mutated = structuredClone(expected);
    delete mutated.requests[0]?.operation_digest;
    await writeFile(join(config.stateDir, "guard-requests.yaml"), `${JSON.stringify(mutated)}\n`, { mode: 0o600 });

    await expect(store.inspect()).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
  });

  it("creates the raw Guard digest key at its contract path", async () => {
    const root = await temporaryRoot("jhw-persistent-key-");
    const stateDir = configFor(root).stateDir;
    const keyStore = new GuardDigestKey(stateDir);

    const key = await keyStore.loadOrCreate();

    expect(key).toHaveLength(32);
    expect(await readFile(join(stateDir, "guard-digest.key"))).toEqual(key);
    await expect(keyStore.inspect()).resolves.toEqual({ status: "ready" });
  });

  it("writes and reads the registered board golden", async () => {
    const root = await temporaryRoot("jhw-persistent-board-");
    const config = configFor(root);
    const probe: LivenessProbe = {
      currentBootId: async () => "boot-1",
      inspect: async () => ({ state: "unknown" }),
    };
    const service = new BoardService(
      config,
      { run: async (callback) => callback() },
      probe,
      () => new Date(START),
      { append: async () => undefined },
    );

    await service.register({
      board_id: "wlan-01",
      description: "wlan target",
      interfaces: [{ type: "serial", address: "/dev/ttyUSB0" }],
      session: "session-a",
    });
    const actual = JSON.parse(await readFile(join(config.stateDir, "boards.yaml"), "utf8"));
    const expected = await golden("boards.registered.json");

    expect(actual).toEqual(expected);
    await expect(service.list()).resolves.toMatchObject({
      boards: [{ board_id: "wlan-01", description: "wlan target" }],
    });
  });

  it("writes and reads the project registration golden and rejects its version mutation", async () => {
    const root = await temporaryRoot("jhw-persistent-registration-");
    const stateDir = configFor(root).stateDir;
    const store = new RegistrationHintStore(stateDir);
    const hint = {
      project_id: "prj-example",
      item_id: "PVTI_created",
      source_node_id: "DI_created",
    };

    await store.record(hint);
    const path = join(stateDir, "project-registrations.json");
    const actual = JSON.parse(await readFile(path, "utf8"));
    const expected = await golden("project-registrations.json");

    expect(actual).toEqual(expected);
    await expect(store.read("prj-example")).resolves.toEqual(hint);

    await writeFile(path, `${JSON.stringify({ ...(expected as object), version: 2 })}\n`, { mode: 0o600 });
    await expect(store.read("prj-example")).rejects.toMatchObject({
      code: "INVALID_REGISTRATION_HINT_STATE",
    });
  });

  it("creates every shared mutation lock at its production path", async () => {
    vi.useRealTimers();
    const root = await temporaryRoot("jhw-persistent-locks-");
    const config = configFor(root);

    await createProductionMutationLock(config, {}, "registry").run(async () => undefined);
    await createProductionMutationLock(config, {}, "board").run(async () => undefined);
    await createObserveJournalLock(config.stateDir, {}).run(async () => undefined);

    expect((await readdir(config.stateDir)).sort()).toEqual([
      "boards.lock",
      "guard-observe-journal.lock",
      "registry.lock",
    ]);
  });

  it("keeps the operation normalizer digest interpretation on a fixed vector", async () => {
    const vector = await golden<{
      key_hex: string;
      material: Parameters<typeof computeOperationDigest>[0];
      digest: string;
    }>("operation-digest.json");

    expect(computeOperationDigest(vector.material, Buffer.from(vector.key_hex, "hex"))).toBe(vector.digest);
    expect(computeOperationDigest(
      { ...vector.material, cwd_relative: "src/changed.ts" },
      Buffer.from(vector.key_hex, "hex"),
    )).not.toBe(vector.digest);
  });
});
