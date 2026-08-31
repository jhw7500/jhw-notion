import { describe, expect, it } from "vitest";

import { createCliDependencies, runCli } from "../cli.js";
import { ControlError } from "../errors.js";
import { assertNoAbsoluteHostPaths, createSensitiveDataPolicy } from "../sensitive-data.js";

describe("SensitiveDataPolicy", () => {
  it("rejects recognized exact secrets and private absolute paths without echoing either", () => {
    const secret = "unmistakably-fake-secret-value";
    const privatePath = "/private/control/source-checkout";
    const policy = createSensitiveDataPolicy({ GH_REPO_TOKEN: secret }, [privatePath]);

    for (const value of [`prefix ${secret} suffix`, `see ${privatePath}/file.ts`]) {
      const error = (() => { try { policy.assertSafe(value); } catch (cause) { return cause; } })();
      expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(privatePath);
    }
  });

  it("ignores empty, short, and unrecognized ambient values while bounding recursive scans", () => {
    const policy = createSensitiveDataPolicy({ GH_REPO_TOKEN: "short", ORDINARY_VALUE: "ordinary-long-value" });
    expect(() => policy.assertSafe({ text: "short ordinary-long-value", nested: ["safe"] })).not.toThrow();
    expect(() => policy.assertSafe("x".repeat(300_000))).toThrowError(expect.objectContaining({ code: "SENSITIVE_SCAN_TOO_LARGE" }));
  });

  it("fails closed instead of dropping a recognized credential when the term bound is exceeded", () => {
    const credential = "unmistakably-fake-priority-credential";
    const environment: NodeJS.ProcessEnv = { GH_REPO_TOKEN: credential };
    for (let index = 0; index < 128; index += 1) {
      environment[`LONG_SECRET_${index}`] = `${"x".repeat(128)}-${index}`;
    }
    const policy = createSensitiveDataPolicy(environment);

    expect(() => policy.assertSafe(`contains ${credential}`)).toThrowError(expect.objectContaining({
      code: "SENSITIVE_SCAN_TOO_LARGE",
    }));
  });

  it.each([
    "file:///srv/private/source-checkout/file.ts",
    "file://localhost/srv/private/source-checkout/file.ts",
    "file:///%73rv/private/source-checkout/file.ts",
  ])("rejects file URI host-path form %s", (uri) => {
    expect(() => assertNoAbsoluteHostPaths(`inspect ${uri}`))
      .toThrowError(expect.objectContaining({ code: "SENSITIVE_DATA_REJECTED" }));
  });

  it.each([
    "contains,file:///srv/private/source-checkout/file.ts",
    "[file:///srv/private/source-checkout/file.ts]",
    "x;file://localhost/srv/private/source-checkout/file.ts",
  ])("rejects punctuation-framed file URI host path %s", (value) => {
    expect(() => assertNoAbsoluteHostPaths(value))
      .toThrowError(expect.objectContaining({ code: "SENSITIVE_DATA_REJECTED" }));
  });

  it("redacts file URIs from direct ControlError metadata", () => {
    const error = new ControlError("SAFE_FAILURE", "failed file:///srv/private/source", {
      evidence: "file://localhost/srv/private/source/file.ts",
    });
    expect(JSON.stringify(error)).not.toContain("file://");
    expect(error.message).not.toContain("file://");
  });

  it.each([
    "contains,/srv/private/source-checkout/file.ts",
    "[/srv/private/source-checkout/file.ts]",
    "</srv/private/source-checkout/file.ts>",
    "x;/srv/private/source-checkout/file.ts",
    "contains,C:\\private\\source-checkout\\file.ts",
  ])("rejects punctuation-framed absolute host path %s", (value) => {
    expect(() => assertNoAbsoluteHostPaths(value))
      .toThrowError(expect.objectContaining({ code: "SENSITIVE_DATA_REJECTED" }));
  });

  it("preserves URL and repository-slug text that is not a host path", () => {
    expect(() => assertNoAbsoluteHostPaths([
      "https://github.com/owner/repository/issues/1",
      "owner/repository#1",
      "docs/project-control/runbook.md",
      "<div>safe HTML",
    ])).not.toThrow();
  });

  it.each([
    "README에 목적/경계/운영 절차 3개 섹션 존재 확인",
    "지식/결정 기록은 상태 기반",
    "사이클1/3 완료",
  ])("preserves non-ASCII prose whose words are separated by slashes %s", (value) => {
    expect(() => assertNoAbsoluteHostPaths(value)).not.toThrow();
  });

  it.each([
    "정말 /srv/private/source-checkout/file.ts",
    "경로,/srv/private/source-checkout/file.ts",
    "한글</srv/private/source-checkout/file.ts>",
  ])("still rejects host paths adjacent to non-ASCII prose %s", (value) => {
    expect(() => assertNoAbsoluteHostPaths(value))
      .toThrowError(expect.objectContaining({ code: "SENSITIVE_DATA_REJECTED" }));
  });

  it.each([
    "जानकारी/मार्ग खंड",
    "ไทย์/ทาง",
  ])("preserves prose whose word ends in a combining mark before a slash %s", (value) => {
    expect(() => assertNoAbsoluteHostPaths(value)).not.toThrow();
  });

  it.each([
    "작업은 /jhw:save 로 기록",
    "/jhw:save 실행",
    "실행 순서는 /oh-my-claudecode:verify 다음에 /jhw:review",
  ])("preserves slash commands whose first segment carries a colon %s", (value) => {
    expect(() => assertNoAbsoluteHostPaths(value)).not.toThrow();
  });

  // Word-glued absolute paths are the documented false-negative boundary of
  // this heuristic in every script: configured host paths are still blocked
  // by createSensitiveDataPolicy's exact term matching.
  it.each([
    "x/home/build-user/data 참조",
    "한글/home/build-user/data 참조",
    "́/home/build-user/data 참조",
  ])("accepts word-glued paths as the documented false-negative boundary %s", (value) => {
    expect(() => assertNoAbsoluteHostPaths(value)).not.toThrow();
  });

  it.each([
    "ไทย์ /srv/private/source-checkout/file.ts",
    "mem:/proc/self/environ",
    "cmd;/jhw/absolute/segment",
    "경로는 /home:evil/jhw/private-checkout",
    "확인 /tmp:x/secret-payload",
    "PATH=/usr/bin:/usr/local/bin:/home/build-user/bin",
  ])("still rejects multi-segment paths regardless of colons %s", (value) => {
    expect(() => assertNoAbsoluteHostPaths(value))
      .toThrowError(expect.objectContaining({ code: "SENSITIVE_DATA_REJECTED" }));
  });

  it("redacts punctuation-framed host paths from direct ControlError metadata", () => {
    const privatePath = "/srv/private/source-checkout/file.ts";
    const error = new ControlError("SAFE_FAILURE", `failed,${privatePath}`, {
      evidence: `[${privatePath}]`,
      windows: "x;C:\\private\\source-checkout\\file.ts",
    });
    expect(error.message).not.toContain(privatePath);
    expect(JSON.stringify(error)).not.toContain(privatePath);
    expect(JSON.stringify(error)).not.toContain("C:\\private\\source-checkout");
  });

  it("keeps checkout-resolved status source failures to their stable error code", async () => {
    const privatePath = "/srv/private/current-checkout";
    const secret = "unmistakably-fake-current-status-secret";
    const dependencies = createCliDependencies({
      HOME: "/fixture/home",
      JHW_REGISTRY_DIR: "/fixture/registry",
      JHW_WORKTREE_ROOT: "/fixture/worktrees",
      JHW_CONTROL_STATE_DIR: "/fixture/state",
      JHW_BUILD_HOST: "fixture-host",
      JHW_GITHUB_OWNER: "fixture-owner",
      JHW_PROJECT_NUMBER: "7",
      JHW_REGISTRY_REPOSITORY: "fixture-owner/registry",
      JHW_PREFLIGHT_PROJECT_ITEM_ID: "PVTI_trial",
      JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: "1",
      GH_REPO_TOKEN: secret,
    });
    dependencies.source.withResolvedTaskStatusContext = async () => {
      throw new ControlError("CHECKOUT_ROOT_MISMATCH", `source failed at ${privatePath} with ${secret}`);
    };

    const result = await runCli([
      "task", "status",
      "--resolve-from-checkout", "true",
      "--repo-path", privatePath,
      "--origin-adapter", "codex",
      "--session", "private-session-value",
    ], {
      ...dependencies,
      journal: { append: async () => undefined },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "CHECKOUT_ROOT_MISMATCH" } });
    expect(output).not.toContain(privatePath);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("private-session-value");
  });
});
