// Notion AI Workspace DB 설정.
// KB/References는 wrapper 페이지 안의 inline DB이므로 databases에 등록.
// (이전: pages.knowledgeBase / pages.references는 wrapper 페이지 ID였음)
export const NOTION_CONFIG = {
  databases: {
    projects: "4430fcd4-bfba-4a46-9a1b-4520db86e883",
    preferences: "4e5ba7f0-b9cc-4171-84a7-f4e430abaf57",
    decisionLog: "6c9fbc24-c5fb-4ca9-aa61-781cacc7ecfd",
    knowledgeBase: "ec68d6c6-6e8e-47e6-9e8c-85d13b9f1461",
    references: "979a9412-73d9-4fa4-be0e-cbcafc0a2505",
  },
} as const;

export type DatabaseName = keyof typeof NOTION_CONFIG.databases;

// redmine 보고서 카테고리. 5개 DB 공통 select 옵션 정확히 10종.
// 미설정 페이지는 redmine 측 keyword fallback이 동작.
// 'none' = 보고 제외 (개인 메모, /jhw:note 권장 기본값)
export const REPORT_VALUES = [
  "pim-app",
  "pim-driver-cam",
  "pim-driver-spi",
  "pim-test",
  "wlan-bsp",
  "wlan-app",
  "wlan-driver",
  "wlan-test",
  "etc",
  "none",
] as const;

export type ReportValue = (typeof REPORT_VALUES)[number];
