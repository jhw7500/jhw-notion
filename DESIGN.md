# jhw-notion 설계 문서

- **작성일**: 2026-04-07
- **저장소**: https://github.com/jhw7500/jhw-notion.git
- **목적**: Notion AI Workspace를 여러 AI TUI(Claude Code, Gemini CLI, Codex CLI 등)에서 통합 사용

## 1. 배경

현재 `/jhw:*` 커맨드 10개가 Claude Code 전용 마크다운 스킬로 구현되어 있다.
로직(DB ID, 절차, 규칙)이 스킬 파일에 분산되어 있어 다른 TUI에서 재사용이 불가능하다.

### 현재 구조

```
사용자 → /jhw:record → Claude Code 스킬(.md) → LLM 해석 → Notion MCP 도구 호출
```

- 스킬 파일: `~/.claude/commands/jhw/*.md` (10개)
- Notion MCP: 범용 도구(notion-search, notion-create-pages 등)
- 문제: 로직이 LLM 프롬프트 안에 있어 TUI 종속

## 2. 목표 구조

```
사용자 → TUI 스킬(얇은 가이드) → LLM → jhw-notion MCP 서버 → Notion REST API
```

- **MCP 서버**: Notion API 직접 호출. 15개 고수준 도구 제공
- **TUI 스킬**: LLM에게 "어떤 MCP 도구를 호출하라"만 안내 (얇은 레이어)
- **review만 예외**: 세션 대화 분석은 LLM 역할이므로 각 TUI 스킬에 로직 유지

### 2.1 Project Control Phase 1A 경계

Phase 1A는 위 Notion workspace를 대체하지 않는 trial control plane이다.

```text
명시적 /jhw:task, /jhw:portfolio, /jhw:project --trial
        |
build server의 jhw-control CLI
        +-- 별도 private Registry checkout (identity, Task, Claim, governance)
        +-- personal private GitHub Project (DraftIssue Project Records + 5 operational fields)
        `-- private local state/snapshot (measurement, export)

