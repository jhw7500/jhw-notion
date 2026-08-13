import { z } from "zod";

import { ControlError } from "./errors.js";
import type { ProcessResult, ProcessRunOptions } from "./process.js";
import {
  ProjectOperationalFieldsSchema,
  ProjectRecordBodySchema,
  ProjectRecordLinkSchema,
  ProjectSnapshotSourceSchema,
  RegisterProjectInputSchema,
  type ProjectFieldDefinition,
  type ProjectOperationalFields,
  type ProjectRecordBody,
  type ProjectRecordLink,
  type ProjectSnapshotItem,
  type ProjectSnapshotSource,
  type RegisterProjectInput,
} from "./schemas.js";

const API_VERSION = "2026-03-10";
const MAX_PROJECT_PAGES = 10_000;
const MAX_ISSUE_PAGES = 10_000;
const PROJECT_RECORD_LABELS = ["trial", "project-record"] as const;
const REQUIRED_OPTIONS = {
  Status: ["proposed", "active", "paused", "completed", "cancelled"],
  Priority: ["P0", "P1", "P2", "P3"],
  Health: ["on-track", "at-risk", "blocked", "unknown"],
} as const;
const REQUIRED_FIELD_TYPES = {
  Status: "SINGLE_SELECT",
  Priority: "SINGLE_SELECT",
  Health: "SINGLE_SELECT",
  "Next Action": "TEXT",
  "Last Reviewed": "DATE",
} as const;

const PROJECT_QUERY = `query ProjectPage($owner: String!, $number: Int!, $fieldCursor: String, $itemCursor: String) {
  user(login: $owner) {
    projectV2(number: $number) {
      id
      updatedAt
      fields(first: 100, after: $fieldCursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { id name } }
        }
      }
      items(first: 100, after: $itemCursor, archivedStates: [ARCHIVED, NOT_ARCHIVED]) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          type
          content { __typename ... on Issue { id } }
          status: fieldValueByName(name: "Status") {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue { optionId name }
          }
          priority: fieldValueByName(name: "Priority") {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue { optionId name }
          }
          health: fieldValueByName(name: "Health") {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue { optionId name }
          }
          nextAction: fieldValueByName(name: "Next Action") {
            __typename
            ... on ProjectV2ItemFieldTextValue { text }
          }
          lastReviewed: fieldValueByName(name: "Last Reviewed") {
            __typename
            ... on ProjectV2ItemFieldDateValue { date }
          }
        }
      }
    }
  }
}`;

const FIELDS_QUERY = `query ProjectFields($owner: String!, $number: Int!, $fieldCursor: String) {
  user(login: $owner) {
    projectV2(number: $number) {
      id
      updatedAt
      fields(first: 100, after: $fieldCursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { id name } }
        }
      }
    }
  }
}`;

const ITEMS_QUERY = `query ProjectItems($owner: String!, $number: Int!, $itemCursor: String) {
  user(login: $owner) {
    projectV2(number: $number) {
      id
      updatedAt
      items(first: 100, after: $itemCursor, archivedStates: [ARCHIVED, NOT_ARCHIVED]) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          type
          content { __typename ... on Issue { id } }
          status: fieldValueByName(name: "Status") { __typename ... on ProjectV2ItemFieldSingleSelectValue { optionId name } }
          priority: fieldValueByName(name: "Priority") { __typename ... on ProjectV2ItemFieldSingleSelectValue { optionId name } }
          health: fieldValueByName(name: "Health") { __typename ... on ProjectV2ItemFieldSingleSelectValue { optionId name } }
          nextAction: fieldValueByName(name: "Next Action") { __typename ... on ProjectV2ItemFieldTextValue { text } }
          lastReviewed: fieldValueByName(name: "Last Reviewed") { __typename ... on ProjectV2ItemFieldDateValue { date } }
        }
      }
    }
  }
}`;

