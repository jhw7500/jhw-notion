import { describe, expect, it, vi } from "vitest";

import { GitHubProjectClient, type GitHubRunner } from "../github-project.js";

const TASK_ID = "tsk-0198e748-3a00-7000-8000-000000000001";

class QueuedGhRunner implements GitHubRunner {
  readonly calls: Array<{ args: string[]; credential: "project" | "repo" }> = [];
  private readonly responses: unknown[] = [];

  enqueue(...responses: unknown[]): void {
    this.responses.push(...responses);
  }

  async runGh(args: string[], credential: "project" | "repo") {
    this.calls.push({ args, credential });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("QueuedGhRunner exhausted");
    return { command: "gh", args, stdout: `${JSON.stringify(response)}\n`, stderr: "", exitCode: 0 as const };
  }
}

const requiredFields = [
  { __typename: "ProjectV2SingleSelectField", id: "PVTF_status", name: "Status", dataType: "SINGLE_SELECT", options: ["proposed", "active", "paused", "completed", "cancelled"].map((name) => ({ id: `status-${name}`, name })) },
  { __typename: "ProjectV2SingleSelectField", id: "PVTF_priority", name: "Priority", dataType: "SINGLE_SELECT", options: ["P0", "P1", "P2", "P3"].map((name) => ({ id: `priority-${name}`, name })) },
  { __typename: "ProjectV2SingleSelectField", id: "PVTF_health", name: "Health", dataType: "SINGLE_SELECT", options: ["on-track", "at-risk", "blocked", "unknown"].map((name) => ({ id: `health-${name}`, name })) },
  { __typename: "ProjectV2Field", id: "PVTF_next", name: "Next Action", dataType: "TEXT" },
  { __typename: "ProjectV2Field", id: "PVTF_reviewed", name: "Last Reviewed", dataType: "DATE" },
];

function projectItem(index: number) {
  return {
    id: `PVTI_${index}`,
    isArchived: false,
    type: "ISSUE",
    content: { __typename: "Issue", id: `I_${index}` },
    status: { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "status-active", name: "active" },
    priority: { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "priority-P2", name: "P2" },
    health: { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "health-on-track", name: "on-track" },
    nextAction: { __typename: "ProjectV2ItemFieldTextValue", text: `task:${TASK_ID}` },
    lastReviewed: { __typename: "ProjectV2ItemFieldDateValue", date: "2026-08-13" },
  };
}

function connection<T>(nodes: T[], totalCount: number, hasNextPage = false, endCursor: string | null = null) {
  return { totalCount, nodes, pageInfo: { hasNextPage, endCursor } };
}

function projectPageFixture(input: {
  start?: number;
  count: number;
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
  fields?: typeof requiredFields;
}) {
  const start = input.start ?? 1;
  return {
    data: {
      user: {
        projectV2: {
          id: "PVT_project",
          updatedAt: "2026-08-13T00:00:00Z",
          fields: connection(input.fields ?? requiredFields, input.fields?.length ?? requiredFields.length),
          items: connection(
            Array.from({ length: input.count }, (_, offset) => projectItem(start + offset)),
            input.totalCount,
            input.hasNextPage,
            input.endCursor,
          ),
        },
      },
    },
  };
}

function issueFixture(index: number) {
  return {
    node_id: `I_${index}`,
    number: index,
    title: `Project ${index}`,
    body: JSON.stringify({ id: `prj-project-${index}`, objective: `Objective ${index}`, repositories: ["repo-control"] }),
    labels: [{ name: "trial" }, { name: "project-record" }],
  };
}

function catalogFixture() {
  return {
    getRepository: vi.fn(async (repoId: string) => ({ id: repoId, github_node_id: "R_repo", slug: "owner/repo" })),
    getTask: vi.fn(async (taskId: string) => ({ id: taskId })),
  };
}

function client(gh: QueuedGhRunner, catalog = catalogFixture()) {
  return new GitHubProjectClient({
    githubOwner: "owner",
    projectNumber: 7,
    registryRepository: "owner/registry",
    preflightProjectItemId: "PVTI_preflight",
    runner: gh,
    catalog,
    now: () => new Date("2026-08-13T00:00:00Z"),
  });
}

