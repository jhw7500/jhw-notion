import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NormalizeOperationContextSchema,
  OperationNormalizationError,
  computeOperationDigest,
  normalizeOperation,
  stableCanonicalJson,
  type NormalizeOperationContext,
} from "../operation-normalizer.js";
import { CanonicalOperationSchema, type PreToolUseEvent } from "../guard-protocol.js";

const TASK_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000001";
const CLAIM_ID = "clm-018f21e0-7b2c-7a00-8000-000000000002";
const KEY = Buffer.alloc(32, 0x42);

describe("operation normalization", () => {
  let root: string;
  let subdir: string;
  let context: NormalizeOperationContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "guard-operation-"));
    subdir = join(root, "src");
    await mkdir(subdir);
    await mkdir(join(root, ".git"));
    context = {
      evaluation_stage: "hook",
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      session_id: "codex-local-hardening",
      cwd_worktree_ref: "wt-local-hardening",
      trusted_worktree_path: root,
      repository: { kind: "repository", id: "repo-wlan-package" },
      issue: { kind: "issue", id: "I_kwDOAb-123" },
      notion_database: { kind: "notion_database", id: "decisionLog" },
      board: { kind: "board", id: "board-alpha" },
      remote_host: { kind: "remote_host", id: "rhost-alpha" },
      firmware_target: { kind: "firmware_target", id: "fwt-alpha" },
      deployment_target: { kind: "deployment_target", id: "dpl-alpha" },
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function event(overrides: Partial<PreToolUseEvent> = {}): PreToolUseEvent {
    return {
      protocol_version: 1,
      adapter: "codex",
      event: "pre_tool_use",
      session_id: context.session_id,
      cwd: root,
      tool_name: "Bash",
      tool_input: { command: "git commit -m bounded" },
      tool_use_id: "call-17",
      ...overrides,
    };
  }

  it("produces a strict, sorted, secret-safe canonical operation", async () => {
    const rawCommand = "git push https://user:credential@example.invalid/private HEAD && echo secret";
    const operation = await normalizeOperation(event({ tool_input: { command: rawCommand } }), context, KEY);

    expect(CanonicalOperationSchema.safeParse(operation).success).toBe(true);
    expect(operation).toMatchObject({
      protocol_version: 1,
      origin_adapter: "codex",
      evaluation_stage: "hook",
      session_id: "codex-local-hardening",
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      cwd_worktree_ref: "wt-local-hardening",
      tool: "shell",
      requirements: [
        { capability: "git.publish", resource: context.repository },
        { capability: "shell.unclassified", resource: context.repository },
      ],
      risk: "high",
      execution_boundary: "guarded_command",
    });
    expect(operation.operation_id).toMatch(/^op-[0-9a-f-]+$/);
    expect(operation.digest).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(operation);
    for (const forbidden of [rawCommand, "credential", "secret", root, "example.invalid", "tool_input"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.each([
    ["Read", "repo.inspect", "file.read", "low"],
    ["Glob", "repo.inspect", "file.read", "low"],
    ["Grep", "repo.inspect", "file.read", "low"],
    ["read_file", "repo.inspect", "file.read", "low"],
    ["Edit", "repo.modify", "file.modify", "medium"],
    ["Write", "repo.modify", "file.modify", "medium"],
    ["NotebookEdit", "repo.modify", "file.modify", "medium"],
    ["apply_patch", "repo.modify", "file.modify", "medium"],
    ["functions.apply_patch", "repo.modify", "file.modify", "medium"],
    ["mcp__filesystem__read_file", "repo.inspect", "file.read", "low"],
    ["mcp__filesystem__write_file", "repo.modify", "file.modify", "medium"],
    ["edit_file", "repo.modify", "file.modify", "medium"],
  ] as const)("maps central file tool %s to %s", async (tool_name, capability, tool, risk) => {
    const operation = await normalizeOperation(event({
      tool_name,
      tool_input: { path: "/private/worktree/file.ts", content: "credential-value" },
    }), context, KEY);

    expect(operation.requirements).toEqual([{ capability, resource: context.repository }]);
    expect(operation.tool).toBe(tool);
    expect(operation.risk).toBe(risk);
    expect(JSON.stringify(operation)).not.toContain("/private/worktree/file.ts");
    expect(JSON.stringify(operation)).not.toContain("credential-value");
  });

  it("does not pretend an arbitrary unknown tool is a repository read", async () => {
    const operation = await normalizeOperation(event({
      tool_name: "ThirdPartyOpaqueTool",
      tool_input: { action: "status" },
    }), context, KEY);

    expect(operation.requirements).toEqual([{
      capability: "shell.unclassified",
      resource: context.repository,
    }]);
    expect(operation.risk).toBe("high");
  });

  it("requires strict validated Task, Claim, session, worktree, and canonical resources", () => {
    expect(NormalizeOperationContextSchema.safeParse(context).success).toBe(true);
    const invalid = [
      { ...context, task_id: "local-hardening" },
      { ...context, claim_id: "current" },
      { ...context, session_id: "" },
      { ...context, cwd_worktree_ref: "/private/worktree" },
      { ...context, repository: { kind: "repository", id: "/private/repository" } },
      { ...context, issue: { kind: "issue", id: "owner/repo#42" } },
      { ...context, board: { kind: "board", id: "192.0.2.1" } },
      { ...context, contract_alias: "repo-wlan-package" },
    ];

    for (const candidate of invalid) {
      expect(NormalizeOperationContextSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("fails before canonicalization when session, cwd, digest key, or unresolved authority is unsafe", async () => {
    await expect(normalizeOperation(event({ session_id: "another-session" }), context, KEY)).rejects.toMatchObject({
      code: "context_mismatch",
    } satisfies Partial<OperationNormalizationError>);
    await expect(normalizeOperation(event({ cwd: join(root, "..") }), context, KEY)).rejects.toMatchObject({
      code: "cwd_outside_worktree",
    } satisfies Partial<OperationNormalizationError>);
    await expect(normalizeOperation(event(), context, Buffer.alloc(31))).rejects.toMatchObject({
      code: "invalid_digest_key",
    } satisfies Partial<OperationNormalizationError>);
    const unresolvedContext = { ...context, remote_host: undefined };
    await expect(normalizeOperation(event({ tool_input: { command: "ssh example.invalid uname -a" } }), unresolvedContext, KEY))
      .rejects.toMatchObject({
        code: "unresolved_boundary",
        signals: [{ capability: "remote.execute", boundary: "guarded_command" }],
      } satisfies Partial<OperationNormalizationError>);
  });

  it("keeps the digest stable across operation IDs, correlation IDs, stages, and object key order", async () => {
    const first = await normalizeOperation(event({
      tool_input: { command: "git commit -m bounded", metadata: { b: 2, a: 1 } },
      tool_use_id: "call-first",
    }), context, KEY);
    const second = await normalizeOperation(event({
      tool_input: { metadata: { a: 1, b: 2 }, command: "git commit -m bounded" },
      tool_use_id: "call-retry",
    }), { ...context, evaluation_stage: "execution" }, KEY);

    expect(first.operation_id).not.toBe(second.operation_id);
    expect(first.evaluation_stage).toBe("hook");
    expect(second.evaluation_stage).toBe("execution");
    expect(first.digest).toBe(second.digest);
  });

  it("changes the digest for adapter, Task, Claim, session, worktree, cwd, argument, and key changes", async () => {
    const base = await normalizeOperation(event(), context, KEY);
    const cases: Array<Promise<{ digest: string }>> = [
      normalizeOperation(event({ adapter: "claude" }), context, KEY),
      normalizeOperation(event(), { ...context, task_id: TASK_ID.replace("001", "011") }, KEY),
      normalizeOperation(event(), { ...context, claim_id: CLAIM_ID.replace("002", "012") }, KEY),
      normalizeOperation(
        event({ session_id: "codex-other" }),
        { ...context, session_id: "codex-other" },
        KEY,
      ),
      normalizeOperation(event(), { ...context, cwd_worktree_ref: "wt-other" }, KEY),
      normalizeOperation(event({ cwd: subdir }), context, KEY),
      normalizeOperation(event({ tool_input: { command: "git commit -m changed" } }), context, KEY),
      normalizeOperation(event(), context, Buffer.alloc(32, 0x43)),
    ];

    for (const candidate of await Promise.all(cases)) expect(candidate.digest).not.toBe(base.digest);
  });

  it("privately binds distinct raw shell command bytes without exposing them", async () => {
    const preserved = await normalizeOperation(event({
      tool_input: { command: 'custom-tool "a\\q"' },
    }), context, KEY);
    const plain = await normalizeOperation(event({
      tool_input: { command: 'custom-tool "aq"' },
    }), context, KEY);

    expect(preserved.digest).not.toBe(plain.digest);
    expect(JSON.stringify(preserved)).not.toContain('custom-tool "a\\q"');
    expect(JSON.stringify(plain)).not.toContain('custom-tool "aq"');
  });

  it("fails normalization for Git effective targets outside the trusted repository", async () => {
    const outside = await mkdtemp(join(tmpdir(), "guard-operation-outside-"));
    await mkdir(join(outside, ".git"));
    try {
      await expect(normalizeOperation(event({
        tool_input: { command: `git -C ${outside} commit -m bounded` },
      }), context, KEY)).rejects.toMatchObject({
        code: "unresolved_boundary",
        signals: [{ capability: "git.commit", boundary: "guarded_command" }],
      } satisfies Partial<OperationNormalizationError>);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("binds verified effective Git target syntax into the operation digest", async () => {
    const plain = await normalizeOperation(event({
      tool_input: { command: "git commit -m bounded" },
    }), context, KEY);
    const explicit = await normalizeOperation(event({
      tool_input: { command: `git -C ${root} commit -m bounded` },
    }), context, KEY);

    expect(explicit.requirements).toEqual([{ capability: "git.commit", resource: context.repository }]);
    expect(explicit.digest).not.toBe(plain.digest);
  });

  it("binds non-command JSON fields that can affect shell execution", async () => {
    const first = await normalizeOperation(event({
      tool_input: { command: "git commit -m bounded", timeout_ms: 1_000, background: false },
    }), context, KEY);
    const changedTimeout = await normalizeOperation(event({
      tool_input: { command: "git commit -m bounded", timeout_ms: 2_000, background: false },
    }), context, KEY);
    const changedMode = await normalizeOperation(event({
      tool_input: { command: "git commit -m bounded", timeout_ms: 1_000, background: true },
    }), context, KEY);

    expect(changedTimeout.digest).not.toBe(first.digest);
    expect(changedMode.digest).not.toBe(first.digest);
  });

  it("binds both local script path and content without exposing either", async () => {
    const firstPath = join(root, "first.sh");
    const secondPath = join(root, "second.sh");
    await writeFile(firstPath, "#!/bin/sh\necho first\n", { mode: 0o700 });
    await writeFile(secondPath, "#!/bin/sh\necho first\n", { mode: 0o700 });
    const first = await normalizeOperation(event({ tool_input: { command: "./first.sh" } }), context, KEY);
    const sameContentDifferentPath = await normalizeOperation(
      event({ tool_input: { command: "./second.sh" } }),
      context,
      KEY,
    );
    await writeFile(firstPath, "#!/bin/sh\necho changed\n", { mode: 0o700 });
    await chmod(firstPath, 0o700);
    const changedContent = await normalizeOperation(event({ tool_input: { command: "./first.sh" } }), context, KEY);

    expect(first.digest).not.toBe(sameContentDifferentPath.digest);
    expect(first.digest).not.toBe(changedContent.digest);
    for (const operation of [first, sameContentDifferentPath, changedContent]) {
      expect(JSON.stringify(operation)).not.toContain(root);
      expect(JSON.stringify(operation)).not.toContain("echo first");
      expect(JSON.stringify(operation)).not.toContain("echo changed");
    }
  });

  it("binds env-prefixed local script content changes", async () => {
    const script = join(root, "prefixed.sh");
    await writeFile(script, "#!/bin/sh\necho first\n", { mode: 0o700 });
    const first = await normalizeOperation(event({
      tool_input: { command: "env MODE=safe ./prefixed.sh" },
    }), context, KEY);
    await writeFile(script, "#!/bin/sh\necho second\n", { mode: 0o700 });
    await chmod(script, 0o700);
    const second = await normalizeOperation(event({
      tool_input: { command: "env MODE=safe ./prefixed.sh" },
    }), context, KEY);

    expect(first.digest).not.toBe(second.digest);
    expect(JSON.stringify(first)).not.toContain("echo first");
    expect(JSON.stringify(second)).not.toContain("echo second");
  });

  it("excludes operation, correlation, stage, and summary metadata from explicit digest material", () => {
    const material = {
      protocol_version: 1 as const,
      tool: "file.modify",
      origin_adapter: "codex" as const,
      task_id: TASK_ID,
      claim_id: CLAIM_ID,
      session_id: "codex-local-hardening",
      cwd_worktree_ref: "wt-local-hardening",
      cwd_relative: "src",
      requirements: [{ capability: "repo.modify" as const, resource: context.repository }],
      execution: { path: "private/file.ts", content: "private-value" },
    };
    const decoratedA = {
      ...material,
      operation_id: "op-018f21e0-7b2c-7a00-8000-000000000003",
      tool_use_id: "call-first",
      evaluation_stage: "hook",
      summary: "first human summary",
    };
    const decoratedB = {
      ...material,
      operation_id: "op-018f21e0-7b2c-7a00-8000-000000000004",
      tool_use_id: "call-second",
      evaluation_stage: "execution",
      summary: "different human summary",
    };

    expect(computeOperationDigest(decoratedA, KEY)).toBe(computeOperationDigest(decoratedB, KEY));
  });
});

describe("stable canonical JSON", () => {
  it("sorts object keys recursively while retaining execution-relevant array order", () => {
    expect(stableCanonicalJson({ z: 1, a: { y: 2, x: 3 }, argv: ["second", "first"] })).toBe(
      '{"a":{"x":3,"y":2},"argv":["second","first"],"z":1}',
    );
  });

  it("rejects cycles, unsupported values, non-finite numbers, sparse arrays, and custom prototypes", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = new Array(2);
    sparse[1] = "value";
    class Custom {
      readonly value = 1;
    }
    for (const input of [cycle, { value: undefined }, { value: () => 1 }, { value: 1n }, { value: Infinity }, sparse, new Custom()]) {
      expect(() => stableCanonicalJson(input)).toThrow();
    }
  });
});
