# AGENTS.md — jhw-notion

Claude Code와 Codex가 공용으로 읽는 저장소 지침이다. 루트 `CLAUDE.md`는 이 파일을
`@AGENTS.md`로 import하는 셔임이며 내용은 여기에만 둔다. 각 도구의 전역 설정에 있는 일반 규칙은
되풀이하지 않고 **이 저장소에서 성립하는 사실과 이 저장소에서 반복된 실수를 막는 규칙**만 적는다.
사실의 정본은 아래 「정본 문서」이고, 어긋나면 그 문서를 따르고 이 파일을 고친다.

## 작업 원칙

- 사용자에게 보내는 응답·보고·질문은 한국어로 쓴다. 코드 식별자·명령·경로·오류 코드는 원문 그대로
  둔다. 커밋·PR 본문은 아래 「커밋과 PR」의 계약을 따른다.
- 배포(`install.sh --activate`·`--refresh-bootstrap`·`--rollback`·`--uninstall`), 실행 중인 프로세스 종료, push·PR·머지는
  각각 실행 직전에 사용자 승인을 받는다. 구현·머지 승인은 배포 승인이 아니다.
- 구현을 서브에이전트에 맡길 때는 push·PR·머지·브랜치 전환 금지를 프롬프트에 적는다.
- 같은 불변식에서 리뷰가 두 번 이상 구멍을 내면 패치를 이어 가지 말고 설계 분기를 사용자에게 올린다.

## 무엇인가

Notion AI Workspace를 Claude Code·Codex·Gemini CLI·OpenCode에서 쓰게 하는 MCP 서버와 스킬,
그리고 Project Control(Task/Claim) CLI의 저장소다. 저장소는 public이다.

- `mcp-server/` — TypeScript MCP 서버. `src/tools/`의 `jhw_*` 도구(파일당 하나, `server.ts`에서 등록),
  `src/control/`의 Project Control CLI(`jhw-control`, Guard hook adapter), `src/config.ts`의 DB·report 설정.
- `skills/claude/*.md` — `/jhw:*` 스킬의 **유일한 정본**. `skills/codex/jhw-*/`는 여기서 생성되는
  산출물이다(`scripts/sync-codex-skills.mjs`).
- `scripts/` — 배포 런타임(`runtime-deploy.mjs`·`runtime-entry.mjs`·`runtime-safety.mjs`·
  `runtime-store.mjs`·`install-wiring.sh`·`install-config.mjs`)과 그 테스트, 스킬 계약 테스트.
- `install.sh` — Node 22 이상을 확인한 뒤 `scripts/runtime-deploy.mjs`로 넘기는 래퍼다.
- `.jhw-runtime/` — checkout별 release·activation·bootstrap 저장소(gitignore). live runtime은
  활성화된 checkout의 `.jhw-runtime/current`이며, checkout을 빌드해도 live에는 반영되지 않는다.

## 명령

`mcp-server` 명령은 `mcp-server/`에서, 나머지는 저장소 루트에서 실행한다.

```bash
npm run build          # dist 정리 → tsc → control 실행 파일 0755
npm run typecheck      # 테스트 파일까지 타입 검사 (tsconfig.test.json)
npm test               # vitest
node --test scripts/test-runtime-safety.mjs scripts/test-runtime-store.mjs \
  scripts/test-runtime-deploy.mjs scripts/test-runtime-entry.mjs
node scripts/test-pr-skill-contract.mjs      # 스킬 계약 (issue·commit·review·task·skill-alias·claude-command-dir도 같은 형식)
bash scripts/test-install-safety.sh           # 격리된 임시 HOME에서 설치기 안전성 (수 분)
node scripts/sync-codex-skills.mjs --check    # skills/codex 드리프트 검사 (쓰기 없음)
```