const ADD_ITEM_MUTATION = `mutation Add($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`;
const SET_SINGLE_MUTATION = `mutation SetSingle($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) { projectV2Item { id } }
}`;
const SET_TEXT_MUTATION = `mutation SetText($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { text: $text } }) { projectV2Item { id } }
}`;
const SET_DATE_MUTATION = `mutation SetDate($projectId: ID!, $itemId: ID!, $fieldId: ID!, $date: Date!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { date: $date } }) { projectV2Item { id } }
}`;
const CLEAR_FIELD_MUTATION = `mutation ClearField($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) { projectV2Item { id } }
}`;
const PREFLIGHT_ITEM_QUERY = `query PreflightItem($itemId: ID!) {
  node(id: $itemId) {
    __typename
    ... on ProjectV2Item {
      id
      type
      content { __typename ... on Issue { id } }
      lastReviewed: fieldValueByName(name: "Last Reviewed") { __typename ... on ProjectV2ItemFieldDateValue { date } }
    }
  }
}`;

const PageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().min(1).nullable() }).strict();
const FieldNodeSchema = z.object({
  __typename: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  dataType: z.string().min(1),
  options: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()).optional(),
}).passthrough();
const FieldConnectionSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  pageInfo: PageInfoSchema,
  nodes: z.array(FieldNodeSchema),
}).strict();
const SelectValueSchema = z.object({
  __typename: z.literal("ProjectV2ItemFieldSingleSelectValue"),
  optionId: z.string().min(1),
  name: z.string().min(1),
}).strict();
const TextValueSchema = z.object({ __typename: z.literal("ProjectV2ItemFieldTextValue"), text: z.string() }).strict();
const DateValueSchema = z.object({ __typename: z.literal("ProjectV2ItemFieldDateValue"), date: z.string() }).strict();
const ItemNodeSchema = z.object({
  id: z.string().min(1),
  isArchived: z.boolean(),
  type: z.string().min(1),
  content: z.unknown().nullable(),
  status: z.unknown().nullable(),
  priority: z.unknown().nullable(),
  health: z.unknown().nullable(),
  nextAction: z.unknown().nullable(),
  lastReviewed: z.unknown().nullable(),
}).strict();
const ItemConnectionSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  pageInfo: PageInfoSchema,
  nodes: z.array(ItemNodeSchema),
}).strict();
const ProjectEnvelopeSchema = z.object({
  data: z.object({
    user: z.object({
      projectV2: z.object({
        id: z.string().min(1),
        updatedAt: z.string().min(1),
        fields: FieldConnectionSchema.optional(),
        items: ItemConnectionSchema.optional(),
      }).passthrough().nullable(),
    }).strict().nullable(),
  }).strict(),
}).passthrough();
const IssueSchema = z.object({
  node_id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string().nullable(),
  labels: z.array(z.object({ name: z.string().min(1) }).passthrough()),
  pull_request: z.unknown().optional(),
}).passthrough();
const IssuePagesSchema = z.array(z.array(IssueSchema).max(100)).max(MAX_ISSUE_PAGES);
const MutationItemSchema = z.object({
  data: z.object({ addProjectV2ItemById: z.object({ item: z.object({ id: z.string().min(1) }).strict() }).strict() }).strict(),
}).passthrough();
const MutationUpdateSchema = z.object({
  data: z.object({ updateProjectV2ItemFieldValue: z.object({ projectV2Item: z.object({ id: z.string().min(1) }).strict() }).strict() }).strict(),
}).passthrough();
const MutationClearSchema = z.object({
  data: z.object({ clearProjectV2ItemFieldValue: z.object({ projectV2Item: z.object({ id: z.string().min(1) }).strict() }).strict() }).strict(),
}).passthrough();
const PreflightItemSchema = z.object({
  data: z.object({
    node: z.object({
      __typename: z.literal("ProjectV2Item"),
      id: z.string().min(1),
      type: z.string().min(1),
      content: z.unknown().nullable(),
      lastReviewed: z.unknown().nullable(),
    }).strict().nullable(),
  }).strict(),
}).passthrough();

type FieldNode = z.infer<typeof FieldNodeSchema>;
type ItemNode = z.infer<typeof ItemNodeSchema>;
type Issue = z.infer<typeof IssueSchema>;

export interface GitHubRunner {
  runGh(args: string[], credential: "project" | "repo", options?: ProcessRunOptions): Promise<ProcessResult>;
}

export interface GitHubCatalogPort {
  getRepository(repoId: string): Promise<{ id: string }>;
  getTask(taskId: string): Promise<{ id: string }>;
}

export interface GitHubProjectClientOptions {
  githubOwner: string;
  projectNumber: number;
  registryRepository: string;
  preflightProjectItemId: string;
  runner: GitHubRunner;
  catalog: GitHubCatalogPort;
  now?: () => Date;
}

