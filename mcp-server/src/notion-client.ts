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
      // 로딩은 프로세스당 1회뿐이라, 키를 나중에 넣었다면 서버를 다시 띄워야 한다.
      throw new Error(
        "NOTION_API_KEY 환경변수가 설정되지 않았습니다 " +
          "(mcp-server/.env 또는 ~/.bashrc를 확인하고 MCP 서버를 재시작하세요)",
      );
    }
    client = new Client({ auth: apiKey });
  }
  return client;
}
