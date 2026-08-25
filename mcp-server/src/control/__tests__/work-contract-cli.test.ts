import { describe, expect, it } from "vitest";

import { ControlError } from "../errors.js";
import {
  parseContractIntentFlags,
  parseRequiredForParentFlag,
  parseTaskCompletionEvidenceFlags,
  parseWorkContractFlags,
} from "../work-contract-cli.js";

const TASK_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000001";
const CHILD_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000002";
const OTHER_TASK_ID = "tsk-018f21e0-7b2c-7a00-8000-000000000003";

function invalidCli(call: () => unknown): void {
  try {
    call();
    throw new Error("expected parser to reject input");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ControlError);
    expect(cause).toMatchObject({ code: "INVALID_CLI_ARGUMENT" });
  }
}

describe("Work Contract CLI parsing", () => {
  it("parses and normalizes exact grant and dependency fields through the Work Contract schema", () => {
    const contract = parseWorkContractFlags(TASK_ID, [
      "repo.modify:repository:repo-wlan-package:shared",
      "git.commit:repository:repo-wlan-package:shared",
    ], [
      `observes:${OTHER_TASK_ID}`,
      `blocked_by:${CHILD_ID}`,
    ]);

    expect(contract).toEqual({
      version: 1,
      task_id: TASK_ID,
      grants: [
        {
          capability: "git.commit",
          resource: { kind: "repository", id: "repo-wlan-package" },
          coordination: "shared",
        },
        {
          capability: "repo.modify",
          resource: { kind: "repository", id: "repo-wlan-package" },
          coordination: "shared",
        },
      ],
      dependencies: [
        { relation: "blocked_by", task_id: CHILD_ID },
        { relation: "observes", task_id: OTHER_TASK_ID },
      ],
    });
  });

  it("deduplicates only byte-identical repeated grants before schema validation", () => {
    const repeated = "repo.modify:repository:repo-wlan-package:shared";

    expect(parseContractIntentFlags([repeated, repeated], []).grants).toEqual([{
      capability: "repo.modify",
      resource: { kind: "repository", id: "repo-wlan-package" },
      coordination: "shared",
    }]);
    invalidCli(() => parseContractIntentFlags([
      repeated,
      "repo.modify:repository:repo-wlan-package:exclusive",
    ], []));
  });

  it.each([
    "repo.modify:repository:repo-wlan-package",
    "repo.modify:repository:repo-wlan-package:shared:extra",
    "repo.modify::repo-wlan-package:shared",
    ":repository:repo-wlan-package:shared",
    "repo.modify:repository::shared",
    "repo.modify:repository:repo-wlan-package:",
    "shell.unclassified:repository:repo-wlan-package:shared",
    "tracker.mutate:repository:repo-wlan-package:shared",
  ])("rejects malformed or non-persistable grant %s", (grant) => {
    invalidCli(() => parseContractIntentFlags([grant], []));
  });

  it.each([
    `blocked_by:${OTHER_TASK_ID}:extra`,
    `:${OTHER_TASK_ID}`,
    "blocked_by:",
    `requires:${OTHER_TASK_ID}`,
    "blocked_by:tsk-not-canonical",
  ])("rejects malformed dependency %s", (dependency) => {
    invalidCli(() => parseContractIntentFlags([
      "repo.modify:repository:repo-wlan-package:shared",
    ], [dependency]));
  });

  it("preserves repeated dependencies for the authoritative schema to decide", () => {
    const dependency = `observes:${OTHER_TASK_ID}`;
    expect(parseContractIntentFlags([
      "repo.modify:repository:repo-wlan-package:shared",
    ], [dependency, dependency]).dependencies).toEqual([
      { relation: "observes", task_id: OTHER_TASK_ID },
      { relation: "observes", task_id: OTHER_TASK_ID },
    ]);
  });

  it("accepts only exact required-for-parent boolean literals", () => {
    expect(parseRequiredForParentFlag("true")).toBe(true);
    expect(parseRequiredForParentFlag("false")).toBe(false);
    for (const value of ["TRUE", "False", "1", "yes", " true", "true "]) {
      invalidCli(() => parseRequiredForParentFlag(value));
    }
  });

  it("parses structured completion evidence without deriving it from outcome text", () => {
    expect(parseTaskCompletionEvidenceFlags(
      ["host tests pass", "integration smoke passes"],
      [`${CHILD_ID}:accepted-risk`],
    )).toEqual({
      integration_validation: ["host tests pass", "integration smoke passes"],
      child_dispositions: [{ task_id: CHILD_ID, disposition: "accepted-risk" }],
    });
  });

  it.each([
    `${CHILD_ID}`,
    `${CHILD_ID}:accepted-risk:extra`,
    `:accepted-risk`,
    `${CHILD_ID}:`,
    `${CHILD_ID}:ignored`,
    "tsk-not-canonical:accepted-risk",
  ])("rejects malformed child disposition %s", (disposition) => {
    invalidCli(() => parseTaskCompletionEvidenceFlags(["integration passes"], [disposition]));
  });

  it("does not silently deduplicate child dispositions", () => {
    invalidCli(() => parseTaskCompletionEvidenceFlags(
      ["integration passes"],
      [`${CHILD_ID}:superseded`, `${CHILD_ID}:superseded`],
    ));
  });
});