- `typecheck`는 build·vitest가 보지 않는 테스트 하네스의 타입 오류를 잡는 유일한 게이트다
  (컴파일되지 않는 e2e 하네스가 나머지 두 게이트를 통과한 적이 있다, #43·#46). 건너뛰지 않는다.
- `test-runtime-entry.mjs`의 일부는 `mcp-server/node_modules`의 rolldown을 쓴다. 새 worktree에서는
  `mcp-server/`에서 먼저 `npm ci`한다(없으면 bundle 테스트 5개가 실패한다).
- `test-runtime-safety.mjs`의 "non-dumpable current-user tasks…" 테스트는 실제 `/proc`을 보므로 이
  호스트에 관리형 MCP가 떠 있으면 실패한다. 변경 전 기준선에서도 같은지 확인하고 환경 실패로 보고한다.
- `npm run test:live`는 `RUN_LIVE_NOTION_TESTS=1`일 때만 sandbox DB를 건드린다.
- CI가 강제하는 것은 리뷰 워크플로와 `skills-sync.yml`(main 대상 PR에서 `--check`)뿐이다.
  build·typecheck·test·런타임 테스트는 CI가 돌리지 않으므로 변경을 마치기 전에 직접 돌린다.
- 결과는 실행·실패·skip 수와 대상 종료코드로 보고한다. `| tail` 뒤의 종료코드나 PASS 문자열은
  증거가 아니다. 테스트가 도는 동안 입력 파일을 고치지 않는다.

## 바꿀 때 같이 고칠 것

- 스킬 — `skills/claude/<cmd>.md`만 고치고 `node scripts/sync-codex-skills.mjs`로 생성물을 갱신해
  같은 커밋에 넣는다. 스킬 문서 안의 경로는 `$HOME` 기준으로 쓴다. `skills/claude/`에는 스킬이 아닌
  `.md`를 두지 않는다 — 디렉터리 전체가 Claude·Gemini·OpenCode 명령으로 배포된다. 명령을 추가·폐기하면
  `skills/COMMANDS.md` 인벤토리 표도 고친다(pr·issue·commit 계약 테스트가 그 행을 검사한다).
- `ControlError` reason — 운영자 조치는 코드로 구분하고, 같은 코드 안에서 조치가 갈릴 때만
  `details.reason`을 싣는다. reason 추가는 `src/control/schemas.ts`의 `ERROR_REASONS` 등록과
  `skills/claude/task.md` 결과 해석 기재가 한 세트다(테스트가 소스 → 어휘 → 문서 포함을 강제한다).
- 배포 worker 상태 키(`runtime-deploy.mjs`의 `KEYS`)·phase — 새 키·phase는 그 키를 모르는 이전
  retained release 라이브러리와 섞여도 동작해야 한다(혼합 버전 테스트가 있다).
- 첫 활성화 plan과 wire·rollback — 소유·잔여물 판정은 같은 함수를 공유한다. 한쪽에만 조건을 넣지 않는다.
- Notion 저장 — DB 프로퍼티 key는 영문(`title`·`status`·`project`·`date` 등)이고 report 값의 정본은
  `src/config.ts`의 `REPORT_VALUES`다. 레코드는 wrapper 페이지 자식이 아니라 실제 DB row로 만든다.

## 배포

절차와 결과 코드는 `README.md`가 정본이다. 반복된 함정만 적는다.

- 순서는 `--prepare` → `--status`(`clear: true`, `uncertain: 0`) → `--activate <release>`이다. 첫
  관리형 활성화에서 다른 checkout의 legacy 설치를 넘겨받을 때만 `--adopt-from <checkout>`을 붙인다.
- 일반 `--activate`는 bootstrap을 다시 설치하지 않는다. bootstrap helper(`scripts/jhw-runtime-*`,
  `scripts/runtime-{entry,safety,store}.mjs`)가 바뀐 release는 활성화한 뒤 같은 window에서
  `--refresh-bootstrap`을 실행한다. `--uninstall`은 넘겨받은 MCP env를 지우므로 helper 반영에 쓰지 않는다.
- 신뢰 checkout은 `umask 022`로 체크아웃하고 git 모드(0644/0755)를 유지한 채 `--prepare`한다.
  스크립트가 0600이면 활성화 중 bootstrap 검사에서 실패한다.
- `--status`의 소비자·`uncertain`은 이 저장소 밖의 프로세스에서도 생긴다. 활성화 전에 확인한다.
  - PC의 Codex 데스크톱 앱이 SSH로 `codex app-server proxy`를 띄우고 app-server를 다시 살린다.
    서버에서 종료해도 되살아나므로 PC 쪽 앱을 끈다.
  - Claude 세션의 종료·시작 hook(episodic-memory sync, claude-mem worker)이 터미널 없는 `claude`와
    legacy MCP를 띄운다. Claude 세션 안에서는 활성화할 수 없다.
  - 테스트가 남긴 wiring worker나 `sleep` 루프가 PID를 계속 바꾸면 `uncertain`이 0이 되지 않는다.
- `jhw-control-host`(claude-config 소유)는 control을 `node ~/.local/bin/jhw-control <cmd>`로
  실행한다. 그래서 링크 대상인 `scripts/jhw-runtime-control`은 직접 실행과 `node <link>` 실행을 모두
  받는 Node 파일이어야 한다(bash selector에서 `CONTROL_OUTPUT_INVALID`가 났다, #187). 배포 validate
  phase는 링크를 직접 실행만 하므로 `node <link>` 형태는 `test-runtime-entry.mjs`만 검증한다.
  `jhw-control`을 직접 호출하지 말고 launcher를 쓴다.

## 커밋과 PR

- 커밋 메시지는 `/jhw:commit`(Change Evidence Contract v1)을 따른다. 제목은 commitlint 규칙
  (`.github/commitlint.config.mjs`: type `feat|fix|chore|refactor|docs|test|build|ci|perf|style`,
  header 100자 이하)과 계약의 결과 중심·72자 이하를 함께 지킨다. 관례는 영문 `type(scope): 결과`다.
- 필드 제목 `### `는 앞에 공백 한 칸을 두고 `git commit --cleanup=verbatim --file <msg-file>`로 커밋한다.
- PR은 `/jhw:pr`로 만든다. 본문은 `Contract version`·`Summary`·`Changes`·`Validation`·
  `Impact and risks`·`Related issue`이고 pinned validator가 push 전에 검증한다. 추가 `##` 제목은
  계약 위반이므로 tribunal 부록 같은 내용은 `Impact and risks` 항목으로 넣는다.
- `gh pr create`는 pre-PR tribunal PASS 뒤에만 통과한다. tribunal risk floor는 실측으로
  루트 `.md`·`skills/**` 100(iterative), `scripts/*.mjs`·`*.ts`·`install.sh` 50, `docs/**/*.md` 0이다.
  확장자 없는 `scripts/jhw-runtime-*`는 `unknown-path` 100이다.
  저장소 설정 `.pre-pr-tribunal.toml`은 없다. PR이 생긴 뒤의 push는 tribunal이 아니라 AI 리뷰어가 맡는다.
- `main`은 보호되지 않는다. main에 직접 push하지 않고 `/jhw:pr`의 reviewed-head 머지 경로를 쓴다.
  스택 PR은 base를 main으로 바꾼 뒤 PR의 base SHA가 갱신되지 않을 수 있으니, 머지 전에 base를 다시
  지정해 갱신한다. 커밋에 `Closes #N`을 쓰면 push 시 이슈가 닫히므로 배포 전 이슈(#153 등)는 `Refs`로 건다.

## 리뷰

- `.github/workflow-config.yml`에 `review.auto`가 없어 관리형 리뷰(Claude·Gemini)는 자동으로 돌지
  않는다. PR에 `review:request` 라벨을 붙여 요청한다. 같은 head 재리뷰는 라벨을 뗐다 다시 붙인다.
- `@codex review`는 사람 계정의 단독 코멘트여야 한다. 재푸시만으로는 Codex가 다시 리뷰하지 않는다.
  응답은 issue comment·review·line comment 세 채널을 모두 본다. 정상 리뷰 3회 뒤에는 현재 snapshot에
  묶인 승인 토큰이 있어야 추가 리뷰를 요청할 수 있다.
- 결과는 sticky 코멘트의 `automation-state`로 판정한다. job success만으로 리뷰가 돌았다고 보지 않고,
  Gemini의 `provider_overloaded` 같은 공급자 실패를 리뷰 결과로 읽지 않는다.

## 하지 않는 것

- `.env`, `docs/notion-architecture-review.md`(로컬 전용)를 커밋하지 않는다.
- 세션 체크포인트 `HANDOFF.<세션>.md`를 커밋하지 않되 `.gitignore`에도 넣지 않는다. 무시된 파일은
  Task worktree 정리의 `git worktree remove`를 막지 못해 체크포인트가 함께 지워진다.
- 도구 상태 디렉터리를 커밋하지 않는다. 목록은 `.gitignore`가 정본이다. 새 도구 디렉터리가 생기면
  스테이징 전에 `git status`로 확인한다.
- `skills/codex/` 생성물을 직접 고치지 않는다.
- Project Control Registry·worktree 상태를 직접 편집·삭제하지 않고, 자동 retry·takeover·force-end를
  하지 않는다. Task 조작은 `jhw-control-host`와 `/jhw:task` 절차로만 한다.
- legacy→registry 권한 전환(cutover)은 별도 승인 전에 구현·실행하지 않는다.

## 정본 문서

| 주제 | 정본 |
|---|---|
| 설치·배포 절차, 결과 코드, DB 스키마, 도구·스킬 목록 | `README.md` |
| 아키텍처 | `DESIGN.md` |
| Project Control Phase 1A 운영 | `docs/project-control/phase1a-runbook.md` |
| Task/Claim 명령과 결과 해석 | `skills/claude/task.md` |
| `/jhw:*` 명령 인벤토리 (canonical·deprecated alias) | `skills/COMMANDS.md` |
| 커밋·PR 증거 형식과 PR 흐름 | `skills/claude/commit.md`, `skills/claude/pr.md` |
| 과거 설계·계획 (이력) | `docs/superpowers/specs/`, `docs/superpowers/plans/`, `PLAN.md` |

`docs/superpowers/`와 `PLAN.md`는 당시 기록이다. 현재 동작은 위의 다른 문서와 코드·테스트로 판단한다.
