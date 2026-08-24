import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { requiresMutationLock, runCli, type CliDependencies } from "../cli.js";
import { ControlError } from "../errors.js";

const HOLDER = `hld-0189a7f0-1234-7abc-8def-0123456789ab`;
const RESERVATION = `rsv-0189a7f0-1234-7abc-8def-0123456789ab`;

function largeBoardSummaries(count = 20): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    board_id: `board-${String(index).padStart(3, "0")}`,
    description: "d".repeat(64),
    interfaces: Array.from({ length: 8 }, () => ({ type: "serial", address: "a".repeat(255) })),
    holder_count: 0,
    reservation_count: 0,
  }));
}

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

  it("preserves a successful board result when its derived journal append fails", async () => {
    const { dependencies, boardJournal, boardService } = makeDependencies();
    boardJournal.append.mockRejectedValueOnce(new Error("injected board journal failure"));

    const result = await runCli([
      "board", "acquire", "wlan-01",
      "--mode", "exclusive", "--for", "30m", "--session", "sess-a", "--purpose", "smoke",
    ], dependencies);

    expect(result.exitCode).toBe(0);
    expect(boardService.acquire).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "board acquire",
      result: { holder: { holder_id: HOLDER } },
      journal_warning: { code: "JOURNAL_WRITE_FAILED" },
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain("injected board journal failure");
  });

  it("paginates a large board list within the CLI envelope without gaps or duplicates", async () => {
    const boards = largeBoardSummaries();
    const { dependencies, boardJournal } = makeDependencies({
      boardService: { list: vi.fn().mockResolvedValue({ boards }) },
    });
    boardJournal.append.mockRejectedValue(new Error("injected board journal failure"));
    const seen: string[] = [];
    let after: string | undefined;

    for (let pageNumber = 0; pageNumber <= boards.length; pageNumber += 1) {
      const result = await runCli(["board", "list", ...(after ? ["--after", after] : [])], dependencies);
      expect(result.exitCode).toBe(0);
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(12 * 1024);
      const envelope = JSON.parse(result.stdout) as {
        result: { boards: Array<{ board_id: string }>; total_boards: number; truncated: boolean; next_after?: string };
        journal_warning?: { code: string };
      };
      expect(envelope.journal_warning).toEqual({ code: "JOURNAL_WRITE_FAILED" });
      const page = envelope.result;
      expect(page.total_boards).toBe(boards.length);
      seen.push(...page.boards.map((board) => board.board_id));
      if (!page.truncated) {
        expect(page.next_after).toBeUndefined();
        break;
      }
      expect(page.boards.length).toBeGreaterThan(0);
      expect(page.next_after).toBe(page.boards.at(-1)?.board_id);
      after = page.next_after;
    }

    expect(seen).toEqual(boards.map((board) => board.board_id));
  });

  it("supports the same cursor on all-board status but rejects it on named detail", async () => {
    const boards = largeBoardSummaries(8);
    const status = vi.fn().mockResolvedValue({ boards });
    const { dependencies } = makeDependencies({ boardService: { status } });

    const page = await runCli(["board", "status", "--after", "board-003"], dependencies);
    expect(page.exitCode).toBe(0);
    expect(status).toHaveBeenCalledWith(undefined);
    expect((JSON.parse(page.stdout) as { result: { boards: Array<{ board_id: string }> } }).result.boards[0]?.board_id)
      .toBe("board-004");

    const named = await runCli(["board", "status", "wlan-01", "--after", "board-003"], dependencies);
    expect(named.exitCode).toBe(2);
  });

  it("rejects an invalid board page cursor before calling the service", async () => {
    const { dependencies, boardService } = makeDependencies();
    const result = await runCli(["board", "list", "--after", "../board-001"], dependencies);
    expect(result.exitCode).toBe(2);
    expect(boardService.list).not.toHaveBeenCalled();
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
