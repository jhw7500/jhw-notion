import { describe, expect, it } from "vitest";

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
      "<div>safe HTML</div>",
    ])).not.toThrow();
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
});
