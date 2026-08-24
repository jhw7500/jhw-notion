import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BoardJournalEvent } from "../board-journal.js";
import { BoardService, type LivenessProbe, type PidInspection } from "../board-service.js";
import type { ControlConfig } from "../config.js";

const BASE = new Date("2026-08-22T10:00:00.000Z").getTime();
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

function configFor(stateDir: string): ControlConfig {
  return {
    registryDir: join(stateDir, "..", "registry"),
    registryRemote: "origin",
    registryBranch: "main",
    worktreeRoot: join(stateDir, "..", "worktrees"),
    buildHost: "testhost",
    githubOwner: "example",
    projectNumber: 1,
    registryRepository: "example/registry",
    preflightProjectItemId: "PVTI_test",
    preflightRegistryIssueNumber: 1,
    stateDir,
  };
}

type ProbeTable = Record<number, PidInspection>;

interface Fixture {
  service: BoardService;
  events: BoardJournalEvent[];
  probeTable: ProbeTable;
  setBootId: (value: string | undefined) => void;
  setNow: (minutes: number) => void;
  stateDir: string;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jhw-board-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const stateDir = join(root, "state");
  let nowMs = BASE;
  let bootId: string | undefined = "boot-1";
  const probeTable: ProbeTable = {};
  const events: BoardJournalEvent[] = [];
  const probe: LivenessProbe = {
    currentBootId: async () => bootId,
    inspect: async (pid) => probeTable[pid] ?? { state: "unknown" },
  };
  const service = new BoardService(
    configFor(stateDir),
    { run: async (callback) => callback() },
    probe,
    () => new Date(nowMs),
    { append: async (event) => { events.push(event); } },
  );
  return {
    service,
    events,
    probeTable,
    setBootId: (value) => { bootId = value; },
    setNow: (minutes) => { nowMs = BASE + minutes * 60_000; },
    stateDir,
  };
}

async function registered(fixture: Fixture, boardId = "wlan-01"): Promise<void> {
  await fixture.service.register({
    board_id: boardId,
    description: "wlan target",
    interfaces: [{ type: "serial", address: "/dev/ttyUSB0" }],
    session: "sess-a",
  });
}

describe("board registration", () => {
  it("registers, lists, updates, and refuses duplicates and non-empty unregister", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await expect(fixture.service.register({
      board_id: "wlan-01", interfaces: [], session: "sess-a",
    })).rejects.toMatchObject({ code: "BOARD_ALREADY_REGISTERED" });

    await fixture.service.update({ board_id: "wlan-01", interfaces: [{ type: "ethernet", address: "192.168.1.50" }], session: "sess-a" });
    const listed = await fixture.service.list();
    expect(listed.boards).toHaveLength(1);
    expect(listed.boards[0]).toMatchObject({ board_id: "wlan-01", interfaces: [{ type: "ethernet", address: "192.168.1.50" }] });

    await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "smoke", for_minutes: 60,
    });
    await expect(fixture.service.unregister({ board_id: "wlan-01", session: "sess-a" }))
      .rejects.toMatchObject({ code: "BOARD_NOT_EMPTY" });
  });

  it("treats a missing state file as empty, and reads status lock-free", async () => {
    const fixture = makeFixture();
    expect((await fixture.service.list()).boards).toHaveLength(0);
    await expect(fixture.service.status("wlan-01")).rejects.toMatchObject({ code: "BOARD_NOT_FOUND" });
  });

  it("rejects malformed metadata as invalid input, never as state corruption", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await expect(fixture.service.update({ board_id: "wlan-01", description: "", session: "sess-a" }))
      .rejects.toMatchObject({ code: "INVALID_BOARD_INPUT" });
    await expect(fixture.service.update({
      board_id: "wlan-01",
      interfaces: Array.from({ length: 9 }, (_, index) => ({ type: "serial" as const, address: `/dev/ttyUSB${index}` })),
      session: "sess-a",
    })).rejects.toMatchObject({ code: "INVALID_BOARD_INPUT" });
    await expect(fixture.service.register({
      board_id: "pim", interfaces: [{ type: "serial", address: "x".repeat(300) }], session: "sess-a",
    })).rejects.toMatchObject({ code: "INVALID_BOARD_INPUT" });
  });

  it("keeps the all-boards status compact while a named board returns detail", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "work", for_minutes: 60 });
    const compact = await fixture.service.status();
    expect(compact.boards[0]).toMatchObject({ board_id: "wlan-01", holder_count: 1, reservation_count: 0 });
    expect(compact.boards[0]).not.toHaveProperty("holders");
    const detail = await fixture.service.status("wlan-01");
    expect((detail.boards[0]?.holders as unknown[])).toHaveLength(1);
  });
});

