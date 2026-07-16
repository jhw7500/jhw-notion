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
4. 각 TUI 설정 파일에 MCP 서버 등록
   - Claude/Gemini: `settings.json`의 `mcpServers`
   - OpenCode: `opencode.json`의 `mcp`

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
| `jhw_recall` | 로컬 캐시 우선 회상 (미스 시 Notion 검색) |
| `jhw_search` | Notion 통합 검색 |
| `jhw_status` | 워크스페이스 현황 조회 |
| `jhw_context` | 프로젝트 컨텍스트 로드 |
| `jhw_history` | 프로젝트 타임라인 조회 |
| `jhw_retrieve` | 주제별 결정·지식·문서 본문 스니펫 조회 |
| `jhw_record` | DB에 레코드 생성 |
| `jhw_note` | Knowledge Base에 메모 |
| `jhw_append` | 기존 페이지 끝에 보강 heading·본문 append |
| `jhw_delete` | 레코드 폐기(archive)/휴지통(delete) |
| `jhw_start` | 프로젝트 시작 (원스톱) |
| `jhw_close` | 프로젝트 종료 + 회고 |
| `jhw_report_preview` | 기간별 업무 보고서 미리보기 |
| `jhw_report_export` | 보고서 출력(redmine/markdown/json) + 선택 저장 |

## 스킬 (커맨드)

TUI에서 `/jhw:` 접두사로 사용. 통합 진입점 위주:

```
/jhw:save     — 확정 정보 즉시 저장 (record/note/delete 흡수, DB 자동 판별)
/jhw:recall   — 통합 회상 (search/context/history 자동 판별)
/jhw:project  — 프로젝트 시작/종료 (--start / --close)
/jhw:review   — 세션 마무리 리뷰 (저장 후보 추출 + 저장가치 평가)
/jhw:match    — 신규 후보를 기존 Notion과 대조 (중복/보강/유사)
/jhw:compact  — 저장 레코드 사후 정리 (합치기 + 요약 + 폐기 평가)
/jhw:report   — 일/주/월 업무 보고서 (preview → export)
/jhw:status   — 워크스페이스 현황
/jhw:import   — Notion 검색 결과를 로컬 memory로 불러오기
/jhw:cclog    — Claude Code 세션 대화 기록 조회 (Notion 아님)
```

> deprecated alias(다음 메이저 릴리스에서 삭제): `/jhw:record`·`/jhw:note`·`/jhw:delete`→`/jhw:save`, `/jhw:search`·`/jhw:context`·`/jhw:history`→`/jhw:recall`, `/jhw:start`·`/jhw:close`→`/jhw:project`.

## 업데이트

```bash
cd jhw-notion
git pull
npm run build --prefix mcp-server
```

스킬은 심링크이므로 자동 반영. MCP 서버는 TUI 재시작 시 반영.

## 현재 Notion DB 스키마

현재 live DB 프로퍼티는 한글 라벨이 아니라 **영문 key** 기준이다. 문서보다 실제 코드를 우선 보면 된다.

- `decisionLog`: `title`, `status`, `rationale`, `alternatives`, `area`, `project`, `date`
- `projects`: `title`, `status`, `repo`, `tech_stack`, `description`, `start_date`, `end_date`
- `preferences`: `title`, `category`, `content`, `tools`, `priority`

## 구조

```
jhw-notion/
├── mcp-server/          # TypeScript MCP 서버 (Notion API 직접 호출)
│   ├── src/tools/       # 12개 도구 핸들러
│   └── dist/            # 빌드 결과
├── skills/claude/       # Claude Code 스킬 (통합 10 + deprecated alias 8)
├── install.sh           # 원클릭 설치/제거
└── DESIGN.md            # 설계 문서
```
