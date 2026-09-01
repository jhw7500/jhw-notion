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
설치기는 launcher의 공개 host contract v4가 exact v4·`secure-store-only`이고 `task start`,
`task child-start`, `task contract`, `task completion-ready`, `task promote`, `task status`,
`task handoff`, `task finish`, `task recover`, `task assert-owner`를 모두 포함하는지 확인한다.
계약이 누락되었거나 구버전이면 스킬·심링크·MCP 설정을 활성화하기 전에 중단한다.

```bash
git clone https://github.com/jhw7500/jhw-notion.git
cd jhw-notion
./install.sh
```

install.sh가 자동으로:
1. MCP 서버 빌드 (`npm ci` + build; manifest/lockfile 불일치 시 수정 없이 실패)
2. `~/.local/bin/jhw-control`과 `~/.local/bin/jhw-control-hook`을 검증한 뒤 두 심링크 생성
3. 설치된 TUI 감지
4. 스킬 심링크 생성
5. 각 TUI 설정 파일에 MCP 서버 등록
   - Claude: `~/.claude.json`의 `mcpServers`
   - Gemini: `~/.gemini/settings.json`의 `mcpServers`
   - OpenCode: `~/.config/opencode/opencode.json`의 `mcp`
   - Codex: `~/.codex/config.toml`의 `mcp_servers`
6. Codex가 설치되어 있으면 `~/.codex/hooks.json`의 `UserPromptSubmit`·`PreToolUse`·`PostToolUse` Guard command group 등록 후 public `jhw-control guard preflight` 실행

모든 canonical/legacy skill target과 same-name MCP entry는 이 저장소 소유임이 증명될 때만 교체한다. 다른 file/symlink/registration이 있으면 그대로 보존하고 install은 fail-closed한다. JSON/TOML 설정은 기존 mode를 보존한 private same-directory temp에서 fsync 후 atomic publish한다. Codex backup도 이 설치기의 명시적 namespace만 관리한다.

Codex hook의 canonical command는 다음 문자열이다. `$HOME` 값을 미리 보간하지 않고 double-quoted shell expansion으로 남기므로 공백·apostrophe·double quote가 포함된 HOME도 하나의 launcher argv가 된다.

```sh
"$HOME/.local/bin/jhw-control-hook" --adapter codex --event <Event>
```

installer는 이 canonical command와 이전 installer가 만든 exact legacy absolute launcher command만 자기 소유로 본다. install은 소유가 증명된 legacy만 canonical로 migration하고 uninstall은 이 두 exact variant만 제거한다. 유사 command, wrapper, 외부 group은 수정하지 않는다. 각 이벤트에서 Guard group은 맨 앞에 추가되며 기존 외부 group은 lexical byte content와 기존 상대 순서를 유지한다.

`jhw-control guard status`는 기존 Plan 2의 고정 `pending` coverage를 유지하며 설치 상태를 추론하지 않는다. 설치된 Codex 0.150은 같은 이벤트의 matching synchronous local handler를 함께 실행하므로 local config에 Guard가 존재하거나 첫 위치라는 사실만으로 보호를 주장하지 않는다. `jhw-control guard preflight`의 Codex `enforced: true`는 `enforce` mode에서 세 이벤트마다 exact trusted synchronous Guard가 하나이고, Guard 외에 활성·실행 가능한 synchronous `command`/`mcpTool` handler가 없음을 read-only runtime inventory로 확인하며, owned launcher symlink가 이 저장소의 executable `scripts/jhw-control-hook`를 가리키고 executable regular `mcp-server/dist/control/hook-adapter.js` core가 존재하며, 저장된 PreToolUse command의 bounded shell probe가 stderr 없이 exact `GUARD_PROTOCOL_MISMATCH` deny를 반환할 때만 가능하다. `command` variant의 `async: false`만 synchronous이고 `mcpTool` variant는 항상 synchronous다. 실행 가능한 foreign handler는 trusted 또는 managed 항목이며 untrusted·modified·disabled handler와 asynchronous command는 충돌로 보지 않는다. variant별 `command`/`async` 또는 `server`/`tool`, trust metadata, probe를 검증할 수 없으면 `enforced: false`/`NO-GO`다. project-source inventory는 이 명령을 실행한 current working directory 범위이므로 진단은 대상 worktree에서 실행한다. 미신뢰 훅 실행을 강제로 우회 허용한 별도 Codex 런타임은 이 판정의 전제 밖이므로 사용하지 않는다.

