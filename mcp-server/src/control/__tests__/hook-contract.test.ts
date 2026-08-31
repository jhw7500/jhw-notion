import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeOperation, type NormalizeOperationContext } from "../operation-normalizer.js";
import { exactGuardUnlockRequestId, type GuardCommonEvent, type PreToolUseEvent } from "../guard-protocol.js";
import { NativeHookOutputSchema } from "../hook-codecs.js";
import type { GuardDecision } from "../schemas.js";

type HookEventName = "UserPromptSubmit" | "PreToolUse" | "PostToolUse";
type Adapter = "claude" | "codex";

interface HookCodecContract {
  decode(event: HookEventName, raw: unknown): GuardCommonEvent;
  renderPreTool(result: GuardDecision): unknown;
}

interface AdapterContractResult {
  contract_version: 1;
  adapter: Adapter;
  native_version: string;
  fixture_axes: {
    prompt_origin: true;
    pre_tool_block: true;
    post_tool_correlation: true;
  };
}

interface HookCodecsModule {
  claudeHookCodec: HookCodecContract;
  codexHookCodec: HookCodecContract;
  adapterContractResults: Readonly<Record<Adapter, AdapterContractResult>>;
}

const modulePath = "../hook-codecs.js";
const loadCodecs = async (): Promise<HookCodecsModule> => import(modulePath) as Promise<HookCodecsModule>;
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/hooks");
const REQUEST_ID = "req-018f21e0-7b2c-7a00-8000-000000000003";
const TASK_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000001";
const CLAIM_ID = "clm-018f21e0-7b2c-7a00-8000-000000000002";
const KEY = Buffer.alloc(32, 0x71);
const roots: string[] = [];

function fixtureBytes(adapter: Adapter, fixture: "user-prompt-submit" | "pre-tool-edit" | "post-tool-edit"): Buffer {
  return readFileSync(join(fixtureRoot, adapter, `${fixture}.json`));
}

function fixtureJson(adapter: Adapter, fixture: "user-prompt-submit" | "pre-tool-edit" | "post-tool-edit"): Record<string, unknown> {
  return JSON.parse(fixtureBytes(adapter, fixture).toString("utf8")) as Record<string, unknown>;
}

function codec(module: HookCodecsModule, adapter: Adapter): HookCodecContract {
  return adapter === "claude" ? module.claudeHookCodec : module.codexHookCodec;
}

