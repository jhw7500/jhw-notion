import { describe, expect, it } from "vitest";

import { createSensitiveDataPolicy } from "../sensitive-data.js";

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
});
