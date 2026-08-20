import { z } from "zod";

import { ControlError } from "./errors.js";
import type { ProcessResult, ProcessRunOptions } from "./process.js";
import type { RegistrationHint, RegistrationHintPort } from "./registration-hint.js";
import { assertNoAbsoluteHostPaths, createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";
import {
  ProjectOperationalFieldsSchema,
  ProjectRecordBodySchema,
  ProjectRecordLinkSchema,
  ProjectRecordUpdateSchema,
  ProjectSnapshotSourceSchema,
  RegisterProjectInputSchema,
  UpdateProjectInputSchema,
  type ProjectFieldDefinition,
  type ProjectOperationalFields,
  type ProjectRecordBody,
  type ProjectRecordLink,
  type ProjectRecordUpdate,
  type ProjectSnapshotItem,
  type ProjectSnapshotSource,
  type RegisterProjectInput,
  type UpdateProjectInput,
} from "./schemas.js";

const MAX_PROJECT_PAGES = 10_000;
/**
 * Why the durable registration record stopped helping. Unreadable and
 * at-capacity are repaired by deleting the file; unwritable is repaired by
 * fixing the state directory. All three leave registration correct and slow.
 */
export type RegistrationRecordWarning =
  | "REGISTRATION_RECORD_UNREADABLE"
  | "REGISTRATION_RECORD_UNWRITABLE"
  | "REGISTRATION_RECORD_AT_CAPACITY";

/**
 * Maps a store failure to the repair it needs. State the store rejected — a
 * damaged file, a path it will not follow — is the same problem a read would
 * have reported, and is fixed by removing the file. Anything else is the
 * directory or the disk.
 */
function recordFailure(cause: unknown): RegistrationRecordWarning {
  if (!(cause instanceof ControlError)) return "REGISTRATION_RECORD_UNWRITABLE";
  if (cause.code === "REGISTRATION_HINT_AT_CAPACITY") return "REGISTRATION_RECORD_AT_CAPACITY";
  if (cause.code === "INVALID_REGISTRATION_HINT_STATE" || cause.code === "UNSAFE_STATE_PATH") {
    return "REGISTRATION_RECORD_UNREADABLE";
  }
  return "REGISTRATION_RECORD_UNWRITABLE";
}
// A Project field write is visible to its own read-back only eventually, so an
// update confirms through a bounded backoff instead of a single immediate read.
const UPDATE_VERIFY_ATTEMPTS = 4;
const UPDATE_VERIFY_BACKOFF_MS = 250;
// Registration waits far longer than an update, and its two waits are budgeted
// differently because their cost and benefit are inverted. Reading back after a
// write costs nothing when the write is already visible, so it gets the full
// window. Confirming that no record exists is paid by every registration that
// creates, and its main case — a retry of a run that already created the
// DraftIssue — is now answered exactly by the recorded coordinates, so one
// attempt is left to cover what the record cannot: a run that died before it
// could record anything.
const REGISTER_VERIFY_ATTEMPTS = 4;
const REGISTER_ABSENCE_ATTEMPTS = 2;
const REGISTER_BACKOFF_MS = 2_000;
const PREFLIGHT_DRAFT_TITLE = "[TRIAL] Project Control Preflight Fixture";
const PREFLIGHT_DRAFT_BODY = "unchanged";
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
const apiId = z.string().min(1).max(256).refine((value) => Buffer.byteLength(value, "utf8") <= 256);
const apiName = z.string().min(1).max(256).refine((value) => Buffer.byteLength(value, "utf8") <= 256);

const PROJECT_QUERY = `query ProjectPage($owner: String!, $number: Int!, $fieldCursor: String, $itemCursor: String) {
  user(login: $owner) {
    projectV2(number: $number) {
      id
      public
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
          content {
            __typename
            ... on DraftIssue { id title body }
          }
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
      public
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
      public
      updatedAt
      items(first: 100, after: $itemCursor, archivedStates: [ARCHIVED, NOT_ARCHIVED]) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          type
          content {
            __typename
            ... on DraftIssue { id title body }
          }
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

const ADD_DRAFT_MUTATION = `mutation AddDraft($projectId: ID!, $title: String!, $body: String!) {
  addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) {
    projectItem {
      id
      type
      content { __typename ... on DraftIssue { id title body } }
    }
  }
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
// Resolving a hint reads exactly the item it names. The list query would answer
// the same question, but it paginates the whole Project and lags behind a fresh
// write for longer, which is the delay this lookup exists to avoid.
const HINTED_ITEM_QUERY = `query HintedProjectRecord($itemId: ID!) {
  node(id: $itemId) {
    __typename
    ... on ProjectV2Item {
      id
      isArchived
      type
      project { id }
      content {
        __typename
        ... on DraftIssue { id title body }
      }
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
}`;
const PREFLIGHT_ITEM_QUERY = `query PreflightItem($itemId: ID!) {
  node(id: $itemId) {
    __typename
    ... on ProjectV2Item {
      id
      type
      content {
        __typename
        ... on DraftIssue { id title body }
      }
      lastReviewed: fieldValueByName(name: "Last Reviewed") { __typename ... on ProjectV2ItemFieldDateValue { date } }
    }
  }
}`;

const PageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: apiId.nullable() }).strict();
const FieldNodeSchema = z.object({
  __typename: apiName,
  id: apiId,
  name: apiName,
  dataType: apiName,
  options: z.array(z.object({ id: apiId, name: apiName }).strict()).max(100).optional(),
}).passthrough();
const FieldConnectionSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  pageInfo: PageInfoSchema,
  nodes: z.array(FieldNodeSchema),
}).strict();
const SelectValueSchema = z.object({
  __typename: z.literal("ProjectV2ItemFieldSingleSelectValue"),
  optionId: apiId,
  name: apiName,
}).strict();
const TextValueSchema = z.object({ __typename: z.literal("ProjectV2ItemFieldTextValue"), text: z.string().max(4096) }).strict();
const DateValueSchema = z.object({ __typename: z.literal("ProjectV2ItemFieldDateValue"), date: z.string().max(64) }).strict();
const ItemNodeSchema = z.object({
  id: apiId,
  isArchived: z.boolean(),
  type: apiName,
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
        id: apiId,
        public: z.boolean(),
        updatedAt: z.string().max(64).datetime({ offset: true }),
        fields: FieldConnectionSchema.optional(),
        items: ItemConnectionSchema.optional(),
      }).passthrough().nullable(),
    }).strict().nullable(),
  }).strict(),
}).passthrough();
const DraftIssueSchema = z.object({
  __typename: z.literal("DraftIssue"),
  id: apiId,
  title: z.string().min(1).max(256),
  body: z.string().max(64 * 1024),
}).strict();
const MutationDraftSchema = z.object({
  data: z.object({
    addProjectV2DraftIssue: z.object({
      projectItem: z.object({
        id: apiId,
        type: z.literal("DRAFT_ISSUE"),
        content: DraftIssueSchema,
      }).strict(),
    }).strict(),
  }).strict(),
}).passthrough();
const MutationUpdateSchema = z.object({
  data: z.object({ updateProjectV2ItemFieldValue: z.object({ projectV2Item: z.object({ id: apiId }).strict() }).strict() }).strict(),
}).passthrough();
const MutationClearSchema = z.object({
  data: z.object({ clearProjectV2ItemFieldValue: z.object({ projectV2Item: z.object({ id: apiId }).strict() }).strict() }).strict(),
}).passthrough();
const HintedItemSchema = z.object({
  __typename: z.literal("ProjectV2Item"),
  id: apiId,
  isArchived: z.boolean(),
  type: apiName,
  project: z.object({ id: apiId }).strict(),
  content: z.unknown().nullable(),
  status: z.unknown().nullable(),
  priority: z.unknown().nullable(),
  health: z.unknown().nullable(),
  nextAction: z.unknown().nullable(),
  lastReviewed: z.unknown().nullable(),
}).strict();
const HintedItemResponseSchema = z.object({
  data: z.object({ node: HintedItemSchema.nullable() }).strict(),
}).passthrough();
const PreflightItemSchema = z.object({
  data: z.object({
    node: z.object({
      __typename: z.literal("ProjectV2Item"),
      id: apiId,
      type: apiName,
      content: z.unknown().nullable(),
      lastReviewed: z.unknown().nullable(),
    }).strict().nullable(),
  }).strict(),
}).passthrough();