describe("occupancy matrix", () => {
  it("exclusive blocks everything, shared holders coexist and block exclusive", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "one", for_minutes: 60 });
    await expect(fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-b", purpose: "two", for_minutes: 60 }))
      .rejects.toMatchObject({ code: "BOARD_BUSY", details: { reason: "exclusive_holder" } });
    await expect(fixture.service.acquire({ board_id: "wlan-01", mode: "shared", session: "sess-b", purpose: "two", for_minutes: 60 }))
      .rejects.toMatchObject({ code: "BOARD_BUSY", details: { reason: "exclusive_holder" } });

    const other = makeFixture();
    await registered(other, "pim");
    await other.service.acquire({ board_id: "pim", mode: "shared", session: "sess-a", purpose: "one", for_minutes: 60 });
    await other.service.acquire({ board_id: "pim", mode: "shared", session: "sess-b", purpose: "two", for_minutes: 60 });
    await expect(other.service.acquire({ board_id: "pim", mode: "exclusive", session: "sess-c", purpose: "three", for_minutes: 60 }))
      .rejects.toMatchObject({ code: "BOARD_BUSY", details: { reason: "shared_holders_block_exclusive" } });
  });

  it("bounds the lease and allows the explicit long-lease opt-in", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await expect(fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "long", for_minutes: 13 * 60 }))
      .rejects.toMatchObject({ code: "BOARD_LIMIT_EXCEEDED", details: { reason: "lease_too_long" } });
    const granted = await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "long", for_minutes: 13 * 60, long_lease: true,
    });
    expect(granted.holder.granted_until).toBe(at(13 * 60));
  });
});

describe("reservation fencing", () => {
  it("refuses inside an active window, and shortening is opt-in", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await fixture.service.reserve({
      board_id: "wlan-01", mode: "exclusive", from: at(30), to: at(90), session: "sess-b", purpose: "regression",
    });

    await expect(fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "now", for_minutes: 120 }))
      .rejects.toMatchObject({ code: "BOARD_RESERVED", details: { reason: "shortening_not_accepted" } });

    const shortened = await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "now", for_minutes: 120, accept_shortened: true,
    });
    expect(shortened.shortened).toBe(true);
    expect(shortened.holder.granted_until).toBe(at(30));

    fixture.setNow(40);
    await fixture.service.release({ board_id: "wlan-01", holder_id: shortened.holder.holder_id, session: "sess-a" });
    await expect(fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "mid", for_minutes: 10 }))
      .rejects.toMatchObject({ code: "BOARD_RESERVED", details: { reason: "reservation_window_active" } });
  });

  it("applies the mode matrix symmetrically: shared reservations block exclusive requests", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await fixture.service.reserve({
      board_id: "wlan-01", mode: "shared", from: at(0), to: at(60), session: "sess-b", purpose: "monitoring",
    });
    await expect(fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "flash", for_minutes: 30 }))
      .rejects.toMatchObject({ code: "BOARD_RESERVED", details: { reason: "reservation_window_active" } });
    const shared = await fixture.service.acquire({
      board_id: "wlan-01", mode: "shared", session: "sess-a", purpose: "observe", for_minutes: 30,
    });
    expect(shared.shortened).toBe(false);
  });

  it("claim-expired evicts only expired holders and never bypasses reservation fencing", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "old", for_minutes: 30 });
    fixture.setNow(60);
    await expect(fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-b", purpose: "next", for_minutes: 30 }))
      .rejects.toMatchObject({ code: "BOARD_BUSY", details: { reason: "overstay_holder" } });
    const evicting = await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-b", purpose: "next", for_minutes: 30, claim_expired: true,
    });
    expect(evicting.evicted_expired).toHaveLength(1);
    expect(fixture.events.some((event) => event.event === "holder_evicted_expired")).toBe(true);

    // An unexpired holder survives claim-expired.
    await expect(fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-c", purpose: "steal", for_minutes: 30, claim_expired: true,
    })).rejects.toMatchObject({ code: "BOARD_BUSY", details: { reason: "exclusive_holder" } });

    // Fencing precedes holder evaluation: an expired holder inside another
    // session's active reservation window still yields BOARD_RESERVED.
    const fenced = makeFixture();
    await registered(fenced, "pim");
    await fenced.service.acquire({ board_id: "pim", mode: "exclusive", session: "sess-a", purpose: "old", for_minutes: 30 });
    await fenced.service.reserve({ board_id: "pim", mode: "exclusive", from: at(40), to: at(120), session: "sess-b", purpose: "mine" });
    fenced.setNow(50);
    await expect(fenced.service.acquire({
      board_id: "pim", mode: "exclusive", session: "sess-c", purpose: "steal", for_minutes: 30, claim_expired: true,
    })).rejects.toMatchObject({ code: "BOARD_RESERVED", details: { reason: "reservation_window_active" } });
  });
});

