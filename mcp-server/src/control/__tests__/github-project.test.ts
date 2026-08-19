import { describe, expect, it, vi } from "vitest";

import { GitHubProjectClient, type GitHubRunner } from "../github-project.js";
import type { RegistrationHint, RegistrationHintPort } from "../registration-hint.js";
import type { ProjectOperationalFields } from "../schemas.js";
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
    if (response instanceof Error) throw response;
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

function client(
  runner: QueuedGhRunner,
  catalog = catalogFixture(),
  sleep?: (milliseconds: number) => Promise<void>,
  registrationHints?: RegistrationHintPort,
) {
  return new GitHubProjectClient({
    githubOwner: "owner",
    projectNumber: 7,
    preflightProjectItemId: "PVTI_preflight",
    runner,
    catalog,
    now: () => new Date("2026-08-13T00:00:00Z"),
    ...(sleep ? { sleep } : {}),
    ...(registrationHints ? { registrationHints } : {}),
  });
}

/** An in-memory hint store whose individual operations can be made to fail. */
class FakeHints implements RegistrationHintPort {
  readonly recorded: RegistrationHint[] = [];
  readonly cleared: string[] = [];

  constructor(
    private pending: RegistrationHint | undefined = undefined,
    private readonly faults: { read?: boolean; record?: boolean; clear?: boolean } = {},
  ) {}

  async read(projectId: string): Promise<RegistrationHint | undefined> {
    if (this.faults.read) throw new Error("hint state is unreadable");
    return this.pending?.project_id === projectId ? this.pending : undefined;
  }

  async record(hint: RegistrationHint): Promise<void> {
    if (this.faults.record) throw new Error("hint state is unwritable");
    this.recorded.push(hint);
    this.pending = hint;
  }

  async clear(projectId: string): Promise<void> {
    if (this.faults.clear) throw new Error("hint state is unwritable");
    this.cleared.push(projectId);
    if (this.pending?.project_id === projectId) this.pending = undefined;
  }
}

function hintedItem(record: ReturnType<typeof recordItem> | null, projectId = "PVT_project") {
  return {
    data: {
      node: record === null ? null : {
        __typename: "ProjectV2Item",
        id: record.id,
        isArchived: record.isArchived,
        type: record.type,
        project: { id: projectId },
        content: record.content,
        status: record.status,
        priority: record.priority,
        health: record.health,
        nextAction: record.nextAction,
        lastReviewed: record.lastReviewed,
      },
    },
  };
}

