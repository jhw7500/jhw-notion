import { constants } from "node:fs";
import { readFile } from "node:fs/promises";

import { BoardJournal, type BoardJournalEvent, type BoardJournalPort } from "./board-journal.js";
import type { ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { newHolderId, newReservationId } from "./ids.js";
import { openSecureStateDirectory, type SecureStateDirectory, type SecureStateDirectoryHooks } from "./journal.js";
import type { MutationLockPort } from "./process.js";
import {
  BoardStateSchema,
  type BoardConflictSummary,
  type BoardHolder,
  type BoardInterface,
  type BoardMode,
  type BoardRecord,
  type BoardReservation,
  type BoardState,
} from "./schemas.js";
import { createSensitiveDataPolicy, type SensitiveDataPolicy } from "./sensitive-data.js";

const BOARD_STATE_FILE = "boards.yaml";
const BOARD_STATE_TEMP = "boards.yaml.tmp";
const LEASE_MAX_MS = 12 * 60 * 60 * 1000;
const LONG_LEASE_MAX_MS = 72 * 60 * 60 * 1000;
const RESERVATION_MAX_MS = 24 * 60 * 60 * 1000;
const RESERVATION_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HOLDERS = 16;
const MAX_RESERVATIONS = 32;
const RESERVATION_DISPLAY_LIMIT = 12;
const DISPLAY_CHARACTERS = 64;
const BOARD_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const HOLDER_ID = /^hld-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESERVATION_ID = /^rsv-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Liveness evidence for one recorded pid; "unknown" is deliberately fail-safe alive. */
export interface PidInspection {
  state: "alive" | "dead" | "unknown";
  startTime?: string;
}

export interface LivenessProbe {
  currentBootId(): Promise<string | undefined>;
  inspect(pid: number): Promise<PidInspection>;
}

function isErrno(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}

/** Reads /proc evidence; every unreadable answer degrades to "no evidence", never to "dead". */
export function createProcessLivenessProbe(): LivenessProbe {
  return {
    async currentBootId(): Promise<string | undefined> {
      try {
        const raw = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
        const value = raw.trim();
        return value.length > 0 && value.length <= 64 ? value : undefined;
      } catch {
        return undefined;
      }
    },
    async inspect(pid: number): Promise<PidInspection> {
      let statLine: string | undefined;
      try {
        statLine = await readFile(`/proc/${pid}/stat`, "utf8");
      } catch (cause) {
        if (isErrno(cause, "ENOENT") || isErrno(cause, "ESRCH")) return { state: "dead" };
      }
      if (statLine !== undefined) {
        // comm may contain spaces and parentheses; the canonical parse anchors
        // on the final ')' before splitting the remaining numeric fields.
        const close = statLine.lastIndexOf(")");
        const fields = close === -1 ? [] : statLine.slice(close + 1).trim().split(/\s+/);
        // starttime is field 22 overall; after pid and comm it is index 19.
        const startTime = fields[19];
        return { state: "alive", ...(startTime && /^\d+$/.test(startTime) ? { startTime } : {}) };
      }
      try {
        process.kill(pid, 0);
        return { state: "alive" };
      } catch (cause) {
        if (isErrno(cause, "ESRCH")) return { state: "dead" };
        return { state: "unknown" };
      }
    },
  };
}

/** The recorded trio for a process the caller wants liveness-reaped; null means untracked. */
export interface LivenessTrio {
  pid: number | null;
  pid_start_time: string | null;
  boot_id: string | null;
}

/** Captures the atomic trio, degrading to fully untracked when any part is unavailable. */
export async function captureLivenessTrio(probe: LivenessProbe, pid: number): Promise<LivenessTrio> {
  const bootId = await probe.currentBootId();
  const inspection = await probe.inspect(pid);
  if (inspection.state === "dead") {
    throw new ControlError("INVALID_BOARD_INPUT", "Recorded pid must be a live process");
  }
  if (bootId === undefined || inspection.startTime === undefined) {
    return { pid: null, pid_start_time: null, boot_id: null };
  }
  return { pid, pid_start_time: inspection.startTime, boot_id: bootId };
}

class BoardStateStore {
  constructor(
    private readonly stateDir: string,
    private readonly secureDirectoryHooks: SecureStateDirectoryHooks = {},
  ) {}

  async read(): Promise<BoardState> {
    const directory = await openSecureStateDirectory(this.stateDir, this.secureDirectoryHooks);
    try {
      let text: string;
      try {
        const file = await directory.openFile(BOARD_STATE_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.nlink !== 1) {
            throw new ControlError("UNSAFE_STATE_PATH", "Board state is not a private single-link regular file");
          }
          text = (await file.readFile()).toString("utf8");
        } finally {
          await file.close();
        }
      } catch (cause) {
        if (cause instanceof ControlError) throw cause;
        // Absence is the empty state, never corruption.
        if (isErrno(cause, "ENOENT")) return { version: 1, boards: {} };
        throw new ControlError("BOARD_STATE_CORRUPT", "Board state is unreadable");
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ControlError("BOARD_STATE_CORRUPT", "Board state is not valid JSON-subset YAML");
      }
      const parsed = BoardStateSchema.safeParse(raw);
      if (!parsed.success) throw new ControlError("BOARD_STATE_CORRUPT", "Board state failed schema validation");
      return parsed.data;
    } finally {
      await directory.close();
    }
  }

  async write(state: BoardState): Promise<void> {
    const parsed = BoardStateSchema.safeParse(state);
    if (!parsed.success) throw new ControlError("BOARD_STATE_CORRUPT", "Refusing to persist invalid board state");
    const directory = await openSecureStateDirectory(this.stateDir, this.secureDirectoryHooks);
    try {
      const file = await directory.openFile(
        BOARD_STATE_TEMP,
        constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(`${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
        // The temp content must reach disk before the rename publishes its name.
        await file.sync();
      } finally {
        await file.close();
      }
      await directory.renameWithin(BOARD_STATE_TEMP, BOARD_STATE_FILE);
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  /** Preserves the corrupt file aside and publishes an empty state in its place. */
  async resetCorrupt(suffix: string): Promise<string> {
    const preserved = `${BOARD_STATE_FILE}.corrupt-${suffix}`;
    const directory = await openSecureStateDirectory(this.stateDir, this.secureDirectoryHooks);
    try {
      try {
        await directory.renameWithin(BOARD_STATE_FILE, preserved);
      } catch (cause) {
        if (!isErrno(cause, "ENOENT")) throw cause;
      }
    } finally {
      await directory.close();
    }
    await this.write({ version: 1, boards: {} });
    return preserved;
  }
}

export interface BoardWindowInput {
  for_minutes?: number;
  until?: string;
}

export interface BoardAcquireInput extends BoardWindowInput {
  board_id: string;
  mode: BoardMode;
  session: string;
  purpose: string;
  liveness?: LivenessTrio;
  consume?: string;
  claim_expired?: boolean;
  accept_shortened?: boolean;
  long_lease?: boolean;
  cross_session?: boolean;
}

export interface BoardHolderSummary {
  board_id: string;
  holder_id: string;
  session: string;
  mode: BoardMode;
  purpose: string;
  acquired_at: string;
  granted_until: string;
  liveness_tracked: boolean;
}

export interface BoardAcquireResult {
  holder: BoardHolderSummary;
  shortened: boolean;
  consumed_reservation?: string;
  evicted_expired: string[];
  cross_session: boolean;
}

export interface BoardWaitOptions {
  poll_ms?: number;
  timeout_ms?: number;
}

interface MutationEvents {
  events: BoardJournalEvent[];
}

function invalidInput(message: string): ControlError {
  return new ControlError("INVALID_BOARD_INPUT", message);
}

function conflictsMode(left: BoardMode, right: BoardMode): boolean {
  return !(left === "shared" && right === "shared");
}

function holderConflict(boardId: string, holder: BoardHolder): BoardConflictSummary {
  return {
    board_id: boardId,
    holder_id: holder.holder_id,
    mode: holder.mode,
    purpose: holder.purpose,
    granted_until: holder.granted_until,
  };
}

function reservationConflict(boardId: string, reservation: BoardReservation): BoardConflictSummary {
  return {
    board_id: boardId,
    reservation_id: reservation.reservation_id,
    mode: reservation.mode,
    purpose: reservation.purpose,
    from: reservation.from,
    to: reservation.to,
  };
}

function epoch(value: string): number {
  return new Date(value).getTime();
}

/** Display-only truncation; coordinates are never passed through this. */
function display(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= DISPLAY_CHARACTERS) return value;
  return `${characters.slice(0, DISPLAY_CHARACTERS).join("")}…`;
}

export class BoardService {
  private readonly store: BoardStateStore;
  private readonly sensitiveData: SensitiveDataPolicy;

  constructor(
    private readonly config: ControlConfig,
    private readonly lock: MutationLockPort,
    private readonly probe: LivenessProbe,
    private readonly now: () => Date = () => new Date(),
    private readonly journal: BoardJournalPort = new BoardJournal(config.stateDir),
    secureDirectoryHooks: SecureStateDirectoryHooks = {},
    sensitiveData?: SensitiveDataPolicy,
  ) {
    this.store = new BoardStateStore(config.stateDir, secureDirectoryHooks);
    this.sensitiveData = sensitiveData ?? createSensitiveDataPolicy(process.env, [config.stateDir]);
  }

  async register(input: {
    board_id: string;
    description?: string;
    interfaces: BoardInterface[];
    session: string;
  }): Promise<{ board_id: string; created: boolean }> {
    this.assertBoardId(input.board_id);
    // Reject malformed metadata here, before persistence: a bad argument that
    // only failed the write-time schema would masquerade as state corruption.
    this.assertDescription(input.description);
    this.assertInterfaces(input.interfaces);
    this.sensitiveData.assertSafe({ description: input.description, purpose: undefined });
    return this.mutate(async (state) => {
      if (state.boards[input.board_id]) {
        throw new ControlError("BOARD_ALREADY_REGISTERED", "Board is already registered", {
          board_id: input.board_id,
        });
      }
      state.boards[input.board_id] = {
        ...(input.description ? { description: input.description } : {}),
        interfaces: input.interfaces,
        registered_at: this.now().toISOString(),
        holders: [],
        reservations: [],
      };
      return { board_id: input.board_id, created: true };
    });
  }

  async update(input: {
    board_id: string;
    description?: string;
    interfaces?: BoardInterface[];
    session: string;
  }): Promise<{ board_id: string }> {
    this.assertBoardId(input.board_id);
    this.assertDescription(input.description);
    if (input.interfaces !== undefined) this.assertInterfaces(input.interfaces);
    this.sensitiveData.assertSafe({ description: input.description });
    if (input.description === undefined && input.interfaces === undefined) {
      throw invalidInput("Board update requires at least one field");
    }
    return this.mutate(async (state) => {
      const board = this.requireBoard(state, input.board_id);
      if (input.description !== undefined) board.description = input.description;
      if (input.interfaces !== undefined) board.interfaces = input.interfaces;
      return { board_id: input.board_id };
    });
  }

  async unregister(input: { board_id: string; session: string }): Promise<{ board_id: string; removed: boolean }> {
    this.assertBoardId(input.board_id);
    return this.mutate(async (state, context) => {
      const board = this.requireBoard(state, input.board_id);
      await this.sweepBoard(state, input.board_id, board, context);
      if (board.holders.length > 0 || board.reservations.length > 0) {
        throw new ControlError("BOARD_NOT_EMPTY", "Board still has holders or reservations", {
          board_id: input.board_id,
        });
      }
      delete state.boards[input.board_id];
      return { board_id: input.board_id, removed: true };
    });
  }

  async acquire(input: BoardAcquireInput): Promise<BoardAcquireResult> {
    this.assertBoardId(input.board_id);
    this.assertSession(input.session);
    this.assertPurpose(input.purpose);
    if (input.consume !== undefined && !RESERVATION_ID.test(input.consume)) {
      throw invalidInput("Invalid reservation coordinate");
    }
    return this.mutate(async (state, context) => {
      const nowMs = this.now().getTime();
      const board = this.requireBoard(state, input.board_id);
      await this.sweepBoard(state, input.board_id, board, context);

      let untilMs = this.resolveWindow(input, nowMs);

      let consumed: BoardReservation | undefined;
      let crossSession = false;
      if (input.consume !== undefined) {
        consumed = board.reservations.find((entry) => entry.reservation_id === input.consume);
        if (!consumed) {
          throw new ControlError("RESERVATION_NOT_FOUND", "Reservation coordinate did not match", {
            board_id: input.board_id,
          });
        }
        if (consumed.mode !== input.mode) {
          throw new ControlError("RESERVATION_CONFLICT", "Requested mode differs from the reservation", {
            reason: "mode_mismatch",
            conflicting_board: reservationConflict(input.board_id, consumed),
          });
        }
        if (nowMs < epoch(consumed.from)) {
          throw new ControlError("RESERVATION_CONFLICT", "Reservation window has not started", {
            reason: "reservation_not_started",
            conflicting_board: reservationConflict(input.board_id, consumed),
          });
        }
        crossSession = this.assertOperable({
          recordedSession: consumed.session,
          live: true,
          callerSession: input.session,
          crossSessionFlag: input.cross_session === true,
          conflict: reservationConflict(input.board_id, consumed),
        });
        untilMs = Math.min(untilMs, epoch(consumed.to));
      }
      // The cap applies to the effective grant: "--for <max>" with a shorter
      // reservation means "until my reservation ends", not a limit violation.
      this.assertLease(untilMs - nowMs, input.long_lease === true);

      let shortened = false;
      const fencing = board.reservations
        .filter((entry) => entry !== consumed && conflictsMode(entry.mode, input.mode))
        .sort((left, right) => epoch(left.from) - epoch(right.from));
      for (const reservation of fencing) {
        const fromMs = epoch(reservation.from);
        const toMs = epoch(reservation.to);
        if (fromMs <= nowMs && nowMs < toMs) {
          throw new ControlError("BOARD_RESERVED", "A conflicting reservation window is active", {
            reason: "reservation_window_active",
            conflicting_board: reservationConflict(input.board_id, reservation),
          });
        }
        if (fromMs > nowMs && fromMs < untilMs) {
          if (input.accept_shortened !== true) {
            throw new ControlError("BOARD_RESERVED", "A reservation starts inside the requested window", {
              reason: "shortening_not_accepted",
              conflicting_board: reservationConflict(input.board_id, reservation),
            });
          }
          untilMs = fromMs;
          shortened = true;
          break;
        }
      }

      const evicted: string[] = [];
      if (input.claim_expired === true) {
        for (const holder of [...board.holders]) {
          if (epoch(holder.granted_until) > nowMs) continue;
          if (!conflictsMode(holder.mode, input.mode)) continue;
          this.removeHolder(board, holder.holder_id);
          evicted.push(holder.holder_id);
          context.events.push({
            event: "holder_evicted_expired",
            board_id: input.board_id,
            holder_id: holder.holder_id,
          });
        }
      }
      const blockers = board.holders.filter((holder) => conflictsMode(holder.mode, input.mode));
      if (blockers.length > 0) {
        const unexpired = blockers.filter((holder) => epoch(holder.granted_until) > nowMs);
        const representative = unexpired.find((holder) => holder.mode === "exclusive") ?? unexpired[0] ?? blockers[0];
        const reason = unexpired.length === 0
          ? "overstay_holder"
          : unexpired.some((holder) => holder.mode === "exclusive")
            ? "exclusive_holder"
            : "shared_holders_block_exclusive";
        throw new ControlError("BOARD_BUSY", "Board is held in a conflicting mode", {
          reason,
          conflicting_board: holderConflict(input.board_id, representative),
        });
      }
      if (board.holders.length >= MAX_HOLDERS) {
        throw new ControlError("BOARD_LIMIT_EXCEEDED", "Board holder limit reached", {
          reason: "holder_count",
          board_id: input.board_id,
        });
      }

      const trio = input.liveness ?? { pid: null, pid_start_time: null, boot_id: null };
      const holder: BoardHolder = {
        holder_id: newHolderId(nowMs),
        session: input.session,
        pid: trio.pid,
        pid_start_time: trio.pid_start_time,
        boot_id: trio.boot_id,
        mode: input.mode,
        purpose: input.purpose,
        acquired_at: new Date(nowMs).toISOString(),
        granted_until: new Date(untilMs).toISOString(),
        extended_after_expiry: 0,
      };
      board.holders.push(holder);
      if (consumed) consumed.consumed_by = holder.holder_id;
      return {
        holder: this.holderSummary(input.board_id, holder),
        shortened,
        ...(consumed ? { consumed_reservation: consumed.reservation_id } : {}),
        evicted_expired: evicted,
        cross_session: crossSession,
      };
    });
  }

  async wait(
    input: BoardAcquireInput,
    options: BoardWaitOptions = {},
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ): Promise<BoardAcquireResult> {
    const poll = options.poll_ms ?? 10_000;
    const timeout = options.timeout_ms ?? 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(poll) || poll <= 0 || !Number.isSafeInteger(timeout) || timeout <= 0) {
      throw invalidInput("Wait bounds must be positive integers");
    }
    const deadline = this.now().getTime() + timeout;
    for (;;) {
      try {
        return await this.acquire(input);
      } catch (cause) {
        if (!this.retriableWait(cause) || this.now().getTime() + poll > deadline) throw cause;
      }
      await sleep(poll);
    }
  }

  async release(input: {
    board_id: string;
    holder_id?: string;
    session: string;
    cross_session?: boolean;
  }): Promise<{ board_id: string; holder_id: string; cross_session: boolean }> {
    this.assertBoardId(input.board_id);
    this.assertSession(input.session);
    if (input.holder_id !== undefined && !HOLDER_ID.test(input.holder_id)) {
      throw invalidInput("Invalid holder coordinate");
    }
    return this.mutate(async (state, context) => {
      const nowMs = this.now().getTime();
      const board = this.requireBoard(state, input.board_id);
      await this.sweepBoard(state, input.board_id, board, context);
      const holder = this.resolveHolder(board, input);
      const crossSession = this.assertOperable({
        recordedSession: holder.session,
        live: epoch(holder.granted_until) > nowMs,
        callerSession: input.session,
        crossSessionFlag: input.cross_session === true,
        conflict: holderConflict(input.board_id, holder),
      });
      this.removeHolder(board, holder.holder_id);
      return { board_id: input.board_id, holder_id: holder.holder_id, cross_session: crossSession };
    });
  }

  async extend(input: {
    board_id: string;
    holder_id: string;
    for_minutes: number;
    session: string;
    long_lease?: boolean;
    cross_session?: boolean;
  }): Promise<{ board_id: string; holder_id: string; granted_until: string; extended_after_expiry: number }> {
    this.assertBoardId(input.board_id);
    this.assertSession(input.session);
    if (!HOLDER_ID.test(input.holder_id)) throw invalidInput("Invalid holder coordinate");
    if (!Number.isSafeInteger(input.for_minutes) || input.for_minutes <= 0) {
      throw invalidInput("Extension must be a positive duration");
    }
    return this.mutate(async (state, context) => {
      const nowMs = this.now().getTime();
      const board = this.requireBoard(state, input.board_id);
      await this.sweepBoard(state, input.board_id, board, context);
      const holder = this.requireHolder(board, input.board_id, input.holder_id);
      const live = epoch(holder.granted_until) > nowMs;
      this.assertOperable({
        recordedSession: holder.session,
        live,
        callerSession: input.session,
        crossSessionFlag: input.cross_session === true,
        conflict: holderConflict(input.board_id, holder),
      });
      // Extension is additive from the surviving grant and never shortens it.
      const baseMs = Math.max(nowMs, epoch(holder.granted_until));
      const untilMs = baseMs + input.for_minutes * 60_000;
      this.assertLease(untilMs - nowMs, input.long_lease === true);
      const consumedByHolder = board.reservations.find((entry) => entry.consumed_by === holder.holder_id);
      for (const reservation of board.reservations) {
        if (reservation === consumedByHolder) continue;
        if (!conflictsMode(reservation.mode, holder.mode)) continue;
        if (epoch(reservation.from) < untilMs && epoch(reservation.to) > baseMs) {
          throw new ControlError("RESERVATION_CONFLICT", "Extended grant would overlap a reservation", {
            reason: "overlaps_reservation",
            conflicting_board: reservationConflict(input.board_id, reservation),
          });
        }
      }
      if (!live) holder.extended_after_expiry += 1;
      holder.granted_until = new Date(untilMs).toISOString();
      return {
        board_id: input.board_id,
        holder_id: holder.holder_id,
        granted_until: holder.granted_until,
        extended_after_expiry: holder.extended_after_expiry,
      };
    });
  }

  async share(input: {
    board_id: string;
    holder_id: string;
    exclusive?: boolean;
    session: string;
    cross_session?: boolean;
  }): Promise<{ board_id: string; holder_id: string; mode: BoardMode }> {
    this.assertBoardId(input.board_id);
    this.assertSession(input.session);
    if (!HOLDER_ID.test(input.holder_id)) throw invalidInput("Invalid holder coordinate");
    return this.mutate(async (state, context) => {
      const nowMs = this.now().getTime();
      const board = this.requireBoard(state, input.board_id);
      await this.sweepBoard(state, input.board_id, board, context);
      const holder = this.requireHolder(board, input.board_id, input.holder_id);
      this.assertOperable({
        recordedSession: holder.session,
        live: epoch(holder.granted_until) > nowMs,
        callerSession: input.session,
        crossSessionFlag: input.cross_session === true,
        conflict: holderConflict(input.board_id, holder),
      });
      const target: BoardMode = input.exclusive === true ? "exclusive" : "shared";
      if (holder.mode === target) return { board_id: input.board_id, holder_id: holder.holder_id, mode: target };
      if (target === "exclusive") {
        const other = board.holders.find((entry) => entry.holder_id !== holder.holder_id);
        if (other) {
          throw new ControlError("BOARD_BUSY", "Other holders block the exclusive conversion", {
            reason: "shared_holders_block_exclusive",
            conflicting_board: holderConflict(input.board_id, other),
          });
        }
        const consumed = board.reservations.find((entry) => entry.consumed_by === holder.holder_id);
        if (consumed && consumed.mode !== "exclusive") {
          // The conversion may not bypass the mode contract the consume established.
          throw new ControlError("RESERVATION_CONFLICT", "Consumed reservation does not permit exclusive mode", {
            reason: "mode_mismatch",
            conflicting_board: reservationConflict(input.board_id, consumed),
          });
        }
        const untilMs = epoch(holder.granted_until);
        for (const reservation of board.reservations) {
          if (reservation === consumed) continue;
          if (epoch(reservation.from) < untilMs && epoch(reservation.to) > nowMs) {
            throw new ControlError("RESERVATION_CONFLICT", "Exclusive conversion would override a reservation", {
              reason: "overlaps_reservation",
              conflicting_board: reservationConflict(input.board_id, reservation),
            });
          }
        }
      }
      holder.mode = target;
      return { board_id: input.board_id, holder_id: holder.holder_id, mode: target };
    });
  }

  async reserve(input: {
    board_id: string;
    mode: BoardMode;
    from: string;
    to: string;
    session: string;
    purpose: string;
  }): Promise<{ board_id: string; reservation_id: string; from: string; to: string; mode: BoardMode }> {
    this.assertBoardId(input.board_id);
    this.assertSession(input.session);
    this.assertPurpose(input.purpose);
    return this.mutate(async (state, context) => {
      const nowMs = this.now().getTime();
      const board = this.requireBoard(state, input.board_id);
      await this.sweepBoard(state, input.board_id, board, context);
      const fromMs = this.parseInstant(input.from);
      const toMs = this.parseInstant(input.to);
      if (fromMs < nowMs) throw invalidInput("Reservation cannot start in the past");
      if (toMs <= fromMs) throw invalidInput("Reservation window must end after it starts");
      if (toMs - fromMs > RESERVATION_MAX_MS) {
        throw new ControlError("BOARD_LIMIT_EXCEEDED", "Reservation window exceeds its bound", {
          reason: "reservation_too_long",
          board_id: input.board_id,
        });
      }
      if (fromMs - nowMs > RESERVATION_HORIZON_MS) {
        throw new ControlError("BOARD_LIMIT_EXCEEDED", "Reservation starts beyond the horizon", {
          reason: "reservation_horizon",
          board_id: input.board_id,
        });
      }
      if (board.reservations.length >= MAX_RESERVATIONS) {
        throw new ControlError("BOARD_LIMIT_EXCEEDED", "Board reservation limit reached", {
          reason: "reservation_count",
          board_id: input.board_id,
        });
      }
      for (const reservation of board.reservations) {
        if (!conflictsMode(reservation.mode, input.mode)) continue;
        if (epoch(reservation.from) < toMs && epoch(reservation.to) > fromMs) {
          throw new ControlError("RESERVATION_CONFLICT", "Reservation overlaps another reservation", {
            reason: "overlaps_reservation",
            conflicting_board: reservationConflict(input.board_id, reservation),
          });
        }
      }
      for (const holder of board.holders) {
        if (!conflictsMode(holder.mode, input.mode)) continue;
        if (epoch(holder.granted_until) > fromMs) {
          throw new ControlError("RESERVATION_CONFLICT", "Reservation overlaps an active grant", {
            reason: "overlaps_active_grant",
            conflicting_board: holderConflict(input.board_id, holder),
          });
        }
      }
      const reservation: BoardReservation = {
        reservation_id: newReservationId(nowMs),
        session: input.session,
        mode: input.mode,
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        purpose: input.purpose,
        created_at: new Date(nowMs).toISOString(),
        consumed_by: null,
      };
      board.reservations.push(reservation);
      return {
        board_id: input.board_id,
        reservation_id: reservation.reservation_id,
        from: reservation.from,
        to: reservation.to,
        mode: reservation.mode,
      };
    });
  }

  async unreserve(input: {
    board_id: string;
    reservation_id: string;
    session: string;
    cross_session?: boolean;
  }): Promise<{ board_id: string; reservation_id: string; cross_session: boolean }> {
    this.assertBoardId(input.board_id);
    this.assertSession(input.session);
    if (!RESERVATION_ID.test(input.reservation_id)) throw invalidInput("Invalid reservation coordinate");
    return this.mutate(async (state, context) => {
      const board = this.requireBoard(state, input.board_id);
      await this.sweepBoard(state, input.board_id, board, context);
      const reservation = board.reservations.find((entry) => entry.reservation_id === input.reservation_id);
      if (!reservation) {
        throw new ControlError("RESERVATION_NOT_FOUND", "Reservation coordinate did not match", {
          board_id: input.board_id,
        });
      }
      const crossSession = this.assertOperable({
        recordedSession: reservation.session,
        live: true,
        callerSession: input.session,
        crossSessionFlag: input.cross_session === true,
        conflict: reservationConflict(input.board_id, reservation),
      });
      board.reservations = board.reservations.filter((entry) => entry !== reservation);
      return { board_id: input.board_id, reservation_id: input.reservation_id, cross_session: crossSession };
    });
  }

  /**
   * Rebinds an untracked holder to the calling wrapper's live trio. A holder
   * whose recorded pid died no longer exists here — the sweep reaped it — so
   * the resume path for that case is an ordinary re-acquire, never adoption.
   */
  async adoptHolder(input: {
    board_id: string;
    holder_id: string;
    session: string;
    liveness: LivenessTrio;
    cross_session?: boolean;
  }): Promise<{ board_id: string; holder_id: string; liveness_tracked: boolean; cross_session: boolean }> {
    this.assertBoardId(input.board_id);
    this.assertSession(input.session);
    if (!HOLDER_ID.test(input.holder_id)) throw invalidInput("Invalid holder coordinate");
    return this.mutate(async (state, context) => {
      const nowMs = this.now().getTime();
      const board = this.requireBoard(state, input.board_id);
      await this.sweepBoard(state, input.board_id, board, context);
      const holder = this.requireHolder(board, input.board_id, input.holder_id);
      // The sweep above already reaped every provably dead pid, so any pid
      // still recorded here belongs to a process we must not displace.
      if (holder.pid !== null) {
        throw new ControlError("HOLDER_MISMATCH", "Holder already tracks a live process", {
          reason: "live_pid_recorded",
          conflicting_board: holderConflict(input.board_id, holder),
        });
      }
      const crossSession = this.assertOperable({
        recordedSession: holder.session,
        live: epoch(holder.granted_until) > nowMs,
        callerSession: input.session,
        crossSessionFlag: input.cross_session === true,
        conflict: holderConflict(input.board_id, holder),
      });
      holder.pid = input.liveness.pid;
      holder.pid_start_time = input.liveness.pid_start_time;
      holder.boot_id = input.liveness.boot_id;
      holder.session = input.session;
      return {
        board_id: input.board_id,
        holder_id: holder.holder_id,
        liveness_tracked: input.liveness.pid !== null,
        cross_session: crossSession,
      };
    });
  }

  async recoverResetState(input: { session: string }): Promise<{ reset: true; preserved: string }> {
    this.assertSession(input.session);
    return this.lock.run(async () => {
      try {
        await this.store.read();
      } catch (cause) {
        if (cause instanceof ControlError && cause.code === "BOARD_STATE_CORRUPT") {
          const suffix = this.now().toISOString().replace(/[:.]/g, "-");
          const preserved = await this.store.resetCorrupt(suffix);
          await this.safeJournal({ event: "state_reset" });
          return { reset: true as const, preserved };
        }
        throw cause;
      }
      throw invalidInput("Board state is not corrupt");
    });
  }

  /**
   * Lock-free read: rename-published state is always a consistent snapshot.
   * Detail (holders and reservations with coordinates) is emitted only for a
   * single named board; the all-boards form stays compact so the observation
   * command cannot outgrow the bounded CLI envelope exactly when the state is
   * busiest. Display strings are truncated — coordinates never are.
   */
  async status(boardId?: string): Promise<{
    boards: Array<Record<string, unknown>>;
  }> {
    if (boardId !== undefined) this.assertBoardId(boardId);
    const state = await this.store.read();
    const nowMs = this.now().getTime();
    if (boardId === undefined) {
      return {
        boards: Object.keys(state.boards).sort().map((name) => {
          const board = state.boards[name] as BoardRecord;
          return {
            board_id: name,
            ...(board.description ? { description: display(board.description) } : {}),
            interfaces: board.interfaces,
            holder_count: board.holders.length,
            reservation_count: board.reservations.length,
            expired_holder_count: board.holders.filter((holder) => epoch(holder.granted_until) <= nowMs).length,
          };
        }),
      };
    }
    const board = state.boards[boardId];
    if (!board) throw new ControlError("BOARD_NOT_FOUND", "Board is not registered", { board_id: boardId });
    const holders = [];
    for (const holder of board.holders) {
      const expired = epoch(holder.granted_until) <= nowMs;
      const verdict = holder.pid === null ? "untracked" : await this.holderVerdict(holder);
      holders.push({
        holder_id: holder.holder_id,
        session: display(holder.session),
        mode: holder.mode,
        purpose: display(holder.purpose),
        acquired_at: holder.acquired_at,
        granted_until: holder.granted_until,
        liveness: verdict,
        expired,
        overstay: expired && verdict !== "dead",
        extended_after_expiry: holder.extended_after_expiry,
      });
    }
    const reservations = board.reservations.slice(0, RESERVATION_DISPLAY_LIMIT).map((reservation) => ({
      reservation_id: reservation.reservation_id,
      session: display(reservation.session),
      mode: reservation.mode,
      from: reservation.from,
      to: reservation.to,
      purpose: display(reservation.purpose),
      consumed_by: reservation.consumed_by,
      lapsed: epoch(reservation.to) <= nowMs,
    }));
    return {
      boards: [{
        board_id: boardId,
        ...(board.description ? { description: display(board.description) } : {}),
        interfaces: board.interfaces,
        holders,
        reservations,
        truncated: board.reservations.length > RESERVATION_DISPLAY_LIMIT,
      }],
    };
  }

  async list(): Promise<{ boards: Array<Record<string, unknown>> }> {
    const state = await this.store.read();
    return {
      boards: Object.keys(state.boards).sort().map((name) => {
        const board = state.boards[name] as BoardRecord;
        return {
          board_id: name,
          ...(board.description ? { description: display(board.description) } : {}),
          interfaces: board.interfaces,
          holder_count: board.holders.length,
          reservation_count: board.reservations.length,
        };
      }),
    };
  }

  private async mutate<T>(fn: (state: BoardState, context: MutationEvents) => Promise<T> | T): Promise<T> {
    return this.lock.run(async () => {
      const state = await this.store.read();
      const context: MutationEvents = { events: [] };
      const result = await fn(state, context);
      await this.store.write(state);
      for (const event of context.events) await this.safeJournal(event);
      return result;
    });
  }

  private async safeJournal(event: BoardJournalEvent): Promise<void> {
    try {
      await this.journal.append(event);
    } catch {
      // The board journal is a derived measurement stream, never lock authority.
    }
  }

  private async sweepBoard(
    state: BoardState,
    boardId: string,
    board: BoardRecord,
    context: MutationEvents,
  ): Promise<void> {
    const nowMs = this.now().getTime();
    for (const reservation of [...board.reservations]) {
      if (epoch(reservation.to) > nowMs) continue;
      board.reservations = board.reservations.filter((entry) => entry !== reservation);
      context.events.push({
        event: "reservation_lapsed",
        board_id: boardId,
        reservation_id: reservation.reservation_id,
      });
    }
    for (const holder of [...board.holders]) {
      if (holder.pid === null) continue;
      if ((await this.holderVerdict(holder)) !== "dead") continue;
      this.removeHolder(board, holder.holder_id);
      context.events.push({
        event: "holder_reaped",
        board_id: boardId,
        holder_id: holder.holder_id,
        cause: "process_dead",
      });
    }
  }

  private async holderVerdict(holder: BoardHolder): Promise<"alive" | "dead"> {
    if (holder.pid === null) return "alive";
    const bootId = await this.probe.currentBootId();
    if (bootId !== undefined && holder.boot_id !== null && holder.boot_id !== bootId) return "dead";
    const inspection = await this.probe.inspect(holder.pid);
    if (inspection.state === "dead") return "dead";
    if (
      inspection.state === "alive" &&
      inspection.startTime !== undefined &&
      holder.pid_start_time !== null &&
      inspection.startTime !== holder.pid_start_time
    ) {
      return "dead";
    }
    // EPERM and unreadable evidence stay alive: reclaim requires proof of death.
    return "alive";
  }

  private removeHolder(board: BoardRecord, holderId: string): void {
    board.holders = board.holders.filter((entry) => entry.holder_id !== holderId);
    for (const reservation of board.reservations) {
      if (reservation.consumed_by === holderId) reservation.consumed_by = null;
    }
  }

  private resolveHolder(board: BoardRecord, input: { board_id: string; holder_id?: string; session: string }): BoardHolder {
    if (input.holder_id !== undefined) {
      return this.requireHolder(board, input.board_id, input.holder_id);
    }
    const own = board.holders.filter((entry) => entry.session === input.session);
    if (own.length === 0) {
      throw new ControlError("HOLDER_NOT_FOUND", "No holder matches the calling session", {
        board_id: input.board_id,
      });
    }
    if (own.length > 1) {
      throw new ControlError("HOLDER_AMBIGUOUS", "Multiple holders match; identify one with its coordinate", {
        board_id: input.board_id,
      });
    }
    return own[0] as BoardHolder;
  }

  private requireHolder(board: BoardRecord, boardId: string, holderId: string): BoardHolder {
    const holder = board.holders.find((entry) => entry.holder_id === holderId);
    if (!holder) {
      throw new ControlError("HOLDER_NOT_FOUND", "Holder coordinate did not match", { board_id: boardId });
    }
    return holder;
  }

  private requireBoard(state: BoardState, boardId: string): BoardRecord {
    const board = state.boards[boardId];
    if (!board) throw new ControlError("BOARD_NOT_FOUND", "Board is not registered", { board_id: boardId });
    return board;
  }

  /** Coordinate-as-authority with one guard: live targets of another session need the explicit flag. */
  private assertOperable(input: {
    recordedSession: string;
    live: boolean;
    callerSession: string;
    crossSessionFlag: boolean;
    conflict: BoardConflictSummary;
  }): boolean {
    if (input.recordedSession === input.callerSession) return false;
    if (input.live && !input.crossSessionFlag) {
      throw new ControlError("HOLDER_MISMATCH", "Operating another session's live entry requires the explicit flag", {
        reason: "cross_session_flag_required",
        conflicting_board: input.conflict,
      });
    }
    return true;
  }

  private resolveWindow(input: BoardWindowInput, nowMs: number): number {
    const hasFor = input.for_minutes !== undefined;
    const hasUntil = input.until !== undefined;
    if (hasFor === hasUntil) throw invalidInput("Exactly one of a duration or an until instant is required");
    if (hasFor) {
      const minutes = input.for_minutes as number;
      if (!Number.isSafeInteger(minutes) || minutes <= 0) throw invalidInput("Duration must be a positive integer");
      return nowMs + minutes * 60_000;
    }
    const untilMs = this.parseInstant(input.until as string);
    if (untilMs <= nowMs) throw invalidInput("Until must be in the future");
    return untilMs;
  }

  private parseInstant(value: string): number {
    const ms = new Date(value).getTime();
    if (!Number.isFinite(ms) || value.length > 64) throw invalidInput("Invalid instant");
    return ms;
  }

  private assertLease(lengthMs: number, longLease: boolean): void {
    const cap = longLease ? LONG_LEASE_MAX_MS : LEASE_MAX_MS;
    if (lengthMs > cap) {
      throw new ControlError("BOARD_LIMIT_EXCEEDED", "Lease exceeds its bound", { reason: "lease_too_long" });
    }
  }

  private retriableWait(cause: unknown): boolean {
    if (!(cause instanceof ControlError)) return false;
    if (cause.code === "BOARD_BUSY" || cause.code === "BOARD_RESERVED") return true;
    if (cause.code === "LOCK_CONTENDED" || cause.code === "LOCK_ACQUIRE_TIMEOUT") return true;
    return cause.code === "RESERVATION_CONFLICT" && cause.details.reason === "reservation_not_started";
  }

  private assertBoardId(value: string): void {
    if (!BOARD_ID.test(value)) throw invalidInput("Invalid board identifier");
  }

  private assertSession(value: string): void {
    if (value.trim().length === 0 || Buffer.byteLength(value, "utf8") > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw invalidInput("Invalid session coordinate");
    }
  }

  private assertDescription(value: string | undefined): void {
    if (value === undefined) return;
    if (value.trim().length === 0 || Buffer.byteLength(value, "utf8") > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw invalidInput("Invalid description");
    }
  }

  private assertInterfaces(interfaces: BoardInterface[]): void {
    if (interfaces.length > 8) throw invalidInput("Too many interfaces");
    for (const entry of interfaces) {
      if (
        entry.address.trim().length === 0 ||
        Buffer.byteLength(entry.address, "utf8") > 255 ||
        /[\u0000-\u001f\u007f]/u.test(entry.address)
      ) {
        throw invalidInput("Invalid interface address");
      }
    }
  }

  private assertPurpose(value: string): void {
    if (value.trim().length === 0 || Buffer.byteLength(value, "utf8") > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw invalidInput("Invalid purpose");
    }
    this.sensitiveData.assertSafe(value);
  }

  private holderSummary(boardId: string, holder: BoardHolder): BoardHolderSummary {
    return {
      board_id: boardId,
      holder_id: holder.holder_id,
      session: holder.session,
      mode: holder.mode,
      purpose: holder.purpose,
      acquired_at: holder.acquired_at,
      granted_until: holder.granted_until,
      liveness_tracked: holder.pid !== null,
    };
  }
}
