export const NOTION_CONFIG = {
  databases: {
    projects: "4430fcd4-bfba-4a46-9a1b-4520db86e883",
    preferences: "4e5ba7f0-b9cc-4171-84a7-f4e430abaf57",
    decisionLog: "6c9fbc24-c5fb-4ca9-aa61-781cacc7ecfd",
  },
  pages: {
    references: "3398a230-a04e-81cc-b3a3-d408355fee9f",
    knowledgeBase: "3398a230-a04e-817d-b04a-d0180abec592",
  },
} as const;

export type DatabaseName = keyof typeof NOTION_CONFIG.databases;