function hintLookups(runner: QueuedGhRunner) {
  return runner.calls.filter((call) => call.args.join(" ").includes("HintedProjectRecord"));
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

const recordedHint = { project_id: registration.project_id, item_id: "PVTI_1", source_node_id: "DI_registration" };

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

function updatedRecord(fields: Partial<ProjectOperationalFields> = {}) {
  const record = registrationRecord("complete");
  const merged: ProjectOperationalFields = { ...registration.fields, ...fields };
  record.status.name = merged.status;
  record.status.optionId = `status-${merged.status}`;
  record.priority.name = merged.priority;
  record.priority.optionId = `priority-${merged.priority}`;
  record.health.name = merged.health;
  record.health.optionId = `health-${merged.health}`;
  record.nextAction.text = merged.next_action;
  record.lastReviewed.date = merged.last_reviewed;
  return record;
}

function mutations(runner: QueuedGhRunner) {
  return runner.calls.filter((call) => call.args.join(" ").includes("updateProjectV2ItemFieldValue"));
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
      runner.enqueue(projectPage({}), projectPage({}), projectPage({}), draftMutation(record));
      const github = new GitHubProjectClient({
        githubOwner: "owner", projectNumber: 7,
        preflightProjectItemId: "PVTI_preflight", runner, catalog: catalogFixture(),
        sensitiveData: createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
        sleep: async () => undefined,
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
      runner.enqueue(projectPage({}), projectPage({}), projectPage({}), draftMutation(record));

      await expect(client(runner, catalogFixture(), async () => undefined).registerProject(registration))
        .rejects.toMatchObject({ code: "PROJECT_REGISTRATION_MISMATCH" });
      expect(runner.calls.filter((call) => call.args.join(" ").includes("updateProjectV2ItemFieldValue"))).toHaveLength(0);
    }
  });

  it("fails closed when the final five-field reread differs from the approved payload", async () => {
    const runner = new QueuedGhRunner();
    const final = registrationRecord("complete");
    final.priority.name = "P1";
    final.priority.optionId = "priority-P1";
    runner.enqueue(
      projectPage({}), projectPage({}), projectPage({}), draftMutation(),
      fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [final] }),
      projectPage({ records: [final] }),
      projectPage({ records: [final] }),
      projectPage({ records: [final] }),
    );

    await expect(client(runner, catalogFixture(), async () => undefined).registerProject(registration))
      .rejects.toMatchObject({ code: "PROJECT_REGISTRATION_MISMATCH" });
  });

  it("reuses a record that appears during the bounded absence window instead of creating a second one", async () => {
    const runner = new QueuedGhRunner();
    const pauses: number[] = [];
    const complete = registrationRecord("complete");
    runner.enqueue(
      projectPage({}),
      projectPage({ records: [complete] }),
      projectPage({ records: [complete] }),
    );

    await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); })
      .registerProject(registration))
      .resolves.toMatchObject({ project_item_id: "PVTI_1", source_node_id: "DI_registration" });
    expect(runner.calls.some((call) => call.args.join(" ").includes("addProjectV2DraftIssue"))).toBe(false);
    expect(mutations(runner)).toHaveLength(0);
    expect(pauses).toEqual([2000]);
  });

  it("creates only after the record stays invisible for the whole absence window", async () => {
    const runner = new QueuedGhRunner();
    const pauses: number[] = [];
    runner.enqueue(
      projectPage({}), projectPage({}), projectPage({}),
      draftMutation(),
      fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [registrationRecord("complete")] }),
    );

    await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); })
      .registerProject(registration))
      .resolves.toMatchObject({ project_item_id: "PVTI_1" });
    expect(runner.calls.filter((call) => call.args.join(" ").includes("addProjectV2DraftIssue"))).toHaveLength(1);
    // The absence window is deliberately shorter than the verification window.
    expect(pauses).toEqual([2000, 4000]);
  });

  it("creates a first Project Record without paying the absence window", async () => {
    const runner = new QueuedGhRunner();
    const pauses: number[] = [];
    const hints = new FakeHints();
    runner.enqueue(
      projectPage({}),
      draftMutation(),
      fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [registrationRecord("complete")] }),
    );

    await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); }, hints)
      .registerProject(registration))
      .resolves.toMatchObject({ project_item_id: "PVTI_1", source_node_id: "DI_registration" });
    // An empty, readable hint store proves no earlier run reached the create.
    expect(pauses).toEqual([]);
    expect(hintLookups(runner)).toHaveLength(0);
    expect(runner.calls.filter((call) => call.args.join(" ").includes("addProjectV2DraftIssue"))).toHaveLength(1);
    // Intent is durable before the irreversible step, coordinates right after.
    expect(hints.recorded).toEqual([{ project_id: registration.project_id }, recordedHint]);
    expect(hints.cleared).toEqual([registration.project_id]);
  });

  it("resumes a create that crashed before its fields through the recorded coordinates", async () => {
    const runner = new QueuedGhRunner();
    const pauses: number[] = [];
    const hints = new FakeHints(recordedHint);
    runner.enqueue(
      projectPage({}),
      hintedItem(registrationRecord("empty")),
      fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [registrationRecord("complete")] }),
    );

    await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); }, hints)
      .registerProject(registration))
      .resolves.toMatchObject({ project_item_id: "PVTI_1", source_node_id: "DI_registration" });
    expect(runner.calls.some((call) => call.args.join(" ").includes("addProjectV2DraftIssue"))).toBe(false);
    expect(hintLookups(runner)).toHaveLength(1);
    expect(pauses).toEqual([]);
    expect(mutations(runner)).toHaveLength(5);
    expect(hints.cleared).toEqual([registration.project_id]);
  });

  it("falls back to the absence window when the recorded coordinates no longer resolve", async () => {
    const runner = new QueuedGhRunner();
    const pauses: number[] = [];
    const hints = new FakeHints(recordedHint);
    runner.enqueue(
      projectPage({}),
      hintedItem(null),
      projectPage({}), projectPage({}),
      draftMutation(),
      fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [registrationRecord("complete")] }),
    );

    await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); }, hints)
      .registerProject(registration))
      .resolves.toMatchObject({ project_item_id: "PVTI_1" });
    expect(pauses).toEqual([2000, 4000]);
    expect(runner.calls.filter((call) => call.args.join(" ").includes("addProjectV2DraftIssue"))).toHaveLength(1);
  });

  it("waits when an intent was recorded but its create never completed", async () => {
    const runner = new QueuedGhRunner();
    const pauses: number[] = [];
    const hints = new FakeHints({ project_id: registration.project_id });
    runner.enqueue(
      projectPage({}),
      projectPage({ records: [registrationRecord("complete")] }),
      projectPage({ records: [registrationRecord("complete")] }),
    );

    await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); }, hints)
      .registerProject(registration))
      .resolves.toMatchObject({ project_item_id: "PVTI_1" });
    // No coordinates to resolve, so the crash gap is covered by waiting.
    expect(hintLookups(runner)).toHaveLength(0);
    expect(pauses).toEqual([2000]);
  });

  it("keeps confirming absence by waiting when the hint store cannot answer", async () => {
    for (const faults of [{ read: true }, { record: true }]) {
      const runner = new QueuedGhRunner();
      const pauses: number[] = [];
      runner.enqueue(
        projectPage({}), projectPage({}), projectPage({}),
        draftMutation(),
        fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
        projectPage({ records: [registrationRecord("complete")] }),
      );

      await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); }, new FakeHints(undefined, faults))
        .registerProject(registration))
        .resolves.toMatchObject({ project_item_id: "PVTI_1" });
      // A store that cannot be read or written costs the window, not the record.
      expect(pauses).toEqual([2000, 4000]);
    }
  });

  it("completes the registration when the settled hint cannot be cleared", async () => {
    const runner = new QueuedGhRunner();
    const hints = new FakeHints(undefined, { clear: true });
    runner.enqueue(
      projectPage({}),
      draftMutation(),
      fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [registrationRecord("complete")] }),
    );

    await expect(client(runner, catalogFixture(), async () => undefined, hints).registerProject(registration))
      .resolves.toMatchObject({ project_item_id: "PVTI_1" });
    expect(hints.cleared).toEqual([]);
  });

  it("ignores a hint that resolves to an item outside the configured Project", async () => {
    const runner = new QueuedGhRunner();
    const pauses: number[] = [];
    runner.enqueue(
      projectPage({}),
      hintedItem(registrationRecord("empty"), "PVT_other"),
      projectPage({}), projectPage({}),
      draftMutation(),
      fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [registrationRecord("complete")] }),
    );

    await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); }, new FakeHints(recordedHint))
      .registerProject(registration))
      .resolves.toMatchObject({ project_item_id: "PVTI_1" });
    expect(pauses).toEqual([2000, 4000]);
  });

  it("ignores a hint whose record claims another Project ID", async () => {
    const runner = new QueuedGhRunner();
    const pauses: number[] = [];
    runner.enqueue(
      projectPage({}),
      hintedItem(recordItem(1, "prj-somebody-else")),
      projectPage({}), projectPage({}),
      draftMutation(),
      fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [registrationRecord("complete")] }),
    );

    await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); }, new FakeHints(recordedHint))
      .registerProject(registration))
      .resolves.toMatchObject({ project_item_id: "PVTI_1" });
    expect(pauses).toEqual([2000, 4000]);
  });

  it("ignores a hint that names the preflight fixture", async () => {
    const runner = new QueuedGhRunner();
    const pauses: number[] = [];
    runner.enqueue(
      projectPage({}),
      projectPage({}), projectPage({}),
      draftMutation(),
      fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [registrationRecord("complete")] }),
    );
    const hints = new FakeHints({ project_id: registration.project_id, item_id: "PVTI_preflight" });

    await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); }, hints)
      .registerProject(registration))
      .resolves.toMatchObject({ project_item_id: "PVTI_1" });
    expect(hintLookups(runner)).toHaveLength(0);
    expect(pauses).toEqual([2000, 4000]);
  });

  it("holds a record found through the hint to the same payload gates", async () => {
    const runner = new QueuedGhRunner();
    const mismatched = registrationRecord("empty");
    mismatched.content.title = "Different";
    runner.enqueue(projectPage({}), hintedItem(mismatched));

    await expect(client(runner, catalogFixture(), async () => undefined, new FakeHints(recordedHint))
      .registerProject(registration))
      .rejects.toMatchObject({ code: "PROJECT_REGISTRATION_MISMATCH" });
    expect(mutations(runner)).toHaveLength(0);
    expect(runner.calls.some((call) => call.args.join(" ").includes("addProjectV2DraftIssue"))).toBe(false);
  });

  it("converges a delayed registration read-back instead of failing a settled write", async () => {
    const runner = new QueuedGhRunner();
    const pauses: number[] = [];
    runner.enqueue(
      projectPage({ records: [registrationRecord("empty")] }),
      fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [registrationRecord("empty")] }),
      projectPage({ records: [registrationRecord("complete")] }),
    );

    await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); })
      .registerProject(registration))
      .resolves.toMatchObject({ project_item_id: "PVTI_1", source_node_id: "DI_registration" });
    expect(pauses).toEqual([2000]);
    expect(mutations(runner)).toHaveLength(5);
  });

  it("separates a registration that never settles from one another writer won", async () => {
    const unsettled = new QueuedGhRunner();
    const unsettledPauses: number[] = [];
    const stale = registrationRecord("empty");
    unsettled.enqueue(
      projectPage({ records: [stale] }),
      fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [stale] }),
      projectPage({ records: [stale] }),
      projectPage({ records: [stale] }),
      projectPage({ records: [stale] }),
    );

    await expect(client(unsettled, catalogFixture(), async (milliseconds) => { unsettledPauses.push(milliseconds); })
      .registerProject(registration))
      .rejects.toMatchObject({ code: "PROJECT_REGISTRATION_UNSETTLED" });
    expect(unsettledPauses).toEqual([2000, 4000, 8000]);
    expect(unsettled.calls.some((call) => call.args.join(" ").includes("addProjectV2DraftIssue"))).toBe(false);

    // A record that settled on values nobody asked for is contention, not lag.
    const contended = new QueuedGhRunner();
    const other = registrationRecord("complete");
    other.priority.name = "P1";
    other.priority.optionId = "priority-P1";
    contended.enqueue(
      projectPage({ records: [registrationRecord("empty")] }),
      fieldMutation, fieldMutation, fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [other] }),
      projectPage({ records: [other] }),
      projectPage({ records: [other] }),
      projectPage({ records: [other] }),
    );

    await expect(client(contended, catalogFixture(), async () => undefined).registerProject(registration))
      .rejects.toMatchObject({ code: "PROJECT_REGISTRATION_MISMATCH" });
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

  it("writes only the changed operating fields and returns the merged record", async () => {
    const runner = new QueuedGhRunner();
    const catalog = catalogFixture();
    runner.enqueue(
      projectPage({ records: [updatedRecord()] }),
      fieldMutation,
      fieldMutation,
      projectPage({ records: [updatedRecord({ status: "active", next_action: `task:${TASK_ID}` })] }),
    );

    await expect(client(runner, catalog).updateProject({
      project_id: registration.project_id,
      fields: { status: "active", next_action: `task:${TASK_ID}` },
    })).resolves.toEqual({
      project_id: registration.project_id,
      project_item_id: "PVTI_1",
      source_node_id: "DI_registration",
      fields: {
        status: "active",
        priority: "P2",
        health: "unknown",
        next_action: `task:${TASK_ID}`,
        last_reviewed: "2026-08-13",
      },
    });
    expect(mutations(runner)).toHaveLength(2);
    // Status enters active last so no reader observes a partially applied record.
    expect(mutations(runner)[0]?.args.join(" ")).toContain(`text=task:${TASK_ID}`);
    expect(mutations(runner)[1]?.args.join(" ")).toContain("optionId=status-active");
    expect(catalog.getTask).toHaveBeenCalledWith(TASK_ID);
    expect(catalog.getRepository).not.toHaveBeenCalled();
    expect(runner.calls.every((call) => call.credential === "project")).toBe(true);
  });

  it("re-verifies an unchanged patch without writing any field", async () => {
    const runner = new QueuedGhRunner();
    runner.enqueue(projectPage({ records: [updatedRecord()] }), projectPage({ records: [updatedRecord()] }));

    await expect(client(runner).updateProject({
      project_id: registration.project_id,
      fields: { priority: registration.fields.priority },
    })).resolves.toMatchObject({ fields: registration.fields });
    expect(mutations(runner)).toHaveLength(0);
  });

  it("rejects an empty or malformed patch before any Project call", async () => {
    const runner = new QueuedGhRunner();
    const github = client(runner);

    await expect(github.updateProject({ project_id: registration.project_id, fields: {} }))
      .rejects.toMatchObject({ code: "INVALID_PROJECT_UPDATE" });
    await expect(github.updateProject({ project_id: registration.project_id, fields: { last_reviewed: "2026-02-30" } }))
      .rejects.toMatchObject({ code: "INVALID_PROJECT_UPDATE" });
    expect(runner.calls).toEqual([]);
  });

  it("refuses to update identity or membership through the operating-field patch", async () => {
    const runner = new QueuedGhRunner();

    await expect(client(runner).updateProject({
      project_id: registration.project_id,
      title: "Renamed",
      fields: { priority: "P1" },
    } as never)).rejects.toMatchObject({ code: "INVALID_PROJECT_UPDATE" });
    expect(runner.calls).toEqual([]);
  });

  it("rejects protected update content before any GitHub call", async () => {
    const runner = new QueuedGhRunner();
    const secret = "unmistakably-fake-project-update-token";
    const github = new GitHubProjectClient({
      githubOwner: "owner", projectNumber: 7,
      preflightProjectItemId: "PVTI_preflight", runner, catalog: catalogFixture(),
      sensitiveData: createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
    });

    const error = await github.updateProject({
      project_id: registration.project_id,
      fields: { next_action: `wait:${secret}` },
    }).catch((cause) => cause);
    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(runner.calls).toEqual([]);
  });

  it("fails closed on an absent or ambiguous canonical Project Record", async () => {
    const missing = new QueuedGhRunner();
    missing.enqueue(projectPage({ records: [recordItem(1)] }));
    await expect(client(missing).updateProject({
      project_id: registration.project_id,
      fields: { priority: "P1" },
    })).rejects.toMatchObject({ code: "PROJECT_RECORD_NOT_FOUND" });
    expect(missing.calls).toHaveLength(1);

    const ambiguous = new QueuedGhRunner();
    ambiguous.enqueue(projectPage({ records: [updatedRecord(), recordItem(2, registration.project_id)] }));
    await expect(client(ambiguous).updateProject({
      project_id: registration.project_id,
      fields: { priority: "P1" },
    })).rejects.toMatchObject({ code: "DUPLICATE_PROJECT_RECORD" });
    expect(mutations(ambiguous)).toHaveLength(0);
  });

  it("rejects a merged active Next Action that contradicts its Health before any write", async () => {
    const runner = new QueuedGhRunner();
    runner.enqueue(projectPage({ records: [updatedRecord()] }));

    await expect(client(runner).updateProject({
      project_id: registration.project_id,
      fields: { status: "active" },
    })).rejects.toMatchObject({ code: "INVALID_PROJECT_NEXT_ACTION" });
    expect(runner.calls).toHaveLength(1);
  });

  it("converges a delayed read through bounded backoff without rewriting the field", async () => {
    const runner = new QueuedGhRunner();
    const pauses: number[] = [];
    runner.enqueue(
      projectPage({ records: [updatedRecord()] }),
      fieldMutation,
      projectPage({ records: [updatedRecord()] }),
      projectPage({ records: [updatedRecord({ priority: "P1" })] }),
    );

    await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); })
      .updateProject({ project_id: registration.project_id, fields: { priority: "P1" } }))
      .resolves.toMatchObject({ fields: { priority: "P1" } });
    expect(pauses).toEqual([250]);
    expect(mutations(runner)).toHaveLength(1);
  });

  it("converges the active reconfiguration whose intermediate state no ordering can avoid", async () => {
    // Status ordering removes the window for entering and leaving active, so an
    // active-to-active Health/Next Action swap is the only reachable state that
    // still needs the transient read to be treated as unsettled.
    const runner = new QueuedGhRunner();
    const pauses: number[] = [];
    const blocked = { status: "active" as const, health: "blocked" as const, next_action: "wait:blocked-on-review" };
    const settled = { health: "on-track" as const, next_action: `task:${TASK_ID}` };
    runner.enqueue(
      projectPage({ records: [updatedRecord(blocked)] }),
      fieldMutation, fieldMutation,
      projectPage({ records: [updatedRecord({ ...blocked, health: "on-track" })] }),
      projectPage({ records: [updatedRecord({ ...blocked, ...settled })] }),
    );

    await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); })
      .updateProject({ project_id: registration.project_id, fields: settled }))
      .resolves.toMatchObject({ fields: { status: "active", health: "on-track", next_action: `task:${TASK_ID}` } });
    expect(pauses).toEqual([250]);
    expect(mutations(runner)).toHaveLength(2);
  });

  it("fails closed when the bounded read-back never converges", async () => {
    const runner = new QueuedGhRunner();
    const pauses: number[] = [];
    runner.enqueue(
      projectPage({ records: [updatedRecord()] }),
      fieldMutation,
      projectPage({ records: [updatedRecord()] }),
      projectPage({ records: [updatedRecord()] }),
      projectPage({ records: [updatedRecord()] }),
      projectPage({ records: [updatedRecord()] }),
    );

    await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); })
      .updateProject({ project_id: registration.project_id, fields: { priority: "P1" } }))
      .rejects.toMatchObject({ code: "PROJECT_UPDATE_MISMATCH" });
    expect(pauses).toEqual([250, 500, 1000]);
    expect(mutations(runner)).toHaveLength(1);

    const unsettled = new QueuedGhRunner();
    const unsettledPauses: number[] = [];
    const blocked = { status: "active" as const, health: "blocked" as const, next_action: "wait:blocked-on-review" };
    const halfApplied = projectPage({ records: [updatedRecord({ ...blocked, health: "on-track" })] });
    unsettled.enqueue(
      projectPage({ records: [updatedRecord(blocked)] }),
      fieldMutation, fieldMutation,
      halfApplied, halfApplied, halfApplied, halfApplied,
    );
    await expect(client(unsettled, catalogFixture(), async (milliseconds) => { unsettledPauses.push(milliseconds); })
      .updateProject({
        project_id: registration.project_id,
        fields: { health: "on-track", next_action: `task:${TASK_ID}` },
      })).rejects.toMatchObject({ code: "PROJECT_UPDATE_UNSETTLED" });
    expect(unsettledPauses).toEqual([250, 500, 1000]);
  });

  it("orders the Status write so a concurrent reader never sees a half-applied active record", async () => {
    const entering = { status: "active" as const, health: "blocked" as const, next_action: "wait:blocked-on-review" };
    const enter = new QueuedGhRunner();
    enter.enqueue(
      projectPage({ records: [updatedRecord()] }),
      fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [updatedRecord(entering)] }),
    );
    await expect(client(enter).updateProject({ project_id: registration.project_id, fields: entering }))
      .resolves.toMatchObject({ fields: entering });
    expect(mutations(enter).map((call) => call.args.join(" "))).toEqual([
      expect.stringContaining("optionId=health-blocked"),
      expect.stringContaining("text=wait:blocked-on-review"),
      expect.stringContaining("optionId=status-active"),
    ]);

    const leaving = { status: "completed" as const, health: "on-track" as const, next_action: "wait:archived" };
    const leave = new QueuedGhRunner();
    leave.enqueue(
      projectPage({ records: [updatedRecord(entering)] }),
      fieldMutation, fieldMutation, fieldMutation,
      projectPage({ records: [updatedRecord(leaving)] }),
    );
    await expect(client(leave).updateProject({ project_id: registration.project_id, fields: leaving }))
      .resolves.toMatchObject({ fields: leaving });
    expect(mutations(leave).map((call) => call.args.join(" "))).toEqual([
      expect.stringContaining("optionId=status-completed"),
      expect.stringContaining("optionId=health-on-track"),
      expect.stringContaining("text=wait:archived"),
    ]);
  });

  it("proves every Task reference the patch asserts and none that it omits", async () => {
    const referencing = { next_action: `task:${TASK_ID}` };
    const deadCatalog = () => ({
      getRepository: vi.fn(async (id: string) => ({ id })),
      getTask: vi.fn(async () => { throw new Error("task is not in the catalog"); }),
    });

    const omitted = new QueuedGhRunner();
    const omittedCatalog = catalogFixture();
    omitted.enqueue(
      projectPage({ records: [updatedRecord(referencing)] }),
      fieldMutation,
      projectPage({ records: [updatedRecord({ ...referencing, priority: "P1" })] }),
    );
    await expect(client(omitted, omittedCatalog)
      .updateProject({ project_id: registration.project_id, fields: { priority: "P1" } }))
      .resolves.toMatchObject({ fields: { priority: "P1", next_action: `task:${TASK_ID}` } });
    expect(omittedCatalog.getTask).not.toHaveBeenCalled();

    const restated = new QueuedGhRunner();
    const restatedCatalog = catalogFixture();
    restated.enqueue(
      projectPage({ records: [updatedRecord(referencing)] }),
      projectPage({ records: [updatedRecord(referencing)] }),
    );
    await expect(client(restated, restatedCatalog)
      .updateProject({ project_id: registration.project_id, fields: referencing }))
      .resolves.toMatchObject({ fields: referencing });
    expect(restatedCatalog.getTask).toHaveBeenCalledWith(TASK_ID);
    expect(mutations(restated)).toHaveLength(0);

    // Restating a reference is still an assertion, so a vanished Task fails it
    // even though the update would write nothing.
    const restatedDead = new QueuedGhRunner();
    restatedDead.enqueue(projectPage({ records: [updatedRecord(referencing)] }));
    await expect(client(restatedDead, deadCatalog())
      .updateProject({ project_id: registration.project_id, fields: referencing }))
      .rejects.toThrow("task is not in the catalog");
    expect(mutations(restatedDead)).toHaveLength(0);

    const changedDead = new QueuedGhRunner();
    changedDead.enqueue(projectPage({ records: [updatedRecord()] }));
    await expect(client(changedDead, deadCatalog())
      .updateProject({ project_id: registration.project_id, fields: referencing }))
      .rejects.toThrow("task is not in the catalog");
    expect(mutations(changedDead)).toHaveLength(0);
  });

  it("patches the Last Reviewed date on its own field mutation path", async () => {
    const runner = new QueuedGhRunner();
    runner.enqueue(
      projectPage({ records: [updatedRecord()] }),
      fieldMutation,
      projectPage({ records: [updatedRecord({ last_reviewed: "2026-08-19" })] }),
    );

    await expect(client(runner).updateProject({
      project_id: registration.project_id,
      fields: { last_reviewed: "2026-08-19" },
    })).resolves.toMatchObject({ fields: { last_reviewed: "2026-08-19" } });
    expect(mutations(runner)).toHaveLength(1);
    expect(mutations(runner)[0]?.args.join(" ")).toContain("date=2026-08-19");
  });

  it("repairs a record left mid-reconfiguration by an interrupted active update", async () => {
    const healthy = { status: "active" as const, health: "on-track" as const, next_action: `task:${TASK_ID}` };
    const interrupted = new QueuedGhRunner();
    interrupted.enqueue(
      projectPage({ records: [updatedRecord(healthy)] }),
      fieldMutation,
      new Error("injected reconfiguration boundary"),
    );
    await expect(client(interrupted).updateProject({
      project_id: registration.project_id,
      fields: { health: "blocked", next_action: "wait:blocked-on-review" },
    })).rejects.toThrow("injected reconfiguration boundary");

    // Health landed and Next Action did not, so every field is present while the
    // active rule is violated — a state only an overwriting writer can produce.
    const wedged = updatedRecord({ ...healthy, health: "blocked" });
    const reader = new QueuedGhRunner();
    reader.enqueue(projectPage({ records: [wedged] }));
    await expect(client(reader).readAll()).rejects.toMatchObject({ code: "INVALID_PROJECT_ITEM" });

    // The runbook promises the same flags converge on re-run; that is exactly
    // the case an interrupted reconfiguration used to make unreachable.
    const rerun = new QueuedGhRunner();
    const reconfigured = { ...healthy, health: "blocked" as const, next_action: "wait:blocked-on-review" };
    rerun.enqueue(
      projectPage({ records: [wedged] }),
      fieldMutation,
      projectPage({ records: [updatedRecord(reconfigured)] }),
    );
    await expect(client(rerun).updateProject({
      project_id: registration.project_id,
      fields: { health: "blocked", next_action: "wait:blocked-on-review" },
    })).resolves.toMatchObject({ fields: reconfigured });
    expect(mutations(rerun)).toHaveLength(1);

    const repair = new QueuedGhRunner();
    repair.enqueue(
      projectPage({ records: [wedged] }),
      fieldMutation,
      projectPage({ records: [updatedRecord(healthy)] }),
    );
    await expect(client(repair).updateProject({
      project_id: registration.project_id,
      fields: { health: "on-track" },
    })).resolves.toMatchObject({ fields: healthy });
    expect(mutations(repair)).toHaveLength(1);

    // A patch that would leave the record invalid still stops before any write.
    const refused = new QueuedGhRunner();
    refused.enqueue(projectPage({ records: [wedged] }));
    await expect(client(refused).updateProject({
      project_id: registration.project_id,
      fields: { last_reviewed: "2026-08-19" },
    })).rejects.toMatchObject({ code: "INVALID_PROJECT_NEXT_ACTION" });
    expect(mutations(refused)).toHaveLength(0);
  });

  it("fails closed without retry when the updated record disappears or its item moves", async () => {
    const gone = new QueuedGhRunner();
    const gonePauses: number[] = [];
    gone.enqueue(projectPage({ records: [updatedRecord()] }), fieldMutation, projectPage({ records: [] }));
    await expect(client(gone, catalogFixture(), async (milliseconds) => { gonePauses.push(milliseconds); })
      .updateProject({ project_id: registration.project_id, fields: { priority: "P1" } }))
      .rejects.toMatchObject({ code: "PROJECT_UPDATE_MISMATCH" });
    expect(gonePauses).toEqual([]);

    const moved = new QueuedGhRunner();
    const movedPauses: number[] = [];
    const relocated = updatedRecord({ priority: "P1" });
    relocated.id = "PVTI_moved";
    moved.enqueue(projectPage({ records: [updatedRecord()] }), fieldMutation, projectPage({ records: [relocated] }));
    await expect(client(moved, catalogFixture(), async (milliseconds) => { movedPauses.push(milliseconds); })
      .updateProject({ project_id: registration.project_id, fields: { priority: "P1" } }))
      .rejects.toMatchObject({ code: "PROJECT_UPDATE_MISMATCH" });
    expect(movedPauses).toEqual([]);
  });

  it("resumes a write interrupted midway without rewriting the settled fields", async () => {
    const patch = { priority: "P1" as const, last_reviewed: "2026-08-19" };
    const interrupted = new QueuedGhRunner();
    interrupted.enqueue(
      projectPage({ records: [updatedRecord()] }),
      fieldMutation,
      new Error("injected second-field boundary"),
    );

    await expect(client(interrupted).updateProject({ project_id: registration.project_id, fields: patch }))
      .rejects.toThrow("injected second-field boundary");
    expect(mutations(interrupted)).toHaveLength(2);

    const resumed = new QueuedGhRunner();
    resumed.enqueue(
      projectPage({ records: [updatedRecord({ priority: "P1" })] }),
      fieldMutation,
      projectPage({ records: [updatedRecord(patch)] }),
    );

    await expect(client(resumed).updateProject({ project_id: registration.project_id, fields: patch }))
      .resolves.toMatchObject({ fields: { priority: "P1", last_reviewed: "2026-08-19" } });
    expect(mutations(resumed)).toHaveLength(1);
    expect(mutations(resumed)[0]?.args.join(" ")).toContain("date=2026-08-19");
  });

  it("fails closed immediately when the record identity changed during the update", async () => {
    for (const changed of ["title", "body"] as const) {
      const runner = new QueuedGhRunner();
      const pauses: number[] = [];
      const final = updatedRecord({ priority: "P1" });
      if (changed === "title") final.content.title = "Renamed";
      else final.content.body = JSON.stringify({ id: registration.project_id, objective: "Different", repositories: registration.repo_ids });
      runner.enqueue(projectPage({ records: [updatedRecord()] }), fieldMutation, projectPage({ records: [final] }));

      await expect(client(runner, catalogFixture(), async (milliseconds) => { pauses.push(milliseconds); })
        .updateProject({ project_id: registration.project_id, fields: { priority: "P1" } }))
        .rejects.toMatchObject({ code: "PROJECT_UPDATE_MISMATCH" });
      expect(pauses).toEqual([]);
    }
  });
});
