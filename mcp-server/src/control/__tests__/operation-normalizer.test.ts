import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NormalizeOperationContextSchema,
  OperationNormalizationError,
  computeOperationDigest,
  normalizeOperation,
  normalizeResolvedOperation,
  stableCanonicalJson,
  type NormalizeOperationContext,
} from "../operation-normalizer.js";
import { guardToolIdentityInventoryForTesting, resolveGuardTool } from "../guard-tool-resolver.js";
import { CanonicalOperationSchema, type JsonValue, type PreToolUseEvent } from "../guard-protocol.js";

const TASK_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000001";
const CLAIM_ID = "clm-018f21e0-7b2c-7a00-8000-000000000002";
const KEY = Buffer.alloc(32, 0x42);
const SUPPORTED_GUARD_TOOL_CASES = [
  { adapter: "codex", raw: "Read", input: { file_path: "src/file.ts" }, tool: "file.read", capability: "repo.inspect" },
  { adapter: "codex", raw: "Glob", input: { pattern: "**/*.ts", path: "src" }, tool: "file.read", capability: "repo.inspect" },
  { adapter: "codex", raw: "Grep", input: { pattern: "bounded", path: "src" }, tool: "file.read", capability: "repo.inspect" },
  { adapter: "codex", raw: "read_file", input: { path: "src/file.ts" }, tool: "file.read", capability: "repo.inspect" },
  { adapter: "codex", raw: "mcp__filesystem__read_file", input: { path: "src/file.ts" }, tool: "file.read", capability: "repo.inspect" },
  { adapter: "codex", raw: "Edit", input: { file_path: "src/file.ts", old_string: "a", new_string: "b" }, tool: "file.modify", capability: "repo.modify" },
  { adapter: "codex", raw: "Write", input: { file_path: "src/file.ts", content: "bounded" }, tool: "file.modify", capability: "repo.modify" },
  { adapter: "codex", raw: "NotebookEdit", input: { notebook_path: "notes.ipynb", cell_id: "one", new_source: "bounded" }, tool: "file.modify", capability: "repo.modify" },
  { adapter: "codex", raw: "edit_file", input: { path: "src/file.ts", old_string: "a", new_string: "b" }, tool: "file.modify", capability: "repo.modify" },
  { adapter: "codex", raw: "mcp__filesystem__write_file", input: { path: "src/file.ts", content: "bounded" }, tool: "file.modify", capability: "repo.modify" },
  { adapter: "codex", raw: "apply_patch", input: "*** Begin Patch\n*** Update File: src/file.ts\n*** End Patch", tool: "file.modify", capability: "repo.modify" },
  { adapter: "codex", raw: "functions.apply_patch", input: { patch: "*** Begin Patch\n*** Update File: src/file.ts\n*** End Patch" }, tool: "file.modify", capability: "repo.modify" },
  { adapter: "codex", raw: "Bash", input: { command: "git status --short" }, tool: "shell", capability: "shell.unclassified" },
  { adapter: "codex", raw: "exec_command", input: { command: "git status --short" }, tool: "shell", capability: "shell.unclassified" },
  { adapter: "codex", raw: "jhw_record", input: { db: "decisionLog", title: "bounded" }, tool: "notion.mutate", capability: "notion.mutate" },
  { adapter: "codex", raw: "jhw_save", input: { db: "decisionLog", id: "page" }, tool: "notion.mutate", capability: "notion.mutate" },
  { adapter: "codex", raw: "jhw_delete", input: { db: "decisionLog", id: "page" }, tool: "notion.mutate", capability: "notion.mutate" },
  { adapter: "codex", raw: "jhw_note", input: { title: "bounded" }, tool: "notion.mutate", capability: "notion.mutate" },
  { adapter: "codex", raw: "github_issue_close", input: { issue_node_id: "I_kwDOAb-123" }, tool: "tracker.mutate", capability: "tracker.mutate" },
  { adapter: "codex", raw: "github_issue_edit", input: { issue_node_id: "I_kwDOAb-123", title: "bounded" }, tool: "tracker.mutate", capability: "tracker.mutate" },
  { adapter: "codex", raw: "github_issue_comment", input: { issue_node_id: "I_kwDOAb-123", body: "bounded" }, tool: "tracker.mutate", capability: "tracker.mutate" },
  { adapter: "claude", raw: "Bash", input: { command: "git status --short" }, tool: "shell", capability: "shell.unclassified" },
  { adapter: "claude", raw: "Edit", input: { file_path: "src/file.ts", old_string: "a", new_string: "b" }, tool: "file.modify", capability: "repo.modify" },
] as const;

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
    ["Read", { file_path: "private/file.ts" }, "repo.inspect", "file.read", "low"],
    ["Glob", { pattern: "private/*.ts" }, "repo.inspect", "file.read", "low"],
    ["Grep", { pattern: "credential-value" }, "repo.inspect", "file.read", "low"],
    ["read_file", { path: "private/file.ts" }, "repo.inspect", "file.read", "low"],
    ["Edit", { file_path: "private/file.ts", old_string: "old", new_string: "credential-value" }, "repo.modify", "file.modify", "medium"],
    ["Write", { file_path: "private/file.ts", content: "credential-value" }, "repo.modify", "file.modify", "medium"],
    ["NotebookEdit", { notebook_path: "private/file.ts" }, "repo.modify", "file.modify", "medium"],
    ["apply_patch", "*** Begin Patch\n*** Update File: private/file.ts\n*** End Patch", "repo.modify", "file.modify", "medium"],
    ["functions.apply_patch", { patch: "*** Begin Patch\n*** Update File: private/file.ts\n*** End Patch" }, "repo.modify", "file.modify", "medium"],
    ["mcp__filesystem__read_file", { path: "private/file.ts" }, "repo.inspect", "file.read", "low"],
    ["mcp__filesystem__write_file", { path: "private/file.ts", content: "credential-value" }, "repo.modify", "file.modify", "medium"],
    ["edit_file", { path: "private/file.ts", old_string: "old", new_string: "credential-value" }, "repo.modify", "file.modify", "medium"],
  ] as const)("maps central file tool %s to %s", async (tool_name, tool_input, capability, tool, risk) => {
    const operation = await normalizeOperation(event({
      tool_name,
      tool_input,
    }), context, KEY);

    expect(operation.requirements).toEqual([{ capability, resource: context.repository }]);
    expect(operation.tool).toBe(tool);
    expect(operation.risk).toBe(risk);
    expect(JSON.stringify(operation)).not.toContain("private/file.ts");
    expect(JSON.stringify(operation)).not.toContain("credential-value");
  });

  it("keeps the table-driven supported cases exhaustive with the single production identity table", () => {
    expect(guardToolIdentityInventoryForTesting()).toEqual(
      SUPPORTED_GUARD_TOOL_CASES.map(({ adapter, raw }) => ({ adapter, rawToolName: raw })),
    );
  });

  it.each(SUPPORTED_GUARD_TOOL_CASES)("preserves the explicit supported identity $adapter/$raw", async (entry) => {
    const operationContext: NormalizeOperationContext = entry.raw === "jhw_note"
      ? { ...context, notion_database: { kind: "notion_database" as const, id: "knowledgeBase" } }
      : context;
    const operation = await normalizeOperation(event({
      adapter: entry.adapter,
      tool_name: entry.raw,
      tool_input: entry.input as JsonValue,
    }), operationContext, KEY);

    expect(operation.tool).toBe(entry.tool);
    expect(operation.requirements.map((requirement) => requirement.capability)).toEqual([entry.capability]);
  });

  it.each([
    ["gemini", "Edit", { file_path: "src/file.ts", old_string: "a", new_string: "b" }],
    ["opencode", "Bash", { command: "git commit -m bounded" }],
    ["claude", "exec_command", { command: "git commit -m bounded" }],
    ["codex", "mcp__remote__Edit", { file_path: "src/file.ts", old_string: "a", new_string: "b" }],
    ["codex", "vendor/Bash", { command: "git commit -m bounded" }],
    ["codex", "evil:jhw_record", { db: "decisionLog", title: "bounded" }],
    ["codex", "mcp__github__github_issue_close", { issue_node_id: "I_kwDOAb-123" }],
  ] as const)("never grants supported suffix authority to unsupported identity %s/%s", async (adapter, raw, input) => {
    const operation = await normalizeOperation(event({ adapter, tool_name: raw, tool_input: input }), context, KEY);

    expect(operation.tool).toBe("tool.unclassified");
    expect(operation.requirements).toEqual([{
      capability: "shell.unclassified",
      resource: context.repository,
    }]);
    expect(operation.risk).toBe("high");
  });

  it.each([
    ["codex", "Edit", {}],
    ["codex", "Bash", { command: 7 }],
    ["codex", "jhw_record", { db: "unknown", title: "bounded" }],
    ["codex", "apply_patch", { patch: 7 }],
    ["claude", "Edit", { path: "src/file.ts", old_string: "a", new_string: "b" }],
  ] as const)("fails closed for malformed recognized codec %s/%s", async (adapter, raw, input) => {
    await expect(normalizeOperation(event({ adapter, tool_name: raw, tool_input: input }), context, KEY))
      .rejects.toMatchObject({ code: "invalid_tool_input" } satisfies Partial<OperationNormalizationError>);
  });

  it("rejects replaying a genuine resolution against different raw input", async () => {
    const original = event({ tool_input: { command: "git status --short" } });
    const changed = event({ tool_input: { command: "git commit -m changed" } });
    const resolved = resolveGuardTool(original.adapter, original.tool_name, original.tool_input);

    await expect(normalizeResolvedOperation(changed, resolved, context, KEY)).rejects.toMatchObject({
      code: "invalid_tool_input",
    } satisfies Partial<OperationNormalizationError>);
  });

  it("rejects a tracker input whose target differs from the canonical Task Issue", async () => {
    await expect(normalizeOperation(event({
      tool_name: "github_issue_edit",
      tool_input: { issue_node_id: "I_kwDOOther-456", title: "bounded" },
    }), context, KEY)).rejects.toMatchObject({
      code: "context_mismatch",
    } satisfies Partial<OperationNormalizationError>);
  });

  it.each([
    ["Read", { file_path: "src/file.ts", path: "../../outside" }],
    ["Edit", { file_path: "src/file.ts", old_string: "a", new_string: "b", path: "../../outside" }],
    ["Bash", { command: "git status --short", cwd: "/tmp/outside" }],
    ["jhw_record", { db: "decisionLog", title: "bounded", database_id: "outside" }],
    ["github_issue_comment", { issue_node_id: "I_kwDOAb-123", body: "bounded", repository: "other/repo" }],
  ] as const)("rejects alternate authority coordinates in recognized %s input", async (toolName, input) => {
    await expect(normalizeOperation(event({
      tool_name: toolName,
      tool_input: input as JsonValue,
    }), context, KEY)).rejects.toMatchObject({
      code: "invalid_tool_input",
    } satisfies Partial<OperationNormalizationError>);
  });

  it("binds exact unknown raw tool identity even when canonical capability and input are equal", async () => {
    const first = await normalizeOperation(event({
      tool_name: "ThirdPartyOpaqueOne",
      tool_input: { action: "bounded" },
    }), context, KEY);
    const second = await normalizeOperation(event({
      tool_name: "ThirdPartyOpaqueTwo",
      tool_input: { action: "bounded" },
    }), context, KEY);

    expect(first.tool).toBe("tool.unclassified");
    expect(second.tool).toBe("tool.unclassified");
    expect(first.digest).not.toBe(second.digest);
    expect(JSON.stringify(first)).not.toContain("ThirdPartyOpaqueOne");
    expect(JSON.stringify(second)).not.toContain("ThirdPartyOpaqueTwo");
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
      raw_tool_identity: "Edit",
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