interface ProjectStructure {
  projectId: string;
  revision: string;
  fields: ProjectFieldDefinition[];
  byName: Map<string, ProjectFieldDefinition>;
}

interface InitialProjectPage {
  projectId: string;
  revision: string;
  fields: z.infer<typeof FieldConnectionSchema>;
  items: z.infer<typeof ItemConnectionSchema>;
}

function jsonFrom<T>(stdout: string, schema: z.ZodType<T>, code: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new ControlError(code, "GitHub returned invalid JSON");
  }
  if (typeof raw === "object" && raw !== null && "errors" in raw) {
    throw new ControlError(code, "GitHub GraphQL returned errors");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ControlError(code, "GitHub response failed strict validation", { issues: parsed.error.issues });
  return parsed.data;
}

function projectFrom(stdout: string): NonNullable<NonNullable<z.infer<typeof ProjectEnvelopeSchema>["data"]["user"]>["projectV2"]> {
  const envelope = jsonFrom(stdout, ProjectEnvelopeSchema, "INVALID_PROJECT_RESPONSE");
  const project = envelope.data.user?.projectV2;
  if (!project) throw new ControlError("PROJECT_NOT_FOUND", "Configured personal Project does not exist");
  return project;
}

function cursor(connection: { pageInfo: { hasNextPage: boolean; endCursor: string | null } }, seen: Set<string>, code: string): string | undefined {
  if (!connection.pageInfo.hasNextPage) return undefined;
  const next = connection.pageInfo.endCursor;
  if (!next || seen.has(next)) throw new ControlError(code, "GitHub pagination cursor is missing or repeated");
  seen.add(next);
  return next;
}

function graphqlArgs(query: string, values: Array<["raw" | "typed", string]>): string[] {
  const args = ["api", "graphql", "--raw-field", `query=${query}`];
  for (const [kind, value] of values) args.push(kind === "raw" ? "--raw-field" : "--field", value);
  return args;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function validateFieldDefinitions(nodes: FieldNode[]): { definitions: ProjectFieldDefinition[]; byName: Map<string, ProjectFieldDefinition> } {
  const definitions: ProjectFieldDefinition[] = [];
  const byName = new Map<string, ProjectFieldDefinition>();
  for (const name of Object.keys(REQUIRED_FIELD_TYPES) as Array<keyof typeof REQUIRED_FIELD_TYPES>) {
    const matches = nodes.filter((node) => node.name === name);
    if (matches.length !== 1) throw new ControlError("INVALID_PROJECT_FIELDS", "Project must contain each required field exactly once", { field: name });
    const raw = matches[0] as FieldNode;
    if (raw.dataType !== REQUIRED_FIELD_TYPES[name]) {
      throw new ControlError("INVALID_PROJECT_FIELDS", "Project field has the wrong data type", { field: name });
    }
    const options = name in REQUIRED_OPTIONS ? raw.options : undefined;
    if (name in REQUIRED_OPTIONS) {
      const expected = REQUIRED_OPTIONS[name as keyof typeof REQUIRED_OPTIONS];
      if (!options || new Set(options.map((option) => option.id)).size !== options.length ||
        JSON.stringify(sorted(options.map((option) => option.name))) !== JSON.stringify(sorted(expected))) {
        throw new ControlError("INVALID_PROJECT_FIELDS", "Project field options do not match the required contract", { field: name });
      }
    } else if (raw.options !== undefined) {
      throw new ControlError("INVALID_PROJECT_FIELDS", "Non-select Project field unexpectedly exposes options", { field: name });
    }
    const definition: ProjectFieldDefinition = {
      id: raw.id,
      name,
      data_type: REQUIRED_FIELD_TYPES[name],
      ...(options ? { options: options.map(({ id, name: optionName }) => ({ id, name: optionName })) } : {}),
    };
    definitions.push(definition);
    byName.set(name, definition);
  }
  return { definitions, byName };
}

function projectBody(body: string | null): ProjectRecordBody {
  if (body === null) throw new ControlError("INVALID_PROJECT_RECORD", "Trial Project Record Issue has no body");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new ControlError("INVALID_PROJECT_RECORD", "Trial Project Record body is not deterministic JSON-subset YAML");
  }
  const parsed = ProjectRecordBodySchema.safeParse(raw);
  if (!parsed.success || JSON.stringify(parsed.data) !== body) {
    throw new ControlError("INVALID_PROJECT_RECORD", "Trial Project Record body is not canonical deterministic JSON-subset YAML");
  }
  return parsed.data;
}

