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
          public: false,
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
  it("rejects protected registration content before any GitHub call", async () => {
    const gh = new QueuedGhRunner();
    const secret = "unmistakably-fake-project-token";
    const github = new GitHubProjectClient({
      githubOwner: "owner",
      projectNumber: 7,
      registryRepository: "owner/registry",
      preflightProjectItemId: "PVTI_preflight",
      runner: gh,
      catalog: catalogFixture(),
      sensitiveData: createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
    });

    const error = await github.registerProject({
      project_id: "prj-project-1",
      title: "Project 1",
      objective: `contains ${secret}`,
      repo_ids: ["repo-control"],
      fields: {
        status: "active", priority: "P2", health: "blocked",
        next_action: "wait:fixture", last_reviewed: "2026-08-13",
      },
    }).catch((cause) => cause);
    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(gh.calls).toEqual([]);
  });

  it("rejects a public Project before treating it as trial authority", async () => {
    const gh = new QueuedGhRunner();
    const page = projectPageFixture({ count: 0, totalCount: 0, hasNextPage: false, endCursor: null });
    (page.data.user.projectV2 as typeof page.data.user.projectV2 & { public: boolean }).public = true;
    gh.enqueue(page);

    await expect(client(gh).readAll()).rejects.toMatchObject({ code: "PROJECT_NOT_PRIVATE" });
  });

  it("proves a Project Record contains the Repository and is attached exactly once", async () => {
    const gh = new QueuedGhRunner();
    gh.enqueue(
      projectPageFixture({ count: 1, totalCount: 1, hasNextPage: false, endCursor: null }),
      [[issueFixture(1)]],
    );

    await expect(client(gh).requireProjectRepository("prj-project-1", "repo-control")).resolves.toBeUndefined();
  });

  it("rejects an unlabeled canonical duplicate during Project membership proof", async () => {
    const gh = new QueuedGhRunner();
    const complete = issueFixture(1);
    const unlabeled = { ...complete, node_id: "I_duplicate", number: 2, labels: [] };
    gh.enqueue(
      projectPageFixture({ count: 1, totalCount: 1, hasNextPage: false, endCursor: null }),
      [[complete, unlabeled]],
    );

    await expect(client(gh).requireProjectRepository("prj-project-1", "repo-control")).rejects.toMatchObject({
      code: "DUPLICATE_PROJECT_RECORD",
    });
  });

  it("rejects missing Repository membership or an unattached Project Record", async () => {
    const wrongRepo = new QueuedGhRunner();
    wrongRepo.enqueue(
      projectPageFixture({ count: 1, totalCount: 1, hasNextPage: false, endCursor: null }),
      [[issueFixture(1)]],
    );
    await expect(client(wrongRepo).requireProjectRepository("prj-project-1", "repo-other")).rejects.toMatchObject({
      code: "PROJECT_REPOSITORY_MISMATCH",
    });

    const unattached = new QueuedGhRunner();
    unattached.enqueue(
      projectPageFixture({ count: 0, totalCount: 0, hasNextPage: false, endCursor: null }),
      [[issueFixture(1)]],
    );
    await expect(client(unattached).requireProjectRepository("prj-project-1", "repo-control")).rejects.toMatchObject({
      code: "PROJECT_RECORD_NOT_ATTACHED",
    });
  });

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
            public: false,
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

  it("rejects duplicate source attachments before portfolio rows are emitted", async () => {
    const gh = new QueuedGhRunner();
    const page = projectPageFixture({ count: 2, totalCount: 2, hasNextPage: false, endCursor: null });
    page.data.user.projectV2.items.nodes[1]!.content = { __typename: "Issue", id: "I_1" };
    gh.enqueue(page, [[issueFixture(1)]]);

    await expect(client(gh).readAll()).rejects.toMatchObject({ code: "DUPLICATE_PROJECT_ITEM" });
  });

  it("rejects two Project Record Issues that claim one canonical Project ID", async () => {
    const gh = new QueuedGhRunner();
    const duplicate = issueFixture(2);
    duplicate.body = JSON.stringify({ id: "prj-project-1", objective: "Other", repositories: ["repo-control"] });
    gh.enqueue(
      projectPageFixture({ count: 2, totalCount: 2, hasNextPage: false, endCursor: null }),
      [[issueFixture(1), duplicate]],
    );

    await expect(client(gh).readAll()).rejects.toMatchObject({ code: "DUPLICATE_PROJECT_RECORD" });
  });

  it("rejects protected or oversized API coordinates before they can be reused outbound", async () => {
    const secret = "unmistakably-fake-project-api-token";
    for (const [kind, mutate, expectedCode] of [
      ["protected", (page: ReturnType<typeof projectPageFixture>) => { page.data.user.projectV2.fields.nodes[0]!.id = secret; }, "SENSITIVE_DATA_REJECTED"],
      ["oversized", (page: ReturnType<typeof projectPageFixture>) => { page.data.user.projectV2.id = `PVT_${"x".repeat(300)}`; }, "INVALID_PROJECT_RESPONSE"],
    ] as const) {
      const gh = new QueuedGhRunner();
      const page = projectPageFixture({ count: 0, totalCount: 0, hasNextPage: false, endCursor: null });
      mutate(page);
      gh.enqueue(page);
      const github = new GitHubProjectClient({
        githubOwner: "owner",
        projectNumber: 7,
        registryRepository: "owner/registry",
        preflightProjectItemId: "PVTI_preflight",
        runner: gh,
        catalog: catalogFixture(),
        sensitiveData: createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
      });

      const error = await github.readAll().catch((cause: unknown) => cause);
      expect(error, kind).toMatchObject({ code: expectedCode });
      expect(gh.calls, kind).toHaveLength(1);
      expect(JSON.stringify(error), kind).not.toContain(secret);
    }
  });

  it("rejects a protected mutation result before any follow-up Project call", async () => {
    const gh = new QueuedGhRunner();
    const secret = "unmistakably-fake-project-mutation-token";
    const issue = {
      node_id: "I_new",
      number: 77,
      title: "Example",
      body: JSON.stringify({ id: "prj-example", objective: "Prove the trial flow", repositories: ["repo-example"] }),
      labels: [{ name: "trial" }, { name: "project-record" }],
    };
    gh.enqueue(
      projectPageFixture({ count: 0, totalCount: 0, hasNextPage: false, endCursor: null }),
      [[]],
      issue,
      issue,
      { data: { addProjectV2ItemById: { item: { id: secret } } } },
    );
    const github = new GitHubProjectClient({
      githubOwner: "owner",
      projectNumber: 7,
      registryRepository: "owner/registry",
      preflightProjectItemId: "PVTI_preflight",
      runner: gh,
      catalog: catalogFixture(),
      sensitiveData: createSensitiveDataPolicy({ FAKE_API_TOKEN: secret }),
    });

    const error = await github.registerProject({
      project_id: "prj-example",
      title: "Example",
      objective: "Prove the trial flow",
      repo_ids: ["repo-example"],
      fields: {
        status: "proposed", priority: "P2", health: "unknown",
        next_action: "wait:select-first-task", last_reviewed: "2026-08-13",
      },
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "SENSITIVE_DATA_REJECTED" });
    expect(gh.calls).toHaveLength(5);
    expect(JSON.stringify(error)).not.toContain(secret);
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
    const verifiedPage = projectPageFixture({ count: 1, totalCount: 1, hasNextPage: false, endCursor: null });
    const verifiedItem = verifiedPage.data.user.projectV2.items.nodes[0]!;
    verifiedItem.id = "PVTI_new";
    verifiedItem.content = { __typename: "Issue", id: "I_new" };
    verifiedItem.status = { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "status-proposed", name: "proposed" };
    verifiedItem.health = { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "health-unknown", name: "unknown" };
    verifiedItem.nextAction = { __typename: "ProjectV2ItemFieldTextValue", text: "wait:select-first-task" };
    gh.enqueue(
      project,
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
      verifiedPage,
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

  it("rejects a duplicate source attachment that appears during final verification", async () => {
    const gh = new QueuedGhRunner();
    const initial = projectPageFixture({ count: 0, totalCount: 0, hasNextPage: false, endCursor: null });
    const issue = {
      node_id: "I_new",
      number: 77,
      title: "Example",
      body: JSON.stringify({ id: "prj-example", objective: "Prove the trial flow", repositories: ["repo-example"] }),
      labels: [{ name: "trial" }, { name: "project-record" }],
    };
    const final = projectPageFixture({ count: 2, totalCount: 2, hasNextPage: false, endCursor: null });
    for (const [index, item] of final.data.user.projectV2.items.nodes.entries()) {
      item.id = index === 0 ? "PVTI_new" : "PVTI_duplicate";
      item.content = { __typename: "Issue", id: "I_new" };
      item.status = { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "status-proposed", name: "proposed" };
      item.health = { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "health-unknown", name: "unknown" };
      item.nextAction = { __typename: "ProjectV2ItemFieldTextValue", text: "wait:select-first-task" };
    }
    gh.enqueue(
      initial,
      [[{ node_id: "I_preflight", number: 900, title: "Preflight fixture", body: "unchanged", labels: [{ name: "trial" }] }]],
      issue,
      issue,
      { data: { addProjectV2ItemById: { item: { id: "PVTI_new" } } } },
      { data: { node: { __typename: "ProjectV2Item", id: "PVTI_new", type: "ISSUE", content: { __typename: "Issue", id: "I_new" }, lastReviewed: null } } },
      ...Array.from({ length: 5 }, () => ({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_new" } } } })),
      final,
    );

    await expect(client(gh).registerProject({
      project_id: "prj-example",
      title: "Example",
      objective: "Prove the trial flow",
      repo_ids: ["repo-example"],
      fields: {
        status: "proposed", priority: "P2", health: "unknown",
        next_action: "wait:select-first-task", last_reviewed: "2026-08-13",
      },
    })).rejects.toMatchObject({ code: "DUPLICATE_PROJECT_ITEM" });
  });

  it("reuses exactly one already-attached Project item after an interrupted registration", async () => {
    const gh = new QueuedGhRunner();
    const page = projectPageFixture({ count: 1, totalCount: 1, hasNextPage: false, endCursor: null });
    const item = page.data.user.projectV2.items.nodes[0]!;
    item.id = "PVTI_existing";
    item.content = { __typename: "Issue", id: "I_existing" };
    item.status = { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "status-proposed", name: "proposed" };
    item.health = { __typename: "ProjectV2ItemFieldSingleSelectValue", optionId: "health-unknown", name: "unknown" };
    item.nextAction = { __typename: "ProjectV2ItemFieldTextValue", text: "wait:select" };
    const issue = {
      node_id: "I_existing",
      number: 77,
      title: "Example",
      body: JSON.stringify({ id: "prj-example", objective: "Prove the trial flow", repositories: ["repo-example"] }),
      labels: [{ name: "trial" }, { name: "project-record" }],
    };
    gh.enqueue(
      page,
      [[issue]],
      issue,
      ...Array.from({ length: 5 }, () => ({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_existing" } } } })),
      page,
    );

    await expect(client(gh).registerProject({
      project_id: "prj-example",
      title: "Example",
      objective: "Prove the trial flow",
      repo_ids: ["repo-example"],
      fields: { status: "proposed", priority: "P2", health: "unknown", next_action: "wait:select", last_reviewed: "2026-08-13" },
    })).resolves.toMatchObject({ project_item_id: "PVTI_existing", source_node_id: "I_existing" });

    expect(gh.calls.some((call) => call.args.join(" ").includes("addProjectV2ItemById"))).toBe(false);
  });

  it("fails closed when one Project Record source is attached more than once", async () => {
    const gh = new QueuedGhRunner();
    const page = projectPageFixture({ count: 2, totalCount: 2, hasNextPage: false, endCursor: null });
    for (const item of page.data.user.projectV2.items.nodes) item.content = { __typename: "Issue", id: "I_existing" };
    const issue = {
      node_id: "I_existing",
      number: 77,
      title: "Example",
      body: JSON.stringify({ id: "prj-example", objective: "Prove the trial flow", repositories: ["repo-example"] }),
      labels: [{ name: "trial" }, { name: "project-record" }],
    };
    gh.enqueue(page, [[issue]], issue);

    await expect(client(gh).registerProject({
      project_id: "prj-example", title: "Example", objective: "Prove the trial flow", repo_ids: ["repo-example"],
      fields: { status: "proposed", priority: "P2", health: "unknown", next_action: "wait:select", last_reviewed: "2026-08-13" },
    })).rejects.toMatchObject({ code: "DUPLICATE_PROJECT_ITEM" });
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

  it.each([
    ["project-record-only", [{ name: "project-record" }], ["trial"]],
    ["unlabeled", [], ["trial", "project-record"]],
  ])("finds a canonical %s interrupted record without a label-filtered query", async (_case, labels, missingLabels) => {
    const gh = new QueuedGhRunner();
    const partial = {
      node_id: "I_partial",
      number: 78,
      title: "Example",
      body: JSON.stringify({ id: "prj-example", objective: "Prove the trial flow", repositories: ["repo-example"] }),
      labels,
    };
    gh.enqueue(
      projectPageFixture({ count: 0, totalCount: 0, hasNextPage: false, endCursor: null }),
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
      details: { issue_number: 78, missing_labels: missingLabels },
    });
    const issueList = gh.calls.find((call) => call.credential === "repo");
    expect(issueList?.args).toEqual(expect.arrayContaining(["--paginate", "--slurp"]));
    expect(issueList?.args.some((arg) => arg.startsWith("labels="))).toBe(false);
    expect(gh.calls.some((call) => call.args.includes("POST") && call.args.includes("repos/owner/registry/issues"))).toBe(false);
  });

  it("detects a complete and partial canonical record with the same ID before any create or adoption", async () => {
    const gh = new QueuedGhRunner();
    const complete = {
      node_id: "I_complete",
      number: 79,
      title: "Example",
      body: JSON.stringify({ id: "prj-example", objective: "Prove the trial flow", repositories: ["repo-example"] }),
      labels: [{ name: "trial" }, { name: "project-record" }],
    };
    const partial = { ...complete, node_id: "I_partial", number: 80, labels: [{ name: "trial" }] };
    gh.enqueue(
      projectPageFixture({ count: 0, totalCount: 0, hasNextPage: false, endCursor: null }),
      [[complete, partial]],
    );

    await expect(client(gh).registerProject({
      project_id: "prj-example",
      title: "Example",
      objective: "Prove the trial flow",
      repo_ids: ["repo-example"],
      fields: { status: "proposed", priority: "P2", health: "unknown", next_action: "wait:select", last_reviewed: "2026-08-13" },
    })).rejects.toMatchObject({ code: "DUPLICATE_PROJECT_RECORD" });

    const issueList = gh.calls.find((call) => call.credential === "repo");
    expect(issueList?.args.some((arg) => arg.startsWith("labels="))).toBe(false);
    expect(gh.calls.some((call) => call.args.includes("POST") && call.args.includes("repos/owner/registry/issues"))).toBe(false);
  });
});
