import { describe, expect, it, vi } from "vitest";

import { GitHubProjectClient, type GitHubRunner } from "../github-project.js";
import { createSensitiveDataPolicy } from "../sensitive-data.js";

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

function connection<T>(nodes: T[], totalCount = nodes.length, hasNextPage = false, endCursor: string | null = null) {
  return { totalCount, nodes, pageInfo: { hasNextPage, endCursor } };
}

function recordBody(index: number, projectId = `prj-project-${index}`) {
  return JSON.stringify({ id: projectId, objective: `Objective ${index}`, repositories: ["repo-control"] });
}

function recordItem(index: number, projectId = `prj-project-${index}`) {
  return {
    id: `PVTI_${index}`,
    isArchived: false,
    type: "DRAFT_ISSUE",
    content: { __typename: "DraftIssue", id: `DI_${index}`, title: `Project ${index}`, body: recordBody(index, projectId) },
    status: { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "status-active", name: "active" },
    priority: { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "priority-P2", name: "P2" },
    health: { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "health-on-track", name: "on-track" },
    nextAction: { __typename: "ProjectV2ItemFieldTextValue", text: `task:${TASK_ID}` },
    lastReviewed: { __typename: "ProjectV2ItemFieldDateValue", date: "2026-08-13" },
  };
}

function preflightItem() {
  return {
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
    lastReviewed: { __typename: "ProjectV2ItemFieldDateValue", date: "2026-08-13" },
  };
}

function projectPage(input: {
  records?: ReturnType<typeof recordItem>[];
  includeFixture?: boolean;
  itemTotal?: number;
  itemNext?: boolean;
  itemCursor?: string | null;
  fields?: typeof requiredFields;
  fieldTotal?: number;
  fieldNext?: boolean;
  fieldCursor?: string | null;
  public?: boolean;
}) {
  const records = input.records ?? [];
  const nodes = [...(input.includeFixture === false ? [] : [preflightItem()]), ...records];
  return {
    data: {
      user: {
        projectV2: {
          id: "PVT_project",
          public: input.public ?? false,
          updatedAt: "2026-08-13T00:00:00Z",
          fields: connection(input.fields ?? requiredFields, input.fieldTotal ?? (input.fields?.length ?? requiredFields.length), input.fieldNext, input.fieldCursor ?? null),
          items: connection(nodes, input.itemTotal ?? nodes.length, input.itemNext, input.itemCursor ?? null),
        },
      },
    },
  };
}

function fieldPage(fields: typeof requiredFields, total: number) {
  return {
    data: {
      user: {
        projectV2: {
          id: "PVT_project",
          public: false,
          updatedAt: "2026-08-13T00:00:00Z",
          fields: connection(fields, total),
        },
      },
    },
  };
}

function preflightResponse(lastReviewed: unknown = null, content: unknown = preflightItem().content) {
  return {
    data: {
      node: {
        __typename: "ProjectV2Item",
        id: "PVTI_preflight",
        type: "DRAFT_ISSUE",
        content,
        lastReviewed,
      },
    },
  };
}

function catalogFixture() {
  return {
    getRepository: vi.fn(async (id: string) => ({ id })),
    getTask: vi.fn(async (id: string) => ({ id })),
  };
}

function client(runner: QueuedGhRunner, catalog = catalogFixture()) {
  return new GitHubProjectClient({
    githubOwner: "owner",
    projectNumber: 7,
    preflightProjectItemId: "PVTI_preflight",
    runner,
    catalog,
    now: () => new Date("2026-08-13T00:00:00Z"),
  });
}

const registration = {
  project_id: "prj-example",
  title: "Example",
  objective: "Prove the trial flow",
  repo_ids: ["repo-example"],
  fields: {
    status: "proposed" as const,
    priority: "P2" as const,
    health: "unknown" as const,
    next_action: "wait:select-first-task",
    last_reviewed: "2026-08-13",
  },
};

function registrationRecord(fields: "empty" | "complete" = "complete") {
  const record = recordItem(1, registration.project_id);
  record.content.id = "DI_registration";
  record.content.title = registration.title;
  record.content.body = JSON.stringify({
    id: registration.project_id,
    objective: registration.objective,
    repositories: registration.repo_ids,
  });
  if (fields === "empty") {
    record.status = null as never;
    record.priority = null as never;
    record.health = null as never;
    record.nextAction = null as never;
    record.lastReviewed = null as never;
  } else {
    record.status.name = registration.fields.status;
    record.status.optionId = `status-${registration.fields.status}`;
    record.priority.name = registration.fields.priority;
    record.priority.optionId = `priority-${registration.fields.priority}`;
    record.health.name = registration.fields.health;
    record.health.optionId = `health-${registration.fields.health}`;
    record.nextAction.text = registration.fields.next_action;
    record.lastReviewed.date = registration.fields.last_reviewed;
  }
  return record;
}

