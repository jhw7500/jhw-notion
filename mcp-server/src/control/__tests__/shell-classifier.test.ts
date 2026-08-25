import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ShellClassificationError,
  classifyShell,
  type ShellClassifierContext,
} from "../shell-classifier.js";

const repository = { kind: "repository" as const, id: "repo-wlan-package" };
const issue = { kind: "issue" as const, id: "I_kwDOAb-123" };
const board = { kind: "board" as const, id: "board-alpha" };

describe("conservative shell classification", () => {
  let root: string;
  let cwd: string;
  let context: ShellClassifierContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "guard-shell-"));
    cwd = join(root, "subdir");
    await mkdir(cwd);
    context = { trusted_worktree_path: root, cwd, repository, issue, board };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("maps git commit to the current canonical repository", async () => {
    const result = await classifyShell("git commit -m 'bounded message'", context);

    expect(result.requirements).toEqual([{ capability: "git.commit", resource: repository }]);
    expect(result.execution_boundary).toBe("hook");
    expect(result.risk).toBe("medium");
    expect(result.ambiguous).toBe(false);
  });

  it.each([
    "git push origin HEAD",
    "git -C . push origin HEAD",
    "gh pr create --title bounded",
    "gh pr merge 42 --merge",
    "gh release create v1.2.3",
  ])("maps publish command %s to guarded git.publish", async (command) => {
    const result = await classifyShell(command, context);

    expect(result.requirements).toContainEqual({ capability: "git.publish", resource: repository });
    expect(result.execution_boundary).toBe("guarded_command");
    expect(result.direct_high_risk).toBe(true);
  });

  it.each([
    "gh issue close 42",
    "gh issue edit 42 --title bounded",
    "gh issue comment 42 --body bounded",
  ])("maps tracker command %s to the exact issue resource", async (command) => {
    const result = await classifyShell(command, context);

    expect(result.requirements).toEqual([{ capability: "tracker.mutate", resource: issue }]);
    expect(result.execution_boundary).toBe("tracker");
    expect(result.direct_high_risk).toBe(true);
  });

  it.each([
    ["ssh target.example uname -a", "remote.execute", "guarded_command"],
    ["scp firmware.bin target.example:/tmp/", "remote.execute", "guarded_command"],
    ["jhw-control board acquire board-alpha --mode exclusive", "board.execute", "board"],
    ["flashrom -p internal -w firmware.bin", "firmware.change", "board"],
    ["dfu-util -D firmware.bin", "firmware.change", "board"],
    ["kubectl apply -f deployment.yaml", "deploy.execute", "guarded_command"],
  ] as const)("retains unresolved high-risk signal for %s", async (command, capability, boundary) => {
    const result = await classifyShell(command, {
      trusted_worktree_path: root,
      cwd,
      repository,
      issue,
    });

    expect(result.unresolved_signals).toContainEqual({ capability, boundary });
    expect(result.direct_high_risk).toBe(true);
    expect([
      ...result.requirements.map((requirement) => requirement.capability),
      ...result.unresolved_signals.map((signal) => signal.capability),
    ]).not.toEqual(["shell.unclassified"]);
  });

  it("does not turn a direct remote hostname into authority even when context has a remote resource", async () => {
    const result = await classifyShell("ssh target.example uname -a", {
      ...context,
      remote_host: { kind: "remote_host", id: "rhost-alpha" },
    });

    expect(result.requirements).not.toContainEqual({
      capability: "remote.execute",
      resource: { kind: "remote_host", id: "rhost-alpha" },
    });
    expect(result.unresolved_signals).toContainEqual({
      capability: "remote.execute",
      boundary: "guarded_command",
    });
  });

  it.each([
    "jhw-control guard prompt req-018f21e0-7b2c-7a00-8000-000000000003",
    "jhw-control guard approve req-018f21e0-7b2c-7a00-8000-000000000003",
    "jhw-control guard consume req-018f21e0-7b2c-7a00-8000-000000000003",
    "echo start && jhw-control guard approve req-018f21e0-7b2c-7a00-8000-000000000003",
  ])("marks self-approval attempt %s as a hard-deny signal", async (command) => {
    const result = await classifyShell(command, context);

    expect(result.self_approval).toBe(true);
  });

  it("maps a simple unknown executable only to shell.unclassified", async () => {
    const result = await classifyShell("custom-tool --opaque value", context);

    expect(result.requirements).toEqual([{ capability: "shell.unclassified", resource: repository }]);
    expect(result.unresolved_signals).toEqual([]);
    expect(result.execution_boundary).toBe("hook");
    expect(result.ambiguous).toBe(false);
  });

  it("keeps every high-risk detection when shell syntax is ambiguous", async () => {
    const result = await classifyShell(
      "bash -c 'git push origin HEAD; gh issue comment 42 --body ok; ssh target.example reboot'",
      context,
    );

    expect(result.ambiguous).toBe(true);
    expect(result.requirements).toEqual([
      { capability: "git.publish", resource: repository },
      { capability: "shell.unclassified", resource: repository },
      { capability: "tracker.mutate", resource: issue },
    ]);
    expect(result.unresolved_signals).toContainEqual({
      capability: "remote.execute",
      boundary: "guarded_command",
    });
    expect(result.execution_boundary).toBe("tracker");
    expect(result.direct_high_risk).toBe(true);
  });

  it.each([
    "git push origin HEAD && echo done",
    "git push origin HEAD > result.txt",
    "git push origin $(git branch --show-current)",
    "git push origin `git branch --show-current`",
    "git push origin 'unterminated",
  ])("does not treat ambiguous command %s as one simple argv", async (command) => {
    const result = await classifyShell(command, context);

    expect(result.ambiguous).toBe(true);
    expect(result.requirements).toContainEqual({ capability: "git.publish", resource: repository });
    expect(result.requirements).toContainEqual({ capability: "shell.unclassified", resource: repository });
  });

  it("unwraps only exact owned guard and board wrappers after a literal separator", async () => {
    const guard = await classifyShell(
      "jhw-control guard with --task tsk-018f21e0-7b2c-7a00-8000-000000000001 --claim clm-018f21e0-7b2c-7a00-8000-000000000002 --session codex-local --origin-adapter codex -- git push origin HEAD",
      context,
    );
    const boardWrapped = await classifyShell(
      "jhw-control board with --board board-alpha --mode exclusive --task tsk-018f21e0-7b2c-7a00-8000-000000000001 --claim clm-018f21e0-7b2c-7a00-8000-000000000002 --session codex-local --origin-adapter codex --purpose bounded -- custom-tool --opaque",
      context,
    );
    const malformed = await classifyShell("jhw-control guard with git push origin HEAD", context);

    expect(guard.owned_wrapper).toBe("guard");
    expect(guard.direct_high_risk).toBe(false);
    expect(guard.requirements).toContainEqual({ capability: "git.publish", resource: repository });
    expect(boardWrapped.owned_wrapper).toBe("board");
    expect(boardWrapped.execution_boundary).toBe("board");
    expect(boardWrapped.requirements).toContainEqual({ capability: "board.execute", resource: board });
    expect(malformed.owned_wrapper).toBeUndefined();
    expect(malformed.requirements).toContainEqual({ capability: "shell.unclassified", resource: repository });
  });

  it("does not bind a board wrapper to a different contextual board", async () => {
    const result = await classifyShell(
      "jhw-control board with --board board-beta --mode exclusive --task tsk-018f21e0-7b2c-7a00-8000-000000000001 --claim clm-018f21e0-7b2c-7a00-8000-000000000002 --session codex-local --origin-adapter codex --purpose bounded -- custom-tool",
      context,
    );

    expect(result.requirements).not.toContainEqual({ capability: "board.execute", resource: board });
    expect(result.unresolved_signals).toContainEqual({ capability: "board.execute", boundary: "board" });
  });

  it("does not trust legacy or incomplete board wrappers without Guard coordinates", async () => {
    for (const command of [
      "jhw-control board with board-alpha --mode exclusive --session codex-local -- custom-tool",
      "jhw-control board with --board board-alpha --mode exclusive --session codex-local -- custom-tool",
    ]) {
      const result = await classifyShell(command, context);
      expect(result.owned_wrapper).toBeUndefined();
      expect(result.direct_high_risk).toBe(true);
    }
  });

  it("does not let the publish wrapper stand in for the board firmware boundary", async () => {
    const result = await classifyShell(
      "jhw-control guard with --task tsk-018f21e0-7b2c-7a00-8000-000000000001 --claim clm-018f21e0-7b2c-7a00-8000-000000000002 --session codex-local --origin-adapter codex -- flashrom -w firmware.bin",
      {
        ...context,
        firmware_target: { kind: "firmware_target", id: "fwt-alpha" },
      },
    );

    expect(result.owned_wrapper).toBe("guard");
    expect(result.requirements).not.toContainEqual({
      capability: "firmware.change",
      resource: { kind: "firmware_target", id: "fwt-alpha" },
    });
    expect(result.unresolved_signals).toContainEqual({ capability: "firmware.change", boundary: "board" });
  });

  it("hashes a simple executable local script without returning its bytes", async () => {
    const script = join(cwd, "safe-script.sh");
    const content = "#!/bin/sh\necho bounded\n";
    await writeFile(script, content, { mode: 0o700 });

    const result = await classifyShell("./safe-script.sh --flag 'two words'", context);

    expect(result.script_content_sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(result.digest_argv).toEqual(["./safe-script.sh", "--flag", "two words"]);
    expect(JSON.stringify(result)).not.toContain(content);
    expect(JSON.stringify(result)).not.toContain(script);
  });

  it("fails closed for a symlink, directory, non-executable, outside, or oversized script", async () => {
    const safe = join(cwd, "safe.sh");
    const linked = join(cwd, "linked.sh");
    const nonExecutable = join(cwd, "non-executable.sh");
    const directory = join(cwd, "directory.sh");
    const outside = join(root, "..", `outside-${root.split("-").at(-1)}.sh`);
    const oversized = join(cwd, "oversized.sh");
    await writeFile(safe, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await symlink(safe, linked);
    await writeFile(nonExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    await mkdir(directory);
    await writeFile(outside, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x61), { mode: 0o700 });

    for (const command of ["./linked.sh", "./directory.sh", "./non-executable.sh", outside, "./oversized.sh"]) {
      await expect(classifyShell(command, context)).rejects.toMatchObject({
        name: "ShellClassificationError",
        code: "unsafe_local_script",
      } satisfies Partial<ShellClassificationError>);
    }
    await rm(outside, { force: true });
  });

  it("detects executable-state changes rather than trusting a path lookup", async () => {
    const script = join(cwd, "mutable.sh");
    await writeFile(script, "#!/bin/sh\necho first\n", { mode: 0o700 });
    const first = await classifyShell("./mutable.sh", context);
    await writeFile(script, "#!/bin/sh\necho second\n", { mode: 0o700 });
    await chmod(script, 0o700);
    const second = await classifyShell("./mutable.sh", context);

    expect(first.script_content_sha256).not.toBe(second.script_content_sha256);
  });
});
