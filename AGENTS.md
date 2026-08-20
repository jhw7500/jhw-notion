<!-- Generated: 2026-04-09 | Updated: 2026-04-09 -->

# jhw-notion

## Purpose
Notion AI Workspace를 여러 AI TUI(Claude Code, Gemini CLI, Codex CLI, OpenCode)에서 사용할 수 있는 MCP 서버 + 스킬 시스템. TypeScript MCP 서버가 Notion REST API를 직접 호출하여 9개 고수준 도구를 제공하고, install.sh가 스킬 심링크 + MCP 서버 등록을 자동화한다.

## Key Files

| File | Description |
|------|-------------|
| `install.sh` | 원클릭 설치/제거 스크립트 (빌드 + TUI 감지 + 심링크 + MCP 등록) |
| `README.md` | 프로젝트 사용 가이드, DB 스키마, MCP 도구/스킬 목록 |
| `DESIGN.md` | 아키텍처 설계 문서 |
| `PLAN.md` | 초기 구현 계획 스냅샷 (live 기준은 코드 우선) |
| `.env` | Notion API 키 (gitignore 대상) |
| `.env.example` | 환경변수 템플릿 |
| `.gitignore` | Git 제외 패턴 |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `mcp-server/` | TypeScript MCP 서버 — Notion API 직접 호출 (see `mcp-server/AGENTS.md`) |
| `skills/` | TUI 스킬 정의 파일 (see `skills/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Notion DB 프로퍼티 key는 영문 기준 (`title`, `status`, `rationale`, `project`, `date` 등). 한글 라벨이 아님.
- `PLAN.md`는 초기 스냅샷. live 기준은 `README.md`, `DESIGN.md`, 그리고 `mcp-server/src/*` 실제 코드.
- `install.sh`는 실행 비트(+x)가 설정되어 있음. 수정 후 권한 유지 확인.
- `.env` 파일은 커밋 금지. `NOTION_API_KEY`만 포함.

### Testing Requirements
- MCP 서버: `cd mcp-server && npm run build`로 컴파일 오류 확인.
- 타입: `npm run typecheck` — **테스트 파일까지 포함해** 검사한다. `build`의 tsconfig는 테스트를 제외하고 vitest는 esbuild라 타입을 보지 않으므로, 이 명령만이 테스트 하네스의 타입 오류를 잡는다. 실제로 컴파일조차 되지 않는 e2e 하네스가 나머지 두 게이트를 통과한 적이 있다(#43, #46).
- 테스트: `npm test`.
- **`ControlError` 메시지는 운영자에게 도달하지 않는다.** `controlErrorResult`가 내보내는 것은 stable `code`와 Claim 충돌 시의 좌표뿐이다. 그러므로 운영자가 조치해야 할 것은 **코드로 구분**하고(예: `PROJECT_REGISTRATION_UNSETTLED` 대 `MISMATCH`, `REGISTRY_MOVED_DURING_READ` 대 `REGISTRY_CORRUPT`), 메시지는 디버깅용으로만 쓴다. `errors.ts`의 리댁션이 슬래시 커맨드·비ASCII 산문을 과잉 마스킹하는 것도 같은 이유로 무해하다 — 다만 **내보내지는 좌표(브랜치명 등)는 마스킹되면 안 되고** 그 경계는 테스트가 고정한다.
- 이 세 가지는 **CI가 강제하지 않는다** — Phase 1A는 GitHub Actions 의존이 없고 build server에서 manual·on-demand로 실행한다(README 참조). 따라서 변경을 마치기 전에 직접 돌려야 하며, 특히 `typecheck`를 건너뛰면 이 게이트를 만든 이유가 그대로 되살아난다.
- install.sh: `--uninstall` 후 재설치로 동작 검증.

### Common Patterns
- MCP 도구 이름: `jhw_` 접두사 (예: `jhw_search`, `jhw_record`).
- 스킬 이름: `/jhw:` 접두사 (예: `/jhw:record`, `/jhw:search`).
- 각 도구는 `mcp-server/src/tools/`에 독립 파일, `server.ts`에서 등록.

## Dependencies

### External
- `@modelcontextprotocol/sdk` ^1.12.0 — MCP 프로토콜 구현
- `@notionhq/client` ^2.2.0 — Notion REST API 클라이언트
- `dotenv` ^16.4.0 — 환경변수 로딩
- `zod` ^3.23.0 — 스키마 유효성 검사
- `typescript` ^5.5.0 — 빌드 도구

<!-- MANUAL: -->