type FieldNode = z.infer<typeof FieldNodeSchema>;
type ItemNode = z.infer<typeof ItemNodeSchema>;
type DraftIssue = z.infer<typeof DraftIssueSchema>;

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
  preflightProjectItemId: string;
  runner: GitHubRunner;
  catalog: GitHubCatalogPort;
  now?: () => Date;
  sensitiveData?: SensitiveDataPolicy;
  /** Test-only replacement for the bounded update read-back backoff. */
  sleep?: (milliseconds: number) => Promise<void>;
  /**
   * Durable index of the Project Records this host created. Without one,
   * registration resolves a lagging read by waiting alone.
   */
  registrationHints?: RegistrationHintPort;
  /**
   * Told when that index could not do its job. The registration still
   * succeeds, so without this the only symptom is that registering got slow
   * again, which is not something an operator can be expected to notice.
   */
  onRegistrationRecordUnavailable?: (code: RegistrationRecordWarning) => void;
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
  if (!parsed.success) throw new ControlError(code, "GitHub response failed strict validation");
  return parsed.data;
}

function projectFrom(stdout: string): NonNullable<NonNullable<z.infer<typeof ProjectEnvelopeSchema>["data"]["user"]>["projectV2"]> {
  const envelope = jsonFrom(stdout, ProjectEnvelopeSchema, "INVALID_PROJECT_RESPONSE");
  const project = envelope.data.user?.projectV2;
  if (!project) throw new ControlError("PROJECT_NOT_FOUND", "Configured personal Project does not exist");
  if (project.public) throw new ControlError("PROJECT_NOT_PRIVATE", "Phase 1A requires a private GitHub Project");
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

function projectBody(body: string): ProjectRecordBody {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new ControlError("INVALID_PROJECT_RECORD", "Trial Project Record body is not deterministic JSON");
  }
  const parsed = ProjectRecordBodySchema.safeParse(raw);
  if (!parsed.success || JSON.stringify(parsed.data) !== body) {
    throw new ControlError("INVALID_PROJECT_RECORD", "Trial Project Record body is not canonical deterministic JSON");
  }
  return parsed.data;
}