function bodyFor(input: RegisterProjectInput): string {
  return JSON.stringify({ id: input.project_id, objective: input.objective, repositories: input.repo_ids });
}

function hasLabels(issue: Issue, expected: readonly string[]): boolean {
  const names = new Set(issue.labels.map((label) => label.name));
  return expected.every((label) => names.has(label));
}

function issueEqual(issue: Issue, input: RegisterProjectInput): boolean {
  return issue.title === input.title && issue.body === bodyFor(input);
}

function sourceId(raw: unknown): string | undefined {
  const parsed = z.object({ __typename: z.literal("Issue"), id: z.string().min(1) }).strict().safeParse(raw);
  return parsed.success ? parsed.data.id : undefined;
}

function optionId(field: ProjectFieldDefinition, value: string): string {
  const matches = field.options?.filter((option) => option.name === value) ?? [];
  if (matches.length !== 1) throw new ControlError("INVALID_PROJECT_FIELDS", "Unable to resolve Project option ID", { field: field.name });
  return (matches[0] as { id: string }).id;
}

function validateActiveNextAction(fields: ProjectOperationalFields): void {
  if (fields.status !== "active") return;
  const waits = fields.next_action.startsWith("wait:");
  if ((fields.health === "blocked") !== waits) {
    throw new ControlError("INVALID_PROJECT_NEXT_ACTION", "Active Project Next Action does not match its Health");
  }
}

function taskId(fields: ProjectOperationalFields): string | undefined {
  return fields.next_action.startsWith("task:") ? fields.next_action.slice("task:".length) : undefined;
}

