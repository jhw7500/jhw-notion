import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { SessionEndEventSchema } from "./guard-protocol.js";
import type { GuardJournalPort } from "./guard-journal.js";
import type { ActiveClaim } from "./schemas.js";
import type { GuardTaskInspection } from "./task-service.js";

export type SessionEndEvidenceResult = Readonly<{
  status: "RECORDED" | "NO_MATCH" | "AMBIGUOUS" | "UNVERIFIED";
}>;

export interface SessionEndRecorderOptions {
  host: string;
  claims: {
    listActiveClaims(): Promise<ActiveClaim[]>;
  };
  tasks: {
    inspectForGuard(taskId: string, claimId: string): Promise<GuardTaskInspection>;
  };
  journal: GuardJournalPort;
  now?: () => Date;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function exactInspection(inspection: GuardTaskInspection, claim: ActiveClaim): boolean {
  return inspection.active.task_id === claim.task_id &&
    inspection.active.claim_id === claim.claim_id &&
    inspection.active.session_id === claim.session_id &&
    inspection.active.host === claim.host &&
    inspection.active.branch === claim.branch &&
    inspection.active.worktree_ref === claim.worktree_ref &&
    inspection.worktree.branch === claim.branch &&
    inspection.worktree.worktree_ref === claim.worktree_ref;
}

/** Read-only session termination evidence. This class has no lifecycle mutation port. */
export class SessionEndRecorder {
  private readonly now: () => Date;

  constructor(private readonly options: SessionEndRecorderOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async record(input: unknown): Promise<SessionEndEvidenceResult> {
    const parsed = SessionEndEventSchema.safeParse(input);
    if (!parsed.success) return { status: "UNVERIFIED" };
    const event = parsed.data;
    let active: ActiveClaim[];
    try {
      active = await this.options.claims.listActiveClaims();
    } catch {
      return { status: "UNVERIFIED" };
    }
    const exact = active.filter((claim) =>
      "origin_adapter" in claim &&
      claim.origin_adapter === event.adapter &&
      claim.session_id === event.session_id &&
      claim.host === this.options.host);
    if (exact.length === 0) return { status: "NO_MATCH" };
    if (exact.length !== 1) return { status: "AMBIGUOUS" };
    const claim = exact[0] as ActiveClaim;

    let inspection: GuardTaskInspection;
    try {
      inspection = await this.options.tasks.inspectForGuard(claim.task_id, claim.claim_id);
      if (!exactInspection(inspection, claim)) return { status: "UNVERIFIED" };
      const [worktreeRoot, currentDirectory] = await Promise.all([
        realpath(inspection.worktree.path),
        realpath(event.cwd),
      ]);
      if (!isWithin(worktreeRoot, currentDirectory)) return { status: "UNVERIFIED" };
    } catch {
      return { status: "UNVERIFIED" };
    }

    const occurredAt = this.now();
    if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
      return { status: "UNVERIFIED" };
    }
    await this.options.journal.append({
      protocol_version: 1,
      origin_adapter: event.adapter,
      event: "session-ended",
      task_id: claim.task_id,
      claim_id: claim.claim_id,
      worktree_ref: inspection.worktree.worktree_ref,
      branch: inspection.worktree.branch,
      head_sha: inspection.worktree.head_sha,
      dirty: inspection.worktree.dirty,
      ahead: inspection.worktree.ahead,
      behind: inspection.worktree.behind,
      occurred_at: occurredAt.toISOString(),
    });
    return { status: "RECORDED" };
  }
}