일반 /jhw:project, /jhw:status --> 기존 Notion live authority
```

- Registry는 `jhw-notion` 워킹 트리 안의 디렉터리가 아니라 독립된 GitHub 저장소/checkout이다.
- `repository register`가 exact checkout root/origin/GitHub node identity를 검증한 뒤에만 Repository Record를 만든다. private이 기본이며 public repository는 `--allow-public true` 명시 opt-in이 Record에 영속된 경우에만 등록과 task start 재검증을 통과한다(opt-in은 재등록마다 다시 선언한다 — public 상태의 무플래그 재등록은 `REPOSITORY_NOT_PRIVATE`로 실패하며 opt-in을 유지하고, 소거는 private 복귀 후 무플래그 재등록에서만 일어난다; Registry·GitHub Project는 여전히 private 필수). Project registration과 formal/temporary Task는 이 verified mapping을 요구하며 Registry file 손편집은 public bootstrap 경로가 아니다.
- public surface는 `repository register`; `task start|promote|handoff|status|finish|recover|assert-owner`; `portfolio status|export`; `project register|update`; `preflight`다. `task start --task`는 같은 persistent Task의 새 Claim generation을 만들고 explicit resume에서만 bounded latest Handoff를 반환한다.
- Claim은 source revision을 acquisition 때 고정한다. temporary lifecycle과 Claim create/release/history는 같은 Registry transaction이다. release 뒤 host cleanup은 authority와 분리되며 exact archived generation의 `recover --action cleanup`만 허용한다.
- takeover는 direct target mapping을 완전 검증한 뒤 저장 좌표가 충돌 가능한 mapping만 physical identity 검사한다. 명백히 무관한 missing mapping은 차단하지 않지만 task/path/repository+branch alias, direct target 손상, removed checkout 재등장은 fail-closed한다.
- `recover --action repair-mapping`은 exact Task/Claim/worktree-ref와 committed Registry lifecycle을 host-global lock 안에서 검증하고, checkout 부재와 mapping snapshot CAS가 모두 성립할 때만 host mapping을 durable `removed` tombstone으로 전환한다. Claim은 수정하지 않으며 live·alias·symlink·mismatch·concurrent-change 상태는 원 bytes를 보존하고 거부한다.
- native `SessionEnd`는 exact current Claim/worktree를 read-only로 확인해 bounded Git 좌표를 derived Guard journal에 남기는 advisory 경로다. digest key, request store, mutation lock, policy/lifecycle service를 구성하지 않고 session/path/transcript를 저장하지 않으므로 release·finish·force-end·takeover·repair authority가 없다. crash/kill은 evidence 없이도 explicit recovery status와 승인된 action으로 복구 가능해야 한다.
- recovery status의 SessionEnd reader는 secure state directory와 `guard-journal.jsonl`을 descriptor-bound/no-follow로 열고 user ownership, regular 단일-link `0600`, 8 MiB/8192행/행당 8 KiB 한계, fatal UTF-8, 전체 event schema, read 전후 identity/size/time 안정성을 모두 검증한다. 먼저 반환할 recovery mapping/dirty/ahead observation과 journal 조회용 worktree 재검사의 겹치는 필드를 비교해 mapping 부재나 snapshot drift를 `unverified`로 내린다. 그 snapshot에서 exact Task/Claim 후보가 하나이고 현재 adapter/worktree/branch/HEAD/dirty/ahead/behind와 같을 때만 `recorded`이며, 그 외 결과는 `absent | ambiguous | unverified`로 축약한다. 결과는 adapter와 시각 외 Claim/Git 좌표를 재노출하지 않고 mutation action을 선택하거나 호출하지 않는다.
- Claude와 Codex의 네 hook은 각각 `~/.claude/settings.json`, `~/.codex/hooks.json`에서 adapter-specific exact group으로 소유한다. 설치된 adapter root는 current-user-owned real directory여야 하며 install/uninstall은 transaction 탐색·할당보다 먼저 이 조건을 검증한다. 공통 JSON transaction editor가 그 parent를 no-follow descriptor에 고정한 채 existing mode와 foreign lexical content/order를 보존하고 duplicate/malformed/nonregular/path-swap race에서 fail-closed한다. install 중 Claude transaction은 Codex publish와 최종 preflight가 끝날 때까지 유지해 뒤 단계 실패 시 두 config와 새 launcher를 함께 rollback하며, reinstall/uninstall은 exact owned group에만 idempotent하다.
- Claude preflight는 standard config source, exact on-disk groups, owned executable launcher/core에 더해 실제 `claude -p --restricted`의 두 `UserPromptSubmit` 응답(repository hook + inline blocker)과 0 model turn/API time/cost/model usage를 요구한다. global settings는 filesystem root부터 `HOME/.claude`까지 전체 directory chain을 descriptor-relative no-follow로 열어 root/current-user ownership과 group/world non-writable mode(root-owned sticky directory 제외)를 검증하고, 읽은 뒤 live pathname chain을 재개방해 identity/mode가 그대로인지 확인한다. `settings.json`은 current-user-owned regular 단일 link와 read 전후 identity/mode/size/time 안정성을 별도로 검증한다. launcher symlink와 exact target/core의 각 absolute parent chain에도 같은 검증을 적용하며 leaf owner/type/link/execute mode, bounded full-read와 current-path identity 안정성을 요구한다. PATH의 선택된 search entry chain과 해석된 Claude binary canonical target도 root/current-user 소유의 non-writable executable 단일-link regular file과 bounded full-read/current-path 안정성을 확인하고, 열린 handle을 child fd 3으로 상속해 `/proc/self/fd/3` 또는 `/dev/fd/3`에서 실행함으로써 검사한 inode에 spawn을 결속한다. build는 `umask 022` 아래에서 `dist`를 재생성하고 executable core를 `0755`로 고정한다. 진단 cwd의 전체 parent chain도 같은 directory trust와 live-path 안정성을 충족해야 하며, 모든 ancestor의 project/local settings에 descriptor-bound owner/type/link/mode/read 안정성, fatal UTF-8, JSON, 중복 없는 top-level `disableAllHooks` 검증을 적용한다. 어느 발견 source든 값이 정확히 `false`가 아니거나 안전하게 읽을 수 없으면 probe 없이 fail-closed한다. 외부 hook은 복제·실행하지 않는다. exact owned command와 완료 signal을 기다리는 blocker만 explicit settings에 넣고 settings file 없는 private temporary config/cwd를 사용해 matching hook의 병렬 실행에서도 두 응답을 보존한다. 실제 stream의 owned stdout newline과 blocker stderr newline shape까지 일치해야 한다. 원래 `HOME`은 canonical launcher 확장에만 유지해 Claude app/session state write를 격리·정리하며 managed policy는 restricted-mode 계약대로 적용한다. child environment는 고정 실행 PATH와 locale 필수값만 allowlist한다. 별도 direct `PreToolUse` probe는 ambient shell 대신 `/usr/bin/bash`로 canonical launcher와 고정 argv를 private cwd에서 직접 실행하고 exact bounded deny를 반환해야 `enforced: true`다. 두 runtime probe는 Project Control 좌표, nested Claude markers, `NODE_OPTIONS`, 실제 credential/provider를 상속하지 않고 non-network dummy key, empty MCP config, bounded output, timeout/process-group termination을 적용한다. 실제 restricted invocation 성공이 현재 binary capability 증거이므로 version 문자열을 별도 신뢰하지 않는다. Codex는 기존 read-only runtime inventory와 direct command probe를 유지한다.
- `SessionEnd` 배선은 Guard enforcement 활성화와 독립이다. Control 좌표 환경변수 미설정 설치도 ambient Guard 정책 플래그와 무관하게 기존 Guard 비활성화와 evidence hook 등록을 하나의 기존 no-clobber transaction으로 처리하며 foreign hook은 보존한다. 종료 composition에만 non-secret `control.env` fallback이 있고, 단일 config source 선택·소유권/0600/no-follow/16 KiB 검증 후 파일 좌표만 기존 `ControlConfig` validator를 통과해야 한다. 파일 fallback에는 사용하지 않는 ambient Guard 정책을 섞지 않는다. credential loader와 일반 Guard/CLI의 환경변수-only 계약 및 Guard 정책 검증은 그대로다.
- `SessionEnd` host config는 선택한 홈을 anchor로 열고 `.config`와 `jhw-control`을 descriptor-relative `O_DIRECTORY | O_NOFOLLOW`로 순회한 뒤 `control.env`를 no-follow로 연다. 따라서 config parent symlink·non-directory를 거부하며 config 파일 및 디렉터리 descriptor는 성공·실패 모두 닫는다.
- Registry Task/Claim/Handoff I/O는 descriptor-relative no-follow record store를 공유하며 symlink, non-directory ancestor, nonregular/multi-link leaf, traversal, path/content ID mismatch를 거부한다. Registry transaction은 host lock, clean/fast-forward check, push/refetch verification 전체를 감싼다.
- 새 session에 이전 session·Notion·memory·Git history를 자동 주입하지 않는다. 현재 요청과 현재 repository 사실에서 시작하고 사용자가 지정한 Project/Task/page만 확장한다. Handoff는 fixed six-section/12 KiB schema이며 goal/lifecycle/full transcript를 복제하지 않는다.
- committed regular HEAD `governance/authority.yaml`, monotonic cache, minimum tool version, server-side Notion database/data-source ancestry guard가 fail-closed authority boundary다. local cache는 권한을 더 제한할 수만 있고 authority를 선택하지 않는다.
- Phase 1A authority는 epoch 1 / `legacy` / null cutover이며 Notion이 live authority다. Phase 1B/cutover, schedule, cross-host retry, reconciliation/migration은 natural evidence 뒤 별도 승인 계획을 요구한다.

### 2.2 운영·credential 제약

개인 account Project에는 fine-grained PAT를 사용할 수 없어 short-lived classic `GH_PROJECT_TOKEN`이 필요하다. normalized scope는 정확히 `project` 하나여야 하고 다른 scope를 허용하지 않는다. 분리된 `GH_REPO_TOKEN`은 Registry와 등록할 private source repository의 Issue/metadata API에 필요한 최소 repository 권한만 가진다. SSH Registry Git credential과도 역할을 섞지 않는다. host credential store가 token을 process environment에만 주입한다.

Project Record는 Project-only token으로 완전히 읽고 쓸 수 있는 canonical DraftIssue다. DraftIssue의 제목과 exact `{id, objective, repositories}` 본문, 같은 Project item의 다섯 운영 필드가 한 레코드를 이룬다. Registry Issue나 repo token과 source ID를 결합하지 않는다.

`jhw-control preflight`는 mutation 전에 committed authority/version, read-only Notion ancestry, exact Project scope, private Project/Registry repository, unique matching SSH remote를 검증한다. 그 뒤 고정 canonical Project DraftIssue fixture의 field를 write/restore하고, 이와 독립된 Registry Issue를 unchanged-write하며, fetch/dry-run push를 확인한다. 성공은 `credentials`, `authority`, `notion_guard`, `project`, `registry_repository`, `registry_issue`, `registry_git` 일곱 check가 모두 `ok`일 때뿐이다.

모든 compliant process는 동일한 Registry realpath/inode/remote identity와 immutable absolute `JHW_CONTROL_STATE_DIR`를 사용한다. 그래야 프로젝트와 세션에 관계없이 하나의 `registry.lock`이 host mutation을 직렬화한다. 일반 Registry writer는 최대 30초 bounded wait하며, timeout은 `LOCK_CONTENDED` + `registry_state_lock`과 optional bounded holder 진단을 반환한다. lock 파일의 metadata는 관측용일 뿐이고 kernel flock만 authority다. process timeout은 bounded이며 Git/SSH는 noninteractive다. secret과 configured private path는 Registry/GitHub/Handoff/journal/snapshot/output/error에 쓰기 전에 중앙 reject policy가 차단한다.

measurement journal은 derived observation이다. journal append가 실패해도 이미 계산된 command success/failure와 coordinates/exit은 바뀌지 않고 bounded `journal_warning`만 추가된다. Phase 1A는 build server manual/on-demand 실행이며 Actions/schedule이 없다. 운영 순서와 stable exit은 `docs/project-control/phase1a-runbook.md`가 정본이다.

## 3. 저장소 구조

```
jhw-notion/
|-- mcp-server/                  # TypeScript MCP 서버
|   |-- src/
|   |   |-- index.ts             # 엔트리포인트
|   |   |-- server.ts            # MCP 서버 설정
|   |   |-- notion-client.ts     # Notion REST API 클라이언트
|   |   |-- config.ts            # DB ID, 페이지 ID 설정
|   |   |-- control/             # Project Control CLI/domain/ports
|   |   `-- tools/               # Notion 도구별 핸들러
|   |       |-- record.ts
|   |       |-- note.ts
|   |       |-- delete.ts
|   |       |-- search.ts
|   |       |-- context.ts
|   |       |-- history.ts
|   |       |-- status.ts
|   |       |-- start.ts
|   |       `-- close.ts
|   |-- package.json
|   |-- tsconfig.json
|   `-- .env.example
|-- skills/
|   |-- claude/                  # 모든 TUI가 공유하는 Markdown 정본
|   |   |-- task.md
|   |   |-- project.md
|   |   |-- portfolio.md
|   |   `-- (Notion command Markdown)
|   `-- codex/jhw-*/             # 정본에서 생성한 SKILL.md + reference link
|-- scripts/
|   |-- sync-codex-skills.mjs    # Codex generated skill 동기화
|   |-- install-config.mjs       # ownership-aware atomic config editor
|   `-- test-install-safety.sh   # isolated-HOME installer gate
|-- install.sh                   # 원클릭 설치
|-- .env.example
`-- README.md
```

