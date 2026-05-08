// p1-3b-datasource-migration: schema.ts 의 dataSourceId 필드 검증.
// 5개 DB의 production data_source_id 가 모두 채워져 있고 UUID 형식인지 확인.
// + sandbox-config 의 dataSources도 동일 형식 검증.
//
// 조회 일자: 2026-05-08 (Notion-Version: 2025-09-03)
// 후속 p1-3c에서 databases.query → dataSources.query 마이그레이션 시
// 본 매핑이 안정적으로 유지되는지 회귀 보호.
import { describe, it, expect } from "vitest";
import {
  DATABASE_SCHEMAS,
  getDataSourceId,
  type DatabaseSchema,
} from "../schema.js";
import type { DatabaseName } from "../config.js";
import { loadSandboxConfig } from "../test/sandbox-config.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DB_NAMES: DatabaseName[] = [
  "projects",
  "preferences",
  "decisionLog",
  "knowledgeBase",
  "references",
];

describe("schema.ts — dataSourceId mapping (p1-3b)", () => {
  it("DATABASE_SCHEMAS 의 5개 DB 모두 dataSourceId가 정의되어 있다", () => {
    for (const db of DB_NAMES) {
      const schema: DatabaseSchema = DATABASE_SCHEMAS[db];
      expect(schema.dataSourceId, `${db}.dataSourceId`).toBeTruthy();
      expect(typeof schema.dataSourceId).toBe("string");
    }
  });

  it("모든 dataSourceId가 UUID 형식이다", () => {
    for (const db of DB_NAMES) {
      const id = DATABASE_SCHEMAS[db].dataSourceId;
      expect(id, `${db}.dataSourceId 가 UUID 형식 아님: ${id}`).toMatch(
        UUID_REGEX,
      );
    }
  });

  it("dataSourceId와 id(database_id)는 서로 다른 값이다 (혼동 방지)", () => {
    for (const db of DB_NAMES) {
      const { id, dataSourceId } = DATABASE_SCHEMAS[db];
      expect(dataSourceId, `${db}: id == dataSourceId 면 안 됨`).not.toBe(id);
    }
  });

  it("getDataSourceId(db) 헬퍼가 정확한 매핑을 반환한다", () => {
    for (const db of DB_NAMES) {
      expect(getDataSourceId(db)).toBe(DATABASE_SCHEMAS[db].dataSourceId);
    }
  });

  it("5개 DB의 dataSourceId가 모두 고유하다 (중복 없음)", () => {
    const ids = DB_NAMES.map((db) => DATABASE_SCHEMAS[db].dataSourceId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

describe("sandbox-config.ts — dataSources mapping (p1-3b)", () => {
  it("sandbox config의 dataSources에 5개 키가 모두 있고 UUID 형식이다", () => {
    const cfg = loadSandboxConfig();
    for (const db of DB_NAMES) {
      const id = cfg.dataSources[db];
      expect(id, `sandbox.dataSources.${db}`).toBeTruthy();
      expect(id, `sandbox.dataSources.${db} 형식 오류: ${id}`).toMatch(
        UUID_REGEX,
      );
    }
  });

  it("sandbox dataSourceId는 production dataSourceId와 모두 다르다 (격리)", () => {
    const cfg = loadSandboxConfig();
    for (const db of DB_NAMES) {
      const sandboxId = cfg.dataSources[db];
      const prodId = DATABASE_SCHEMAS[db].dataSourceId;
      expect(
        sandboxId,
        `sandbox.${db} 가 production과 같음 (격리 위반)`,
      ).not.toBe(prodId);
    }
  });

  it("sandbox dataSourceId 5개가 서로 고유하다", () => {
    const cfg = loadSandboxConfig();
    const ids = DB_NAMES.map((db) => cfg.dataSources[db]);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
