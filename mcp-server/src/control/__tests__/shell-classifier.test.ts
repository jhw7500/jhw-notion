import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ShellClassificationError,
  classifyShell,
  detectGuardSelfApproval,
  type ShellClassifierContext,
} from "../shell-classifier.js";
import * as shellClassifierModule from "../shell-classifier.js";

const repository = { kind: "repository" as const, id: "repo-wlan-package" };
const issue = { kind: "issue" as const, id: "I_kwDOAb-123" };
const board = { kind: "board" as const, id: "board-alpha" };
const unsupportedExecutingEnvCases = [
  {
    name: "attached split string",
    command: "env -Sbash ./unsupported-env.sh",
    argv: ["-Sbash", "./unsupported-env.sh"],
  },
  {
    name: "attached unset",
    command: "env -uPATH bash ./unsupported-env.sh",
    argv: ["-uPATH", "bash", "./unsupported-env.sh"],
  },
  {
    name: "debug",
    command: "env --debug bash ./unsupported-env.sh",
    argv: ["--debug", "bash", "./unsupported-env.sh"],
  },
  {
    name: "verbose",
    command: "env -v bash ./unsupported-env.sh",
    argv: ["-v", "bash", "./unsupported-env.sh"],
  },
  {
    name: "signal handling",
    command: "env --block-signal=PIPE bash ./unsupported-env.sh",
    argv: ["--block-signal=PIPE", "bash", "./unsupported-env.sh"],
  },
  {
    name: "combined short options",
    command: "env -iv bash ./unsupported-env.sh",
    argv: ["-iv", "bash", "./unsupported-env.sh"],
  },
  {
    name: "legacy bare dash",
    command: "env - bash ./unsupported-env.sh",
    argv: ["-", "bash", "./unsupported-env.sh"],
  },
] as const;

const unsupportedNonExecutingEnvCases = [
  "env --definitely-unsupported bash ./unsupported-env.sh",
  "env --unset= bash ./unsupported-env.sh",
] as const;