describe("GitHubProjectClient", () => {
  it("continues until hasNextPage is false and rejects totalCount mismatch", async () => {
    const gh = new QueuedGhRunner();
    const github = client(gh);
    gh.enqueue(
      projectPageFixture({ count: 100, totalCount: 101, hasNextPage: true, endCursor: "c1" }),
      projectPageFixture({ start: 101, count: 1, totalCount: 101, hasNextPage: false, endCursor: null }),
      [
        Array.from({ length: 100 }, (_, index) => issueFixture(index + 1)),
        [issueFixture(101)],
      ],
    );

    const source = await github.readAll();

    expect(source.items).toHaveLength(101);
    expect(gh.calls.filter((call) => call.credential === "project")).toHaveLength(2);
    expect(gh.calls[0]?.args.join("\n")).toContain("archivedStates: [ARCHIVED, NOT_ARCHIVED]");
    expect(gh.calls[0]?.args).not.toContain("itemCursor=c1");
    expect(gh.calls[1]?.args).toContain("itemCursor=c1");
    expect(gh.calls.filter((call) => call.credential === "repo")).toHaveLength(1);
    const issueCall = gh.calls.find((call) => call.credential === "repo");
    expect(issueCall?.args).toEqual(expect.arrayContaining(["--paginate", "--slurp", "--raw-field", "labels=trial,project-record"]));
    expect(issueCall?.args.some((arg) => arg.startsWith("page="))).toBe(false);

    const incomplete = new QueuedGhRunner();
    incomplete.enqueue(
      projectPageFixture({ count: 1, totalCount: 2, hasNextPage: false, endCursor: null }),
      [[issueFixture(1)]],
    );
    await expect(client(incomplete).readAll()).rejects.toMatchObject({ code: "INCOMPLETE_PROJECT_READ" });
  });

  it("paginates field definitions separately and rejects duplicate required fields", async () => {
    const gh = new QueuedGhRunner();
    const initial = projectPageFixture({ count: 0, totalCount: 0, hasNextPage: false, endCursor: null });
    initial.data.user.projectV2.fields = connection(requiredFields.slice(0, 4), 6, true, "fields-c1");
    const duplicate = {
      data: {
        user: {
          projectV2: {
            id: "PVT_project",
            updatedAt: "2026-08-13T00:00:00Z",
            fields: connection([requiredFields[4], { ...requiredFields[0], id: "PVTF_status_duplicate" }], 6),
          },
        },
      },
    };
    gh.enqueue(initial, duplicate);

    await expect(client(gh).readAll()).rejects.toMatchObject({ code: "INVALID_PROJECT_FIELDS" });
    expect(gh.calls[1]?.args).toContain("fieldCursor=fields-c1");
  });

  it("fails closed on a redacted source item or invalid operating-field option", async () => {
    const redacted = new QueuedGhRunner();
    const page = projectPageFixture({ count: 1, totalCount: 1, hasNextPage: false, endCursor: null });
    page.data.user.projectV2.items.nodes[0]!.content = { __typename: "Redacted" } as { __typename: string; id: string };
    redacted.enqueue(page);
    await expect(client(redacted).readAll()).rejects.toMatchObject({ code: "PROJECT_SOURCE_REDACTED" });

    const badOption = new QueuedGhRunner();
    const optionPage = projectPageFixture({ count: 1, totalCount: 1, hasNextPage: false, endCursor: null });
    optionPage.data.user.projectV2.items.nodes[0]!.priority.name = "P9";
    badOption.enqueue(optionPage);
    await expect(client(badOption).readAll()).rejects.toMatchObject({ code: "INVALID_PROJECT_ITEM" });
  });

  it("creates a verified trial Issue, attaches it, and writes all five fields", async () => {
    const gh = new QueuedGhRunner();
    const catalog = catalogFixture();
    const github = client(gh, catalog);
    const project = projectPageFixture({ count: 0, totalCount: 0, hasNextPage: false, endCursor: null });
    const issue = {
      node_id: "I_new",
      number: 77,
      title: "Example",
      body: JSON.stringify({ id: "prj-example", objective: "Prove the trial flow", repositories: ["repo-example"] }),
      labels: [{ name: "trial" }, { name: "project-record" }],
    };
    gh.enqueue(
      project,
      [[]],
      [[{
        node_id: "I_preflight",
        number: 900,
        title: "Preflight fixture",
        body: "unchanged",
        labels: [{ name: "trial" }],
      }]],
      issue,
      issue,
      { data: { addProjectV2ItemById: { item: { id: "PVTI_new" } } } },
      {
        data: {
          node: {
            __typename: "ProjectV2Item",
            id: "PVTI_new",
            type: "ISSUE",
            content: { __typename: "Issue", id: "I_new" },
            lastReviewed: null,
          },
        },
      },
      ...Array.from({ length: 5 }, () => ({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_new" } } } })),
    );

    const registered = await github.registerProject({
      project_id: "prj-example",
      title: "Example",
      objective: "Prove the trial flow",
      repo_ids: ["repo-example"],
      fields: {
        status: "proposed",
        priority: "P2",
        health: "unknown",
        next_action: "wait:select-first-task",
        last_reviewed: "2026-08-13",
      },
    });

    expect(registered).toEqual({ project_id: "prj-example", project_item_id: "PVTI_new", source_node_id: "I_new", issue_number: 77 });
    expect(catalog.getRepository).toHaveBeenCalledWith("repo-example");
    const create = gh.calls.find((call) => call.args.includes("--method") && call.args.includes("POST") && call.args.includes("repos/owner/registry/issues"));
    expect(create).toMatchObject({ credential: "repo" });
    expect(create?.args).toEqual(expect.arrayContaining([
      "-H", "X-GitHub-Api-Version: 2026-03-10",
      "--raw-field", "labels[]=trial",
      "--raw-field", "labels[]=project-record",
    ]));
    expect(gh.calls.some((call) => call.args.includes("itemId=PVTI_new"))).toBe(true);
    expect(gh.calls.filter((call) => call.args.join(" ").includes("updateProjectV2ItemFieldValue"))).toHaveLength(5);
  });

  it("fails closed on duplicate/mismatched idempotency records and invalid active Next Action", async () => {
    const mismatch = new QueuedGhRunner();
    const existing = issueFixture(1);
    existing.body = JSON.stringify({ id: "prj-example", objective: "different", repositories: ["repo-example"] });
    mismatch.enqueue(
      projectPageFixture({ count: 0, totalCount: 0, hasNextPage: false, endCursor: null }),
      [[existing]],
    );
    await expect(client(mismatch).registerProject({
      project_id: "prj-example",
      title: "Example",
      objective: "expected",
      repo_ids: ["repo-example"],
      fields: { status: "proposed", priority: "P2", health: "unknown", next_action: "wait:select", last_reviewed: "2026-08-13" },
    })).rejects.toMatchObject({ code: "PROJECT_REGISTRATION_MISMATCH" });

    const invalid = new QueuedGhRunner();
    await expect(client(invalid).registerProject({
      project_id: "prj-example",
      title: "Example",
      objective: "expected",
      repo_ids: ["repo-example"],
      fields: { status: "active", priority: "P2", health: "on-track", next_action: "wait:not-blocked", last_reviewed: "2026-08-13" },
    })).rejects.toMatchObject({ code: "INVALID_PROJECT_NEXT_ACTION" });
    expect(invalid.calls).toHaveLength(0);
  });

  it("uses the shortest active cadence but never marks completed projects stale", async () => {
    const gh = new QueuedGhRunner();
    const page = projectPageFixture({ count: 2, totalCount: 2, hasNextPage: false, endCursor: null });
    page.data.user.projectV2.items.nodes[0]!.priority.name = "P0";
    page.data.user.projectV2.items.nodes[0]!.priority.optionId = "priority-P0";
    page.data.user.projectV2.items.nodes[0]!.lastReviewed.date = "2026-08-11";
    page.data.user.projectV2.items.nodes[1]!.status.name = "completed";
    page.data.user.projectV2.items.nodes[1]!.status.optionId = "status-completed";
    page.data.user.projectV2.items.nodes[1]!.priority.name = "P0";
    page.data.user.projectV2.items.nodes[1]!.priority.optionId = "priority-P0";
    page.data.user.projectV2.items.nodes[1]!.nextAction.text = "wait:done";
    page.data.user.projectV2.items.nodes[1]!.lastReviewed.date = "2020-01-01";
    gh.enqueue(page, [[issueFixture(1), issueFixture(2)]]);

    const result = await client(gh).readAll();

    expect(result.items.map((entry) => entry.stale)).toEqual([true, false]);
  });

  it("follows slurped Link pages even when the first page is short and ignores the trial-only preflight fixture", async () => {
    const gh = new QueuedGhRunner();
    const page = projectPageFixture({ count: 2, totalCount: 3, hasNextPage: false, endCursor: null });
    page.data.user.projectV2.items.nodes.push({
      id: "PVTI_preflight",
      isArchived: false,
      type: "ISSUE",
      content: { __typename: "Issue", id: "I_preflight" },
      status: null,
      priority: null,
      health: null,
      nextAction: null,
      lastReviewed: { __typename: "ProjectV2ItemFieldDateValue", date: "2026-08-13" },
    });
    const preflightFixture = {
      node_id: "I_preflight",
      number: 900,
      title: "Preflight fixture",
      body: "unchanged",
      labels: [{ name: "trial" }],
    };
    gh.enqueue(page, [[preflightFixture, issueFixture(1)], [issueFixture(2)]]);

    const result = await client(gh).readAll();

    expect(result.items.map((entry) => entry.project_id)).toEqual(["prj-project-1", "prj-project-2"]);
    expect(gh.calls.filter((call) => call.credential === "repo")).toHaveLength(1);
  });

  it("fails closed without creating a duplicate when an exact interrupted record is missing project-record", async () => {
    const gh = new QueuedGhRunner();
    const partial = {
      node_id: "I_partial",
      number: 77,
      title: "Example",
      body: JSON.stringify({ id: "prj-example", objective: "Prove the trial flow", repositories: ["repo-example"] }),
      labels: [{ name: "trial" }],
    };
    gh.enqueue(
      projectPageFixture({ count: 0, totalCount: 0, hasNextPage: false, endCursor: null }),
      [[]],
      [[partial]],
    );

    const error = await client(gh).registerProject({
      project_id: "prj-example",
      title: "Example",
      objective: "Prove the trial flow",
      repo_ids: ["repo-example"],
      fields: { status: "proposed", priority: "P2", health: "unknown", next_action: "wait:select", last_reviewed: "2026-08-13" },
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "PROJECT_RECORD_LABEL_RECOVERY_REQUIRED",
      details: { issue_number: 77, missing_labels: ["project-record"] },
    });
    expect(gh.calls.some((call) => call.args.includes("POST") && call.args.includes("repos/owner/registry/issues"))).toBe(false);
  });
});