위 트리는 초기 구조를 설명한다. 현재 live 파일과 Phase 1A 경계는 실제 코드, `README.md`, 본 문서, runbook을 우선한다. `PLAN.md`는 초기 계획의 원본 snapshot으로 유지하며 live architecture로 다시 쓰지 않는다.

## 4. MCP 서버 설계

### 4.1 기술 스택

- **런타임**: Node.js (TypeScript)
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Notion API**: `@notionhq/client` (공식 SDK)
- **전송**: stdio (모든 TUI에서 지원)

### 4.2 설정 (config.ts)

```typescript
export const NOTION_CONFIG = {
  databases: {
    projects: "4430fcd4-bfba-4a46-9a1b-4520db86e883",
    preferences: "4e5ba7f0-b9cc-4171-84a7-f4e430abaf57",
    decisionLog: "6c9fbc24-c5fb-4ca9-aa61-781cacc7ecfd",
  },
  pages: {
    references: "3398a230-a04e-81cc-b3a3-d408355fee9f",
    knowledgeBase: "3398a230-a04e-817d-b04a-d0180abec592",
  },
};
```

### 4.3 MCP 도구 정의 (15개)

#### 읽기 도구 (8개)

| 도구 | 입력 | 출력 | 설명 |
|------|------|------|------|
| `jhw_search` | `{ query: string }` | 검색 결과 (DB별 그룹) | 전체 DB + 페이지 통합 검색 |
| `jhw_status` | `{ db?: string }` | DB별 레코드 수, 최근 항목 | 워크스페이스 현황 |
| `jhw_context` | `{ project: string }` | 프로젝트 정보 + 관련 결정 + 페이지 본문 | 프로젝트 컨텍스트 로드 |
| `jhw_history` | `{ project: string }` | 시간순 활동 타임라인 | 프로젝트 히스토리 |
| `jhw_recall` | `{ query: string, notionFallback?: boolean }` | 캐시+Notion 검색 결과 | 로컬 캐시 우선 회상 |
| `jhw_retrieve` | `{ topic: string, project?: string }` | 관련 본문 스니펫 | 주제별 결정·지식·문서 조회 |
| `jhw_fetch` | `{ pageId: string, maxCharacters?: number }` | 페이지 메타데이터 + 구조 보존 Markdown + 절단 상태 | 전체 페이지 읽기 전용 조회 |
| `jhw_report_preview` | `{ period: string, ... }` | 기간별 보고서 미리보기 | report 필드 기반 보고서 조회 |

