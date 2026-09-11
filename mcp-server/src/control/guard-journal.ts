import { constants } from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

import {
  GuardAdapterSchema,
  CanonicalOperationRequirementsSchema,
  GuardWorktreeRefSchema,
  RequestIdSchema,
  type GuardAdapter,
} from "./guard-protocol.js";
import {
  ErrorReasonSchema,
  GuardDenyCodeSchema,
  OffsetDateTimeSchema,
  TaskIdSchema,
} from "./schemas.js";
import {
  appendBoundedJournalLine,
  inspectSecureStateDirectory,
  type SecureStateDirectoryHooks,
} from "./journal.js";
import {
  assertNoAbsoluteHostPaths,
  createSensitiveDataPolicy,
  type SensitiveDataPolicy,
} from "./sensitive-data.js";
import { ControlError } from "./errors.js";
import {
  createGuardHostCoordinateAuthority,
  type GuardHostCoordinateAuthority,
} from "./guard-coordinate.js";

const GUARD_JOURNAL_FILE = "guard-journal.jsonl";
// The schema-maximum event is pinned at 7,843 bytes in guard-journal.test.ts.
const MAX_GUARD_JOURNAL_LINE_BYTES = 8 * 1024;
const MAX_GUARD_JOURNAL_READ_BYTES = 8 * 1024 * 1024;
const MAX_GUARD_JOURNAL_READ_LINES = 8 * 1024;
const guardJournalReadFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const claimId = z.string().regex(/^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const boundedCoordinate = (maximumBytes: number) => z.string()
  .min(1)
  .max(maximumBytes)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
  .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes);
const directlyConstructedGuardJournals = new WeakMap<object, GuardHostCoordinateAuthority>();
const productionGuardJournals = new WeakMap<object, GuardHostCoordinateAuthority>();

export const GuardJournalEventSchema = z.object({
  protocol_version: z.literal(1),
  origin_adapter: GuardAdapterSchema.optional(),
  evaluation_stage: z.enum(["hook", "execution"]).optional(),
  event: z.enum(["decision", "requested", "approved", "consumed", "completed", "failed", "expired", "session-ended"]),
  task_id: TaskIdSchema.optional(),
  claim_id: claimId.optional(),
  session_id: boundedCoordinate(255).optional(),
  request_id: RequestIdSchema.optional(),
  operation_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  requirements: CanonicalOperationRequirementsSchema.optional(),
  occurred_at: OffsetDateTimeSchema,
  requested_at: OffsetDateTimeSchema.optional(),
  approval_expires_at: OffsetDateTimeSchema.optional(),
  approved_at: OffsetDateTimeSchema.optional(),
  start_by: OffsetDateTimeSchema.optional(),
  consumed_at: OffsetDateTimeSchema.optional(),
  finished_at: OffsetDateTimeSchema.optional(),
  decision_code: GuardDenyCodeSchema.optional(),
  error_reason: ErrorReasonSchema.optional(),
  worktree_ref: GuardWorktreeRefSchema.optional(),
  branch: boundedCoordinate(255).optional(),
  head_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional(),
  dirty: z.boolean().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
}).strict().superRefine((event, context) => {
  if (event.event === "session-ended") {
    for (const field of [
      "origin_adapter", "task_id", "claim_id", "worktree_ref", "branch",
      "head_sha", "dirty", "ahead", "behind",
    ] as const) {
      if (event[field] === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `SessionEnd journal event requires ${field}`,
        });
      }
    }
    if (event.session_id !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["session_id"],
        message: "SessionEnd journal event must not persist session identity",
      });
    }
    return;
  }
  if (event.event === "decision") return;
  for (const field of ["origin_adapter", "task_id", "claim_id", "session_id"] as const) {
    if (event[field] === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `Lifecycle journal event requires ${field}`,
      });
    }
  }
});
export type GuardJournalEvent = z.infer<typeof GuardJournalEventSchema>;

