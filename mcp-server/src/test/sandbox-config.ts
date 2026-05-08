// Live integration test 전용 sandbox 설정 (P2).
// 환경변수에서 sandbox DB ID를 읽어 운영 DB와 분리된 캡슐화 제공.
// RUN_LIVE_NOTION_TESTS=1 이 아니면 isLiveEnabled() === false.
// .env 자동 로드 (vitest는 기본으로 .env를 안 읽으므로 명시적 import).
import "dotenv/config";

export interface SandboxConfig {
  enabled: boolean;
  apiKey: string | undefined;
  databases: {
    projects: string;
    preferences: string;
    decisionLog: string;
    knowledgeBase: string;
    references: string;
  };
  /**
   * Notion v5 dataSources.query() 용 data_source_id (sandbox 5개).
   * 조회 일자: 2026-05-08 (Notion-Version: 2025-09-03).
   * 5개 모두 1:1 (count=1). 후속 p1-3c에서 마이그레이션 시 사용.
   * 운영 schema(schema.ts)와 분리하여 sandbox 격리 유지.
   */
  dataSources: {
    projects: string;
    preferences: string;
    decisionLog: string;
    knowledgeBase: string;
    references: string;
  };
}

/** Sandbox dataSource 매핑 (조회 일자 2026-05-08). */
const SANDBOX_DATA_SOURCES = {
  projects: "280d2a38-9eb0-48cd-9a99-a6fd16b27524",
  preferences: "22ad1943-abce-4e1b-aaf8-1104a29d4bfd",
  decisionLog: "5a60f9f2-1a92-4dd9-abbe-83c7403b3ccf",
  knowledgeBase: "c7f269e2-aecd-4eb9-a8c4-08d208c8c597",
  references: "03ce789f-dd74-4b36-a09c-6dd1ca800ef1",
} as const;

export function isLiveEnabled(): boolean {
  return process.env.RUN_LIVE_NOTION_TESTS === "1";
}

export function loadSandboxConfig(): SandboxConfig {
  return {
    enabled: isLiveEnabled(),
    apiKey: process.env.NOTION_API_KEY,
    databases: {
      projects: process.env.NOTION_SANDBOX_DB_PROJECTS ?? "",
      preferences: process.env.NOTION_SANDBOX_DB_PREFERENCES ?? "",
      decisionLog: process.env.NOTION_SANDBOX_DB_DECISION_LOG ?? "",
      knowledgeBase: process.env.NOTION_SANDBOX_DB_KNOWLEDGE_BASE ?? "",
      references: process.env.NOTION_SANDBOX_DB_REFERENCES ?? "",
    },
    dataSources: { ...SANDBOX_DATA_SOURCES },
  };
}

/**
 * Vitest skip 가드. 모든 sandbox env가 설정되어 있어야 통과.
 * 일부만 누락되면 명확한 메시지로 skip.
 */
export function describeLiveOrSkip(): {
  enabled: boolean;
  reason?: string;
  config: SandboxConfig;
} {
  const config = loadSandboxConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      reason: "RUN_LIVE_NOTION_TESTS=1 이 아님",
      config,
    };
  }
  if (!config.apiKey) {
    return {
      enabled: false,
      reason: "NOTION_API_KEY 미설정",
      config,
    };
  }
  const missing = Object.entries(config.databases)
    .filter(([, id]) => !id)
    .map(([k]) => k);
  if (missing.length > 0) {
    return {
      enabled: false,
      reason: `NOTION_SANDBOX_DB_* 누락: ${missing.join(", ")}`,
      config,
    };
  }
  return { enabled: true, config };
}