#### 쓰기 도구 (7개)

| 도구 | 입력 | 출력 | 설명 |
|------|------|------|------|
| `jhw_record` | `{ db: string, title: string, properties: object }` | 생성된 페이지 ID + URL | DB에 레코드 생성 |
| `jhw_note` | `{ title: string, content: string, project?: string }` | 생성된 페이지 ID + URL | Knowledge Base에 메모 |
| `jhw_append` | `{ pageId: string, heading?: string, content: string }` | 추가 block 수 + 대상 ID | 기존 페이지 끝에 보강 블록 추가 |
| `jhw_delete` | `{ pageId: string, mode: "archive" \| "delete" }` | 처리 결과 | 레코드 삭제/폐기 |
| `jhw_start` | `{ name: string, repo?: string, stack?: string, description: string }` | 생성된 3건의 ID | 프로젝트 시작 (3단계) |
| `jhw_close` | `{ project: string, achievement?: string, lessons?: string }` | 처리 결과 | 프로젝트 종료 + 회고 |
| `jhw_report_export` | `{ period: string, format: string, ... }` | 보고서 출력·선택 저장 결과 | 기간별 보고서 export |

#### review는 MCP 도구 없음

`/jhw:review`는 "세션 대화를 분석하여 저장 후보 추출"이 핵심이므로 LLM이 담당.
각 TUI 스킬에서 대화 분석 후 `jhw_record`를 호출하는 방식.

