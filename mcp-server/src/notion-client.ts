import { Client } from "@notionhq/client";
import { loadNotionEnv } from "./env.js";

let client: Client | null = null;

export function getNotionClient(): Client {
  if (!client) {
    if (!process.env.NOTION_API_KEY) {
      loadNotionEnv();
    }

    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey) {
      throw new Error("NOTION_API_KEY 환경변수가 설정되지 않았습니다");
    }
    client = new Client({ auth: apiKey });
  }
  return client;
}
