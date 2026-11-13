import { describe, expect, it, vi } from "vitest";

const detector = vi.hoisted(() => ({ failure: undefined as unknown }));

vi.mock("../shell-classifier.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../shell-classifier.js")>();
  return {
    ...original,
    detectGuardSelfApproval: (input: string): boolean => {
      if (detector.failure !== undefined) throw detector.failure;
      return original.detectGuardSelfApproval(input);
    },
  };
});

import { ShellClassificationError } from "../shell-classifier.js";
import { GuardService, screenSelfApproval, type GuardServiceOptions } from "../guard-service.js";

const approval = "jhw-control guard approve req-018f21e0-7b2c-7a00-8000-000000000003";

describe("screenSelfApproval", () => {
  it.each([
    ["a benign shell command", "codex", "Bash", { command: "git status --short" }, "clear"],
    ["a self-approving shell command", "codex", "Bash", { command: approval }, "self_approval"],
    ["a self-approving command of an unclassified tool", "claude", "mcp__other__run", { command: approval }, "self_approval"],
    ["a self-approving patch body", "codex", "apply_patch", { command: approval }, "self_approval"],
    ["an input without a command", "codex", "Read", { file_path: "README.md" }, "clear"],
    ["an empty command", "codex", "Bash", { command: "" }, "clear"],
    ["a shell command above the scan bound", "codex", "Bash", { command: `printf ${"a".repeat(65 * 1024)}` }, "unscannable"],
    ["a patch body above the scan bound", "codex", "apply_patch", { command: "a".repeat(65 * 1024) }, "clear"],
    ["a non-string command of a shell tool", "codex", "Bash", { command: 7 }, "invalid_command"],
    ["a non-string command of a file read", "codex", "Read", { file_path: "README.md", command: 7 }, "clear"],
    ["a non-string command of a Notion mutation", "codex", "jhw_note", { title: "x", command: 7 }, "clear"],
    ["a non-string command of a tracker mutation", "codex", "github_issue_edit", { issue_node_id: "I_x", command: 7 }, "clear"],
    ["a non-string command of an unclassified tool", "codex", "mcp__other__run", { command: 7 }, "clear"],
    ["a non-string command of a patch tool", "codex", "apply_patch", { command: 7 }, "clear"],
    ["a string tool_input", "codex", "functions.apply_patch", "*** Begin Patch", "unreadable"],
    ["an array tool_input", "codex", "Bash", [], "unreadable"],
    ["a null tool_input", "codex", "Bash", null, "unreadable"],
    ["a missing tool_input", "codex", "Bash", undefined, "unreadable"],
  ] as const)("returns the verdict for %s", (_label, adapter, toolName, toolInput, expected) => {
    expect(screenSelfApproval(adapter, toolName, toolInput)).toBe(expected);
  });

  it("reports an unreadable tool name", () => {
    expect(screenSelfApproval("codex", undefined, { command: "true" })).toBe("unreadable");
  });

  it("treats a detector failure as not clear", () => {
    try {
      detector.failure = new TypeError("detector bug");
      expect(screenSelfApproval("codex", "Bash", { command: "git status" })).toBe("unscannable");
      expect(screenSelfApproval("codex", "apply_patch", { command: "x" })).toBe("unscannable");
      detector.failure = new ShellClassificationError("invalid_shell_input");
      expect(screenSelfApproval("codex", "Bash", { command: "git status" })).toBe("unscannable");
      expect(screenSelfApproval("codex", "apply_patch", { command: "x" })).toBe("clear");
    } finally {
      detector.failure = undefined;
    }
  });

  describe("enforce output of the early screen", () => {
    // The screen runs before the tool resolves, so none of these need any Guard dependency.
    const evaluate = (toolName: string, toolInput: unknown, options: Partial<GuardServiceOptions> = {}) =>
      new GuardService(options as GuardServiceOptions).evaluatePreTool({
        protocol_version: 1, adapter: "codex", event: "pre_tool_use", session_id: "sess-018f21e0-7b2c-7a00-8000-000000000001",
        cwd: "/srv/worktrees/screen", tool_name: toolName, tool_input: toolInput, tool_use_id: "call-screen",
      });
    const large = `printf ${"a".repeat(65 * 1024)}`;

    it("reports self-approval for a malformed input or an invalid mode instead of GUARD_UNAVAILABLE", async () => {
      await expect(evaluate("Bash", { command: approval, cwd: "/elsewhere" }))
        .resolves.toMatchObject({ decision: "DENY", code: "GUARD_SELF_APPROVAL_DENIED" });
      await expect(evaluate("Bash", { command: approval }, { mode: "bogus" as never }))
        .resolves.toMatchObject({ decision: "DENY", code: "GUARD_SELF_APPROVAL_DENIED" });
    });

    it("reports GUARD_PROTOCOL_MISMATCH for an unscannable command of a malformed input or an invalid mode", async () => {
      await expect(evaluate("Bash", { command: large, cwd: "/elsewhere" }))
        .resolves.toMatchObject({ decision: "DENY", code: "GUARD_PROTOCOL_MISMATCH" });
      await expect(evaluate("Bash", { command: large }, { mode: "bogus" as never }))
        .resolves.toMatchObject({ decision: "DENY", code: "GUARD_PROTOCOL_MISMATCH" });
    });

    it("denies with GUARD_PROTOCOL_MISMATCH when the detector fails with an error that is not a ShellClassificationError", async () => {
      try {
        detector.failure = new TypeError("detector bug");
        await expect(evaluate("Bash", { command: "git status" }))
          .resolves.toMatchObject({ decision: "DENY", code: "GUARD_PROTOCOL_MISMATCH" });
      } finally {
        detector.failure = undefined;
      }
    });
  });
});