Codex hook 등록은 설치기가 hook을 자동 신뢰하지 않는다. 중첩된 ownership key까지 중복 없는 exact group만 소유하며 모호한 JSON과 fatal UTF-8 검증을 통과하지 못한 raw bytes는 fail-closed하고 malformed backup도 byte-exact하게 남긴다. 설치 후 Codex의 `/hooks` 화면에서 세 command hook을 검토하고 활성화·신뢰 상태를 확인한다. 설치 마지막 preflight의 정형 `NO-GO`(exit 78)는 신뢰 검토 또는 미구현 adapter가 남았다는 fail-closed 진단이므로 그대로 표시하고 설치는 완료하지만 보호 완료를 뜻하지 않는다. Project Control/Guard 환경 설정이 하나도 없는 기본 설치는 public diagnostic의 exact `INVALID_CONFIG`만 `UNPROTECTED`로 분류하고 필수 좌표 설정 안내와 함께 완료한다. 이때 launcher·스킬·MCP는 설치하지만 Guard hook group은 활성화하지 않으며, 이전 설치의 exact owned group만 제거하고 외부 hook은 보존한다. 좌표를 설정한 뒤 installer를 다시 실행해야 Guard group이 등록된다. required/optional을 불문한 일부 명시 설정, invalid Guard mode, malformed/non-Guard output, 또는 다른 실행 실패는 설치를 중단하고 이번 실행이 추가한 hook config/link만 원상 복구한다. Codex PostToolUse adapter의 `ok: true`는 승인된 invocation이 transport event까지 도달해 exact Guard correlation을 닫았다는 뜻일 뿐, tool의 업무 성공을 뜻하지 않는다.

hook config 등록·rollback·uninstall은 same-parent private `0700` `.hooks.json.jhw-txn.*` namespace를 사용하고, launcher symlink 제거는 별도의 same-parent private `0700` `.jhw-control-hook-link-txn.*` no-clobber namespace를 사용한다. Node는 live path를 capture하기 전에 intent를 fsync하고, capture 후 실제 type·mode·identity와 exact bytes를 `0600` manifest/evidence에 기록한다. symlink/FIFO는 follow하지 않고 exclusive hard-link로 원 객체를 복구한다. launcher 제거도 owned symlink를 private `captured-link`로 atomic rename한 뒤 identity/target을 재검증하며, 경합 교체된 외부 object는 absent live path에만 no-clobber republish한다. winner가 있으면 덮어쓰거나 지우지 않고 evidence를 보존한다. 경합 중 capture된 directory는 Node 표준 API로 안전한 no-clobber rename을 할 수 없으므로 private `captured-live` subtree와 launcher를 보존하고 `manual recovery required`로 중단하며, live path를 복구했다고 주장하지 않는다. rollback의 live candidate도 이동 전에 별도 intent를 fsync한다. 이동 직후 기록이 끊기면 recovery는 live parent와 transaction directory를 먼저 fsync하고 surviving `candidate-live` identity를 manifest에 인수한 뒤, 종류와 무관하게 exact candidate 경로와 launcher를 보존한 `manual-recovery-required` 상태에서 중단한다. Node의 pathname-only hard-link API로는 기록한 inode와 이후 publication source를 원자적으로 결속할 수 없으므로 이 interrupted-intent 경로는 live `hooks.json`을 자동 재게시하지 않는다. 정상적으로 중단 없이 진행되는 등록·복구·rollback만 준비된 inode를 absent `hooks.json`에 exclusive link하는 방식으로 publish한다. 그 사이 다른 path가 생기면 해당 winner를 덮어쓰거나 지우지 않고 launcher와 original/published/candidate evidence를 보존한다. 어느 namespace든 기존 transaction directory가 남아 있으면 다음 install/uninstall은 새 transaction을 만들기 전에 그 exact path를 안내하고 fail-closed한다.

helper 결과나 fsync가 불명확한 경우 installer는 현재 path 상태를 단정하지 않으며, 검증된 manifest의 존재하는 evidence 경로와 실제 mode만 안내한다. register와 unregister 모두 inspector가 durable `manual-recovery-required`와 실제 `captured-live`를 확인하면 helper 종료 코드와 무관하게 그 exact evidence를 선택한다. rollback은 재검증된 durable stage와 실제 `candidate-live`, launcher 제거는 전용 manifest stage와 실제 `captured-link`를 기준으로 안내한다. 따라서 stage commit 직후 helper가 비정상 종료해도 해당 exact 경로를 표시한다. parent fsync 전에 실패한 `rollback-capture-intent`도 검증 가능한 candidate가 남아 있으면 내구성 완료를 주장하지 않은 채 그 경로와 live unknown/absent 상태만 안내한다. live config를 exclusive link하고 parent를 sync한 뒤 private `published-ready`를 떼기 전에는 `activation-detach-intent`와 exact delete target을 먼저 기록한다. 중단 시 이 stage만 `published-ready` 하나의 누락을 허용하므로 surviving live config와 transaction evidence를 검사할 수 있지만, installer는 완료를 주장하지 않고 launcher와 private transaction을 보존한다. finalize는 각 artifact의 recorded identity와 durable delete-intent를 확인해 재시도하고 unexpected loss/substitution을 삭제하지 않는다. transaction directory 제거 뒤 parent fsync가 실패하면 evidence가 제거됐다는 사실과 durability 미확인 상태를 그대로 알리고 launcher를 유지하며, evidence가 보존됐다고 말하거나 완료를 주장하지 않는다. Claude Guard 배선은 후속 단계이며 Gemini/OpenCode Guard는 현재 지원하지 않는다.

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