async function normalizationContext(adapter: Adapter, root: string): Promise<NormalizeOperationContext> {
  return {
    evaluation_stage: "hook",
    task_id: TASK_ID,
    claim_id: CLAIM_ID,
    session_id: `${adapter}-contract-session-01`,
    cwd_worktree_ref: "wt-adapter-contract",
    trusted_worktree_path: root,
    repository: { kind: "repository", id: "repo-adapter-contract" },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("recorded native hook contracts", () => {
  it("catches native schema drift by decoding every sanitized fixture byte-for-byte", async () => {
    const codecs = await loadCodecs();
    for (const adapter of ["claude", "codex"] as const) {
      expect(codec(codecs, adapter).decode("UserPromptSubmit", fixtureJson(adapter, "user-prompt-submit")))
        .toMatchObject({ adapter, event: "user_prompt_submit" });
      expect(codec(codecs, adapter).decode("PreToolUse", fixtureJson(adapter, "pre-tool-edit")))
        .toMatchObject({ adapter, event: "pre_tool_use" });
      expect(codec(codecs, adapter).decode("PostToolUse", fixtureJson(adapter, "post-tool-edit")))
        .toMatchObject({ adapter, event: "post_tool_use" });
    }
  });

  it("catches documented subagent metadata rejection without treating it as Guard authority", async () => {
    const codecs = await loadCodecs();
    for (const adapter of ["claude", "codex"] as const) {
      const decoded = codec(codecs, adapter).decode("PreToolUse", {
        ...fixtureJson(adapter, "pre-tool-edit"),
        agent_id: `${adapter}-subagent-01`,
        agent_type: "Explore",
      });
      expect(decoded).toMatchObject({ adapter, event: "pre_tool_use" });
      expect(decoded).not.toHaveProperty("agent_id");
      expect(decoded).not.toHaveProperty("agent_type");
    }
  });

  it("catches omitted Codex 0.149.1 required native coordinates before Guard evaluation", async () => {
    const codecs = await loadCodecs();
    const required: ReadonlyArray<readonly [
      HookEventName,
      "user-prompt-submit" | "pre-tool-edit" | "post-tool-edit",
      readonly string[],
    ]> = [
      ["UserPromptSubmit", "user-prompt-submit", ["model", "permission_mode", "transcript_path", "turn_id"]],
      ["PreToolUse", "pre-tool-edit", ["model", "permission_mode", "transcript_path", "turn_id"]],
      ["PostToolUse", "post-tool-edit", ["model", "permission_mode", "transcript_path", "turn_id", "tool_response"]],
    ];

    for (const [event, fixture, fields] of required) {
      for (const field of fields) {
        const native = fixtureJson("codex", fixture);
        delete native[field];
        expect(() => codecs.codexHookCodec.decode(event, native), `${event}.${field}`).toThrow();
      }
    }
  });

  it("catches adapter normalization drift by preserving equal edit requirements, risk, and boundary", async () => {
    const codecs = await loadCodecs();
    const root = await mkdtemp(join(tmpdir(), "hook-contract-"));
    roots.push(root);
    await Promise.all([mkdir(join(root, ".git")), mkdir(join(root, "src"))]);
    const [claudeContext, codexContext] = await Promise.all([
      normalizationContext("claude", root),
      normalizationContext("codex", root),
    ]);
    const pre = (adapter: Adapter): PreToolUseEvent => codec(codecs, adapter).decode("PreToolUse", {
      ...fixtureJson(adapter, "pre-tool-edit"),
      cwd: root,
      tool_input: {
        file_path: join(root, "src", "example.ts"),
        old_string: "export const value = 1;",
        new_string: "export const value = 2;",
      },
    }) as PreToolUseEvent;
    const [claude, codex] = await Promise.all([
      normalizeOperation(pre("claude"), claudeContext, KEY),
      normalizeOperation(pre("codex"), codexContext, KEY),
    ]);

    expect(claude.requirements).toEqual(codex.requirements);
    expect(claude.risk).toBe(codex.risk);
    expect(claude.execution_boundary).toBe(codex.execution_boundary);
    expect(claude.digest).not.toBe(codex.digest);
  });

  it("catches permit aliasing by binding adapter identity while excluding hook versus execution stage", async () => {
    const codecs = await loadCodecs();
    const root = await mkdtemp(join(tmpdir(), "hook-contract-"));
    roots.push(root);
    const context = await normalizationContext("codex", root);
    const pre = codec(codecs, "codex").decode("PreToolUse", {
      ...fixtureJson("codex", "pre-tool-edit"),
      cwd: root,
      tool_input: { file_path: join(root, "src", "example.ts"), old_string: "one", new_string: "two" },
    }) as PreToolUseEvent;
    const hook = await normalizeOperation(pre, context, KEY);
    const execution = await normalizeOperation(pre, { ...context, evaluation_stage: "execution" }, KEY);
    const claude = await normalizeOperation({ ...pre, adapter: "claude" }, context, KEY);

    expect(hook.digest).toBe(execution.digest);
    expect(hook.digest).not.toBe(claude.digest);
  });

  it("catches unlock rewriting by delivering the exact native prompt bytes to submitUserPrompt", async () => {
    const codecs = await loadCodecs();
    for (const adapter of ["claude", "codex"] as const) {
      const raw = fixtureBytes(adapter, "user-prompt-submit");
      const native = JSON.parse(raw.toString("utf8")) as { prompt: string };
      const decoded = codec(codecs, adapter).decode("UserPromptSubmit", native);
      expect(decoded).toMatchObject({ prompt: native.prompt });
      expect(native.prompt).toBe(`/jhw:unlock ${REQUEST_ID}`);
    }
  });

  it("catches non-prompt authority fallback by rejecting user_prompt, input, transcript, and assistant text", async () => {
    const codecs = await loadCodecs();
    for (const adapter of ["claude", "codex"] as const) {
      const prompt = fixtureJson(adapter, "user-prompt-submit");
      for (const mutation of [
        { ...prompt, user_prompt: `/jhw:unlock ${REQUEST_ID}` },
        { ...prompt, input: `/jhw:unlock ${REQUEST_ID}` },
        { ...prompt, transcript: `/jhw:unlock ${REQUEST_ID}` },
        { ...prompt, assistant_text: `/jhw:unlock ${REQUEST_ID}` },
        Object.fromEntries(Object.entries(prompt).filter(([key]) => key !== "prompt")),
      ]) expect(() => codec(codecs, adapter).decode("UserPromptSubmit", mutation)).toThrow();
    }
  });

  it("catches native deny sanitization that drops the one exact approval command", async () => {
    const codecs = await loadCodecs();
    const approval_command = `/jhw:unlock ${REQUEST_ID}`;
    for (const adapter of ["claude", "codex"] as const) {
      const rendered = JSON.stringify(codec(codecs, adapter).renderPreTool({
        decision: "PERMIT_REQUIRED",
        operation_id: "op-018f21e0-7b2c-7a00-8000-000000000004",
        request_id: REQUEST_ID,
        summary: "Modify the recorded contract fixture",
        approval_command,
        approval_expires_at: "2026-08-25T06:10:00.000Z",
      }));
      expect(NativeHookOutputSchema.safeParse(JSON.parse(rendered)).success).toBe(true);
      expect(rendered.split(approval_command)).toHaveLength(3);
    }
  });

  it("catches ALLOW rendering that reinstates a native permission override", async () => {
    const codecs = await loadCodecs();
    for (const adapter of ["claude", "codex"] as const) {
      expect(JSON.stringify(codec(codecs, adapter).renderPreTool({
        decision: "ALLOW",
        operation_id: "op-018f21e0-7b2c-7a00-8000-000000000004",
        summary: "Inspect adapter contract",
        execution_boundary: "hook",
      }))).not.toContain("permissionDecision");
    }
  });

  it("catches post-tool correlation loss by preserving the exact native tool_use_id", async () => {
    const codecs = await loadCodecs();
    for (const adapter of ["claude", "codex"] as const) {
      const native = fixtureJson(adapter, "post-tool-edit");
      const decoded = codec(codecs, adapter).decode("PostToolUse", native);
      expect(decoded).toMatchObject({ tool_use_id: native.tool_use_id });
    }
  });

  it("catches hostile fixture drift by failing closed for unknown events, event mismatch, missing prompts, unlock suffixes, malformed tool input, and protocol versions", async () => {
    const codecs = await loadCodecs();
    for (const adapter of ["claude", "codex"] as const) {
      const pre = fixtureJson(adapter, "pre-tool-edit");
      const prompt = fixtureJson(adapter, "user-prompt-submit");
      const eventUnknown = { ...pre, hook_event_name: "UnknownEvent" };
      const eventMismatch = { ...pre, hook_event_name: "PostToolUse" };
      const noPrompt = Object.fromEntries(Object.entries(prompt).filter(([key]) => key !== "prompt"));
      const extraUnlock = { ...prompt, prompt: `/jhw:unlock ${REQUEST_ID}\nextra` };
      const malformedTool = { ...pre, tool_input: undefined };
      const protocolVersion = { ...pre, protocol_version: 2 };
      for (const hostile of [eventUnknown, eventMismatch, noPrompt, malformedTool, protocolVersion]) {
        expect(() => codec(codecs, adapter).decode(
          hostile === noPrompt ? "UserPromptSubmit" : "PreToolUse",
          hostile,
        )).toThrow();
      }
      const decoded = codec(codecs, adapter).decode("UserPromptSubmit", extraUnlock);
      expect(decoded.event === "user_prompt_submit" && exactGuardUnlockRequestId(decoded.prompt)).toBeUndefined();
    }
  });

  it("catches approval-coordinate mutation by producing a distinct permit digest for changed cwd or file path", async () => {
    const codecs = await loadCodecs();
    const root = await mkdtemp(join(tmpdir(), "hook-contract-"));
    roots.push(root);
    const other = join(root, "other");
    await mkdir(other);
    const context = await normalizationContext("codex", root);
    const native = fixtureJson("codex", "pre-tool-edit");
    const operation = (cwd: string, filePath: string): PreToolUseEvent => codec(codecs, "codex").decode("PreToolUse", {
      ...native,
      cwd,
      tool_input: { file_path: filePath, old_string: "one", new_string: "two" },
    }) as PreToolUseEvent;
    const permitted = await normalizeOperation(operation(root, join(root, "src", "example.ts")), context, KEY);
    const movedCwd = await normalizeOperation(operation(other, join(root, "src", "example.ts")), context, KEY);
    const movedFile = await normalizeOperation(operation(root, join(root, "src", "other.ts")), context, KEY);

    expect(movedCwd.digest).not.toBe(permitted.digest);
    expect(movedFile.digest).not.toBe(permitted.digest);
  });

  it("catches undocumented adapter evidence by exporting the pinned versioned fixture axes", async () => {
    const { adapterContractResults } = await loadCodecs();
    expect(adapterContractResults).toEqual({
      claude: {
        contract_version: 1,
        adapter: "claude",
        native_version: "2.1.246",
        fixture_axes: { prompt_origin: true, pre_tool_block: true, post_tool_correlation: true },
      },
      codex: {
        contract_version: 1,
        adapter: "codex",
        native_version: "0.149.1",
        fixture_axes: { prompt_origin: true, pre_tool_block: true, post_tool_correlation: true },
      },
    });
  });
});
