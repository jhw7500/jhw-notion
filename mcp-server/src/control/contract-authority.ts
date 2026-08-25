import { ControlError } from "./errors.js";
import type { RepositoryRecord, TaskRecord } from "./schemas.js";
import type { WorkContract } from "./work-contract.js";

export interface ContractAuthorityPorts {
  getRepository(repoId: string): Promise<RepositoryRecord>;
  getTask(taskId: string): Promise<TaskRecord>;
  boardStatus(boardId: string): Promise<unknown>;
}

export interface ContractAuthorityPort {
  assertKnownContract(taskContext: TaskRecord, contract: WorkContract): Promise<void>;
}

/** Validates every contract coordinate against authority already known locally. */
export class ControlContractAuthority implements ContractAuthorityPort {
  constructor(private readonly ports: ContractAuthorityPorts) {}

  async assertKnownContract(taskContext: TaskRecord, contract: WorkContract): Promise<void> {
    if (contract.task_id !== taskContext.id) {
      throw new ControlError("TASK_CONTRACT_MISMATCH", "Work Contract Task ID disagrees with Task context");
    }

    for (const grant of contract.grants) {
      switch (grant.resource.kind) {
        case "repository": {
          if (grant.resource.id !== taskContext.repo_id) {
            throw new ControlError("RESOURCE_AUTHORITY_MISMATCH", "Repository grant is outside Task authority");
          }
          const repository = await this.ports.getRepository(grant.resource.id);
          if (repository.id !== taskContext.repo_id) {
            throw new ControlError("RESOURCE_AUTHORITY_MISMATCH", "Resolved Repository disagrees with Task authority");
          }
          break;
        }
        case "issue": {
          const formal = taskContext.kind === "child"
            ? await this.requireFormalParent(taskContext.parent_task_id)
            : taskContext.kind === "formal" ? taskContext : undefined;
          if (!formal || grant.resource.id !== formal.issue_node_id) {
            throw new ControlError("RESOURCE_AUTHORITY_MISMATCH", "Issue grant is outside Task authority");
          }
          break;
        }
        case "notion_database":
          // ResourceRefSchema is the closed configured logical-ID authority.
          break;
        case "board":
          await this.ports.boardStatus(grant.resource.id);
          break;
        case "remote_host":
        case "firmware_target":
        case "deployment_target":
          throw new ControlError("RESOURCE_AUTHORITY_UNSUPPORTED", "Standalone resource authority is not supported");
      }
    }

    for (const dependency of contract.dependencies) {
      if (dependency.task_id === taskContext.id) {
        throw new ControlError("TASK_DEPENDENCY_SELF", "Task cannot depend on itself");
      }
      await this.ports.getTask(dependency.task_id);
    }
  }

  private async requireFormalParent(taskId: string): Promise<Extract<TaskRecord, { kind: "formal" }>> {
    const parent = await this.ports.getTask(taskId);
    if (parent.kind !== "formal" || parent.task_role !== "parent") {
      throw new ControlError("TASK_CHILD_DEPTH_EXCEEDED", "Child Task parent must be formal");
    }
    return parent;
  }
}
