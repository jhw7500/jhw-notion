export const NOTION_CONFIG = {
  databases: {
    projects: "d45ed33c-26ee-45be-ad9c-513db7c422e0",
    preferences: "634f7b00-b7a2-447b-9514-a109b57557a8",
    decisionLog: "c1d8d3c3-538e-40a9-a306-2b694a4d8ff9",
  },
  pages: {
    references: "3398a230-a04e-81cc-b3a3-d408355fee9f",
    knowledgeBase: "3398a230-a04e-817d-b04a-d0180abec592",
  },
} as const;

export type DatabaseName = keyof typeof NOTION_CONFIG.databases;
