import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ShellClassificationError,
  classifyShell,
  detectGuardSelfApproval,
  isClaimFreeGuardStatusCommand,
  type ShellClassifierContext,
} from "../shell-classifier.js";

const repository = { kind: "repository" as const, id: "repo-wlan-package" };
const issue = { kind: "issue" as const, id: "I_kwDOAb-123" };
const board = { kind: "board" as const, id: "board-alpha" };
const scopedStatusSession = "codex-guard-task";
const argvMarker = "__JHW_BASH_ARGV__";
const historyInjectionMarker = "__JHW_HISTORY_INJECTED__";

const nonBashWhitespace = [
  ["vertical tab", "\u000b"],
  ["form feed", "\u000c"],
  ["no-break space", "\u00a0"],
  ["ogham space mark", "\u1680"],
  ["en quad", "\u2000"],
  ["em quad", "\u2001"],
  ["en space", "\u2002"],
  ["em space", "\u2003"],
  ["three-per-em space", "\u2004"],
  ["four-per-em space", "\u2005"],
  ["six-per-em space", "\u2006"],
  ["figure space", "\u2007"],
  ["punctuation space", "\u2008"],
  ["thin space", "\u2009"],
  ["hair space", "\u200a"],
  ["line separator", "\u2028"],
  ["paragraph separator", "\u2029"],
  ["narrow no-break space", "\u202f"],
  ["medium mathematical space", "\u205f"],
  ["ideographic space", "\u3000"],
  ["byte-order mark", "\ufeff"],
] as const;

const inertHistorySources = [
  {
    name: "single-quoted bang",
    source: "jhw-control guard status --session 'single!session'",
    coordinate: "single!session",
  },
  {
    name: "backslash-escaped bang",
    source: "jhw-control guard status --session escaped\\!session",
    coordinate: "escaped!session",
  },
  {
    name: "double-quoted backslash bang",
    source: 'jhw-control guard status --session "double\\!session"',
    coordinate: "double\\!session",
  },
  {
    name: "single-quoted semicolon",
    source: "jhw-control guard status --session 'quoted;session'",
    coordinate: "quoted;session",
  },
  {
    name: "backslash-escaped semicolon",
    source: "jhw-control guard status --session escaped\\;session",
    coordinate: "escaped;session",
  },
] as const;

const activeHistorySources = [
  ["unquoted bang", "jhw-control guard status --session active!missing"],
  ["double-quoted bang", 'jhw-control guard status --session "active!missing"'],
  ["unquoted double bang", "jhw-control guard status --session !!"],
] as const;

const fixedArgvOracleSources = new Set([
  `jhw-control guard status --session ${scopedStatusSession}`,
  `jhw-control\tguard\tstatus\t--session\t${scopedStatusSession}`,
  ...nonBashWhitespace.map(([, separator]) =>
    `jhw-control${separator}guard status --session ${scopedStatusSession}`),
  ...inertHistorySources.map(({ source }) => source),
]);

const fixedHistoryOracleSources = new Set<string>([
  ...inertHistorySources.map(({ source }) => source),
  ...activeHistorySources.map(([, source]) => source),
]);

function bashOracleEnvironment(directory: string, historyName: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    TERM: "dumb",
    HISTFILE: join(directory, historyName),
    HISTSIZE: "32",
    HISTFILESIZE: "32",
    PS1: "",
    PS2: "",
    PROMPT_COMMAND: "",
  };
}

function markedArgv(stdout: string): string[] {
  return stdout.split("\n")
    .filter((line) => line.startsWith(argvMarker))
    .map((line) => line.slice(argvMarker.length));
}

