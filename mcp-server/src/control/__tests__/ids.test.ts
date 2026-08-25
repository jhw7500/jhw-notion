import { describe, expect, it } from "vitest";
import {
  newClaimId,
  newOperationId,
  newProjectId,
  newRepositoryId,
  newRequestId,
  newTaskId,
  sourceIndexKey,
} from "../ids.js";

describe("registry identifiers", () => {
  it("creates RFC 9562 UUIDv7 IDs with prefixes", () => {
    expect(newTaskId(1_723_516_800_000)).toMatch(
      /^tsk-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(newClaimId(1_723_516_800_000)).toMatch(/^clm-.*-7.*$/);
    expect(newRequestId(1_723_516_800_000)).toMatch(
      /^req-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(newOperationId(1_723_516_800_000)).toMatch(
      /^op-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("creates distinct lowercase request and operation identifiers", () => {
    const requestIds = new Set(Array.from({ length: 32 }, () => newRequestId()));
    const operationIds = new Set(Array.from({ length: 32 }, () => newOperationId()));

    expect(requestIds.size).toBe(32);
    expect(operationIds.size).toBe(32);
    for (const id of [...requestIds, ...operationIds]) expect(id).toBe(id.toLowerCase());
  });

  it("encodes immutable source IDs as path-safe keys", () => {
    expect(sourceIndexKey("I_kwDOAb+/=")).toBe("SV9rd0RPQWIrLz0");
  });

  it("validates canonical project and repository slugs", () => {
    expect(newProjectId("wlan-platform")).toBe("prj-wlan-platform");
    expect(newRepositoryId("wlan-package")).toBe("repo-wlan-package");
    expect(() => newProjectId("Bad_slug")).toThrow();
    expect(() => newRepositoryId("a")).toThrow();
  });
});
