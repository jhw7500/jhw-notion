# jhw-notion

Notion AI Workspace를 여러 AI TUI에서 사용할 수 있는 MCP 서버.

## 지원 TUI

- Claude Code
- Gemini CLI
- Codex CLI
- OpenCode / Crush

## 설치

```bash
git clone https://github.com/jhw7500/jhw-notion.git
cd jhw-notion
./install.sh
```

install.sh가 자동으로:
1. MCP 서버 빌드 (npm install + build)
2. 설치된 TUI 감지
3. 스킬 심링크 생성
4. 각 TUI settings.json에 MCP 서버 등록

### Notion API Key 설정

```bash
cp mcp-server/.env.example mcp-server/.env
# .env 파일에 NOTION_API_KEY 입력
```

Notion Integration 생성: https://www.notion.so/my-integrations

## 제거

```bash
./install.sh --uninstall
```

## MCP 도구

| 도구 | 설명 |
|------|------|
| `jhw_search` | Notion 통합 검색 |
| `jhw_status` | 워크스페이스 현황 조회 |
| `jhw_context` | 프로젝트 컨텍스트 로드 |
| `jhw_history` | 프로젝트 타임라인 조회 |
| `jhw_record` | DB에 레코드 생성 |
| `jhw_note` | Knowledge Base에 메모 |
| `jhw_delete` | 레코드 삭제/폐기 |
| `jhw_start` | 프로젝트 시작 (원스톱) |
| `jhw_close` | 프로젝트 종료 + 회고 |

## 스킬 (커맨드)

TUI에서 `/jhw:` 접두사로 사용:

```
/jhw:record   — 확정된 정보 즉시 저장
/jhw:note     — Knowledge Base에 기술 지식 메모
/jhw:review   — 세션 마무리 리뷰 (저장 후보 추출)
/jhw:delete   — 레코드 삭제/폐기
/jhw:search   — 키워드 통합 검색
/jhw:context  — 프로젝트 컨텍스트 로드
/jhw:history  — 프로젝트 타임라인 조회
/jhw:status   — 워크스페이스 현황
/jhw:start    — 새 프로젝트 시작
/jhw:close    — 프로젝트 종료 + 회고
```

## 업데이트

```bash
cd jhw-notion
git pull
npm run build --prefix mcp-server
```

스킬은 심링크이므로 자동 반영. MCP 서버는 TUI 재시작 시 반영.

## 구조

```
jhw-notion/
├── mcp-server/          # TypeScript MCP 서버 (Notion API 직접 호출)
│   ├── src/tools/       # 9개 도구 핸들러
│   └── dist/            # 빌드 결과
├── skills/claude/       # Claude Code 스킬 (10개)
├── install.sh           # 원클릭 설치/제거
└── DESIGN.md            # 설계 문서
```
