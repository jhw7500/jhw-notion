import { resolve } from "node:path";

import { z } from "zod";

import {
  GuardAdapterSchema,
  CanonicalOperationRequirementsSchema,
  RequestIdSchema,
} from "./guard-protocol.js";
import {
  ErrorReasonSchema,
  GuardDenyCodeSchema,
  OffsetDateTimeSchema,
  TaskIdSchema,
} from "./schemas.js";
import {
  appendBoundedJournalLine,
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
  event: z.enum(["decision", "requested", "approved", "consumed", "completed", "failed", "expired"]),
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
}).strict().superRefine((event, context) => {
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
