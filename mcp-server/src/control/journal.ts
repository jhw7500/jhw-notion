import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { ControlError } from "./errors.js";

const MAX_JOURNAL_LINE_BYTES = 4096;
const JOURNAL_FILE = "pilot-journal.jsonl";

export interface JournalEvent {
  command: string;
  task_id?: string;
  claim_id?: string;
  started_at: string;
  finished_at: string;
  elapsed_ms: number;
  ok: boolean;
  error_code?: string;
  bypass_reason?: string;
  payload_bytes: number;
  active_work_minutes?: number;
}

export interface JournalPort {
  append(event: JournalEvent): Promise<void>;
}

/**
 * A narrow append-only pilot journal. Events deliberately hold only stable
 * command metadata, never argument values or host-local paths.
 */
export class PilotJournal implements JournalPort {
  constructor(private readonly stateDir: string) {}

  async append(event: JournalEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_JOURNAL_LINE_BYTES) {
      throw new ControlError("JOURNAL_EVENT_TOO_LARGE", "Pilot journal event exceeds the atomic append boundary");
    }

    try {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      const file = await open(join(this.stateDir, JOURNAL_FILE), "a", 0o600);
      try {
        // `O_APPEND` plus one bounded write keeps each event a complete line
        // when read-only command invocations finish concurrently.
        await file.chmod(0o600);
        await file.write(line, undefined, "utf8");
      } finally {
        await file.close();
      }
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      throw new ControlError("JOURNAL_WRITE_FAILED", "Unable to append the pilot journal");
    }
  }
}