describe("reservation lifecycle", () => {
  it.each([
    "2026-08-23",
    "2026-08-23 10:00",
    "2026-09-31T10:00:00Z",
    "2026-08-22T20:00:00+0900",
  ])("rejects a non-offset or invalid-calendar until instant: %s", async (until) => {
    const fixture = makeFixture();
    await registered(fixture);
    await expect(fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "invalid", until,
    })).rejects.toMatchObject({ code: "INVALID_BOARD_INPUT" });
  });

  it("rejects an invalid-calendar reservation instant before normalization", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await expect(fixture.service.reserve({
      board_id: "wlan-01",
      mode: "exclusive",
      from: "2026-09-31T10:00:00Z",
      to: "2026-10-01T12:00:00Z",
      session: "sess-a",
      purpose: "invalid",
    })).rejects.toMatchObject({ code: "INVALID_BOARD_INPUT" });
  });

  it("accepts an explicit offset datetime and stores its UTC instant", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    const acquired = await fixture.service.acquire({
      board_id: "wlan-01",
      mode: "exclusive",
      session: "sess-a",
      purpose: "offset",
      until: "2026-08-22T20:00:00+09:00",
    });
    expect(acquired.holder.granted_until).toBe("2026-08-22T11:00:00.000Z");
  });

  it("validates windows, bounds, and overlap conflicts", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await expect(fixture.service.reserve({ board_id: "wlan-01", mode: "exclusive", from: at(-10), to: at(30), session: "sess-a", purpose: "past" }))
      .rejects.toMatchObject({ code: "INVALID_BOARD_INPUT" });
    await expect(fixture.service.reserve({ board_id: "wlan-01", mode: "exclusive", from: at(30), to: at(30), session: "sess-a", purpose: "empty" }))
      .rejects.toMatchObject({ code: "INVALID_BOARD_INPUT" });
    await expect(fixture.service.reserve({ board_id: "wlan-01", mode: "exclusive", from: at(0), to: at(25 * 60), session: "sess-a", purpose: "long" }))
      .rejects.toMatchObject({ code: "BOARD_LIMIT_EXCEEDED", details: { reason: "reservation_too_long" } });
    await expect(fixture.service.reserve({ board_id: "wlan-01", mode: "exclusive", from: at(8 * 24 * 60), to: at(8 * 24 * 60 + 30), session: "sess-a", purpose: "far" }))
      .rejects.toMatchObject({ code: "BOARD_LIMIT_EXCEEDED", details: { reason: "reservation_horizon" } });

    await fixture.service.reserve({ board_id: "wlan-01", mode: "shared", from: at(60), to: at(120), session: "sess-a", purpose: "one" });
    await fixture.service.reserve({ board_id: "wlan-01", mode: "shared", from: at(60), to: at(120), session: "sess-b", purpose: "two" });
    await expect(fixture.service.reserve({ board_id: "wlan-01", mode: "exclusive", from: at(90), to: at(150), session: "sess-c", purpose: "clash" }))
      .rejects.toMatchObject({ code: "RESERVATION_CONFLICT", details: { reason: "overlaps_reservation" } });

    await fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "hold", for_minutes: 30 });
    await expect(fixture.service.reserve({ board_id: "wlan-01", mode: "exclusive", from: at(10), to: at(40), session: "sess-b", purpose: "clash" }))
      .rejects.toMatchObject({ code: "RESERVATION_CONFLICT", details: { reason: "overlaps_active_grant" } });
  });

  it("consume caps the grant at the reservation end and preserves the reservation for re-acquisition", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    const reservation = await fixture.service.reserve({
      board_id: "wlan-01", mode: "exclusive", from: at(0), to: at(120), session: "sess-a", purpose: "mine",
    });

    await expect(fixture.service.acquire({
      board_id: "wlan-01", mode: "shared", session: "sess-a", purpose: "wrong", for_minutes: 30, consume: reservation.reservation_id,
    })).rejects.toMatchObject({ code: "RESERVATION_CONFLICT", details: { reason: "mode_mismatch" } });

    const consumed = await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "use", for_minutes: 4 * 60, consume: reservation.reservation_id,
    });
    expect(consumed.holder.granted_until).toBe(at(120));
    expect(consumed.consumed_reservation).toBe(reservation.reservation_id);

    // A non-consuming acquire is fenced by the same reservation even for the
    // session that created it: the coordinate, not the session, is authority.
    fixture.setNow(30);
    await fixture.service.release({ board_id: "wlan-01", holder_id: consumed.holder.holder_id, session: "sess-a" });
    await expect(fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "plain", for_minutes: 10 }))
      .rejects.toMatchObject({ code: "BOARD_RESERVED", details: { reason: "reservation_window_active" } });
    const again = await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "back", for_minutes: 10, consume: reservation.reservation_id,
    });
    expect(again.holder.granted_until).toBe(at(40));
  });

  it("applies the lease cap to the effective grant after the consume clamp", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    const reservation = await fixture.service.reserve({
      board_id: "wlan-01", mode: "exclusive", from: at(0), to: at(120), session: "sess-a", purpose: "mine",
    });
    // "--for 13h" with a 2h reservation means "until my reservation ends".
    const consumed = await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "use",
      for_minutes: 13 * 60, consume: reservation.reservation_id,
    });
    expect(consumed.holder.granted_until).toBe(at(120));
  });

  it("refuses early consume and lapses reservations on the sweep", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    const reservation = await fixture.service.reserve({
      board_id: "wlan-01", mode: "exclusive", from: at(60), to: at(120), session: "sess-a", purpose: "later",
    });
    await expect(fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "early", for_minutes: 10, consume: reservation.reservation_id,
    })).rejects.toMatchObject({ code: "RESERVATION_CONFLICT", details: { reason: "reservation_not_started" } });

    fixture.setNow(130);
    await fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-b", purpose: "after", for_minutes: 10 });
    expect(fixture.events.some((event) => event.event === "reservation_lapsed")).toBe(true);
  });
});

