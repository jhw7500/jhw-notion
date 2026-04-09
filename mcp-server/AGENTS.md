<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-09 | Updated: 2026-04-09 -->

# mcp-server

## Purpose
TypeScript MCP 서버. Notion REST API를 직접 호출하여 9개 고수준 도구(`jhw_*`)를 stdio 전송으로 제공한다. AI TUI들이 이 서버에 연결하여 Notion workspace를 조작한다.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | 의존성 및 빌드 스크립트 (`build`, `dev`, `start`) |
| `tsconfig.json` | TypeScript 설정 (ES2022, Node16, strict) |
| `.env` | `NOTION_API_KEY` (gitignore 대상) |
| `.env.example` | 환경변수 템플릿 |
| `package-lock.json` | 의존성 잠금 파일 |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | 소스 코드 (see `src/AGENTS.md`) |
| `dist/` | 빌드 산출물 (`tsc` 출력, git 제외) |

## For AI Agents

### Working In This Directory
- ESM 모듈 시스템 (`"type": "module"`). import 경로에 `.js` 확장자 필수.
- 빌드: `npm run build` (`tsc`). 출력: `dist/`.
- 엔트리포인트: `dist/index.js` (TUI 설정 파일에 등록됨).
- `.env`는 `mcp-server/` 디렉토리 안에 위치. 루트의 `.env`와 별개.

### Testing Requirements
- `npm run build`로 컴파일 에러 확인.
- 새 도구 추가 시 `server.ts`에 `register*` 호출 추가 필수.

### Common Patterns
- 도구 등록: 각 도구 파일이 `register*(server: McpServer)` 함수를 export, `server.ts`에서 호출.
- Notion 클라이언트: `notion-client.ts`의 `getNotionClient()` 싱글턴 사용.
- DB/페이지 ID: `config.ts`의 `NOTION_CONFIG` 상수 참조.

## Dependencies

### External
- `@modelcontextprotocol/sdk` ^1.12.0
- `@notionhq/client` ^2.2.0
- `dotenv` ^16.4.0
- `zod` ^3.23.0

<!-- MANUAL: -->
