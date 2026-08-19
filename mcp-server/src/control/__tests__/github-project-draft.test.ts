import { describe, expect, it, vi } from "vitest";

import { GitHubProjectClient, type GitHubRunner } from "../github-project.js";

const requiredFields = [
  { __typename: "ProjectV2SingleSelectField", id: "PVTF_status", name: "Status", dataType: "SINGLE_SELECT", options: ["proposed", "active", "paused", "completed", "cancelled"].map((name) => ({ id: `status-${name}`, name })) },
  { __typename: "ProjectV2SingleSelectField", id: "PVTF_priority", name: "Priority", dataType: "SINGLE_SELECT", options: ["P0", "P1", "P2", "P3"].map((name) => ({ id: `priority-${name}`, name })) },
  { __typename: "ProjectV2SingleSelectField", id: "PVTF_health", name: "Health", dataType: "SINGLE_SELECT", options: ["on-track", "at-risk", "blocked", "unknown"].map((name) => ({ id: `health-${name}`, name })) },
  { __typename: "ProjectV2Field", id: "PVTF_next", name: "Next Action", dataType: "TEXT" },
  { __typename: "ProjectV2Field", id: "PVTF_reviewed", name: "Last Reviewed", dataType: "DATE" },
];

const body = JSON.stringify({
  id: "prj-example",
  objective: "Prove the least-privilege trial flow",
  repositories: ["repo-example"],
});

function item(fields: "empty" | "complete") {
  return {
    id: "PVTI_record",
    isArchived: false,
    type: "DRAFT_ISSUE",
    content: { __typename: "DraftIssue", id: "DI_record", title: "Example", body },
    status: fields === "complete" ? { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "status-proposed", name: "proposed" } : null,
    priority: fields === "complete" ? { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "priority-P2", name: "P2" } : null,
    health: fields === "complete" ? { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "health-unknown", name: "unknown" } : null,
    nextAction: fields === "complete" ? { __typename: "ProjectV2ItemFieldTextValue", text: "wait:select-first-task" } : null,
    lastReviewed: fields === "complete" ? { __typename: "ProjectV2ItemFieldDateValue", date: "2026-08-18" } : null,
  };
}

const preflightItem = {
  id: "PVTI_preflight",
  isArchived: false,
  type: "DRAFT_ISSUE",
  content: {
    __typename: "DraftIssue",
    id: "DI_preflight",
    title: "[TRIAL] Project Control Preflight Fixture",
    body: "unchanged",
  },
  status: null,
  priority: null,
  health: null,
  nextAction: null,
  lastReviewed: null,
};

function page(items: unknown[]) {
  return {
    data: {
      user: {
        projectV2: {
          id: "PVT_project",
          public: false,
          updatedAt: "2026-08-18T00:00:00Z",
          fields: { totalCount: 5, nodes: requiredFields, pageInfo: { hasNextPage: false, endCursor: null } },
          items: { totalCount: items.length, nodes: items, pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    },
  };
}

class DraftRunner implements GitHubRunner {
  readonly calls: Array<{ args: string[]; credential: "project" | "repo" }> = [];
  private projectReads = 0;
  private created = false;

  constructor(private readonly initiallyExisting: boolean, private readonly archived = false) {}

  async runGh(args: string[], credential: "project" | "repo") {
    this.calls.push({ args, credential });
    if (credential !== "project") throw new Error("Project records must not use the repository credential");
    const joined = args.join("\n");
    let response: unknown;
    if (joined.includes("query ProjectPage")) {
      this.projectReads += 1;
      const initialRecord = item("empty");
      initialRecord.isArchived = this.archived;
      // A record only becomes visible because it exists: either it was already
      // there, or this run created it. Materialising it on the second read
      // regardless would hide whether the create actually happened.
      const present = this.initiallyExisting || this.created;
      if (!present) response = page([preflightItem]);
      else response = page([preflightItem, this.projectReads === 1 ? initialRecord : item("complete")]);
    } else if (joined.includes("addProjectV2DraftIssue")) {
      this.created = true;
      response = {
        data: {
          addProjectV2DraftIssue: {
            projectItem: {
              id: "PVTI_record",
              type: "DRAFT_ISSUE",
              content: { __typename: "DraftIssue", id: "DI_record", title: "Example", body },
            },
          },
        },
      };
    } else if (joined.includes("updateProjectV2ItemFieldValue")) {
      response = { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_record" } } } };
    } else {
      throw new Error(`Unexpected Project call: ${joined}`);
    }
    return { command: "gh", args, stdout: `${JSON.stringify(response)}\n`, stderr: "", exitCode: 0 as const };
  }
}

function client(runner: GitHubRunner) {
  return new GitHubProjectClient({
    githubOwner: "owner",
    projectNumber: 7,
    preflightProjectItemId: "PVTI_preflight",
    runner,
    catalog: {
      getRepository: vi.fn(async (id: string) => ({ id })),
      getTask: vi.fn(async (id: string) => ({ id })),
    },
    now: () => new Date("2026-08-18T00:00:00Z"),
    // The visibility window is exercised by its own tests; here it only needs
    // to not spend real seconds.
    sleep: async () => undefined,
  });
}

const input = {
  project_id: "prj-example",
  title: "Example",
  objective: "Prove the least-privilege trial flow",
  repo_ids: ["repo-example"],
  fields: {
    status: "proposed" as const,
    priority: "P2" as const,
    health: "unknown" as const,
    next_action: "wait:select-first-task",
    last_reviewed: "2026-08-18",
  },
};

describe("GitHubProjectClient DraftIssue records", () => {
  it("creates a canonical DraftIssue using only the project credential", async () => {
    const runner = new DraftRunner(false);

    await expect(client(runner).registerProject(input)).resolves.toEqual({
      project_id: "prj-example",
      project_item_id: "PVTI_record",
      source_node_id: "DI_record",
    });

    expect(runner.calls.every((call) => call.credential === "project")).toBe(true);
    expect(runner.calls.filter((call) => call.args.join(" ").includes("addProjectV2DraftIssue"))).toHaveLength(1);
    expect(runner.calls.some((call) => call.args.includes("repos/owner/registry/issues"))).toBe(false);
  });

  it("reuses one exact partial DraftIssue without creating another item", async () => {
    const runner = new DraftRunner(true);

    await expect(client(runner).registerProject(input)).resolves.toMatchObject({
      project_item_id: "PVTI_record",
      source_node_id: "DI_record",
    });

    expect(runner.calls.some((call) => call.args.join(" ").includes("addProjectV2DraftIssue"))).toBe(false);
    expect(runner.calls.filter((call) => call.args.join(" ").includes("updateProjectV2ItemFieldValue"))).toHaveLength(5);
  });

  it("finds an archived partial DraftIssue and never duplicates it", async () => {
    const runner = new DraftRunner(true, true);

    await expect(client(runner).registerProject(input)).resolves.toMatchObject({
      project_item_id: "PVTI_record",
      source_node_id: "DI_record",
    });

    expect(runner.calls.some((call) => call.args.join(" ").includes("addProjectV2DraftIssue"))).toBe(false);
  });
});