### 4.4 도구 상세

#### jhw_record

```typescript
// 입력
{
  db: "decisionLog" | "preferences" | "projects" | "references",
  title: string,
  properties: {
    // decisionLog
    status?: string,       // "확정" | "폐기" (기본: "확정")
    rationale?: string,    // 근거
    alternatives?: string, // 대안
    area?: string,         // 영역
    project?: string,      // 관련 프로젝트
    // preferences
    category?: string,     // 범주
    // projects
    repo?: string,         // 레포 경로
    stack?: string,        // 기술 스택
    description?: string,  // 설명
  }
}

// 동작
// 1. db에 해당하는 database_id를 config에서 조회
// 2. properties를 Notion 프로퍼티 형식으로 변환 (프로퍼티명은 한글)
// 3. notion.pages.create() 호출
// 4. 생성된 페이지 ID + URL 반환
```

#### jhw_search

```typescript
// 입력
{ query: string }

// 동작
// 1. notion.search({ query }) 실행
// 2. 결과를 DB별로 그룹화
// 3. 각 결과에서 제목, 날짜, 미리보기 추출
// 4. 구조화된 JSON 반환
```

#### jhw_fetch

```typescript
// 입력
{ pageId: string, maxCharacters?: number } // UUID/URL, 기본 100000자

// 동작
// 1. pageId를 dashed UUID로 정규화하고 페이지 메타데이터 조회
// 2. block children pagination과 중첩 children을 끝까지 재귀 조회
// 3. heading/list/code/quote/table 등 구조를 Markdown으로 변환
// 4. 문자·block·pagination 한계 또는 partial/unsupported block이면
//    truncated + 기본 사유(truncation) + 전체 사유(truncations) 반환
```

#### jhw_start

```typescript
// 입력
{
  name: string,
  repo?: string,
  stack?: string,
  description: string
}

// 동작
// 1. Projects DB에 레코드 생성 (상태: 진행중, 시작일: 오늘)
// 2. Decision Log에 "프로젝트 시작" 기록
// 3. 프로젝트 페이지에 템플릿 콘텐츠 추가 (목표/범위/제약사항/메모)
// 4. 3건의 생성 결과 반환
```

#### jhw_close

```typescript
// 입력
{
  project: string,
  achievement?: string,  // 달성한 것
  lessons?: string       // 배운 점
}

// 동작
// 1. Projects DB에서 프로젝트 검색
// 2. 상태 → 완료, 완료일 → 오늘로 업데이트
// 3. 프로젝트 페이지에 회고 섹션 추가 (있는 경우)
// 4. lessons가 있으면 Knowledge Base에 별도 페이지 생성
```

