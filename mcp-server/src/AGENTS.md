<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-09 | Updated: 2026-04-09 -->

# src

## Purpose
MCP 서버 TypeScript 소스 코드. 엔트리포인트, 서버 초기화, Notion 클라이언트 래퍼, DB 설정, 그리고 9개 도구 핸들러로 구성된다.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | 엔트리포인트 — `loadNotionEnv()` 호출, StdioServerTransport 생성, 서버 시작 |
| `env.ts` | 환경변수 로딩 단일 진입점 (`loadNotionEnv()`) — `.env` → `~/.bashrc` 순 |
| `server.ts` | McpServer 인스턴스 생성 + 9개 도구 등록 (`register*` 호출) |
| `notion-client.ts` | Notion API 클라이언트 싱글턴 팩토리 (`getNotionClient()`) |
| `config.ts` | Notion DB/페이지 ID 상수 (`NOTION_CONFIG`) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `tools/` | 9개 MCP 도구 핸들러 (see `tools/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- ESM import 시 `.js` 확장자 필수 (예: `import { createServer } from "./server.js"`).
- `config.ts`의 DB ID는 하드코딩된 Notion DB UUID. 변경 시 Notion 워크스페이스와 정합성 확인.
- `notion-client.ts`는 싱글턴 패턴. `NOTION_API_KEY` 환경변수 필수.
- 새 도구 추가 절차: `tools/` 에 파일 생성 → `server.ts`에 import + `register*` 호출 추가.

### Common Patterns
- 모든 파일이 named export 사용 (default export 없음).
- 환경변수 로딩: `env.ts`의 `loadNotionEnv()`가 유일한 진입점. `__dirname` 기준으로 `.env`를 읽고,
  `NOTION_API_KEY`가 없으면 `bash -c 'source "$HOME/.bashrc"'`로 폴백한다 (MCP 서버는 비로그인 셸이라
  `.bashrc` export를 상속받지 못함). `index.ts` 시작 시 1회, `notion-client.ts`에서 키 부재 시 지연 호출.
  테스트에서는 `vi.mock("../env.js")`로 스텁 (프로덕션 코드에 `NODE_ENV` 분기를 두지 않는다).

## Dependencies

### Internal
- `tools/` — 각 도구 핸들러가 `server.ts`에서 등록됨

### External
- `@modelcontextprotocol/sdk` — `McpServer`, `StdioServerTransport`
- `@notionhq/client` — `Client`
- `dotenv` — `config()`
- `zod` — 도구 파라미터 스키마 (tools/ 내에서 사용)

<!-- MANUAL: -->