`jhw-control`, `jhw-control-hook`, 정확히 소유한 Codex hook group, 네 TUI의 canonical/legacy link, MCP registration은 이 저장소 소유일 때만 제거된다. 다른 파일, link, hook group, same-name MCP entry, backup은 덮어쓰거나 삭제하지 않는다.

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
/jhw:pr       — PR 생성·head-scoped AI 리뷰·필수 게이트·조건부 머지
```

PR 리뷰 정책 예시:

```text
/jhw:pr --review              — 저장소 설정과 무관하게 현재 head AI 리뷰 요청
/jhw:pr --no-review           — review:skip 적용, AI 리뷰 생략
/jhw:pr --review --auto-fix   — 최대 5라운드 수정·재리뷰
/jhw:ship ...                 — deprecated; 같은 인자로 /jhw:pr 실행
```

`--review`/`--no-review`를 생략하면 저장소 설정을 따르며, 현재 설정과 호환 기본값은 review-on이다.

> deprecated alias(다음 메이저 릴리스에서 삭제): `/jhw:record`·`/jhw:note`·`/jhw:delete`→`/jhw:save`, `/jhw:search`·`/jhw:context`·`/jhw:history`→`/jhw:recall`, `/jhw:start`·`/jhw:close`→`/jhw:project`, `/jhw:ship`→`/jhw:pr`.

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

현재 checkout의 Task를 확인할 때는 이미 v4 allowlist에 있는 `task status`에 current-context flags를 그대로 전달한다. host contract v4 remains unchanged because the existing `task status` allowlist already includes this command; 새 launcher command/version은 추가하지 않는다.

```bash
REPOSITORY_PATH="$(git rev-parse --show-toplevel)" || exit $?
test -n "$REPOSITORY_PATH" || exit 1
"$HOME/.local/bin/jhw-control-host" task status \
  --resolve-from-checkout true --repo-path "$REPOSITORY_PATH" \
  --origin-adapter '<claude|codex|gemini|opencode>' --session '<session-id>'
```

current-context는 같은 repository의 active Claim 중 `session_id`·adapter·host로 선택된 집합과 checkout에 매핑된 집합의 **union**을 후보로 삼는다. 후보가 없으면 `match=none`, 하나면 `match=unique`이며 session과 worktree가 모두 맞을 때만 `owner=current`(하나만 맞으면 `mismatch`, legacy로 ownership을 검증할 수 없으면 `unverifiable`)다. 둘 이상이면 `match=ambiguous`와 `candidate_count`만 반환하고 Claim을 선택하지 않으며 후보 좌표도 노출하지 않는다. `none`/`unique`/`ambiguous` 모든 성공 output에는 `session_id`나 absolute/private path를 포함하지 않는다.

`/jhw:review --control`은 이 조회를 사용하는 opt-in proposal-only flow다. Notion 저장, Project Control Project, Project Control Task, GitHub Issue 승인은 각각 별도 slot이며 한 authority의 승인이 다른 authority로 전파되지 않는다.

기존 formal Task ID를 모르면 현재 checkout과 canonical Issue URL로 읽기 전용 recovery discovery를 실행한다.

```bash
"$HOME/.local/bin/jhw-control-host" task recover \
  --action status \
  --resolve-from-checkout true \
  --repo-path <absolute-exact-checkout-root> \
  --issue-url https://github.com/<owner>/<repo>/issues/<number>
```

`state: inactive`이면 반환된 canonical `task_id`를 registration field 없이 `task start --task`에 사용한다. `handoff.available: false`는 exact latest Claim generation에 Handoff가 없다는 뜻이다. `state: active`이면 `task_id`, `claim_id`, `host`, `branch`, `worktree_ref`, `started_at` 여섯 Claim 좌표와 recovery observations만 표시하고 멈춘다. `process_exists: false`만으로 stale을 판정하거나 takeover하지 않는다. `TASK_CONTRACT_MISMATCH`와 `TASK_ALREADY_CLAIMED`도 formal registration을 반복하지 말고 이 status로 canonical Task/Claim을 확인하며, takeover·force-end는 계속 별도 실행 직전 승인이 필요하다.

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
