import { ControlError } from "./errors.js";
import { TaskRoleSchema, type TaskRole } from "./schemas.js";
import {
  TaskCompletionEvidenceSchema,
  type TaskCompletionEvidence,
} from "./task-completion.js";
import {
  normalizeWorkContract,
  type TaskDependency,
  type WorkContract,
  type WorkGrant,
} from "./work-contract.js";

export interface ParsedContractIntent {
  grants: WorkGrant[];
  dependencies: TaskDependency[];
}

function invalidCli(): never {
  throw new ControlError("INVALID_CLI_ARGUMENT", "Invalid Work Contract command argument");
}

function exactFields(raw: string, count: number): string[] {
  const fields = raw.split(":");
  if (fields.length !== count || fields.some((field) => field.length === 0)) invalidCli();
  return fields;
}

function validationTaskId(dependencies: readonly { task_id: string }[]): string {
  const occupied = new Set(dependencies.map((dependency) => dependency.task_id));
  for (let index = 0; index <= dependencies.length; index += 1) {
    const candidate = `tsk-00000000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error("Unable to allocate parser validation identity");
}

function parseContract(
  taskId: string | undefined,
  rawGrants: readonly string[],
  rawDependencies: readonly string[],
): WorkContract {
  if (rawGrants.length === 0) invalidCli();
  const grants = [...new Set(rawGrants)].map((raw) => {
    const [capability, kind, id, coordination] = exactFields(raw, 4);
    return { capability, resource: { kind, id }, coordination };
  });
  const dependencies = rawDependencies.map((raw) => {
    const [relation, dependencyTaskId] = exactFields(raw, 2);
    return { relation, task_id: dependencyTaskId };
  });
  try {
    return normalizeWorkContract({
      version: 1,
      task_id: taskId ?? validationTaskId(dependencies),
      grants,
      dependencies,
    });
  } catch {
    invalidCli();
  }
}

/** Parses registration intent while Catalog remains the authority for the generated Task ID. */
export function parseContractIntentFlags(
  rawGrants: readonly string[],
  rawDependencies: readonly string[],
): ParsedContractIntent {
  const parsed = parseContract(undefined, rawGrants, rawDependencies);
  return { grants: parsed.grants, dependencies: parsed.dependencies };
}

/** Parses a replacement contract whose canonical Task ID is already known. */
export function parseWorkContractFlags(
  taskId: string,
  rawGrants: readonly string[],
  rawDependencies: readonly string[],
): WorkContract {
  return parseContract(taskId, rawGrants, rawDependencies);
}

export function parseTaskRoleFlag(raw: string | undefined): TaskRole {
  const parsed = TaskRoleSchema.safeParse(raw ?? "standalone");
  if (!parsed.success) invalidCli();
  return parsed.data;
}

export function parseRequiredForParentFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return invalidCli();
}

export function parseTaskCompletionEvidenceFlags(
  integrationValidation: readonly string[],
  rawChildDispositions: readonly string[],
): TaskCompletionEvidence {
  const childDispositions = rawChildDispositions.map((raw) => {
    const [taskId, disposition] = exactFields(raw, 2);
    return { task_id: taskId, disposition };
  });
  const parsed = TaskCompletionEvidenceSchema.safeParse({
    integration_validation: [...integrationValidation],
    child_dispositions: childDispositions,
  });
  if (!parsed.success) invalidCli();
  return parsed.data;
}
