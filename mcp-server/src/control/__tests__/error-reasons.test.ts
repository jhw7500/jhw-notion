import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERROR_REASONS } from "../schemas.js";

const controlDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(dirname(controlDir)));

// The seven parse-level causes share one operator action — the committed
// Handoff artifact is corrupt — so the skill doc covers them with a single
// catch-all sentence instead of naming each.
const GIT_STATE_PARSE_FAMILY = [
  "invalid_git_state_line",
  "duplicate_git_state_key",
  "unexpected_git_state_key",
  "missing_git_state_key",
  "invalid_git_state_count",
  "missing_git_identity",
  "invalid_dirty_digest",
] as const;

describe("error reason vocabulary", () => {
  it("registers every reason literal a control source sets outside the typed helper", () => {
    // handoffRetryConflict's parameter is typed to the vocabulary, so tsc pins
    // its call sites; this sweep pins the untyped `reason:` keys in details
    // objects, where a typo or an invented synonym would otherwise just stop
    // emitting without anything failing.
    const found = new Set<string>();
    for (const name of readdirSync(controlDir)) {
      if (!name.endsWith(".ts")) continue;
      const source = readFileSync(join(controlDir, name), "utf8");
      for (const match of source.matchAll(/\breason: "([^"]*)"/g)) found.add(match[1]);
    }

    expect(found).toContain("handoff_copy_not_plain_file");
    expect(found).toContain("duplicate_dirty_files");
    for (const literal of found) expect(ERROR_REASONS).toContain(literal);
  });

  it("documents every registered reason where the operator is told to read it", () => {
    const doc = readFileSync(join(repositoryRoot, "skills", "claude", "task.md"), "utf8");

    expect(doc).toContain("git-state 파스 계열");
    for (const family of GIT_STATE_PARSE_FAMILY) expect(ERROR_REASONS).toContain(family);
    for (const reason of ERROR_REASONS) {
      if ((GIT_STATE_PARSE_FAMILY as readonly string[]).includes(reason)) continue;
      expect(doc).toContain(`\`${reason}\``);
    }
  });

  it("keeps every registered reason inside the bounded identifier shape that emission relies on", () => {
    // Emission is now membership, so the #35/#56 guarantee — no prose, paths,
    // or redaction output on stderr — holds only while every member keeps the
    // shape the old schema enforced.
    expect(new Set(ERROR_REASONS).size).toBe(ERROR_REASONS.length);
    for (const reason of ERROR_REASONS) {
      expect(reason).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
      expect(reason.length).toBeLessThanOrEqual(64);
    }
  });
});