function runFixedBashArgvOracle(source: string, directory: string): string[] {
  if (!fixedArgvOracleSources.has(source)) throw new Error("unreviewed Bash argv oracle source");
  const script = [
    `set -- ${source}`,
    `for argument in "$@"; do printf '${argvMarker}%s\\n' "$argument"; done`,
    "",
  ].join("\n");
  const result = spawnSync("bash", ["--noprofile", "--norc"], {
    cwd: directory,
    env: bashOracleEnvironment(directory, "argv-oracle.history"),
    input: script,
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("fixed Bash argv oracle failed");
  return markedArgv(result.stdout);
}

function runFixedHistoryOracle(
  source: string,
  directory: string,
): { argv: string[]; stdout: string; stderr: string } {
  if (!fixedHistoryOracleSources.has(source)) throw new Error("unreviewed Bash history oracle source");
  const script = [
    "history -c",
    `history -s 'fixed-session; printf "${historyInjectionMarker}\\n"'`,
    `set -- ${source}`,
    `for argument in "$@"; do printf '${argvMarker}%s\\n' "$argument"; done`,
    "exit",
    "",
  ].join("\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-H", "-i"], {
    cwd: directory,
    env: bashOracleEnvironment(directory, "history-oracle.history"),
    input: script,
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("fixed Bash history oracle failed");
  return { argv: markedArgv(result.stdout), stdout: result.stdout, stderr: result.stderr };
}

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

  it.each([
    ["ASCII space", " "],
    ["ASCII tab", "\t"],
  ] as const)("matches Bash argv for %s scoped-status separators", (_name, separator) => {
    const source = separator === " "
      ? `jhw-control guard status --session ${scopedStatusSession}`
      : `jhw-control\tguard\tstatus\t--session\t${scopedStatusSession}`;

    expect(runFixedBashArgvOracle(source, root)).toEqual([
      "jhw-control",
      "guard",
      "status",
      "--session",
      scopedStatusSession,
    ]);
    expect(isClaimFreeGuardStatusCommand(source)).toBe(true);
  });

  it.each(nonBashWhitespace)(
    "does not reconstruct %s as a Bash scoped-status separator",
    (_name, separator) => {
      const source = `jhw-control${separator}guard status --session ${scopedStatusSession}`;

      expect(runFixedBashArgvOracle(source, root)).toEqual([
        `jhw-control${separator}guard`,
        "status",
        "--session",
        scopedStatusSession,
      ]);
      expect(isClaimFreeGuardStatusCommand(source)).toBe(false);
    },
  );

  it.each([
    ["newline", "\n"],
    ["carriage return", "\r"],
  ] as const)("keeps shell %s command boundaries ambiguous", (_name, separator) => {
    const source = `jhw-control${separator}guard status --session ${scopedStatusSession}`;
    expect(isClaimFreeGuardStatusCommand(source)).toBe(false);
  });

  it.each(inertHistorySources)(
    "preserves Bash argv for an inert $name coordinate",
    ({ source, coordinate }) => {
      const oracle = runFixedHistoryOracle(source, root);

      expect(oracle.stdout).not.toContain(historyInjectionMarker);
      expect(oracle.argv).toEqual(["jhw-control", "guard", "status", "--session", coordinate]);
      expect(isClaimFreeGuardStatusCommand(source)).toBe(true);
    },
  );

  it.each(activeHistorySources.slice(0, 2))(
    "rejects a history-active %s coordinate",
    (_name, source) => {
      const oracle = runFixedHistoryOracle(source, root);

      expect(oracle.stderr).toContain("event not found");
      expect(isClaimFreeGuardStatusCommand(source)).toBe(false);
    },
  );

  it("rejects a double-bang coordinate that deterministic Bash history expands into injected source", () => {
    const source = activeHistorySources[2][1];
    const oracle = runFixedHistoryOracle(source, root);

    expect(oracle.stdout).toContain(historyInjectionMarker);
    expect(oracle.argv).toEqual(["jhw-control", "guard", "status", "--session", "fixed-session"]);
    expect(isClaimFreeGuardStatusCommand(source)).toBe(false);
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

  it("keeps every high-risk detection when shell syntax is ambiguous", async () => {
    const result = await classifyShell(
      "bash -c 'git push origin HEAD; gh issue comment 42 --body ok; ssh target.example reboot'",
      context,
    );

    expect(result.ambiguous).toBe(true);
    expect(result.requirements).toEqual([
      { capability: "git.publish", resource: repository },
      { capability: "shell.unclassified", resource: repository },
    ]);
    expect(result.unresolved_signals).toContainEqual({ capability: "tracker.mutate", boundary: "tracker" });
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
      "env MODE=safe ./prefixed.sh",
      "env -i MODE=safe ./prefixed.sh",
      "env --unset UNUSED MODE=safe ./prefixed.sh",
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

  it("retains high-risk evidence from attached GNU env split-string options", async () => {
    const git = await classifyShell("env -SGIT_DIR=/tmp/other/.git\\ git\\ commit\\ -m\\ escaped", context);
    const remote = await classifyShell("env -Sssh\\ target.example", context);
    const combined = await classifyShell("env -iSssh\\ target.example", context);

    expect(git.requirements).not.toContainEqual({ capability: "git.commit", resource: repository });
    expect(git.unresolved_signals).toContainEqual({
      capability: "git.commit",
      boundary: "guarded_command",
    });
    for (const result of [remote, combined]) {
      expect(result.unresolved_signals).toContainEqual({
        capability: "remote.execute",
        boundary: "guarded_command",
      });
      expect(result.direct_high_risk).toBe(true);
      expect(result.script_content_sha256).toBeUndefined();
    }
  });

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