### 4.5 Notion 프로퍼티 매핑

현재 live Notion DB의 프로퍼티 key는 **영문**이다. 과거 한글 스키마 문서는 stale이며, 실제 기준은 `mcp-server/src/config.ts`와 각 tool 구현이다.

#### Decision Log DB

| 프로퍼티 | 타입 | 비고 |
|---------|------|------|
| title | title | 제목 |
| status | select | 확정, 검토중, 폐기 |
| rationale | rich_text | |
| alternatives | rich_text | |
| area | select | |
| project | rich_text | |
| date | date | |
| result | rich_text | 선택 사항 |

#### Projects DB

| 프로퍼티 | 타입 | 비고 |
|---------|------|------|
| title | title | 제목 |
| status | select | 계획중, 진행중, 완료 |
| repo | rich_text | |
| tech_stack | multi_select | 기술 스택 배열 |
| description | rich_text | |
| start_date | date | |
| end_date | date | |
| created_at | created_time | Notion 자동 생성 |

#### Preferences DB

| 프로퍼티 | 타입 | 비고 |
|---------|------|------|
| title | title | 제목 |
| category | select | |
| content | rich_text | 본문 |
| tools | multi_select | 선호 도구 |
| priority | select | 우선순위 |
| created_at | created_time | Notion 자동 생성 |
| updated_at | last_edited_time | Notion 자동 갱신 |

## 5. TUI 스킬 설계

### 5.1 얇은 스킬 원칙

MCP 도구가 로직을 담당하므로 스킬은 다음만 포함:
- 사용자 입력 파싱 방법
- 미리보기 포맷
- 승인 흐름
- 어떤 MCP 도구를 호출할지

### 5.2 Claude Code 스킬 예시 (record.md)

```markdown
---
description: Notion AI Workspace에 확정된 정보를 즉시 저장
---

# /jhw:record — Notion 즉시 저장

1. 사용자 입력에서 저장할 내용과 대상 DB를 파악한다.
2. 미리보기를 보여주고 승인을 받는다.
3. 승인 후 `jhw_record` MCP 도구를 호출한다.
4. 결과 URL을 반환한다.

## DB 판별 기준
- 기술 결정 → db: "decisionLog"
- AI 사용 선호도 → db: "preferences"
- 프로젝트 등록 → db: "projects"
- 참조 문서 → db: "references"
- 기술 지식 → /jhw:note 안내

## 규칙
- 중간 결과나 미확정 정보는 저장하지 않는다.
- 저장 전 반드시 사용자 승인을 받는다.
```

### 5.3 review 스킬 (각 TUI에서 로직 유지)

```markdown
---
description: 세션 마무리 시 Notion 저장 후보 정리 및 승인 저장
---

# /jhw:review — 세션 마무리 리뷰

1. 현재 세션 대화를 분석하여 저장 후보를 추출한다:
   - 새로운 기술 결정 → decisionLog
   - AI 사용 피드백 → preferences
   - 프로젝트 상태 변경 → projects

2. 추출된 항목을 테이블로 보여준다.

3. 사용자 승인 후 각 항목에 대해 `jhw_record` MCP 도구를 호출한다.

## 규칙
- 실패한 시도나 중간 과정은 후보에서 제외한다.
- 이미 저장된 항목은 중복 제안하지 않는다.
```

## 6. 설치 시스템

### 6.1 install.sh 동작과 ownership

`install.sh`는 Linux `/proc`, Bash, `/usr/bin/flock`, Node.js 22 이상을 요구하는 작은 공개
dispatcher다. 인자를 그대로 `scripts/runtime-deploy.mjs`에 넘기며 production CLI에는 fixture
root, lock fd, inventory 우회, force flag가 없다. 공개 command는 `--prepare`, `--status`,
`--activate RELEASE_ID`, `--rollback`, `--uninstall`뿐이다. release ID는
`r-<40 또는 64자리 source revision>-<64자리 content digest>`의 lowercase hex exact 값이다.

runtime artifact는 canonical trusted checkout의 `.jhw-runtime/`에 있다.