describe("conservative shell classification", () => {
  let root: string;
  let cwd: string;
  let context: ShellClassifierContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "guard-shell-"));
    cwd = join(root, "subdir");
    await mkdir(cwd);
    await mkdir(join(root, ".git"));
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

  it("binds Git effective-directory options only when they resolve to the trusted repository", async () => {
    for (const command of [
      `git -C ${root} commit -m bounded`,
      "git -C . commit -m bounded",
      `git --git-dir=${join(root, ".git")} --work-tree=${root} commit -m bounded`,
    ]) {
      const result = await classifyShell(command, context);
      expect(result.requirements).toContainEqual({ capability: "git.commit", resource: repository });
      expect(result.unresolved_signals).not.toContainEqual({
        capability: "git.commit",
        boundary: "guarded_command",
      });
    }
  });

  it("does not attach the current repository to external Git effective targets", async () => {
    const outside = await mkdtemp(join(tmpdir(), "guard-shell-outside-"));
    await mkdir(join(outside, ".git"));
    try {
      for (const command of [
        `git -C ${outside} commit -m bounded`,
        `git --git-dir=${join(outside, ".git")} --work-tree=${outside} commit -m bounded`,
      ]) {
        const result = await classifyShell(command, context);
        expect(result.requirements).not.toContainEqual({ capability: "git.commit", resource: repository });
        expect(result.unresolved_signals).toContainEqual({
          capability: "git.commit",
          boundary: "guarded_command",
        });
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("fails closed for dynamic, missing, or incomplete Git effective targets", async () => {
    for (const command of [
      'git -C "$TARGET" commit -m bounded',
      'git -C"$TARGET" commit -m bounded',
      "git -C missing-directory commit -m bounded",
      "git --git-dir commit -m bounded",
      "git --work-tree=/srv/other commit -m bounded",
    ]) {
      const result = await classifyShell(command, context);
      expect(result.requirements).not.toContainEqual({ capability: "git.commit", resource: repository });
      expect(result.unresolved_signals).toContainEqual({
        capability: "git.commit",
        boundary: "guarded_command",
      });
    }
  });

  it("does not let environment overrides or bare mode redirect repository authority", async () => {
    const outside = await mkdtemp(join(tmpdir(), "guard-shell-env-outside-"));
    await mkdir(join(outside, ".git"));
    try {
      for (const command of [
        `GIT_DIR=${join(outside, ".git")} git commit -m bounded`,
        `env GIT_WORK_TREE=${outside} git commit -m bounded`,
        'GIT_DIR="$TARGET" git commit -m bounded',
        "cd /srv/other && git commit -m bounded",
        "git --bare commit -m bounded",
        "GH_REPO=cli/cli gh pr create --title bounded",
        'env GH_REPO="$TARGET" gh pr create --title bounded',
        "env GH_HOST=github.example gh pr create --title bounded",
        "gh --hostname github.example pr create --title bounded",
      ]) {
        const result = await classifyShell(command, context);
        const capability = command.includes("gh ") ? "git.publish" : "git.commit";
        expect(result.requirements.map((requirement) => requirement.capability)).not.toContain(capability);
        expect(result.unresolved_signals).toContainEqual({ capability, boundary: "guarded_command" });
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not treat PATH-selected or local lookalike executables as canonical Git", async () => {
    const lookalike = join(cwd, "git");
    const content = "#!/bin/sh\necho not-git\n";
    await writeFile(lookalike, content, { mode: 0o700 });

    for (const command of [
      `PATH=${cwd} git commit -m bounded`,
      "env -i git commit -m bounded",
      "./git commit -m bounded",
    ]) {
      const result = await classifyShell(command, context);
      expect(result.requirements.map((requirement) => requirement.capability)).not.toContain("git.commit");
      expect(result.unresolved_signals).toContainEqual({
        capability: "git.commit",
        boundary: "guarded_command",
      });
    }
    const local = await classifyShell("./git commit -m bounded", context);
    expect(local.script_content_sha256).toBe(createHash("sha256").update(content).digest("hex"));
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
  ])("keeps tracker command %s unresolved until the authoritative tracker resolver", async (command) => {
    const result = await classifyShell(command, context);

    expect(result.requirements.map((requirement) => requirement.capability)).not.toContain("tracker.mutate");
    expect(result.unresolved_signals).toContainEqual({ capability: "tracker.mutate", boundary: "tracker" });
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

  it("applies high-risk and self-approval detection to quote-composed executable argv", async () => {
    const remote = await classifyShell("s's'h target.example uname -a", context);
    const selfApproval = await classifyShell(
      "jhw-control g'u'ard approve req-018f21e0-7b2c-7a00-8000-000000000003",
      context,
    );

    expect(remote.unresolved_signals).toContainEqual({
      capability: "remote.execute",
      boundary: "guarded_command",
    });
    expect(remote.direct_high_risk).toBe(true);
    expect(selfApproval.self_approval).toBe(true);
  });

  it("exposes the bounded central lexical self-approval detector without filesystem context", () => {
    expect(detectGuardSelfApproval(
      "jhw-control g'u'ard consume req-018f21e0-7b2c-7a00-8000-000000000003",
    )).toBe(true);
    expect(detectGuardSelfApproval("git status --short")).toBe(false);
    expect(detectGuardSelfApproval("x".repeat(70 * 1024))).toBe(false);
  });

  it.each([
    ["gh --repo cli/cli pr create --title bounded", "git.publish", "guarded_command"],
    ["gh -R cli/cli issue close 999", "tracker.mutate", "tracker"],
  ] as const)("retains installed-valid gh global-option form %s as unresolved high risk", async (
    command,
    capability,
    boundary,
  ) => {
    const result = await classifyShell(command, context);
    expect(result.unresolved_signals).toContainEqual({ capability, boundary });
    expect(result.requirements.map((requirement) => requirement.capability)).not.toContain(capability);
    expect(result.direct_high_risk).toBe(true);
  });

  it.each([
    ["gh pr --repo cli/cli create --title bounded", "git.publish", "guarded_command"],
    ["gh issue -R cli/cli close 42", "tracker.mutate", "tracker"],
    ["gh pr create --repo cli/cli --title bounded", "git.publish", "guarded_command"],
    ["gh pr --hostname github.example create --title bounded", "git.publish", "guarded_command"],
    ["gh pr create --hostname github.example --title bounded", "git.publish", "guarded_command"],
  ] as const)("keeps persistent gh target option position in %s unresolved", async (
    command,
    capability,
    boundary,
  ) => {
    const result = await classifyShell(command, context);

    expect(result.requirements.map((requirement) => requirement.capability)).not.toContain(capability);
    expect(result.unresolved_signals).toContainEqual({ capability, boundary });
    expect(result.direct_high_risk).toBe(true);
  });

  it("does not let a guard wrapper override a stricter gh target detection", async () => {
    const result = await classifyShell(
      "jhw-control guard with --task tsk-018f21e0-7b2c-7a00-8000-000000000001 --claim clm-018f21e0-7b2c-7a00-8000-000000000002 --session codex-local --origin-adapter codex -- gh pr create --repo cli/cli --title bounded",
      context,
    );

    expect(result.owned_wrapper).toBe("guard");
    expect(result.requirements).not.toContainEqual({ capability: "git.publish", resource: repository });
    expect(result.unresolved_signals).toContainEqual({
      capability: "git.publish",
      boundary: "guarded_command",
    });
    expect(result.direct_high_risk).toBe(false);
  });

  it("keeps an uninterpretable known gh executable in the high-risk boundary", async () => {
    const result = await classifyShell("gh --repo pr create --title bounded", context);

    expect(result.unresolved_signals).toContainEqual({
      capability: "git.publish",
      boundary: "guarded_command",
    });
    expect(result.direct_high_risk).toBe(true);
  });

  it("maps a simple unknown executable only to shell.unclassified", async () => {
    const result = await classifyShell("custom-tool --opaque value", context);

    expect(result.requirements).toEqual([{ capability: "shell.unclassified", resource: repository }]);
    expect(result.unresolved_signals).toEqual([]);
    expect(result.execution_boundary).toBe("hook");
    expect(result.ambiguous).toBe(false);
  });

  it("fails closed for a shell -c form instead of guessing a literal script operand", async () => {
    await expect(classifyShell(
      "bash -c 'git push origin HEAD; gh issue comment 42 --body ok; ssh target.example reboot'",
      context,
    )).rejects.toMatchObject({
      name: "ShellClassificationError",
      code: "unsafe_local_script",
    } satisfies Partial<ShellClassificationError>);
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

  it.each([
    ["shell", "bash ./literal.sh alpha"],
    ["versioned Python", "python3.12 ./literal.sh alpha"],
    ["Node", "node ./literal.sh alpha"],
    ["source", "source ./literal.sh alpha"],
    ["dot", ". ./literal.sh alpha"],
  ] as const)("hashes one non-executable literal %s script operand", async (_name, command) => {
    const script = join(cwd, "literal.sh");
    const content = "print('first')\n";
    await writeFile(script, content, { mode: 0o600 });

    const result = await classifyShell(command, context);

    expect(result.script_content_sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(result.digest_argv).toEqual(command.split(" "));
    expect(JSON.stringify(result)).not.toContain(content);
    expect(JSON.stringify(result)).not.toContain(script);
  });

  it.each([
    "bash -c true",
    "python -c pass",
    "python3 -m bounded.module",
    "node --eval bounded",
    "node --print bounded",
    "source literal.sh",
    ". literal.sh",
    "python -- ./literal.sh",
  ])("fails closed when interpreter/source syntax cannot prove one literal local script: %s", async (command) => {
    await writeFile(join(cwd, "literal.sh"), "print('bounded')\n", { mode: 0o600 });

    await expect(classifyShell(command, context)).rejects.toMatchObject({
      name: "ShellClassificationError",
      code: "unsafe_local_script",
    } satisfies Partial<ShellClassificationError>);
  });

  it("fails closed for interpreter operands that are symlinked, outside, non-regular, oversized, or multiply linked", async () => {
    const safe = join(cwd, "safe.py");
    const linked = join(cwd, "linked.py");
    const directory = join(cwd, "directory.py");
    const fifo = join(cwd, "fifo.py");
    const oversized = join(cwd, "oversized.py");
    const multiplyLinked = join(cwd, "multiply-linked.py");
    const hardLink = join(cwd, "hard-link.py");
    const outside = join(root, "..", `outside-${root.split("-").at(-1)}.py`);
    await writeFile(safe, "print('safe')\n", { mode: 0o600 });
    await symlink(safe, linked);
    await mkdir(directory);
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x61), { mode: 0o600 });
    await writeFile(multiplyLinked, "print('linked')\n", { mode: 0o600 });
    await link(multiplyLinked, hardLink);
    await writeFile(outside, "print('outside')\n", { mode: 0o600 });

    try {
      for (const command of [
        "python ./linked.py",
        "python ./directory.py",
        "python ./fifo.py",
        "python ./oversized.py",
        "python ./multiply-linked.py",
        `python ${outside}`,
      ]) {
        await expect(classifyShell(command, context), command).rejects.toMatchObject({
          name: "ShellClassificationError",
          code: "unsafe_local_script",
        } satisfies Partial<ShellClassificationError>);
      }
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("fails closed when a slash-qualified local executable has an interpreter basename", async () => {
    const interpreter = join(cwd, "python");
    const script = join(cwd, "script.py");
    await writeFile(interpreter, "#!/bin/sh\nexec python3 \"$@\"\n", { mode: 0o700 });
    await writeFile(script, "print('first')\n", { mode: 0o600 });

    await expect(classifyShell("./python ./script.py", context)).rejects.toMatchObject({
      name: "ShellClassificationError",
      code: "unsafe_local_script",
    } satisfies Partial<ShellClassificationError>);
    await writeFile(script, "print('changed')\n", { mode: 0o600 });
    await expect(classifyShell("./python ./script.py", context)).rejects.toMatchObject({
      name: "ShellClassificationError",
      code: "unsafe_local_script",
    } satisfies Partial<ShellClassificationError>);
  });

  it.each([
    "bash ./script.sh && echo composed",
    "bash $(printf ./script.sh)",
  ])("fails closed when ambiguity hides an interpreter script operand: %s", async (command) => {
    await writeFile(join(cwd, "script.sh"), "#!/bin/sh\necho bounded\n", { mode: 0o600 });

    await expect(classifyShell(command, context)).rejects.toMatchObject({
      name: "ShellClassificationError",
      code: "unsafe_local_script",
    } satisfies Partial<ShellClassificationError>);
  });

  it("detects a deterministic script path swap after the descriptor is inspected", async () => {
    const script = join(cwd, "swapped.py");
    const replacement = join(cwd, "replacement.py");
    await writeFile(script, "print('first')\n", { mode: 0o600 });
    await writeFile(replacement, "print('second')\n", { mode: 0o600 });
    const classifyForTesting = (shellClassifierModule as unknown as {
      classifyShellForTesting?: (
        input: string,
        classifierContext: ShellClassifierContext,
        hooks: { afterScriptPreStat(): Promise<void> },
      ) => Promise<unknown>;
    }).classifyShellForTesting;

    expect(classifyForTesting).toBeTypeOf("function");
    if (!classifyForTesting) return;
    await expect(classifyForTesting("python ./swapped.py", context, {
      afterScriptPreStat: async () => {
        await rename(replacement, script);
      },
    })).rejects.toMatchObject({
      name: "ShellClassificationError",
      code: "unsafe_local_script",
    } satisfies Partial<ShellClassificationError>);
  });

  it("never reads beyond the one-MiB script bound when the opened file grows", async () => {
    const script = join(cwd, "growing.py");
    await writeFile(script, "print('small')\n", { mode: 0o600 });
    const classifyForTesting = (shellClassifierModule as unknown as {
      classifyShellForTesting?: (
        input: string,
        classifierContext: ShellClassifierContext,
        hooks: { afterScriptPreStat(): Promise<void> },
      ) => Promise<unknown>;
    }).classifyShellForTesting;

    expect(classifyForTesting).toBeTypeOf("function");
    if (!classifyForTesting) return;
    await expect(classifyForTesting("python ./growing.py", context, {
      afterScriptPreStat: async () => {
        await writeFile(script, Buffer.alloc(1024 * 1024 + 1, 0x62), { mode: 0o600 });
      },
    })).rejects.toMatchObject({
      name: "ShellClassificationError",
      code: "unsafe_local_script",
    } satisfies Partial<ShellClassificationError>);
  });

  it("uses POSIX double-quote backslash rules without collapsing distinct argv", async () => {
    const preserved = await classifyShell('custom-tool "a\\q"', context);
    const plain = await classifyShell('custom-tool "aq"', context);
    const continued = await classifyShell("custom-tool \"a\\\nq\"", context);

    expect(preserved.digest_argv).toEqual(["custom-tool", "a\\q"]);
    expect(plain.digest_argv).toEqual(["custom-tool", "aq"]);
    expect(preserved.digest_argv).not.toEqual(plain.digest_argv);
    expect(continued.digest_argv).toEqual(["custom-tool", "aq"]);
  });

  it.each([
    "custom-tool *.ts",
    "custom-tool {alpha,beta}",
    "custom-tool ~/runtime-target",
    'custom-tool "$RUNTIME_TARGET"',
  ])("treats runtime expansion %s as ambiguous shell.unclassified", async (command) => {
    const result = await classifyShell(command, context);

    expect(result.ambiguous).toBe(true);
    expect(result.requirements).toContainEqual({ capability: "shell.unclassified", resource: repository });
    expect(result.digest_argv).toBeUndefined();
  });

  it("finds and hashes local scripts after assignments and env prefixes", async () => {
    const script = join(cwd, "prefixed.sh");
    const content = "#!/bin/sh\necho prefixed\n";
    await writeFile(script, content, { mode: 0o700 });
    const expected = createHash("sha256").update(content).digest("hex");

    for (const command of [
      "MODE=safe ./prefixed.sh",
      "MODE=safe env SECOND=safe ./prefixed.sh",
      "env MODE=safe ./prefixed.sh",
      "env MODE=safe -- ./prefixed.sh",
      "env -i MODE=safe ./prefixed.sh",
      "env --ignore-environment MODE=safe ./prefixed.sh",
      "env -u UNUSED MODE=safe ./prefixed.sh",
      "env --unset UNUSED MODE=safe ./prefixed.sh",
      "env --unset=UNUSED MODE=safe ./prefixed.sh",
    ]) {
      const result = await classifyShell(command, context);
      expect(result.script_content_sha256).toBe(expected);
    }
  });

  it("fails closed for an env-prefixed unsafe local script", async () => {
    const script = join(cwd, "prefixed-safe.sh");
    await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await symlink(script, join(cwd, "prefixed-linked.sh"));

    await expect(classifyShell("env MODE=safe ./prefixed-linked.sh", context)).rejects.toMatchObject({
      name: "ShellClassificationError",
      code: "unsafe_local_script",
    } satisfies Partial<ShellClassificationError>);
  });

  it("fails closed instead of resolving a local script through env chdir", async () => {
    const outside = await mkdtemp(join(tmpdir(), "guard-shell-env-chdir-"));
    const script = join(outside, "outside.sh");
    await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    try {
      for (const option of [`-C ${outside}`, `--chdir=${outside}`]) {
        await expect(classifyShell(`env ${option} ./outside.sh`, context)).rejects.toMatchObject({
          name: "ShellClassificationError",
          code: "unsafe_local_script",
        } satisfies Partial<ShellClassificationError>);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each([
    "env -SGIT_DIR=/tmp/other/.git\\ git\\ commit\\ -m\\ escaped",
    "env -Sssh\\ target.example",
    "env -iSssh\\ target.example",
  ])("fails closed for attached GNU env split strings carrying high-risk payloads: %s", async (command) => {
    await expect(classifyShell(command, context)).rejects.toMatchObject({
      name: "ShellClassificationError",
      code: "unsafe_local_script",
    } satisfies Partial<ShellClassificationError>);
  });

  it.each(unsupportedExecutingEnvCases)(
    "rejects unsupported executable-producing GNU env $name grammar after proving it reaches a script",
    async ({ command, argv }) => {
      const script = join(cwd, "unsupported-env.sh");
      await writeFile(script, "exit 47\n", { mode: 0o600 });
      const oracle = spawnSync("/usr/bin/env", argv, {
        cwd,
        env: { ...process.env },
        stdio: "ignore",
      });

      expect(oracle.status).toBe(47);
      await expect(classifyShell(command, context)).rejects.toMatchObject({
        name: "ShellClassificationError",
        code: "unsafe_local_script",
      } satisfies Partial<ShellClassificationError>);

      await writeFile(script, "exit 48\n", { mode: 0o600 });
      await expect(classifyShell(command, context)).rejects.toMatchObject({
        name: "ShellClassificationError",
        code: "unsafe_local_script",
      } satisfies Partial<ShellClassificationError>);
    },
  );

  it.each(unsupportedNonExecutingEnvCases)(
    "rejects an unsupported GNU env option token before the unclassified fallback: %s",
    async (command) => {
      await writeFile(join(cwd, "unsupported-env.sh"), "exit 49\n", { mode: 0o600 });

      await expect(classifyShell(command, context)).rejects.toMatchObject({
        name: "ShellClassificationError",
        code: "unsafe_local_script",
      } satisfies Partial<ShellClassificationError>);
    },
  );

  it("fails closed for attached or combined GNU env chdir before a local script", async () => {
    const outside = await mkdtemp(join(tmpdir(), "guard-shell-env-attached-chdir-"));
    await writeFile(join(outside, "outside.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    try {
      for (const option of [`-C${outside}`, `-iC${outside}`]) {
        await expect(classifyShell(`env ${option} ./outside.sh`, context)).rejects.toMatchObject({
          name: "ShellClassificationError",
          code: "unsafe_local_script",
        } satisfies Partial<ShellClassificationError>);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps generic guard wrappers for tracker, remote, and deployment targets unresolved", async () => {
    const prefix = "jhw-control guard with --task tsk-018f21e0-7b2c-7a00-8000-000000000001 --claim clm-018f21e0-7b2c-7a00-8000-000000000002 --session codex-local --origin-adapter codex --";
    const cases = [
      {
        command: `${prefix} gh issue comment 999 --body bounded`,
        capability: "tracker.mutate" as const,
        boundary: "tracker" as const,
      },
      {
        command: `${prefix} ssh arbitrary.example uname -a`,
        capability: "remote.execute" as const,
        boundary: "guarded_command" as const,
      },
      {
        command: `${prefix} kubectl apply -f deployment.yaml`,
        capability: "deploy.execute" as const,
        boundary: "guarded_command" as const,
      },
    ];

    for (const candidate of cases) {
      const result = await classifyShell(candidate.command, {
        ...context,
        remote_host: { kind: "remote_host", id: "rhost-alpha" },
        deployment_target: { kind: "deployment_target", id: "dpl-alpha" },
      });
      expect(result.owned_wrapper).toBe("guard");
      expect(result.requirements.map((requirement) => requirement.capability)).not.toContain(candidate.capability);
      expect(result.unresolved_signals).toContainEqual({
        capability: candidate.capability,
        boundary: candidate.boundary,
      });
    }
  });

  it("does not let a board wrapper borrow a generic remote-host context", async () => {
    const result = await classifyShell(
      "jhw-control board with --board board-alpha --mode exclusive --task tsk-018f21e0-7b2c-7a00-8000-000000000001 --claim clm-018f21e0-7b2c-7a00-8000-000000000002 --session codex-local --origin-adapter codex --purpose bounded -- ssh arbitrary.example uname -a",
      { ...context, remote_host: { kind: "remote_host", id: "rhost-alpha" } },
    );

    expect(result.requirements).toContainEqual({ capability: "board.execute", resource: board });
    expect(result.requirements).not.toContainEqual({
      capability: "remote.execute",
      resource: { kind: "remote_host", id: "rhost-alpha" },
    });
    expect(result.unresolved_signals).toContainEqual({
      capability: "remote.execute",
      boundary: "guarded_command",
    });
  });

  it("binds board-wrapped firmware only to the exact board coordinate", async () => {
    const result = await classifyShell(
      "jhw-control board with --board board-alpha --mode exclusive --task tsk-018f21e0-7b2c-7a00-8000-000000000001 --claim clm-018f21e0-7b2c-7a00-8000-000000000002 --session codex-local --origin-adapter codex --purpose bounded -- flashrom -w firmware.bin",
      { ...context, firmware_target: { kind: "firmware_target", id: "fwt-unproven" } },
    );

    expect(result.requirements).toContainEqual({ capability: "firmware.change", resource: board });
    expect(result.requirements).not.toContainEqual({
      capability: "firmware.change",
      resource: { kind: "firmware_target", id: "fwt-unproven" },
    });
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
