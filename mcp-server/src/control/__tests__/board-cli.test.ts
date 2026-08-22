import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { requiresMutationLock, runCli, type CliDependencies } from "../cli.js";
import { ControlError } from "../errors.js";

const HOLDER = `hld-0189a7f0-1234-7abc-8def-0123456789ab`;
const RESERVATION = `rsv-0189a7f0-1234-7abc-8def-0123456789ab`;

interface BoardOverrides {
  boardService?: Record<string, unknown>;
}

function makeDependencies(overrides: BoardOverrides = {}) {
  const pilotJournal = { append: vi.fn().mockResolvedValue(undefined) };
  const boardJournal = { append: vi.fn().mockResolvedValue(undefined) };
  const mutationLock = { run: vi.fn(async <T>(callback: () => Promise<T>) => callback()) };
  const boardService = {
    register: vi.fn().mockResolvedValue({ board_id: "wlan-01", created: true }),
    update: vi.fn().mockResolvedValue({ board_id: "wlan-01" }),
    unregister: vi.fn().mockResolvedValue({ board_id: "wlan-01", removed: true }),
    list: vi.fn().mockResolvedValue({ boards: [] }),
    status: vi.fn().mockResolvedValue({ boards: [] }),
    acquire: vi.fn().mockResolvedValue({
      holder: {
        board_id: "wlan-01", holder_id: HOLDER, session: "sess-a", mode: "exclusive",
        purpose: "smoke", acquired_at: "2026-08-22T10:00:00.000Z", granted_until: "2026-08-22T11:00:00.000Z",
        liveness_tracked: false,
      },
      shortened: false,
      evicted_expired: [],
      cross_session: false,
    }),
    wait: vi.fn().mockResolvedValue({ holder: {}, shortened: false, evicted_expired: [], cross_session: false }),
    release: vi.fn().mockResolvedValue({ board_id: "wlan-01", holder_id: HOLDER, cross_session: false }),
    extend: vi.fn().mockResolvedValue({ board_id: "wlan-01", holder_id: HOLDER, granted_until: "2026-08-22T12:00:00.000Z", extended_after_expiry: 0 }),
    share: vi.fn().mockResolvedValue({ board_id: "wlan-01", holder_id: HOLDER, mode: "shared" }),
    reserve: vi.fn().mockResolvedValue({ board_id: "wlan-01", reservation_id: RESERVATION, from: "2026-08-22T12:00:00.000Z", to: "2026-08-22T13:00:00.000Z", mode: "exclusive" }),
    unreserve: vi.fn().mockResolvedValue({ board_id: "wlan-01", reservation_id: RESERVATION, cross_session: false }),
    adoptHolder: vi.fn(),
    recoverResetState: vi.fn().mockResolvedValue({ reset: true, preserved: "boards.yaml.corrupt-x" }),
    ...overrides.boardService,
  };
  const dependencies = {
    stateDir: join(tmpdir(), "jhw-board-cli-state"),
    env: {},
    now: () => new Date("2026-08-22T10:00:00.000Z"),
    taskService: {},
    claimService: {},
    catalog: {},
    source: {},
    portfolio: {},
    preflight: {},
    mutationLock,
    journal: pilotJournal,
    boardService,
    boardJournal,
    livenessProbe: { currentBootId: async () => "boot-1", inspect: async () => ({ state: "alive" as const, startTime: "1" }) },
  } as unknown as CliDependencies;
  return { dependencies, pilotJournal, boardJournal, mutationLock, boardService };
}

describe("board CLI wiring", () => {
  it("never touches the pilot journal or the registry mutation lock", async () => {
    const { dependencies, pilotJournal, boardJournal, mutationLock } = makeDependencies();
    const result = await runCli(["board", "list"], dependencies);
    expect(result.exitCode).toBe(0);
    expect(pilotJournal.append).not.toHaveBeenCalled();
    expect(mutationLock.run).not.toHaveBeenCalled();
    expect(boardJournal.append).toHaveBeenCalledTimes(1);
    expect(boardJournal.append.mock.calls[0]?.[0]).toMatchObject({ event: "command", command: "board list", ok: true });
    expect(requiresMutationLock(["board", "acquire", "wlan-01"])).toBe(false);
  });

  it("dispatches acquire with parsed duration and coordinates, journaling the board id", async () => {
    const { dependencies, boardJournal, boardService } = makeDependencies();
    const result = await runCli([
      "board", "acquire", "wlan-01",
      "--mode", "exclusive", "--for", "2h", "--session", "sess-a", "--purpose", "smoke",
    ], dependencies);
    expect(result.exitCode).toBe(0);
    expect(boardService.acquire).toHaveBeenCalledWith(expect.objectContaining({
      board_id: "wlan-01", mode: "exclusive", for_minutes: 120, session: "sess-a", purpose: "smoke",
    }));
    expect(boardJournal.append.mock.calls[0]?.[0]).toMatchObject({ board_id: "wlan-01" });
  });

  it("maps board conflicts to exit 4 and emits the bounded reason and conflict coordinates", async () => {
    const { dependencies } = makeDependencies({
      boardService: {
        acquire: vi.fn().mockRejectedValue(new ControlError("BOARD_BUSY", "held", {
          reason: "exclusive_holder",
          conflicting_board: {
            board_id: "wlan-01", holder_id: HOLDER, mode: "exclusive",
            purpose: "other", granted_until: "2026-08-22T11:00:00.000Z",
          },
        })),
      },
    });
    const result = await runCli([
      "board", "acquire", "wlan-01",
      "--mode", "exclusive", "--for", "30m", "--session", "sess-b", "--purpose", "mine",
    ], dependencies);
    expect(result.exitCode).toBe(4);
    const error = (JSON.parse(result.stderr) as { error: Record<string, unknown> }).error;
    expect(error).toMatchObject({
      code: "BOARD_BUSY",
      reason: "exclusive_holder",
      conflicting_board: { holder_id: HOLDER },
    });
  });

  it("maps a full board to the conflict exit family, not the crash family", async () => {
    const { dependencies } = makeDependencies({
      boardService: {
        acquire: vi.fn().mockRejectedValue(new ControlError("BOARD_LIMIT_EXCEEDED", "full", {
          reason: "holder_count", board_id: "wlan-01",
        })),
      },
    });
    const result = await runCli([
      "board", "acquire", "wlan-01",
      "--mode", "shared", "--for", "30m", "--session", "sess-a", "--purpose", "p",
    ], dependencies);
    expect(result.exitCode).toBe(4);
  });

  it("rejects bare boolean flags that are not the exact literal true", async () => {
    const { dependencies } = makeDependencies();
    const result = await runCli([
      "board", "acquire", "wlan-01",
      "--mode", "exclusive", "--for", "30m", "--session", "sess-a", "--purpose", "p",
      "--claim-expired", "yes",
    ], dependencies);
    expect(result.exitCode).toBe(2);
  });

  it("requires the exact literal confirmation for a state reset", async () => {
    const { dependencies, boardService } = makeDependencies();
    const refused = await runCli(["board", "recover", "--action", "reset-state", "--confirm", "yes", "--session", "s"], dependencies);
    expect(refused.exitCode).toBe(2);
    expect(boardService.recoverResetState).not.toHaveBeenCalled();
    const accepted = await runCli(["board", "recover", "--action", "reset-state", "--confirm", "reset-state", "--session", "s"], dependencies);
    expect(accepted.exitCode).toBe(0);
  });
});