```text
.jhw-runtime/
|-- deploy.lock
|-- admission.lock
|-- bootstrap/                 # independently validated stable entry helpers
|-- current -> activations/<activation-id>
|-- activations/<activation-id>/
|-- releases/<release-id>/    # immutable built generation
|-- .bootstrap.previous.<id>/ # retained helper evidence, 있을 때
`-- .deploy.<id>/             # private 0600 state/preimage/phase evidence
```

`--prepare`는 private `0700` same-store stage에 allowlisted source만 복사하고 그 안에서
`npm ci`와 build를 실행한다. MCP/control/hook selector는 각각 code splitting 없는 단일 CJS
bundle로 생성한다. manifest와 content digest를 검증한 complete release만 atomic rename으로
보존하며 live checkout의 `dist`·`node_modules`, `current`, HOME wiring을 바꾸지 않는다.
staging fixture에서 생긴 ID는 live deployable artifact가 아니다.

`--activate`·`--rollback`·`--uninstall`은 mutation 전 inventory, exclusive deploy/admission
lease, lease 뒤 두 번째 inventory를 요구한다. TUI, Codex app server, legacy runtime,
managed MCP/control/hook 중 하나가 살아 있거나 `/proc` 관측이 불확실하면 shared mutation
전에 fail-closed한다. force·process signal·lock 삭제는 없다. mutation worker는 실제 두 lease
fd를 상속한다. runtime validation 동안 exclusive admission은 닫아 managed MCP/control/hook이
shared admission으로 진입할 수 있게 하고, finalize 전 새 exclusive admission과 inventory를
다시 얻는다. worker timeout이나 parent EOF는 child를 종료하거나 자동 restore하지 않으며,
child가 끝날 때까지 상속 lease와 pending evidence가 남는다.

첫 activation은 stable bootstrap을 설치하고 기존 ownership-aware no-clobber transaction으로
네 TUI의 MCP/skill, control/hook, Claude/Codex hook wiring을 옮긴다. managed MCP vector는
bootstrap `jhw-runtime-entry mcp`, control/hook link는 bootstrap의 closed selector, skill은
`current/skills`를 사용한다. configuration은 기존 mode를 적용한 private same-directory temp를
fsync한 뒤 atomic publish하고 directory를 fsync한다. foreign target/config/group과 모호한
ownership은 그대로 보존하고 실패한다. bootstrap verifier는 no-follow descriptor로 읽어
검증한 helper bytes 자체를 import하며, selected MCP/control/hook artifact는 열린 descriptor와
현재 이름의 identity를 spawn 직전에 다시 대조한다. selector는 그 pinned bundle 하나만
entry로 실행하고 이후 built-in 외 module load를 거부한다. control authorization tool version은
private build stage의 package metadata에서 검증해 bundle bytes에 상수로 삽입하며 managed
runtime은 release pathname의 `package.json`을 읽지 않는다. hook timeout은 이벤트 종류와
무관하게 `SIGTERM` 뒤 200 ms grace가 지나면 `SIGKILL`로 승격한다. bootstrap runner는
selected release root를 bundle 평가 전에 변경 불가능한 process-local binding으로 설정해
descriptor filename과 control trust root를 분리한다. managed MCP credential은 canonical
`.env`의 owner·mode·type·single-link·identity를 검사한 열린 fd를 상속한다. 인증된 runner는
1 MiB 한도와 fatal UTF-8을 적용해 descriptor를 끝까지 읽고 read 전후 identity를 비교하며,
well-formed assignment 중 `NOTION_API_KEY` 하나만 반영한 뒤 bundle load 전에 fd를 닫는다. 다른 key는
실행·전달하지 않고 selector child의 `NODE_OPTIONS`·`NODE_PATH`·`NODE_REPL_EXTERNAL_MODULE`·
`BASH_ENV`·`ENV`를 제거하므로 credential data가 Node pre-evaluation 단계에 도달하지 않는다. 모든 owned
launcher/skill/prompt 제거는 같은 parent의 private capture transaction으로 수행해 검사 뒤
바뀐 foreign replacement를 삭제하지 않는다. control/hook launcher transaction도 parent를
retained no-follow descriptor로 고정하며 반환 직전 논리 parent identity를 다시 검증한다.

activation validation은 fresh worker의 exact host contract v5와 Guard preflight, managed MCP
`initialize`·`notifications/initialized`·`tools/list`를 bounded output/timeout으로 검사한다.
그 뒤 admission을 다시 독점하고 consumer inventory와 pointer read-back을 반복해야
finalize한다. `NO-GO` 또는 결과의 `unprotected: true`는 Guard protection 완료가 아니다.

첫 migration에는 managed predecessor가 없다. 실패 시 `.deploy.<id>/state.json`, mutation 전
`before.json`, bounded phase log와 기존 hook transaction evidence를 보존하지만 자동 복원
CLI나 legacy rollback은 제공하지 않는다. 초기 검증 실패는 `DEPLOY_VALIDATION_FAILED` /
`first_migration_recovery_required`로 operator의 수동 wiring 검토를 요구한다. 기존 설치 완료
wiring을 유지한 managed pointer update 실패에만 `validated_rollback_required`를 안내하고,
durable observation이 정확히 일치할 때 `--rollback`이 committed predecessor를 검증한다.
pointer 목적 activation은 `current` rename 전에 journal에 fsync하므로 rename 뒤 directory
fsync나 read-back이 실패해도 관측된 destination과 predecessor가 일치하면 같은 recovery gate로
rollback할 수 있다.
guarded uninstall 뒤 재설치 검증 실패는 `DEPLOY_VALIDATION_FAILED` /
`wiring_refresh_recovery_required`다. retained predecessor가 있어도 wiring은 아직 설치 완료가
아니므로 `--rollback`은 `DEPLOY_RECOVERY_REQUIRED`로 거부되고 pointer와 evidence는 유지된다.
operator는 maintenance를 유지한 채 wiring·helper·hook transaction evidence를 수동 검토한다.
rollback 자체의 검증 실패는 `DEPLOY_VALIDATION_FAILED` / `rollback_recovery_required`로
수동 operator 검토를 요구한다. 추가 `--rollback`은 `DEPLOY_RECOVERY_REQUIRED`로 거부되며
maintenance와 selected pointer·pending evidence를 유지한다.
`installed:true` 조기 기록이나 journal 삭제로 recovery gate를 우회하지 않는다.

### 6.2 업데이트

```bash
cd <canonical-trusted-runtime-checkout>
./install.sh --prepare
./install.sh --status
# 별도 승인된 all-consumers-stopped maintenance window
./install.sh --activate '<exact retained RELEASE_ID>'
```

normal managed update는 validated activation과 `current` pointer만 바꾸며 HOME wiring과 stable
bootstrap source release를 유지한다. source checkout build나 skill 변경은 즉시 live 반영되지
않는다. Claude/Gemini/OpenCode의 whole-directory skill link는 새 `current` content를 보지만,
Codex의 개별 skill/prompt 이름 집합이 달라지는 release는 pointer publication 전에
`DEPLOY_WIRING_TOPOLOGY_CHANGED` / `guarded_uninstall_reinstall_required`로 거부된다. helper
교체 또는 이 Codex topology 변경을 채택할 때만 같은 maintenance gate 아래 다음을 실행한다.

```bash
./install.sh --uninstall
./install.sh --activate '<exact retained RELEASE_ID>'
```

두 command 모두 독립적으로 quiescence와 exclusive admission을 통과해야 한다. 이전 helper
directory, release, activation, `current`, journal은 자동 삭제하지 않는다.

### 6.3 제거

```bash
./install.sh --uninstall
# 이 repository 소유가 증명된 link와 MCP entry만 제거
```

Uninstall도 같은 ownership proof를 사용한다. Claude/Codex 설정 root는 private transaction을
탐색하거나 만들기 전에 검증하므로 symlink/non-directory/외부 소유 root를 따라 쓰지 않는다.
installer-owned HOME wiring만 제거하고 foreign target/config/backup과 retained runtime
artifact/evidence는 건드리지 않는다. 설치 안전성은 isolated HOME에서 네 TUI, canonical,
legacy, foreign, transaction/race/recovery 경계를 검증한다.

## 7. 설치 호환성과 migration 경계

현재 Notion MCP/tool과 shared skill 설치는 기존 Notion database/page를 그대로 사용한다. Project Control Phase 1A는 별도 Registry/private Project에만 trial record를 만들며 Notion record migration을 수행하지 않는다. `legacy → registry` authority 전환과 reconciliation은 별도 승인 계획 전에는 구현·실행하지 않는다.

### 호환성

- 기존 Notion DB/페이지는 변경 없음 (동일 ID 사용)
- 기존 Notion MCP 플러그인은 제거 가능 (jhw-notion이 대체)
  - 단, jhw 이외 용도로 Notion MCP를 쓰고 있다면 병존 가능

## 8. 제약사항

- **Notion API 키 필요**: Notion Integration 생성 후 토큰 발급
- **DB 접근 권한**: Integration에 각 DB 공유 필요
- **프로퍼티 key 영문**: current live DB key는 `title`, `status`, `rationale`, `project`, `date` 등 실제 code/schema의 영문 key가 기준
- **review 스킬**: TUI마다 개별 유지보수 필요 (LLM 의존 로직)
