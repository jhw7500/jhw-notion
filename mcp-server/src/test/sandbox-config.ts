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
}

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
