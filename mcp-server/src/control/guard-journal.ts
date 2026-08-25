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

const GUARD_JOURNAL_FILE = "guard-journal.jsonl";
// The schema-maximum event is pinned at 7,843 bytes in guard-journal.test.ts.
const MAX_GUARD_JOURNAL_LINE_BYTES = 8 * 1024;
const claimId = z.string().regex(/^clm-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const boundedCoordinate = (maximumBytes: number) => z.string()
  .min(1)
  .max(maximumBytes)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
  .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes);

export const GuardJournalEventSchema = z.object({
  protocol_version: z.literal(1),
  origin_adapter: GuardAdapterSchema,
  evaluation_stage: z.enum(["hook", "execution"]).optional(),
  event: z.enum(["decision", "requested", "approved", "consumed", "completed", "failed", "expired"]),
  task_id: TaskIdSchema,
  claim_id: claimId,
  session_id: boundedCoordinate(255),
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
}).strict();
export type GuardJournalEvent = z.infer<typeof GuardJournalEventSchema>;

export interface GuardJournalPort {
  append(event: GuardJournalEvent): Promise<void>;
}

export class GuardJournal implements GuardJournalPort {
  private readonly sensitiveData: SensitiveDataPolicy;

  constructor(
    private readonly stateDir: string,
    private readonly secureDirectoryHooks: SecureStateDirectoryHooks = {},
    sensitiveData?: SensitiveDataPolicy,
  ) {
    this.sensitiveData = sensitiveData ?? createSensitiveDataPolicy(process.env, [stateDir]);
  }

  async append(event: GuardJournalEvent): Promise<void> {
    try {
      const parsed = GuardJournalEventSchema.parse(event);
      this.sensitiveData.assertSafe(parsed);
      assertNoAbsoluteHostPaths(parsed);
      await appendBoundedJournalLine(
        this.stateDir,
        this.secureDirectoryHooks,
        this.sensitiveData,
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
