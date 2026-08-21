import { appendBoundedJournalLine, type SecureStateDirectoryHooks } from "./journal.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";

const BOARD_JOURNAL_FILE = "board-journal.jsonl";

/**
 * Event-typed board records. This stream is deliberately separate from the
 * pilot journal: board rows must never enter the Phase 1A trial audit set.
 * Values are bounded identifiers and codes only — never `purpose`, addresses,
 * or other free text. The event's machine-readable origin is carried in
 * `cause`, never in a key named after the error-reason axis, so the closed
 * reason vocabulary sweep stays scoped to actual error emission sites.
 */
export interface BoardJournalEvent {
  event: "command" | "holder_reaped" | "holder_evicted_expired" | "reservation_lapsed" | "state_reset";
  command?: string;
  board_id?: string;
  holder_id?: string;
  reservation_id?: string;
  cause?: string;
  cross_session?: boolean;
  started_at?: string;
  finished_at?: string;
  elapsed_ms?: number;
  ok?: boolean;
  error_code?: string;
  error_reason?: string;
  payload_bytes?: number;
}

export interface BoardJournalPort {
  append(event: BoardJournalEvent): Promise<void>;
}

/** Same hardened append mechanics as the pilot journal, different stream. */
export class BoardJournal implements BoardJournalPort {
  private readonly sensitiveData: SensitiveDataPolicy;

  constructor(
    private readonly stateDir: string,
    private readonly secureDirectoryHooks: SecureStateDirectoryHooks = {},
    sensitiveData?: SensitiveDataPolicy,
  ) {
    this.sensitiveData = sensitiveData ?? createSensitiveDataPolicy(process.env, [stateDir]);
  }

  async append(event: BoardJournalEvent): Promise<void> {
    await appendBoundedJournalLine(
      this.stateDir,
      this.secureDirectoryHooks,
      this.sensitiveData,
      BOARD_JOURNAL_FILE,
      event,
      {
        tooLarge: "Board journal event exceeds the atomic append boundary",
        incomplete: "Board journal append was incomplete",
        failed: "Unable to append the board journal",
      },
    );
  }
}
