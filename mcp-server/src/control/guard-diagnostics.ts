import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { GuardAdapter } from "./guard-protocol.js";
import { appendBoundedJournalLine, inspectSecureStateDirectory } from "./journal.js";
import { createSensitiveDataPolicy } from "./sensitive-data.js";

/**
 * Lock-free, capped diagnostics for Guard hook self-failures. No release reads
 * this file, so it never feeds a decision and a release rolled back to never
 * opens it. Rows hold fixed vocabulary and numbers only: no session id, no path.
 */
export const GUARD_HOOK_DIAGNOSTICS_FILE = "guard-hook-diagnostics.v1.jsonl";

const MAX_DIAGNOSTIC_LINE_BYTES = 1024;
const MAX_DIAGNOSTICS_BYTES = 1024 * 1024;
// Latency rows are the most frequent kind, so they stop first and leave room for the rest.
const MAX_LATENCY_DIAGNOSTICS_BYTES = 512 * 1024;

export type GuardDiagnosticKind = "deadline" | "latency" | "unrecorded_allow" | "decode_failure";

export interface GuardDiagnosticRow {
  adapter: GuardAdapter;
  event: "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "SessionEnd";
  mode: "enforce" | "observe";
  kind: GuardDiagnosticKind;
  code?: string;
  elapsed_ms?: number;
}

const diagnosticLabels = {
  tooLarge: "Guard hook diagnostics row exceeds the append boundary",
  incomplete: "Guard hook diagnostics append was incomplete",
  failed: "Unable to append Guard hook diagnostics",
};

/**
 * Best effort and never throws: a diagnostics failure must not change a
 * decision. An uninitialized state directory is skipped without creating it.
 */
export async function appendGuardHookDiagnostic(stateDir: string, row: GuardDiagnosticRow): Promise<void> {
  try {
    const inspection = await inspectSecureStateDirectory(stateDir);
    if (inspection.status !== "ready") return;
    await inspection.directory.close();
    let size = 0;
    try {
      size = (await lstat(join(stateDir, GUARD_HOOK_DIAGNOSTICS_FILE))).size;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    if (size >= (row.kind === "latency" ? MAX_LATENCY_DIAGNOSTICS_BYTES : MAX_DIAGNOSTICS_BYTES)) return;
    await appendBoundedJournalLine(
      stateDir,
      {},
      createSensitiveDataPolicy({}, []),
      GUARD_HOOK_DIAGNOSTICS_FILE,
      { v: 1, at: new Date().toISOString(), ...row },
      diagnosticLabels,
      {
        maximumLineBytes: MAX_DIAGNOSTIC_LINE_BYTES,
        strictExistingStateDirectory: true,
        strictExistingFileMode: true,
      },
    );
  } catch {
    // Diagnostics are advisory.
  }
}
