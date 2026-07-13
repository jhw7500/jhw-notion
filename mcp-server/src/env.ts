import { config } from "dotenv";
import { execFileSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// MCP 클라이언트의 기동 대기를 넘기지 않도록 셸 폴백을 짧게 끊는다.
const SHELL_FALLBACK_TIMEOUT_MS = 3000;

let loaded = false;

export function loadNotionEnv(): void {
  // 키를 못 찾으면 셸 폴백만큼 기동이 지연된다. 진입점과 notion-client에서 각각
  // 호출되므로 가드가 없으면 그 지연이 두 배가 된다.
  if (loaded) return;
  loaded = true;

  config({ path: resolve(__dirname, "..", ".env") });

  if (!process.env.NOTION_API_KEY) {
    try {
      // MCP 서버는 비로그인 셸로 실행되어 ~/.bashrc의 export를 상속받지 못한다.
      const apiKey = execFileSync(
        "bash",
        [
          "-c",
          'source "$HOME/.bashrc" >/dev/null 2>&1; printf %s "$NOTION_API_KEY"',
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: SHELL_FALLBACK_TIMEOUT_MS,
        },
      ).trim();
      if (apiKey) {
        process.env.NOTION_API_KEY = apiKey;
      }
    } catch {
      // Keep the original missing-key error from notion-client.
    }
  }
}