function stale(fields: ProjectOperationalFields, now: Date): boolean {
  if (fields.status === "completed" || fields.status === "cancelled") return false;
  const cadences: number[] = [];
  if (fields.priority === "P0") cadences.push(1);
  if (fields.health === "blocked" || fields.health === "at-risk") cadences.push(3);
  if (fields.status === "active") cadences.push(7);
  if (fields.status === "proposed") cadences.push(14);
  if (fields.status === "paused") cadences.push(30);
  if (cadences.length === 0) return false;
  const reviewed = Date.parse(`${fields.last_reviewed}T00:00:00.000Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  return today > reviewed + Math.min(...cadences) * 86_400_000;
}

function operatingFields(node: ItemNode, structure: ProjectStructure): ProjectOperationalFields {
  const status = SelectValueSchema.safeParse(node.status);
  const priority = SelectValueSchema.safeParse(node.priority);
  const health = SelectValueSchema.safeParse(node.health);
  const nextAction = TextValueSchema.safeParse(node.nextAction);
  const lastReviewed = DateValueSchema.safeParse(node.lastReviewed);
    if (!status.success || !priority.success || !health.success || !nextAction.success || !lastReviewed.success) {
    throw new ControlError("INVALID_PROJECT_ITEM", "Project item is missing a valid operating field", { project_item_id: node.id });
  }
  const selected = [
    ["Status", status.data],
    ["Priority", priority.data],
    ["Health", health.data],
  ] as const;
  for (const [name, value] of selected) {
    const field = structure.byName.get(name);
    const options = field?.options?.filter((option) => option.name === value.name) ?? [];
    if (!field || options.length !== 1 || options[0]?.id !== value.optionId) {
      throw new ControlError("INVALID_PROJECT_ITEM", "Project item option ID/name is inconsistent", { project_item_id: node.id, field: name });
    }
  }
  const parsed = ProjectOperationalFieldsSchema.safeParse({
    status: status.data.name,
    priority: priority.data.name,
    health: health.data.name,
    next_action: nextAction.data.text,
    last_reviewed: lastReviewed.data.date,
  });
  if (!parsed.success) throw new ControlError("INVALID_PROJECT_ITEM", "Project item operating fields are invalid", { project_item_id: node.id });
  try {
    validateActiveNextAction(parsed.data);
  } catch {
    throw new ControlError("INVALID_PROJECT_ITEM", "Active Project item Next Action does not match its Health", {
      project_item_id: node.id,
    });
  }
  return parsed.data;
}

/** Strict personal-Project adapter with a repository-token join at immutable Issue node IDs. */
export class GitHubProjectClient {
  private readonly now: () => Date;
  private preflightStructure?: ProjectStructure;

  constructor(private readonly options: GitHubProjectClientOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private assertSupportedOwner(): void {
    const owner = this.options.registryRepository.split("/", 1)[0];
    if (!owner || owner.toLowerCase() !== this.options.githubOwner.toLowerCase()) {
      throw new ControlError("UNSUPPORTED_REGISTRY_OWNER", "Personal Project automation requires a Registry owned by the configured user");
    }
  }

  private coordinates(): Array<["raw" | "typed", string]> {
    return [["raw", `owner=${this.options.githubOwner}`], ["typed", `number=${this.options.projectNumber}`]];
  }

  private async initialPage(): Promise<InitialProjectPage> {
    this.assertSupportedOwner();
    const project = projectFrom((await this.options.runner.runGh(graphqlArgs(PROJECT_QUERY, this.coordinates()), "project")).stdout);
    if (!project.fields || !project.items) throw new ControlError("INVALID_PROJECT_RESPONSE", "Initial Project response is incomplete");
    return { projectId: project.id, revision: project.updatedAt, fields: project.fields, items: project.items };
  }

  private assertStable(project: { id: string; updatedAt: string }, initial: InitialProjectPage): void {
    if (project.id !== initial.projectId || project.updatedAt !== initial.revision) {
      throw new ControlError("PROJECT_CHANGED_DURING_READ", "Project revision changed while it was being paginated");
    }
  }

  private async structure(initial: InitialProjectPage): Promise<ProjectStructure> {
    const nodes = [...initial.fields.nodes];
    const total = initial.fields.totalCount;
    const seen = new Set<string>();
    let next = cursor(initial.fields, seen, "INCOMPLETE_PROJECT_FIELD_READ");
    let pages = 1;
    while (next !== undefined) {
      if (pages++ >= MAX_PROJECT_PAGES) throw new ControlError("INCOMPLETE_PROJECT_FIELD_READ", "Project field pagination exceeded its safety bound");
      const project = projectFrom((await this.options.runner.runGh(graphqlArgs(FIELDS_QUERY, [
        ...this.coordinates(), ["raw", `fieldCursor=${next}`],
      ]), "project")).stdout);
      this.assertStable(project, initial);
      if (!project.fields || project.fields.totalCount !== total) {
        throw new ControlError("INCOMPLETE_PROJECT_FIELD_READ", "Project field count changed during pagination");
      }
      nodes.push(...project.fields.nodes);
      next = cursor(project.fields, seen, "INCOMPLETE_PROJECT_FIELD_READ");
    }
    if (nodes.length !== total || new Set(nodes.map((node) => node.id)).size !== nodes.length) {
      throw new ControlError("INCOMPLETE_PROJECT_FIELD_READ", "Project field pagination was incomplete or duplicated");
    }
    const validated = validateFieldDefinitions(nodes);
    return { projectId: initial.projectId, revision: initial.revision, fields: validated.definitions, byName: validated.byName };
  }

  private async items(initial: InitialProjectPage): Promise<ItemNode[]> {
    const nodes = [...initial.items.nodes];
    const total = initial.items.totalCount;
    const seen = new Set<string>();
    let next = cursor(initial.items, seen, "INCOMPLETE_PROJECT_READ");
    let pages = 1;
    while (next !== undefined) {
      if (pages++ >= MAX_PROJECT_PAGES) throw new ControlError("INCOMPLETE_PROJECT_READ", "Project item pagination exceeded its safety bound");
      const project = projectFrom((await this.options.runner.runGh(graphqlArgs(ITEMS_QUERY, [
        ...this.coordinates(), ["raw", `itemCursor=${next}`],
      ]), "project")).stdout);
      this.assertStable(project, initial);
      if (!project.items || project.items.totalCount !== total) {
        throw new ControlError("INCOMPLETE_PROJECT_READ", "Project item count changed during pagination");
      }
      nodes.push(...project.items.nodes);
      next = cursor(project.items, seen, "INCOMPLETE_PROJECT_READ");
    }
    if (nodes.length !== total || new Set(nodes.map((node) => node.id)).size !== nodes.length) {
      throw new ControlError("INCOMPLETE_PROJECT_READ", "Project item pagination was incomplete or duplicated");
    }
    return nodes;
  }

  private issueHeaders(): string[] {
    return ["-H", "Accept: application/vnd.github+json", "-H", `X-GitHub-Api-Version: ${API_VERSION}`];
  }

  private async listIssues(requiredLabels?: readonly string[]): Promise<Issue[]> {
    this.assertSupportedOwner();
    const endpoint = `repos/${this.options.registryRepository}/issues`;
    const args = [
      "api", "--method", "GET", endpoint,
      ...this.issueHeaders(),
      "--paginate", "--slurp",
      "--raw-field", "state=all",
      ...(requiredLabels === undefined ? [] : ["--raw-field", `labels=${requiredLabels.join(",")}`]),
      "--field", "per_page=100",
    ];
    const pages = jsonFrom(
      (await this.options.runner.runGh(args, "repo")).stdout,
      IssuePagesSchema,
      "INVALID_ISSUE_RESPONSE",
    );
    const allIssues = pages.flat().filter((issue) => issue.pull_request === undefined);
    if (
      new Set(allIssues.map((issue) => issue.node_id)).size !== allIssues.length ||
      new Set(allIssues.map((issue) => issue.number)).size !== allIssues.length
    ) {
      throw new ControlError("INCOMPLETE_ISSUE_READ", "Registry Issue pagination returned duplicate records");
    }
    return requiredLabels === undefined
      ? allIssues
      : allIssues.filter((issue) => hasLabels(issue, requiredLabels));
  }

  private async listProjectRecordIssues(): Promise<Issue[]> {
    const issues = await this.listIssues(PROJECT_RECORD_LABELS);
    for (const issue of issues) projectBody(issue.body);
    return issues;
  }

  private async canonicalProjectRecords(projectId: string): Promise<Issue[]> {
    const candidates: Issue[] = [];
    for (const issue of await this.listIssues()) {
      let body: ProjectRecordBody;
      try {
        body = projectBody(issue.body);
      } catch {
        // Recovery scans every Issue independent of labels. Only canonical
        // Project Record bodies participate in idempotency decisions.
        continue;
      }
      if (body.id === projectId) candidates.push(issue);
    }
    return candidates;
  }

  private async readIssue(number: number): Promise<Issue> {
    return jsonFrom(
      (await this.options.runner.runGh([
        "api", `repos/${this.options.registryRepository}/issues/${number}`, ...this.issueHeaders(),
      ], "repo")).stdout,
      IssueSchema,
      "INVALID_ISSUE_RESPONSE",
    );
  }

  private async createIssue(input: RegisterProjectInput): Promise<Issue> {
    return jsonFrom(
      (await this.options.runner.runGh([
        "api", "--method", "POST", `repos/${this.options.registryRepository}/issues`,
        ...this.issueHeaders(),
        "--raw-field", `title=${input.title}`,
        "--raw-field", `body=${bodyFor(input)}`,
        "--raw-field", "labels[]=trial",
        "--raw-field", "labels[]=project-record",
      ], "repo")).stdout,
      IssueSchema,
      "INVALID_ISSUE_RESPONSE",
    );
  }

  private verifyIssue(issue: Issue, expected: RegisterProjectInput, expectedNodeId?: string): void {
    if (!issueEqual(issue, expected) || (expectedNodeId !== undefined && issue.node_id !== expectedNodeId)) {
      throw new ControlError("PROJECT_REGISTRATION_MISMATCH", "Project Record Issue does not match the approved registration payload");
    }
    if (!hasLabels(issue, PROJECT_RECORD_LABELS)) {
      const names = new Set(issue.labels.map((label) => label.name));
      throw new ControlError(
        "PROJECT_RECORD_LABEL_RECOVERY_REQUIRED",
        "Project Record Issue is missing its disjoint classification labels",
        {
          issue_number: issue.number,
          missing_labels: PROJECT_RECORD_LABELS.filter((label) => !names.has(label)),
        },
      );
    }
  }

  private async addItem(projectId: string, contentId: string): Promise<string> {
    let result: z.infer<typeof MutationItemSchema>;
    try {
      result = jsonFrom(
        (await this.options.runner.runGh(graphqlArgs(ADD_ITEM_MUTATION, [
          ["raw", `projectId=${projectId}`], ["raw", `contentId=${contentId}`],
        ]), "project")).stdout,
        MutationItemSchema,
        "INVALID_PROJECT_MUTATION",
      );
    } catch {
      throw new ControlError("PROJECT_TOKEN_REQUIRES_BROAD_REPO_SCOPE", "Narrow Project credential could not attach the private trial Issue");
    }
    return result.data.addProjectV2ItemById.item.id;
  }

  private async updateField(
    structure: ProjectStructure,
    itemId: string,
    fieldName: keyof typeof REQUIRED_FIELD_TYPES,
    kind: "single" | "text" | "date",
    value: string,
  ): Promise<void> {
    const field = structure.byName.get(fieldName);
    if (!field) throw new ControlError("INVALID_PROJECT_FIELDS", "Required Project field is unavailable", { field: fieldName });
    const query = kind === "single" ? SET_SINGLE_MUTATION : kind === "text" ? SET_TEXT_MUTATION : SET_DATE_MUTATION;
    const variableName = kind === "single" ? "optionId" : kind === "text" ? "text" : "date";
    const variableValue = kind === "single" ? optionId(field, value) : value;
    const result = jsonFrom(
      (await this.options.runner.runGh(graphqlArgs(query, [
        ["raw", `projectId=${structure.projectId}`],
        ["raw", `itemId=${itemId}`],
        ["raw", `fieldId=${field.id}`],
        ["raw", `${variableName}=${variableValue}`],
      ]), "project")).stdout,
      MutationUpdateSchema,
      "INVALID_PROJECT_MUTATION",
    );
    if (result.data.updateProjectV2ItemFieldValue.projectV2Item.id !== itemId) {
      throw new ControlError("INVALID_PROJECT_MUTATION", "Project field mutation returned another item ID");
    }
  }

  async readAll(): Promise<ProjectSnapshotSource> {
    const initial = await this.initialPage();
    const structure = await this.structure(initial);
    const itemNodes = (await this.items(initial)).filter((node) => node.id !== this.options.preflightProjectItemId);
    const parsedItems = itemNodes.map((node) => {
      const source = sourceId(node.content);
      if (!source) throw new ControlError("PROJECT_SOURCE_REDACTED", "Project item source identity is unavailable", { project_item_id: node.id });
      return { node, source, fields: operatingFields(node, structure) };
    });
    const issues = await this.listProjectRecordIssues();
    const byNode = new Map(issues.map((issue) => [issue.node_id, issue]));
    const output: ProjectSnapshotItem[] = [];
    for (const { node, source, fields } of parsedItems) {
      const issue = byNode.get(source);
      if (!issue) throw new ControlError("PROJECT_RECORD_NOT_FOUND", "Project item is not backed by a trial Registry Issue", { project_item_id: node.id });
      const body = projectBody(issue.body);
      await Promise.all(body.repositories.map((repoId) => this.options.catalog.getRepository(repoId)));
      const nextTask = taskId(fields);
      if (nextTask) await this.options.catalog.getTask(nextTask);
      output.push({
        project_item_id: node.id,
        source_node_id: source,
        project_id: body.id,
        title: issue.title,
        objective: body.objective,
        repo_ids: body.repositories,
        fields,
        stale: stale(fields, this.now()),
      });
    }
    const source = ProjectSnapshotSourceSchema.safeParse({
      project_node_id: structure.projectId,
      source_revision: structure.revision,
      field_definitions: structure.fields,
      items: output,
      total_count: output.length,
    });
    if (!source.success) throw new ControlError("INVALID_PROJECT_SOURCE", "Project snapshot source failed validation");
    return source.data;
  }

  async registerProject(rawInput: RegisterProjectInput): Promise<ProjectRecordLink> {
    const input = RegisterProjectInputSchema.safeParse(rawInput);
    if (!input.success) throw new ControlError("INVALID_PROJECT_REGISTRATION", "Project registration input is invalid");
    validateActiveNextAction(input.data.fields);
    await Promise.all(input.data.repo_ids.map((repoId) => this.options.catalog.getRepository(repoId)));
    const nextTask = taskId(input.data.fields);
    if (nextTask) await this.options.catalog.getTask(nextTask);

    const initial = await this.initialPage();
    const structure = await this.structure(initial);
    const matches = await this.canonicalProjectRecords(input.data.project_id);
    if (matches.length > 1) throw new ControlError("DUPLICATE_PROJECT_RECORD", "Multiple canonical Issues use the requested Project ID");
    let issue: Issue;
    if (matches.length === 1) {
      issue = matches[0] as Issue;
      this.verifyIssue(issue, input.data);
    } else {
      issue = await this.createIssue(input.data);
      this.verifyIssue(issue, input.data);
    }
    const verified = await this.readIssue(issue.number);
    this.verifyIssue(verified, input.data, issue.node_id);

    const itemId = await this.addItem(structure.projectId, issue.node_id);
    try {
      if (await this.verifyItemContentId(itemId) !== issue.node_id) throw new Error("attached source mismatch");
    } catch {
      throw new ControlError(
        "PROJECT_TOKEN_REQUIRES_BROAD_REPO_SCOPE",
        "Narrow Project credential could not identify the newly attached private Project Record",
      );
    }
    await this.updateField(structure, itemId, "Status", "single", input.data.fields.status);
    await this.updateField(structure, itemId, "Priority", "single", input.data.fields.priority);
    await this.updateField(structure, itemId, "Health", "single", input.data.fields.health);
    await this.updateField(structure, itemId, "Next Action", "text", input.data.fields.next_action);
    await this.updateField(structure, itemId, "Last Reviewed", "date", input.data.fields.last_reviewed);

    const link = ProjectRecordLinkSchema.safeParse({
      project_id: input.data.project_id,
      project_item_id: itemId,
      source_node_id: issue.node_id,
      issue_number: issue.number,
    });
    if (!link.success) throw new ControlError("INVALID_PROJECT_MUTATION", "Project registration returned invalid coordinates");
    return link.data;
  }

  async verifyFields(): Promise<void> {
    const initial = await this.initialPage();
    this.preflightStructure = await this.structure(initial);
  }

  async addPreflightItem(contentId: string): Promise<string> {
    const structure = this.preflightStructure;
    if (!structure) throw new ControlError("PREFLIGHT_SEQUENCE_INVALID", "Project fields must be verified before the fixture attach probe");
    return this.addItem(structure.projectId, contentId);
  }

  private async preflightItem(itemId: string): Promise<z.infer<typeof PreflightItemSchema>["data"]["node"]> {
    return jsonFrom(
      (await this.options.runner.runGh(graphqlArgs(PREFLIGHT_ITEM_QUERY, [["raw", `itemId=${itemId}`]]), "project")).stdout,
      PreflightItemSchema,
      "INVALID_PREFLIGHT_ITEM",
    ).data.node;
  }

  async verifyItemContentId(itemId: string): Promise<string | undefined> {
    const item = await this.preflightItem(itemId);
    if (!item || item.id !== itemId) return undefined;
    return sourceId(item.content);
  }

  async readLastReviewed(itemId: string): Promise<string | undefined> {
    const item = await this.preflightItem(itemId);
    if (!item || item.id !== itemId) throw new ControlError("INVALID_PREFLIGHT_ITEM", "Configured preflight Project item does not exist");
    if (item.lastReviewed === null) return undefined;
    const parsed = DateValueSchema.safeParse(item.lastReviewed);
    if (!parsed.success || !ProjectOperationalFieldsSchema.shape.last_reviewed.safeParse(parsed.data.date).success) {
      throw new ControlError("INVALID_PREFLIGHT_ITEM", "Preflight Last Reviewed value is invalid");
    }
    return parsed.data.date;
  }

  async writeLastReviewed(itemId: string, date: string): Promise<void> {
    const structure = this.preflightStructure;
    if (!structure) throw new ControlError("PREFLIGHT_SEQUENCE_INVALID", "Project fields must be verified before the date probe");
    await this.updateField(structure, itemId, "Last Reviewed", "date", date);
  }

  async clearLastReviewed(itemId: string): Promise<void> {
    const structure = this.preflightStructure;
    const field = structure?.byName.get("Last Reviewed");
    if (!structure || !field) throw new ControlError("PREFLIGHT_SEQUENCE_INVALID", "Project fields must be verified before the date probe");
    const result = jsonFrom(
      (await this.options.runner.runGh(graphqlArgs(CLEAR_FIELD_MUTATION, [
        ["raw", `projectId=${structure.projectId}`], ["raw", `itemId=${itemId}`], ["raw", `fieldId=${field.id}`],
      ]), "project")).stdout,
      MutationClearSchema,
      "INVALID_PROJECT_MUTATION",
    );
    if (result.data.clearProjectV2ItemFieldValue.projectV2Item.id !== itemId) {
      throw new ControlError("INVALID_PROJECT_MUTATION", "Project clear mutation returned another item ID");
    }
  }
}