describe("liveness reaping", () => {
  const trio = { pid: 4242, pid_start_time: "100", boot_id: "boot-1" };

  it("reaps a dead-pid holder and a pid-reuse impostor, but never on EPERM-style uncertainty", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "tracked", for_minutes: 60, liveness: trio,
    });
    fixture.probeTable[4242] = { state: "unknown" };
    await expect(fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-b", purpose: "next", for_minutes: 30 }))
      .rejects.toMatchObject({ code: "BOARD_BUSY" });

    fixture.probeTable[4242] = { state: "dead" };
    const granted = await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-b", purpose: "next", for_minutes: 30,
    });
    expect(granted.holder.session).toBe("sess-b");
    expect(fixture.events.some((event) => event.event === "holder_reaped")).toBe(true);

    const reused = makeFixture();
    await registered(reused, "pim");
    await reused.service.acquire({
      board_id: "pim", mode: "exclusive", session: "sess-a", purpose: "tracked", for_minutes: 60, liveness: trio,
    });
    reused.probeTable[4242] = { state: "alive", startTime: "999" };
    await reused.service.acquire({ board_id: "pim", mode: "exclusive", session: "sess-b", purpose: "next", for_minutes: 30 });
  });

  it("treats a boot-id mismatch as certain death across reboots", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "tracked", for_minutes: 60, liveness: trio,
    });
    fixture.probeTable[4242] = { state: "alive", startTime: "100" };
    fixture.setBootId("boot-2");
    await fixture.service.acquire({ board_id: "wlan-01", mode: "exclusive", session: "sess-b", purpose: "after-reboot", for_minutes: 30 });
  });
});