function draftMutation(record = registrationRecord("empty")) {
  return {
    data: { addProjectV2DraftIssue: { projectItem: {
      id: record.id,
      type: record.type,
      content: record.content,
    } } },
  };
}

const fieldMutation = { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } } };

describe("GitHubProjectClient", () => {
  it("rejects protected registration content before any GitHub call", async () => {
    const runner = new QueuedGhRunner();
    const secret = "unmistakably-fake-project-token";
    const github = new GitHubProjectClient({
      githubOwner: "owner", projectNumber: 7,
      preflightProjectItemId: "PVTI_preflight", runner, catalog: catalogFixture(),
      sensitiveData: createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
    });

    const error = await github.registerProject({ ...registration, objective: `contains ${secret}` }).catch((cause) => cause);
    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(runner.calls).toEqual([]);
  });

  it("rejects protected DraftIssue mutation coordinates before any field write", async () => {
    const secret = "unmistakably-fake-project-result-token";
    for (const coordinate of [secret, "/srv/private-project-result"]) {
      const runner = new QueuedGhRunner();
      const record = registrationRecord("empty");
      record.content.id = coordinate;
      runner.enqueue(projectPage({}), draftMutation(record));
      const github = new GitHubProjectClient({
        githubOwner: "owner", projectNumber: 7,
        preflightProjectItemId: "PVTI_preflight", runner, catalog: catalogFixture(),
        sensitiveData: createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
      });

      const error = await github.registerProject(registration).catch((cause) => cause);
      expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
      expect(JSON.stringify(error)).not.toContain(coordinate);
      expect(runner.calls.filter((call) => call.args.join(" ").includes("updateProjectV2ItemFieldValue"))).toHaveLength(0);
    }
  });

  it("rejects a public Project", async () => {
    const runner = new QueuedGhRunner();
    runner.enqueue(projectPage({ public: true }));
    await expect(client(runner).readAll()).rejects.toMatchObject({ code: "PROJECT_NOT_PRIVATE" });
  });

  it("proves repository membership from exactly one DraftIssue record", async () => {
    const runner = new QueuedGhRunner();
    runner.enqueue(projectPage({ records: [recordItem(1)] }));
    await expect(client(runner).requireProjectRepository("prj-project-1", "repo-control")).resolves.toBeUndefined();

    const wrong = new QueuedGhRunner();
    wrong.enqueue(projectPage({ records: [recordItem(1)] }));
    await expect(client(wrong).requireProjectRepository("prj-project-1", "repo-other")).rejects.toMatchObject({ code: "PROJECT_REPOSITORY_MISMATCH" });
  });

  it("paginates archived and active Project items without any repo credential call", async () => {
    const runner = new QueuedGhRunner();
    const first = Array.from({ length: 100 }, (_, i) => recordItem(i + 1));
    runner.enqueue(
      projectPage({ records: first, itemTotal: 102, itemNext: true, itemCursor: "c1" }),
      projectPage({ records: [recordItem(101)], includeFixture: false, itemTotal: 102 }),
    );

    const result = await client(runner).readAll();
    expect(result.items).toHaveLength(101);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls.every((call) => call.credential === "project")).toBe(true);
    expect(runner.calls[0]?.args.join("\n")).toContain("archivedStates: [ARCHIVED, NOT_ARCHIVED]");
    expect(runner.calls[1]?.args).toContain("itemCursor=c1");

    const incomplete = new QueuedGhRunner();
    incomplete.enqueue(projectPage({ records: [recordItem(1)], itemTotal: 3 }));
    await expect(client(incomplete).readAll()).rejects.toMatchObject({ code: "INCOMPLETE_PROJECT_READ" });
  });

  it("paginates field definitions separately and rejects a duplicate required field", async () => {
    const runner = new QueuedGhRunner();
    runner.enqueue(
      projectPage({ fields: requiredFields.slice(0, 4), fieldTotal: 6, fieldNext: true, fieldCursor: "f1" }),
      fieldPage([requiredFields[4]!, { ...requiredFields[0]!, id: "PVTF_duplicate" }], 6),
    );
    await expect(client(runner).readAll()).rejects.toMatchObject({ code: "INVALID_PROJECT_FIELDS" });
    expect(runner.calls[1]?.args).toContain("fieldCursor=f1");
  });

  it.each([
    ["redacted", null],
    ["repository Issue", { __typename: "Issue" }],
  ])("fails closed on %s content without falling back to the repo credential", async (_label, content) => {
    const runner = new QueuedGhRunner();
    const record = recordItem(1);
    record.content = content as typeof record.content;
    runner.enqueue(projectPage({ records: [record] }));

    await expect(client(runner).readAll()).rejects.toMatchObject({ code: "INVALID_PROJECT_RECORD" });
    expect(runner.calls.every((call) => call.credential === "project")).toBe(true);
  });

  it("rejects a missing or mispointed configured preflight fixture", async () => {
    const missing = new QueuedGhRunner();
    missing.enqueue(projectPage({ records: [recordItem(1)], includeFixture: false }));
    await expect(client(missing).readAll()).rejects.toMatchObject({ code: "INVALID_PREFLIGHT_ITEM" });

    const hidden = new QueuedGhRunner();
    const fixture = preflightItem();
    fixture.content = recordItem(9).content;
    const page = projectPage({ records: [recordItem(1)] });
    page.data.user.projectV2.items.nodes[0] = fixture;
    hidden.enqueue(page);
    await expect(client(hidden).readAll()).rejects.toMatchObject({ code: "INVALID_PREFLIGHT_ITEM" });
  });

  it("rejects malformed, duplicate-source, and duplicate-project DraftIssue records", async () => {
    const malformed = new QueuedGhRunner();
    const bad = recordItem(1);
    bad.content.body = "{}";
    malformed.enqueue(projectPage({ records: [bad] }));
    await expect(client(malformed).readAll()).rejects.toMatchObject({ code: "INVALID_PROJECT_RECORD" });

    const duplicateSource = new QueuedGhRunner();
    const left = recordItem(1);
    const right = recordItem(2);
    right.content.id = left.content.id;
    duplicateSource.enqueue(projectPage({ records: [left, right] }));
    await expect(client(duplicateSource).readAll()).rejects.toMatchObject({ code: "DUPLICATE_PROJECT_ITEM" });

    const duplicateProject = new QueuedGhRunner();
    duplicateProject.enqueue(projectPage({ records: [recordItem(1), recordItem(2, "prj-project-1")] }));
    await expect(client(duplicateProject).readAll()).rejects.toMatchObject({ code: "DUPLICATE_PROJECT_RECORD" });
  });

  it("rejects invalid operating fields and applies the shortest stale cadence", async () => {
    const invalid = new QueuedGhRunner();
    const bad = recordItem(1);
    bad.priority.name = "P9";
    invalid.enqueue(projectPage({ records: [bad] }));
    await expect(client(invalid).readAll()).rejects.toMatchObject({ code: "INVALID_PROJECT_ITEM" });

    const stale = new QueuedGhRunner();
    const p0 = recordItem(1);
    p0.priority = { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "priority-P0", name: "P0" };
    p0.lastReviewed.date = "2026-08-11";
    const completed = recordItem(2);
    completed.status = { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "status-completed", name: "completed" };
    completed.priority = { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "priority-P0", name: "P0" };
    completed.nextAction.text = "wait:done";
    completed.lastReviewed.date = "2020-01-01";
    stale.enqueue(projectPage({ records: [p0, completed] }));
    expect((await client(stale).readAll()).items.map((entry) => entry.stale)).toEqual([true, false]);
  });

  it("fails an idempotent retry when the exact Project ID has different content", async () => {
    const runner = new QueuedGhRunner();
    const existing = recordItem(1, "prj-example");
    runner.enqueue(projectPage({ records: [existing] }));
    await expect(client(runner).registerProject(registration)).rejects.toMatchObject({ code: "PROJECT_REGISTRATION_MISMATCH" });
    expect(runner.calls).toHaveLength(1);
  });

  it("returns an exact complete retry without rewriting later operational state", async () => {
    const runner = new QueuedGhRunner();
    const complete = registrationRecord("complete");
    runner.enqueue(projectPage({ records: [complete] }), projectPage({ records: [complete] }));

    await expect(client(runner).registerProject(registration)).resolves.toMatchObject({
      project_item_id: "PVTI_1",
      source_node_id: "DI_registration",
    });
    expect(runner.calls.filter((call) => call.args.join(" ").includes("updateProjectV2ItemFieldValue"))).toHaveLength(0);
  });

  it("rejects a present partial field mismatch before writing any missing field", async () => {
    const runner = new QueuedGhRunner();
    const partial = registrationRecord("empty");
    partial.status = {
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      optionId: "status-active",
      name: "active",
    };
    runner.enqueue(projectPage({ records: [partial] }));

    await expect(client(runner).registerProject(registration)).rejects.toMatchObject({ code: "PROJECT_REGISTRATION_MISMATCH" });
    expect(runner.calls.filter((call) => call.args.join(" ").includes("updateProjectV2ItemFieldValue"))).toHaveLength(0);
  });

  it("rejects unrelated duplicate canonical Project IDs before registration mutates anything", async () => {
    const runner = new QueuedGhRunner();
    runner.enqueue(projectPage({ records: [recordItem(1), recordItem(2, "prj-project-1")] }));

    await expect(client(runner).registerProject(registration)).rejects.toMatchObject({ code: "DUPLICATE_PROJECT_RECORD" });
    expect(runner.calls).toHaveLength(1);
  });

  it("rejects a DraftIssue creation response whose canonical title or body differs", async () => {
    for (const changed of ["title", "body"] as const) {
      const runner = new QueuedGhRunner();
      const record = registrationRecord("empty");
      if (changed === "title") record.content.title = "Different";
      else record.content.body = JSON.stringify({ id: registration.project_id, objective: "Different", repositories: registration.repo_ids });
      runner.enqueue(projectPage({}), draftMutation(record));

      await expect(client(runner).registerProject(registration)).rejects.toMatchObject({ code: "PROJECT_REGISTRATION_MISMATCH" });
      expect(runner.calls.filter((call) => call.args.join(" ").includes("updateProjectV2ItemFieldValue"))).toHaveLength(0);
    }
  });

  it("fails closed when the final five-field reread differs from the approved payload", async () => {
    const runner = new QueuedGhRunner();
    const final = registrationRecord("complete");
    final.priority.name = "P1";
    final.priority.optionId = "priority-P1";
    runner.enqueue(
      projectPage({}), draftMutation(),
      fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [final] }),
    );

    await expect(client(runner).registerProject(registration)).rejects.toMatchObject({ code: "PROJECT_REGISTRATION_MISMATCH" });
  });

  it("rejects an invalid active Next Action before any Project call", async () => {
    const runner = new QueuedGhRunner();
    await expect(client(runner).registerProject({
      ...registration,
      fields: { ...registration.fields, status: "active", health: "on-track", next_action: "wait:not-blocked" },
    })).rejects.toMatchObject({ code: "INVALID_PROJECT_NEXT_ACTION" });
    expect(runner.calls).toEqual([]);
  });

  it("verifies the fixed DraftIssue fixture and its Last Reviewed read/write/clear boundary", async () => {
    const runner = new QueuedGhRunner();
    runner.enqueue(
      projectPage({}),
      preflightResponse({ __typename: "ProjectV2ItemFieldDateValue", date: "2026-08-12" }),
      { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_preflight" } } } },
      { data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_preflight" } } } },
    );
    const github = client(runner);
    await github.verifyFields();
    await github.verifyPreflightItem("PVTI_preflight");
    await github.writeLastReviewed("PVTI_preflight", "2026-08-13");
    await github.clearLastReviewed("PVTI_preflight");
    expect(runner.calls.every((call) => call.credential === "project")).toBe(true);
  });

  it("rejects protected or oversized API coordinates before reuse", async () => {
    const secret = "unmistakably-fake-project-api-token";
    for (const [mutate, expectedCode] of [
      [(page: ReturnType<typeof projectPage>) => { page.data.user.projectV2.fields.nodes[0]!.id = secret; }, "SENSITIVE_DATA_REJECTED"],
      [(page: ReturnType<typeof projectPage>) => { page.data.user.projectV2.id = `PVT_${"x".repeat(300)}`; }, "INVALID_PROJECT_RESPONSE"],
    ] as const) {
      const runner = new QueuedGhRunner();
      const page = projectPage({});
      mutate(page);
      runner.enqueue(page);
      const github = new GitHubProjectClient({
        githubOwner: "owner", projectNumber: 7,
        preflightProjectItemId: "PVTI_preflight", runner, catalog: catalogFixture(),
        sensitiveData: createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
      });
      const error = await github.readAll().catch((cause) => cause);
      expect(error).toMatchObject({ code: expectedCode });
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});
