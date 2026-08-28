# jhw-notion

Notion AI Workspace를 여러 AI TUI에서 사용할 수 있는 MCP 서버.

## 지원 TUI

- Claude Code
- Gemini CLI
- Codex CLI
- OpenCode / Crush

## 설치

`/jhw:task`가 사용하는 secure launcher는 `claude-config`가 소유한다. 먼저 해당 저장소의
`install.sh`를 실행해 `$HOME/.local/bin/jhw-control-host`를 설치해야 한다. 이 저장소의
설치기는 launcher의 공개 계약이 exact v3·`secure-store-only`인지 확인하며, 누락되었거나
구버전이면 스킬·심링크·MCP 설정을 활성화하기 전에 중단한다.

```bash
git clone https://github.com/jhw7500/jhw-notion.git
cd jhw-notion
./install.sh
```

install.sh가 자동으로:
1. MCP 서버 빌드 (npm install + build)
2. `~/.local/bin/jhw-control` 심링크 생성
3. 설치된 TUI 감지
4. 스킬 심링크 생성
5. 각 TUI 설정 파일에 MCP 서버 등록
   - Claude: `~/.claude.json`의 `mcpServers`
   - Gemini: `~/.gemini/settings.json`의 `mcpServers`
   - OpenCode: `~/.config/opencode/opencode.json`의 `mcp`
   - Codex: `~/.codex/config.toml`의 `mcp_servers`

모든 canonical/legacy skill target과 same-name MCP entry는 이 저장소 소유임이 증명될 때만 교체한다. 다른 file/symlink/registration이 있으면 그대로 보존하고 install은 fail-closed한다. JSON/TOML 설정은 기존 mode를 보존한 private same-directory temp에서 fsync 후 atomic publish한다. Codex backup도 이 설치기의 명시적 namespace만 관리한다.

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

`jhw-control`, 네 TUI의 canonical/legacy link, MCP registration은 이 저장소 소유일 때만 제거된다. 다른 파일, link, same-name MCP entry, backup은 덮어쓰거나 삭제하지 않는다.

## MCP 도구

| 도구 | 설명 |
|------|------|
| `jhw_recall` | 로컬 캐시 우선 회상 (미스 시 Notion 검색) |
| `jhw_search` | Notion 통합 검색 |
| `jhw_status` | 워크스페이스 현황 조회 |
| `jhw_context` | 프로젝트 컨텍스트 로드 |
| `jhw_history` | 프로젝트 타임라인 조회 |
| `jhw_retrieve` | 주제별 결정·지식·문서 본문 스니펫 조회 |
| `jhw_fetch` | 페이지 전체 본문을 구조 보존 Markdown으로 조회 |
| `jhw_record` | DB에 레코드 생성 |
| `jhw_note` | Knowledge Base에 메모 |
| `jhw_append` | 기존 페이지 끝에 보강 heading·본문 append |
| `jhw_delete` | 레코드 폐기(archive)/휴지통(delete) |
| `jhw_start` | 프로젝트 시작 (원스톱) |
| `jhw_close` | 프로젝트 종료 + 회고 |
| `jhw_report_preview` | 기간별 업무 보고서 미리보기 |
| `jhw_report_export` | 보고서 출력(redmine/markdown/json) + 선택 저장 |

### `jhw_fetch` 계약

- 입력: `pageId`(Notion page UUID 또는 URL), 선택 `maxCharacters`(1~200,000자, 기본 100,000자).
- 동작: 페이지 메타데이터와 모든 top-level block 페이지를 읽고, `has_children` block을 끝까지 재귀 조회한다. 모든 Notion 호출은 공통 `callNotion` retry/rate-limit/error 경로를 사용하며 페이지를 변경하지 않는다.
- 출력: JSON의 `pageId`, `url`, `title`, `markdown`, `truncated`, 기본 사유 `truncation`, 전체 사유 배열 `truncations`, `metadata.blocksRead`, `metadata.characters`, `metadata.maxCharacters`.
- 구조: heading, 목록, 체크박스, 인용, callout, code, divider, 표와 중첩 깊이를 Markdown으로 보존한다.
- 절단: 문자 한도는 `reason=max_characters`와 `atCharacter`를, 내부 10,000-block 안전 한도·비정상 pagination·partial/unsupported block은 해당 reason과 `blockId`/`depth`를 반환한다. 둘 이상이면 구조 조회 사유가 `truncation`에 우선하고 모든 사유가 `truncations`에 남는다. `truncated:false`일 때만 본문이 완전하다.

## 스킬 (커맨드)

TUI에서 `/jhw:` 접두사로 사용. 통합 진입점 위주:

```
/jhw:save     — 확정 정보 즉시 저장 (record/note/delete 흡수, DB 자동 판별)
/jhw:recall   — 통합 회상 (search/context/history 자동 판별)
/jhw:project  — 프로젝트 시작/종료 (--start / --close)
/jhw:task     — 명시적 Project Control Task 시작·재개·종료·복구
/jhw:portfolio — 명시적 Project Control status/export/preflight
/jhw:review   — 세션 마무리 리뷰 (저장 후보 추출 + 저장가치 평가)
/jhw:match    — 신규 후보를 기존 Notion과 대조 (중복/보강/유사)
/jhw:compact  — 저장 레코드 사후 정리 (합치기 + 요약 + 폐기 평가)
/jhw:report   — 일/주/월 업무 보고서 (preview → export)
/jhw:status   — 워크스페이스 현황
/jhw:import   — Notion 검색 결과를 로컬 memory로 불러오기
/jhw:cclog    — Claude Code 세션 대화 기록 조회 (Notion 아님)
```

> deprecated alias(다음 메이저 릴리스에서 삭제): `/jhw:record`·`/jhw:note`·`/jhw:delete`→`/jhw:save`, `/jhw:search`·`/jhw:context`·`/jhw:history`→`/jhw:recall`, `/jhw:start`·`/jhw:close`→`/jhw:project`.

## Project Control Phase 1A

Phase 1A control plane은 이 저장소와 **별도 checkout**인 비공개 Registry, 개인 GitHub Project, build-server `jhw-control`을 사용한다. `task` Claim/worktree lifecycle, 제한된 portfolio 조회·단방향 export, live preflight, 중앙 authority guard를 제공한다.

경계는 의도적으로 단순하다.

- 사용자가 `/jhw:task`, `/jhw:portfolio`, 또는 `/jhw:project --trial`을 명시해야만 trial control을 사용한다.
- 현재 요청과 현재 저장소 사실만 쓴다. 이전 세션, Notion, memory, recall/load/cclog, 광범위 Git history를 자동 주입하지 않는다.
- 일반 `/jhw:project`/`--start`/`--close`와 `/jhw:status`는 계속 기존 Notion workflow다. **Phase 1A에서 Notion이 변경 없이 live authority**이며 Registry trial은 authority flip이나 migration이 아니다.
- 개인 Project는 fine-grained PAT로 제어할 수 없어 별도 short-lived classic Project token이 필요하다. `GH_PROJECT_TOKEN`은 정확히 `project` scope 하나만 허용한다. 분리된 `GH_REPO_TOKEN`은 Registry와 등록할 private source repository의 Issue/metadata 검증에 필요한 최소 repository 권한만 가진다. token을 재사용하거나 scope를 자동 확장하지 않는다.
- `JHW_REGISTRY_DIR`, Registry SSH remote/repository slug, `JHW_CONTROL_STATE_DIR`를 한 host identity로 고정한다. alternate checkout/symlink/state directory를 섞으면 전역 lock과 Registry identity가 깨지므로 허용하지 않는다.
- Project Record는 개인 비공개 GitHub Project의 canonical DraftIssue다. 제목과 `{id, objective, repositories}` 본문은 DraftIssue가, 다섯 운영 필드는 같은 Project item이 소유한다. Registry Issue와 node ID를 결합하지 않는다.
- `jhw-control preflight`는 committed authority/tool version, read-only Notion ancestry guard, exact credential scope, private Project/Registry repository, 고정 Project DraftIssue와 독립 Registry Issue fixture restore, unique matching SSH remote와 Git dry-run을 확인하는 운영 go/no-go다.
- build server에서 manual/on-demand로 실행한다. Phase 1A에는 GitHub Actions workflow/minutes 의존과 schedule이 없다.

구현된 public control command는 다음 13개뿐이다.

| 영역 | command |
|---|---|
| Repository | `repository register` |
| Task | `task start`, `task promote`, `task handoff`, `task status`, `task finish`, `task recover`, `task assert-owner` |
| Portfolio/Project | `portfolio status`, `portfolio export`, `project register`, `project update`, `preflight` |

`task start --task`는 같은 persistent Task를 명시적으로 재개하고 bounded latest Handoff만 반환한다. Handoff source revision은 Claim 시점에 고정된다. release 뒤 local cleanup은 `task recover --action cleanup`으로 exact Claim generation만 복구한다. `task assert-owner`는 raw Git을 통합 enforce하지 않는 advisory check라서 승인된 takeover와 race할 수 있다.

measurement journal은 authority가 아니다. 성공 output에 `journal_warning.code=JOURNAL_WRITE_FAILED`가 붙어도 command는 이미 성공했으므로 재시도하지 않는다. 실패 command도 원래 exit/error를 유지한다.

설정, 안전한 credential 주입, stable exit code, 세 번의 자연 Task cycle, 중단 기준은 [Phase 1A runbook](docs/project-control/phase1a-runbook.md)을 따른다. Phase 1B/cutover는 별도 승인 계획이 필요하다.

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
│   ├── src/tools/       # 15개 도구 핸들러
│   └── dist/            # 빌드 결과
├── skills/claude/       # 공유 TUI 스킬 정본 (Project Control 명시적 진입점 포함)
├── install.sh           # 원클릭 설치/제거
└── DESIGN.md            # 설계 문서
```

`PLAN.md`는 초기 구현 계획의 **원본 snapshot**이다. live 기준은 `README.md`, `DESIGN.md`, runbook, 그리고 실제 코드다.