describe("cross-session guard", () => {
  it("requires the explicit flag for a live holder of another session, but not for an expired one", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    const granted = await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "work", for_minutes: 60,
    });
    await expect(fixture.service.release({ board_id: "wlan-01", holder_id: granted.holder.holder_id, session: "sess-b" }))
      .rejects.toMatchObject({ code: "HOLDER_MISMATCH", details: { reason: "cross_session_flag_required" } });
    const released = await fixture.service.release({
      board_id: "wlan-01", holder_id: granted.holder.holder_id, session: "sess-b", cross_session: true,
    });
    expect(released.cross_session).toBe(true);

    const expired = makeFixture();
    await registered(expired, "pim");
    const holder = await expired.service.acquire({
      board_id: "pim", mode: "exclusive", session: "sess-a", purpose: "work", for_minutes: 30,
    });
    expired.setNow(45);
    const cleaned = await expired.service.release({ board_id: "pim", holder_id: holder.holder.holder_id, session: "sess-b" });
    expect(cleaned.cross_session).toBe(true);
  });

  it("resolves session-implicit release with the ambiguity codes", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await expect(fixture.service.release({ board_id: "wlan-01", session: "sess-a" }))
      .rejects.toMatchObject({ code: "HOLDER_NOT_FOUND" });
    await fixture.service.acquire({ board_id: "wlan-01", mode: "shared", session: "sess-a", purpose: "one", for_minutes: 30 });
    await fixture.service.acquire({ board_id: "wlan-01", mode: "shared", session: "sess-a", purpose: "two", for_minutes: 30 });
    await expect(fixture.service.release({ board_id: "wlan-01", session: "sess-a" }))
      .rejects.toMatchObject({ code: "HOLDER_AMBIGUOUS" });
  });
});

describe("extend and share", () => {
  it("extends additively, never shortens, and counts overstay extensions", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    const granted = await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "work", for_minutes: 60,
    });
    const extended = await fixture.service.extend({
      board_id: "wlan-01", holder_id: granted.holder.holder_id, for_minutes: 60, session: "sess-a",
    });
    expect(extended.granted_until).toBe(at(120));
    expect(extended.extended_after_expiry).toBe(0);

    await fixture.service.reserve({ board_id: "wlan-01", mode: "exclusive", from: at(150), to: at(240), session: "sess-b", purpose: "next" });
    await expect(fixture.service.extend({
      board_id: "wlan-01", holder_id: granted.holder.holder_id, for_minutes: 120, session: "sess-a",
    })).rejects.toMatchObject({ code: "RESERVATION_CONFLICT", details: { reason: "overlaps_reservation" } });
    const status = await fixture.service.status("wlan-01");
    expect((status.boards[0]?.holders as Array<{ granted_until: string }>)[0]?.granted_until).toBe(at(120));

    fixture.setNow(130);
    const overstay = await fixture.service.extend({
      board_id: "wlan-01", holder_id: granted.holder.holder_id, for_minutes: 10, session: "sess-a",
    });
    expect(overstay.granted_until).toBe(at(140));
    expect(overstay.extended_after_expiry).toBe(1);
  });

  it("re-fences exclusive conversion and honors the consumed reservation's mode contract", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    const first = await fixture.service.acquire({
      board_id: "wlan-01", mode: "shared", session: "sess-a", purpose: "one", for_minutes: 60,
    });
    await fixture.service.acquire({ board_id: "wlan-01", mode: "shared", session: "sess-b", purpose: "two", for_minutes: 60 });
    await expect(fixture.service.share({ board_id: "wlan-01", holder_id: first.holder.holder_id, exclusive: true, session: "sess-a" }))
      .rejects.toMatchObject({ code: "BOARD_BUSY", details: { reason: "shared_holders_block_exclusive" } });

    const consumeCase = makeFixture();
    await registered(consumeCase, "pim");
    const reservation = await consumeCase.service.reserve({
      board_id: "pim", mode: "shared", from: at(0), to: at(120), session: "sess-a", purpose: "shared-window",
    });
    const holder = await consumeCase.service.acquire({
      board_id: "pim", mode: "shared", session: "sess-a", purpose: "use", for_minutes: 60, consume: reservation.reservation_id,
    });
    await expect(consumeCase.service.share({ board_id: "pim", holder_id: holder.holder.holder_id, exclusive: true, session: "sess-a" }))
      .rejects.toMatchObject({ code: "RESERVATION_CONFLICT", details: { reason: "mode_mismatch" } });
  });
});