const GuardSessionEndExpectationSchema = z.object({
  origin_adapter: GuardAdapterSchema,
  task_id: TaskIdSchema,
  claim_id: claimId,
  worktree_ref: GuardWorktreeRefSchema,
  branch: boundedCoordinate(255),
  head_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  dirty: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
}).strict();

export interface GuardSessionEndExpectation {
  origin_adapter: GuardAdapter;
  task_id: string;
  claim_id: string;
  worktree_ref: string;
  branch: string;
  head_sha: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export type GuardSessionEndEvidence =
  | { status: "recorded"; origin_adapter: GuardAdapter; occurred_at: string }
  | { status: "absent" | "ambiguous" | "unverified" };

export interface GuardJournalPort {
  append(event: GuardJournalEvent): Promise<void>;
}

export class GuardJournal implements GuardJournalPort {
  readonly #stateDir: string;
  readonly #secureDirectoryHooks: SecureStateDirectoryHooks;
  readonly #sensitiveData: SensitiveDataPolicy;

  constructor(
    stateDir: string,
    secureDirectoryHooks: SecureStateDirectoryHooks = {},
    sensitiveData?: SensitiveDataPolicy,
  ) {
    this.#stateDir = resolve(stateDir);
    this.#secureDirectoryHooks = secureDirectoryHooks;
    this.#sensitiveData = sensitiveData ?? createSensitiveDataPolicy(process.env, [this.#stateDir]);
    if (new.target === GuardJournal) {
      directlyConstructedGuardJournals.set(this, createGuardHostCoordinateAuthority(this.#stateDir));
    }
  }

  async append(event: GuardJournalEvent): Promise<void> {
    try {
      const parsed = GuardJournalEventSchema.parse(event);
      this.#sensitiveData.assertSafe(parsed);
      assertNoAbsoluteHostPaths(parsed);
      await appendBoundedJournalLine(
        this.#stateDir,
        this.#secureDirectoryHooks,
        this.#sensitiveData,
        GUARD_JOURNAL_FILE,
        parsed,
        {
          tooLarge: "Guard journal event exceeds the atomic append boundary",
          incomplete: "Guard journal append was incomplete",
          failed: "Unable to append the Guard journal",
        },
        {
          maximumLineBytes: MAX_GUARD_JOURNAL_LINE_BYTES,
          strictExistingStateDirectory: true,
          strictExistingFileMode: true,
        },
      );
    } catch {
      throw new ControlError("GUARD_JOURNAL_UNAVAILABLE", "Guard journal append is unavailable");
    }
  }

  /**
   * Reads only bounded, schema-valid SessionEnd evidence. It never creates,
   * repairs, locks, or rewrites local state, and it exposes no Claim or Git
   * coordinates to the caller.
   */
  async inspectSessionEndEvidence(
    rawExpectation: GuardSessionEndExpectation,
  ): Promise<GuardSessionEndEvidence> {
    try {
      const expectation = GuardSessionEndExpectationSchema.parse(rawExpectation);
      this.#sensitiveData.assertSafe(expectation);
      assertNoAbsoluteHostPaths(expectation);
      const inspected = await inspectSecureStateDirectory(this.#stateDir, this.#secureDirectoryHooks);
      if (inspected.status === "not_initialized") return { status: "absent" };
      const directory = inspected.directory;
      try {
        let file;
        try {
          file = await directory.openFile(GUARD_JOURNAL_FILE, guardJournalReadFlags);
        } catch (cause) {
          if (isNotFound(cause)) return { status: "absent" };
          throw cause;
        }
        try {
          const before = await file.stat({ bigint: true });
          const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
          if (
            !before.isFile()
            || before.nlink !== 1n
            || (before.mode & 0o777n) !== 0o600n
            || (currentUid !== undefined && before.uid !== currentUid)
            || before.size > BigInt(MAX_GUARD_JOURNAL_READ_BYTES)
          ) {
            return { status: "unverified" };
          }
          const size = Number(before.size);
          const bytes = Buffer.alloc(size);
          let offset = 0;
          while (offset < size) {
            const read = await file.read(bytes, offset, size - offset, offset);
            if (read.bytesRead === 0) break;
            offset += read.bytesRead;
          }
          const after = await file.stat({ bigint: true });
          if (
            offset !== size
            || after.dev !== before.dev
            || after.ino !== before.ino
            || after.size !== before.size
            || after.mtimeNs !== before.mtimeNs
            || after.ctimeNs !== before.ctimeNs
          ) {
            return { status: "unverified" };
          }
          if (size === 0) return { status: "absent" };
          if (bytes[size - 1] !== 0x0a) return { status: "unverified" };
          let lineCount = 0;
          for (const byte of bytes) {
            if (byte === 0x0a && ++lineCount > MAX_GUARD_JOURNAL_READ_LINES) {
              return { status: "unverified" };
            }
          }
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          const lines = text.slice(0, -1).split("\n");
          const candidates: GuardJournalEvent[] = [];
          for (const line of lines) {
            if (!line || Buffer.byteLength(`${line}\n`, "utf8") > MAX_GUARD_JOURNAL_LINE_BYTES) {
              return { status: "unverified" };
            }
            let decoded: unknown;
            try {
              decoded = JSON.parse(line);
            } catch {
              return { status: "unverified" };
            }
            const parsed = GuardJournalEventSchema.safeParse(decoded);
            if (!parsed.success) return { status: "unverified" };
            this.#sensitiveData.assertSafe(parsed.data);
            assertNoAbsoluteHostPaths(parsed.data);
            if (
              parsed.data.event === "session-ended"
              && parsed.data.task_id === expectation.task_id
              && parsed.data.claim_id === expectation.claim_id
            ) {
              candidates.push(parsed.data);
            }
          }
          if (candidates.length === 0) return { status: "absent" };
          if (candidates.length !== 1) return { status: "ambiguous" };
          const candidate = candidates[0];
          if (!candidate ||
            candidate.origin_adapter !== expectation.origin_adapter ||
            candidate.worktree_ref !== expectation.worktree_ref ||
            candidate.branch !== expectation.branch ||
            candidate.head_sha !== expectation.head_sha ||
            candidate.dirty !== expectation.dirty ||
            candidate.ahead !== expectation.ahead ||
            candidate.behind !== expectation.behind
          ) {
            return { status: "unverified" };
          }
          return {
            status: "recorded",
            origin_adapter: expectation.origin_adapter,
            occurred_at: candidate.occurred_at,
          };
        } finally {
          await file.close();
        }
      } finally {
        await directory.close();
      }
    } catch {
      return { status: "unverified" };
    }
  }
}

function isNotFound(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

/** Mints the only GuardJournal provenance accepted by production composition. */
export function createProductionGuardJournal(
  stateDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): GuardJournal {
  const stateDirSnapshot = resolve(stateDir);
  const environmentSnapshot = Object.freeze({ ...environment });
  const journal = new GuardJournal(
    stateDirSnapshot,
    Object.freeze({}),
    createSensitiveDataPolicy(environmentSnapshot, [stateDirSnapshot]),
  );
  const coordinate = directlyConstructedGuardJournals.get(journal);
  if (!coordinate) throw new TypeError("Production GuardJournal construction failed");
  productionGuardJournals.set(journal, coordinate);
  Object.freeze(journal);
  return journal;
}

/** True only for journals constructed directly by this module's concrete class. */
export function isDirectGuardJournal(value: unknown): value is GuardJournal {
  return typeof value === "object" && value !== null && directlyConstructedGuardJournals.has(value);
}

/** Returns no path, only the immutable coordinate proof captured at direct construction. */
export function guardJournalHostCoordinate(
  journal: GuardJournal,
): GuardHostCoordinateAuthority | undefined {
  return productionGuardJournals.get(journal);
}

/** Test-only coordinate proof; it is not accepted by production composition. */
export function guardJournalHostCoordinateForTesting(
  journal: GuardJournal,
): GuardHostCoordinateAuthority | undefined {
  return directlyConstructedGuardJournals.get(journal);
}