function bodyFor(input: RegisterProjectInput): string {
  return JSON.stringify({ id: input.project_id, objective: input.objective, repositories: input.repo_ids });
}

function draftIssue(raw: unknown): DraftIssue | undefined {
  const parsed = DraftIssueSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
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

/**
 * Parses the five stored operating fields without asserting the resting active
 * rule. A partially applied write can leave every field present yet violate the
 * Health/Next Action coupling, and that record still has to be readable so an
 * approved patch can repair it.
 */
function storedOperatingFields(node: ItemNode, structure: ProjectStructure): ProjectOperationalFields {
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
  return parsed.data;
}

function operatingFields(node: ItemNode, structure: ProjectStructure): ProjectOperationalFields {
  const stored = storedOperatingFields(node, structure);
  try {
    validateActiveNextAction(stored);
  } catch {
    throw new ControlError("INVALID_PROJECT_ITEM", "Active Project item Next Action does not match its Health", {
      project_item_id: node.id,
    });
  }
  return stored;
}

type RegistrationFieldUpdate = {
  fieldName: keyof typeof REQUIRED_FIELD_TYPES;
  kind: "single" | "text" | "date";
  value: string;
};

function registrationFieldUpdates(fields: ProjectOperationalFields): RegistrationFieldUpdate[] {
  return [
    { fieldName: "Status", kind: "single", value: fields.status },
    { fieldName: "Priority", kind: "single", value: fields.priority },
    { fieldName: "Health", kind: "single", value: fields.health },
    { fieldName: "Next Action", kind: "text", value: fields.next_action },
    { fieldName: "Last Reviewed", kind: "date", value: fields.last_reviewed },
  ];
}

function changedFieldUpdates(
  current: ProjectOperationalFields,
  merged: ProjectOperationalFields,
): RegistrationFieldUpdate[] {
  const before = new Map(registrationFieldUpdates(current).map((update) => [update.fieldName, update.value]));
  const changed = registrationFieldUpdates(merged).filter((update) => before.get(update.fieldName) !== update.value);
  // The Next Action/Health rule binds only while Status is active, so a record
  // entering active writes Status last and one leaving active writes it first.
  // That removes the window where a concurrent reader would reject a partially
  // applied record; an active-to-active change cannot avoid one because the
  // Project API has no multi-field mutation.
  const status = changed.filter((update) => update.fieldName === "Status");
  const others = changed.filter((update) => update.fieldName !== "Status");
  return merged.status === "active" ? [...others, ...status] : [...status, ...others];
}

/** Reads operating fields, treating a partially applied write as not yet settled. */
function settledOperatingFields(node: ItemNode, structure: ProjectStructure): ProjectOperationalFields | undefined {
  try {
    return operatingFields(node, structure);
  } catch (cause) {
    if (cause instanceof ControlError && cause.code === "INVALID_PROJECT_ITEM") return undefined;
    throw cause;
  }
}

function missingRegistrationFields(
  node: ItemNode,
  structure: ProjectStructure,
  expected: ProjectOperationalFields,
): RegistrationFieldUpdate[] {
  const updates = registrationFieldUpdates(expected);
  const rawByField: Record<RegistrationFieldUpdate["fieldName"], unknown> = {
    Status: node.status,
    Priority: node.priority,
    Health: node.health,
    "Next Action": node.nextAction,
    "Last Reviewed": node.lastReviewed,
  };
  const missing: RegistrationFieldUpdate[] = [];
  for (const update of updates) {
    const raw = rawByField[update.fieldName];
    if (raw === null) {
      missing.push(update);
      continue;
    }
    let matches = false;
    if (update.kind === "single") {
      const actual = SelectValueSchema.safeParse(raw);
      const field = structure.byName.get(update.fieldName);
      matches = actual.success && field !== undefined &&
        actual.data.name === update.value && actual.data.optionId === optionId(field, update.value);
    } else if (update.kind === "text") {
      const actual = TextValueSchema.safeParse(raw);
      matches = actual.success && actual.data.text === update.value;
    } else {
      const actual = DateValueSchema.safeParse(raw);
      matches = actual.success && actual.data.date === update.value;
    }
    if (!matches) {
      throw new ControlError(
        "PROJECT_REGISTRATION_MISMATCH",
        "Existing Project Record field differs from the approved registration payload",
        { project_item_id: node.id, field: update.fieldName },
      );
    }
  }
  return missing;
}

/** Strict personal-Project adapter whose records are project-only DraftIssues. */
export class GitHubProjectClient {
  private readonly now: () => Date;
  private readonly sensitiveData: SensitiveDataPolicy;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private preflightStructure?: ProjectStructure;

  constructor(private readonly options: GitHubProjectClientOptions) {
    this.now = options.now ?? (() => new Date());
    this.sensitiveData = options.sensitiveData ?? createSensitiveDataPolicy();
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }));
  }

  private coordinates(): Array<["raw" | "typed", string]> {
    return [["raw", `owner=${this.options.githubOwner}`], ["typed", `number=${this.options.projectNumber}`]];
  }

  private projectResponse(stdout: string): ReturnType<typeof projectFrom> {
    const project = projectFrom(stdout);
    this.assertContentSafe(project);
    return project;
  }

  private safeApiResult<T>(value: T): T {
    this.assertContentSafe(value);
    return value;
  }

  private assertContentSafe(value: unknown): void {
    this.sensitiveData.assertSafe(value);
    assertNoAbsoluteHostPaths(value);
  }

  private async initialPage(): Promise<InitialProjectPage> {
    const project = this.projectResponse((await this.options.runner.runGh(graphqlArgs(PROJECT_QUERY, this.coordinates()), "project")).stdout);
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
      const project = this.projectResponse((await this.options.runner.runGh(graphqlArgs(FIELDS_QUERY, [
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
      const project = this.projectResponse((await this.options.runner.runGh(graphqlArgs(ITEMS_QUERY, [
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

  private recordItems(nodes: ItemNode[]): Array<{ node: ItemNode; content: DraftIssue; body: ProjectRecordBody }> {
    const fixtures = nodes.filter((node) => node.id === this.options.preflightProjectItemId);
    if (fixtures.length !== 1) {
      throw new ControlError("INVALID_PREFLIGHT_ITEM", "The dedicated Project must contain exactly one configured preflight fixture");
    }
    this.assertPreflightItem(fixtures[0] as ItemNode, this.options.preflightProjectItemId);
    const records: Array<{ node: ItemNode; content: DraftIssue; body: ProjectRecordBody }> = [];
    for (const node of nodes) {
      if (node.id === this.options.preflightProjectItemId) continue;
      const content = draftIssue(node.content);
      if (node.type !== "DRAFT_ISSUE" || !content) {
        throw new ControlError(
          "INVALID_PROJECT_RECORD",
          "The dedicated Project contains a non-record item",
          { project_item_id: node.id },
        );
      }
      records.push({ node, content, body: projectBody(content.body) });
    }
    if (new Set(records.map(({ node }) => node.id)).size !== records.length) {
      throw new ControlError("DUPLICATE_PROJECT_ITEM", "Project item identity is duplicated");
    }
    if (new Set(records.map(({ content }) => content.id)).size !== records.length) {
      throw new ControlError("DUPLICATE_PROJECT_ITEM", "One DraftIssue source is attached more than once");
    }
    if (new Set(records.map(({ body }) => body.id)).size !== records.length) {
      throw new ControlError("DUPLICATE_PROJECT_RECORD", "Multiple DraftIssues claim one canonical Project ID");
    }
    return records;
  }

  private verifyRecord(
    record: { content: DraftIssue; body: ProjectRecordBody },
    expected: RegisterProjectInput,
  ): void {
    if (record.content.title !== expected.title || record.content.body !== bodyFor(expected)) {
      throw new ControlError("PROJECT_REGISTRATION_MISMATCH", "Project Record DraftIssue does not match the approved registration payload");
    }
  }

  private async createDraft(structure: ProjectStructure, input: RegisterProjectInput): Promise<{ itemId: string; content: DraftIssue }> {
    this.assertContentSafe(input);
    const result = this.safeApiResult(jsonFrom(
      (await this.options.runner.runGh(graphqlArgs(ADD_DRAFT_MUTATION, [
        ["raw", `projectId=${structure.projectId}`],
        ["raw", `title=${input.title}`],
        ["raw", `body=${bodyFor(input)}`],
      ]), "project")).stdout,
      MutationDraftSchema,
      "INVALID_PROJECT_MUTATION",
    ));
    const created = result.data.addProjectV2DraftIssue.projectItem;
    const record = { content: created.content, body: projectBody(created.content.body) };
    this.verifyRecord(record, input);
    return { itemId: created.id, content: created.content };
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
    const result = this.safeApiResult(jsonFrom(
      (await this.options.runner.runGh(graphqlArgs(query, [
        ["raw", `projectId=${structure.projectId}`],
        ["raw", `itemId=${itemId}`],
        ["raw", `fieldId=${field.id}`],
        ["raw", `${variableName}=${variableValue}`],
      ]), "project")).stdout,
      MutationUpdateSchema,
      "INVALID_PROJECT_MUTATION",
    ));
    if (result.data.updateProjectV2ItemFieldValue.projectV2Item.id !== itemId) {
      throw new ControlError("INVALID_PROJECT_MUTATION", "Project field mutation returned another item ID");
    }
  }

  async readAll(): Promise<ProjectSnapshotSource> {
    const initial = await this.initialPage();
    const structure = await this.structure(initial);
    const records = this.recordItems(await this.items(initial));
    const output: ProjectSnapshotItem[] = [];
    for (const { node, content, body } of records) {
      await Promise.all(body.repositories.map((repoId) => this.options.catalog.getRepository(repoId)));
      const fields = operatingFields(node, structure);
      const nextTask = taskId(fields);
      if (nextTask) await this.options.catalog.getTask(nextTask);
      output.push({
        project_item_id: node.id,
        source_node_id: content.id,
        project_id: body.id,
        title: content.title,
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
    this.assertContentSafe(source.data);
    return source.data;
  }

  /** Proves the canonical Project Record, its repository relation, and one attachment. */
  async requireProjectRepository(projectId: string, repoId: string): Promise<void> {
    const initial = await this.initialPage();
    const matches = this.recordItems(await this.items(initial)).filter(({ body }) => body.id === projectId);
    if (matches.length === 0) throw new ControlError("PROJECT_RECORD_NOT_FOUND", "Canonical Project Record does not exist");
    if (matches.length !== 1) throw new ControlError("DUPLICATE_PROJECT_RECORD", "Canonical Project Record is ambiguous");
    const match = matches[0] as { node: ItemNode; content: DraftIssue; body: ProjectRecordBody };
    if (!match.body.repositories.includes(repoId)) {
      throw new ControlError("PROJECT_REPOSITORY_MISMATCH", "Project Record does not contain the canonical Repository");
    }
  }

  async registerProject(rawInput: RegisterProjectInput): Promise<ProjectRecordLink> {
    this.assertContentSafe(rawInput);
    const input = RegisterProjectInputSchema.safeParse(rawInput);
    if (!input.success) throw new ControlError("INVALID_PROJECT_REGISTRATION", "Project registration input is invalid");
    validateActiveNextAction(input.data.fields);
    await Promise.all(input.data.repo_ids.map((repoId) => this.options.catalog.getRepository(repoId)));
    const nextTask = taskId(input.data.fields);
    if (nextTask) await this.options.catalog.getTask(nextTask);

    const initial = await this.initialPage();
    const structure = await this.structure(initial);
    const initialItems = await this.items(initial);
    const matches = this.recordItems(initialItems).filter(({ body }) => body.id === input.data.project_id);
    if (matches.length > 1) throw new ControlError("DUPLICATE_PROJECT_RECORD", "Multiple DraftIssues use the requested Project ID");
    let itemId: string;
    let sourceNodeId: string;
    let updates: RegistrationFieldUpdate[];
    // Creating is the only irreversible step here, so an empty read is resolved
    // against the recorded coordinates first and then confirmed across the
    // visibility window before it is taken.
    const existing = matches[0] ?? await this.resolveAbsentRecord(input.data.project_id, structure);
    if (existing) {
      const match = existing;
      this.verifyRecord(match, input.data);
      itemId = match.node.id;
      sourceNodeId = match.content.id;
      updates = missingRegistrationFields(match.node, structure, input.data.fields);
    } else {
      const created = await this.createDraft(structure, input.data);
      itemId = created.itemId;
      sourceNodeId = created.content.id;
      updates = registrationFieldUpdates(input.data.fields);
    }
    // Recording where the record is turns the next run's empty listing into an
    // exact lookup. It is written for a reused record too, because a listing
    // that showed it now is not one that will show it in a second.
    await this.rememberHint({
      project_id: input.data.project_id,
      item_id: itemId,
      source_node_id: sourceNodeId,
    });
    for (const update of updates) {
      await this.updateField(structure, itemId, update.fieldName, update.kind, update.value);
    }
    await this.verifyRegisteredItem(itemId, sourceNodeId, input.data, structure);

    const link = ProjectRecordLinkSchema.safeParse({
      project_id: input.data.project_id,
      project_item_id: itemId,
      source_node_id: sourceNodeId,
    });
    if (!link.success) throw new ControlError("INVALID_PROJECT_MUTATION", "Project registration returned invalid coordinates");
    return link.data;
  }

  /** Patches only the operating fields of one existing canonical Project Record. */
  async updateProject(rawInput: UpdateProjectInput): Promise<ProjectRecordUpdate> {
    this.assertContentSafe(rawInput);
    const input = UpdateProjectInputSchema.safeParse(rawInput);
    if (!input.success) throw new ControlError("INVALID_PROJECT_UPDATE", "Project update input is invalid");

    const initial = await this.initialPage();
    const structure = await this.structure(initial);
    const matches = this.recordItems(await this.items(initial)).filter(({ body }) => body.id === input.data.project_id);
    if (matches.length === 0) throw new ControlError("PROJECT_RECORD_NOT_FOUND", "Canonical Project Record does not exist");
    if (matches.length > 1) throw new ControlError("DUPLICATE_PROJECT_RECORD", "Multiple DraftIssues use the requested Project ID");
    const match = matches[0] as { node: ItemNode; content: DraftIssue; body: ProjectRecordBody };

    // Title, objective, and repositories stay the record's immutable identity.
    // The stored read deliberately skips the resting active rule: a record left
    // mid-reconfiguration violates it, and refusing to read that record would
    // make the approved patch that repairs it unreachable. The merged result is
    // still held to the rule below, so no update can leave a record invalid.
    const current = storedOperatingFields(match.node, structure);
    const merged = ProjectOperationalFieldsSchema.safeParse({ ...current, ...input.data.fields });
    if (!merged.success) throw new ControlError("INVALID_PROJECT_UPDATE", "Merged Project operating fields are invalid");
    validateActiveNextAction(merged.data);
    const updates = changedFieldUpdates(current, merged.data);
    // Prove every Task reference this patch asserts, including one restated at
    // its current value, because naming it is the operator's claim that it
    // exists. A patch that omits Next Action is never blocked by the reference
    // the record already carried.
    // Repository membership is not re-proven: this command cannot change it,
    // and registration already established it for the record being patched.
    if (input.data.fields.next_action !== undefined) {
      const nextTask = taskId(merged.data);
      if (nextTask) await this.options.catalog.getTask(nextTask);
    }

    for (const update of updates) {
      await this.updateField(structure, match.node.id, update.fieldName, update.kind, update.value);
    }
    await this.verifyUpdatedItem(match.node.id, match.content, merged.data, structure);

    const updated = ProjectRecordUpdateSchema.safeParse({
      project_id: input.data.project_id,
      project_item_id: match.node.id,
      source_node_id: match.content.id,
      fields: merged.data,
    });
    if (!updated.success) throw new ControlError("INVALID_PROJECT_MUTATION", "Project update returned invalid coordinates");
    return updated.data;
  }

  private async verifyUpdatedItem(
    itemId: string,
    content: DraftIssue,
    expected: ProjectOperationalFields,
    structure: ProjectStructure,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const page = await this.initialPage();
      const matches = this.recordItems(await this.items(page)).filter((record) => record.content.id === content.id);
      if (matches.length > 1) {
        throw new ControlError("DUPLICATE_PROJECT_ITEM", "Project Record DraftIssue is attached more than once after the update");
      }
      const match = matches[0];
      if (!match || match.node.id !== itemId) {
        throw new ControlError("PROJECT_UPDATE_MISMATCH", "Updated Project item identity failed final verification");
      }
      if (match.content.title !== content.title || match.content.body !== content.body) {
        throw new ControlError("PROJECT_UPDATE_MISMATCH", "Project Record identity changed during the operating-field update");
      }
      const actual = settledOperatingFields(match.node, structure);
      if (actual && JSON.stringify(actual) === JSON.stringify(expected)) return;
      if (attempt >= UPDATE_VERIFY_ATTEMPTS) {
        // Distinguish a read that never settled from one that settled on
        // another writer's values: only the error code reaches the operator.
        if (!actual) throw new ControlError("PROJECT_UPDATE_UNSETTLED", "Updated Project fields never settled within the bounded read-back");
        throw new ControlError("PROJECT_UPDATE_MISMATCH", "Updated Project fields failed final verification");
      }
      await this.sleep(UPDATE_VERIFY_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }

  /**
   * Resolves an empty first read. Recorded coordinates answer it exactly and
   * immediately, which is what a retry of an interrupted registration needs;
   * anything else falls back to confirming absence by waiting.
   */
  private async resolveAbsentRecord(
    projectId: string,
    structure: ProjectStructure,
  ): Promise<{ node: ItemNode; content: DraftIssue; body: ProjectRecordBody } | undefined> {
    const hint = await this.readHint(projectId);
    if (hint) {
      const record = await this.recordFromHint(hint.item_id, projectId, structure);
      if (record) return record;
    }
    return this.awaitVisibleRecord(projectId);
  }

  /**
   * Reads the exact item a hint names. The hint is a shortcut, never authority:
   * anything unresolvable, foreign, or unparseable falls back to the ordinary
   * path rather than deciding anything on its own.
   */
  private async recordFromHint(
    itemId: string,
    projectId: string,
    structure: ProjectStructure,
  ): Promise<{ node: ItemNode; content: DraftIssue; body: ProjectRecordBody } | undefined> {
    // The configured fixture is never a Project Record, so a hint naming it is
    // corrupt rather than resumable.
    if (itemId === this.options.preflightProjectItemId) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse((await this.options.runner.runGh(
        graphqlArgs(HINTED_ITEM_QUERY, [["raw", `itemId=${itemId}`]]),
        "project",
      )).stdout);
    } catch {
      return undefined;
    }
    if (typeof raw === "object" && raw !== null && "errors" in raw) return undefined;
    const response = HintedItemResponseSchema.safeParse(raw);
    if (!response.success) return undefined;
    const node = response.data.data.node;
    if (!node) return undefined;
    // Ownership is settled before the content is inspected at all: another
    // Project's item is not this registration's to scan, let alone to reuse.
    if (node.project.id !== structure.projectId) return undefined;
    // From here the content gates still apply in full: a hint may select which
    // item to look at, but never what counts as a usable record. A node that
    // fails the content policy is discarded unread rather than raised — the
    // shortcut must not turn a registration that would have succeeded into a
    // failure, and the listing this falls back to applies the same policy.
    try {
      this.assertContentSafe(node);
    } catch {
      return undefined;
    }
    const content = draftIssue(node.content);
    if (node.type !== "DRAFT_ISSUE" || !content) return undefined;
    let body: ProjectRecordBody;
    try {
      body = projectBody(content.body);
    } catch {
      return undefined;
    }
    if (body.id !== projectId) return undefined;
    return {
      node: {
        id: node.id,
        isArchived: node.isArchived,
        type: node.type,
        content: node.content,
        status: node.status,
        priority: node.priority,
        health: node.health,
        nextAction: node.nextAction,
        lastReviewed: node.lastReviewed,
      },
      content,
      body,
    };
  }

  /** A store that cannot be read simply has nothing to offer: the caller's
   * fallback is the same wait it would have done without one. */
  private async readHint(projectId: string): Promise<RegistrationHint | undefined> {
    try {
      return await this.options.registrationHints?.read(projectId);
    } catch (cause) {
      // Classified the same way the write classifies it. Reading and writing
      // fail for the same reasons — the write reads first — so hardcoding one
      // of them made the reported repair depend on which call happened to run.
      this.reportRecordUnavailable(recordFailure(cause));
      return undefined;
    }
  }

  /** Publishes a hint, swallowing failure rather than raising it: the shortcut
   * it buys is worth nothing next to the registration it must not refuse. */
  private async rememberHint(hint: RegistrationHint): Promise<void> {
    try {
      await this.options.registrationHints?.record(hint);
    } catch (cause) {
      // Writing reads the file first, so most of what fails here is the stored
      // state rather than the write, and reporting all of it as unwritable
      // would send the operator to check a directory that is fine. A record
      // reused from the first listing never calls readHint, which makes this
      // the only site that reports at all on that path.
      this.reportRecordUnavailable(recordFailure(cause));
    }
  }

  /** Reporting must never be able to fail the registration it is describing. */
  private reportRecordUnavailable(code: RegistrationRecordWarning): void {
    try {
      this.options.onRegistrationRecordUnavailable?.(code);
    } catch {
      return;
    }
  }

  /**
   * Re-reads until the Project ID becomes visible or the window closes. The
   * caller has already looked once; this exists so a retry that runs while the
   * previous run's DraftIssue is still replicating reuses it instead of
   * creating a duplicate.
   */
  private async awaitVisibleRecord(
    projectId: string,
  ): Promise<{ node: ItemNode; content: DraftIssue; body: ProjectRecordBody } | undefined> {
    for (let attempt = 1; attempt < REGISTER_ABSENCE_ATTEMPTS; attempt += 1) {
      await this.sleep(REGISTER_BACKOFF_MS * 2 ** (attempt - 1));
      const page = await this.initialPage();
      const matches = this.recordItems(await this.items(page)).filter(({ body }) => body.id === projectId);
      if (matches.length > 1) {
        throw new ControlError("DUPLICATE_PROJECT_RECORD", "Multiple DraftIssues use the requested Project ID");
      }
      const match = matches[0];
      if (match) return match;
    }
    return undefined;
  }

  private async verifyRegisteredItem(
    itemId: string,
    sourceNodeId: string,
    expected: RegisterProjectInput,
    structure: ProjectStructure,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const finalPage = await this.initialPage();
      const matches = this.recordItems(await this.items(finalPage)).filter(({ content }) => content.id === sourceNodeId);
      if (matches.length > 1) {
        throw new ControlError("DUPLICATE_PROJECT_ITEM", "Project Record DraftIssue is attached more than once after registration");
      }
      const match = matches[0];
      // An absent or half-applied record is what a lagging read looks like. A
      // record that is visible under another item ID, or with different
      // content, is corruption and never becomes correct by waiting.
      if (match && match.node.id !== itemId) {
        throw new ControlError("PROJECT_REGISTRATION_MISMATCH", "Registered Project item identity failed final verification");
      }
      let settled = false;
      if (match) {
        this.verifyRecord(match, expected);
        const actual = settledOperatingFields(match.node, structure);
        settled = actual !== undefined;
        if (actual && JSON.stringify(actual) === JSON.stringify(expected.fields)) return;
      }
      if (attempt >= REGISTER_VERIFY_ATTEMPTS) {
        // A record that never appeared or never settled is a read that lost the
        // race; one that settled on other values means another writer won. The
        // operator's next step differs, and only the code reaches them.
        if (!settled) throw new ControlError("PROJECT_REGISTRATION_UNSETTLED", "Registered Project record did not settle within the bounded read-back");
        throw new ControlError("PROJECT_REGISTRATION_MISMATCH", "Registered Project fields failed final verification");
      }
      await this.sleep(REGISTER_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }

  async verifyFields(): Promise<void> {
    const initial = await this.initialPage();
    this.preflightStructure = await this.structure(initial);
  }

  private async preflightItem(itemId: string): Promise<z.infer<typeof PreflightItemSchema>["data"]["node"]> {
    return this.safeApiResult(jsonFrom(
      (await this.options.runner.runGh(graphqlArgs(PREFLIGHT_ITEM_QUERY, [["raw", `itemId=${itemId}`]]), "project")).stdout,
      PreflightItemSchema,
      "INVALID_PREFLIGHT_ITEM",
    )).data.node;
  }

  private assertPreflightItem(item: NonNullable<z.infer<typeof PreflightItemSchema>["data"]["node"]> | ItemNode, itemId: string): void {
    const content = draftIssue(item.content);
    if (
      item.id !== itemId || item.type !== "DRAFT_ISSUE" || !content ||
      content.title !== PREFLIGHT_DRAFT_TITLE || content.body !== PREFLIGHT_DRAFT_BODY
    ) {
      throw new ControlError("INVALID_PREFLIGHT_ITEM", "Configured Project fixture is not the canonical DraftIssue");
    }
  }

  async verifyPreflightItem(itemId: string): Promise<void> {
    const item = await this.preflightItem(itemId);
    if (!item) throw new ControlError("INVALID_PREFLIGHT_ITEM", "Configured Project fixture does not exist");
    this.assertPreflightItem(item, itemId);
  }

  async readLastReviewed(itemId: string): Promise<string | undefined> {
    const item = await this.preflightItem(itemId);
    if (!item || item.id !== itemId) throw new ControlError("INVALID_PREFLIGHT_ITEM", "Configured preflight Project item does not exist");
    this.assertPreflightItem(item, itemId);
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
    const result = this.safeApiResult(jsonFrom(
      (await this.options.runner.runGh(graphqlArgs(CLEAR_FIELD_MUTATION, [
        ["raw", `projectId=${structure.projectId}`], ["raw", `itemId=${itemId}`], ["raw", `fieldId=${field.id}`],
      ]), "project")).stdout,
      MutationClearSchema,
      "INVALID_PROJECT_MUTATION",
    ));
    if (result.data.clearProjectV2ItemFieldValue.projectV2Item.id !== itemId) {
      throw new ControlError("INVALID_PROJECT_MUTATION", "Project clear mutation returned another item ID");
    }
  }
}