describe("adopt and wait", () => {
  it("adopts an untracked holder and refuses one that tracks a live process", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    const untracked = await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "bare", for_minutes: 60,
    });
    const adopted = await fixture.service.adoptHolder({
      board_id: "wlan-01",
      holder_id: untracked.holder.holder_id,
      session: "sess-a",
      liveness: { pid: 777, pid_start_time: "50", boot_id: "boot-1" },
    });
    expect(adopted.liveness_tracked).toBe(true);

    fixture.probeTable[777] = { state: "alive", startTime: "50" };
    await expect(fixture.service.adoptHolder({
      board_id: "wlan-01",
      holder_id: untracked.holder.holder_id,
      session: "sess-a",
      liveness: { pid: 888, pid_start_time: "60", boot_id: "boot-1" },
    })).rejects.toMatchObject({ code: "HOLDER_MISMATCH", details: { reason: "live_pid_recorded" } });

    // A holder whose tracked pid died is reaped by the sweep before adoption
    // can see it: the resume path for that case is an ordinary re-acquire.
    fixture.probeTable[777] = { state: "dead" };
    await expect(fixture.service.adoptHolder({
      board_id: "wlan-01",
      holder_id: untracked.holder.holder_id,
      session: "sess-a",
      liveness: { pid: 888, pid_start_time: "60", boot_id: "boot-1" },
    })).rejects.toMatchObject({ code: "HOLDER_NOT_FOUND" });
  });

  it("waits through a busy board and succeeds once the blocker is reaped", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await fixture.service.acquire({
      board_id: "wlan-01", mode: "exclusive", session: "sess-a", purpose: "blocker", for_minutes: 60,
      liveness: { pid: 4242, pid_start_time: "100", boot_id: "boot-1" },
    });
    fixture.probeTable[4242] = { state: "alive", startTime: "100" };
    let polls = 0;
    const granted = await fixture.service.wait(
      { board_id: "wlan-01", mode: "exclusive", session: "sess-b", purpose: "waiter", for_minutes: 30 },
      { poll_ms: 60_000, timeout_ms: 60 * 60_000 },
      async () => {
        polls += 1;
        if (polls >= 2) fixture.probeTable[4242] = { state: "dead" };
      },
    );
    expect(granted.holder.session).toBe("sess-b");
    expect(polls).toBeGreaterThanOrEqual(2);
  });
});

describe("state durability", () => {
  it("fail-closes on corruption and recovers only through the explicit reset", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    await expect(fixture.service.recoverResetState({ session: "sess-a" }))
      .rejects.toMatchObject({ code: "INVALID_BOARD_INPUT" });

    await writeFile(join(fixture.stateDir, "boards.yaml"), "{ not json", "utf8");
    await expect(fixture.service.list()).rejects.toMatchObject({ code: "BOARD_STATE_CORRUPT" });
    const reset = await fixture.service.recoverResetState({ session: "sess-a" });
    expect(reset.reset).toBe(true);
    expect((await fixture.service.list()).boards).toHaveLength(0);
    expect(fixture.events.some((event) => event.event === "state_reset")).toBe(true);
  });

  it("persists JSON-subset YAML the schema can round-trip", async () => {
    const fixture = makeFixture();
    await registered(fixture);
    const raw = JSON.parse(await readFile(join(fixture.stateDir, "boards.yaml"), "utf8")) as { version: number };
    expect(raw.version).toBe(1);
  });
});
