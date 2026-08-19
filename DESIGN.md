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

- **MCP 서버**: Notion API 직접 호출. 14개 고수준 도구 제공
- **TUI 스킬**: LLM에게 "어떤 MCP 도구를 호출하라"만 안내 (얇은 레이어)
- **review만 예외**: 세션 대화 분석은 LLM 역할이므로 각 TUI 스킬에 로직 유지

### 2.1 Project Control Phase 1A 경계

Phase 1A는 위 Notion workspace를 대체하지 않는 trial control plane이다.

```text
명시적 /jhw:task, /jhw:portfolio, /jhw:project --trial
        ↓
build server의 jhw-control CLI
        ├─ 별도 private Registry checkout (identity, Task, Claim, governance)
        ├─ personal private GitHub Project (DraftIssue Project Records + 5 operational fields)
        └─ private local state/snapshot (measurement, export)

일반 /jhw:project, /jhw:status → 기존 Notion live authority
```

- Registry는 `jhw-notion` 워킹 트리 안의 디렉터리가 아니라 독립된 GitHub 저장소/checkout이다.
- `repository register`가 exact checkout root/origin/GitHub node identity를 검증한 뒤에만 Repository Record를 만든다. private이 기본이며 public repository는 `--allow-public true` 명시 opt-in이 Record에 영속된 경우에만 등록과 task start 재검증을 통과한다(opt-in은 재등록마다 다시 선언한다 — public 상태의 무플래그 재등록은 `REPOSITORY_NOT_PRIVATE`로 실패하며 opt-in을 유지하고, 소거는 private 복귀 후 무플래그 재등록에서만 일어난다; Registry·GitHub Project는 여전히 private 필수). Project registration과 formal/temporary Task는 이 verified mapping을 요구하며 Registry file 손편집은 public bootstrap 경로가 아니다.
- public surface는 `repository register`; `task start|promote|handoff|status|finish|recover|assert-owner`; `portfolio status|export`; `project register|update`; `preflight`다. `task start --task`는 같은 persistent Task의 새 Claim generation을 만들고 explicit resume에서만 bounded latest Handoff를 반환한다.
- Claim은 source revision을 acquisition 때 고정한다. temporary lifecycle과 Claim create/release/history는 같은 Registry transaction이다. release 뒤 host cleanup은 authority와 분리되며 exact archived generation의 `recover --action cleanup`만 허용한다.
- Registry Task/Claim/Handoff I/O는 descriptor-relative no-follow record store를 공유하며 symlink, non-directory ancestor, nonregular/multi-link leaf, traversal, path/content ID mismatch를 거부한다. Registry transaction은 host lock, clean/fast-forward check, push/refetch verification 전체를 감싼다.
- 새 session에 이전 session·Notion·memory·Git history를 자동 주입하지 않는다. 현재 요청과 현재 repository 사실에서 시작하고 사용자가 지정한 Project/Task/page만 확장한다. Handoff는 fixed six-section/12 KiB schema이며 goal/lifecycle/full transcript를 복제하지 않는다.
- committed regular HEAD `governance/authority.yaml`, monotonic cache, minimum tool version, server-side Notion database/data-source ancestry guard가 fail-closed authority boundary다. local cache는 권한을 더 제한할 수만 있고 authority를 선택하지 않는다.
- Phase 1A authority는 epoch 1 / `legacy` / null cutover이며 Notion이 live authority다. Phase 1B/cutover, schedule, cross-host retry, reconciliation/migration은 natural evidence 뒤 별도 승인 계획을 요구한다.

### 2.2 운영·credential 제약

개인 account Project에는 fine-grained PAT를 사용할 수 없어 short-lived classic `GH_PROJECT_TOKEN`이 필요하다. normalized scope는 정확히 `project` 하나여야 하고 다른 scope를 허용하지 않는다. 분리된 `GH_REPO_TOKEN`은 Registry와 등록할 private source repository의 Issue/metadata API에 필요한 최소 repository 권한만 가진다. SSH Registry Git credential과도 역할을 섞지 않는다. host credential store가 token을 process environment에만 주입한다.

Project Record는 Project-only token으로 완전히 읽고 쓸 수 있는 canonical DraftIssue다. DraftIssue의 제목과 exact `{id, objective, repositories}` 본문, 같은 Project item의 다섯 운영 필드가 한 레코드를 이룬다. Registry Issue나 repo token과 source ID를 결합하지 않는다.

`jhw-control preflight`는 mutation 전에 committed authority/version, read-only Notion ancestry, exact Project scope, private Project/Registry repository, unique matching SSH remote를 검증한다. 그 뒤 고정 canonical Project DraftIssue fixture의 field를 write/restore하고, 이와 독립된 Registry Issue를 unchanged-write하며, fetch/dry-run push를 확인한다. 성공은 `credentials`, `authority`, `notion_guard`, `project`, `registry_repository`, `registry_issue`, `registry_git` 일곱 check가 모두 `ok`일 때뿐이다.

모든 compliant process는 동일한 Registry realpath/inode/remote identity와 immutable absolute `JHW_CONTROL_STATE_DIR`를 사용한다. 그래야 하나의 `registry.lock`이 host mutation을 직렬화한다. process timeout은 bounded이며 Git/SSH는 noninteractive다. secret과 configured private path는 Registry/GitHub/Handoff/journal/snapshot/output/error에 쓰기 전에 중앙 reject policy가 차단한다.

measurement journal은 derived observation이다. journal append가 실패해도 이미 계산된 command success/failure와 coordinates/exit은 바뀌지 않고 bounded `journal_warning`만 추가된다. Phase 1A는 build server manual/on-demand 실행이며 Actions/schedule이 없다. 운영 순서와 stable exit은 `docs/project-control/phase1a-runbook.md`가 정본이다.

## 3. 저장소 구조

```
jhw-notion/
├── mcp-server/                  # TypeScript MCP 서버
│   ├── src/
│   │   ├── index.ts             # 엔트리포인트
│   │   ├── server.ts            # MCP 서버 설정
│   │   ├── notion-client.ts     # Notion REST API 클라이언트
│   │   ├── config.ts            # DB ID, 페이지 ID 설정
│   │   ├── control/             # Project Control CLI/domain/ports
│   │   └── tools/               # Notion 도구별 핸들러
│   │       ├── record.ts
│   │       ├── note.ts
│   │       ├── delete.ts
│   │       ├── search.ts
│   │       ├── context.ts
│   │       ├── history.ts
│   │       ├── status.ts
│   │       ├── start.ts
│   │       └── close.ts
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── skills/
│   ├── claude/                  # 모든 TUI가 공유하는 Markdown 정본
│   │   ├── task.md
│   │   ├── project.md
│   │   ├── portfolio.md
│   │   └── (Notion command Markdown)
│   └── codex/jhw-*/             # 정본에서 생성한 SKILL.md + reference link
├── scripts/
│   ├── sync-codex-skills.mjs    # Codex generated skill 동기화
│   ├── install-config.mjs       # ownership-aware atomic config editor
│   └── test-install-safety.sh   # isolated-HOME installer gate
├── install.sh                   # 원클릭 설치
├── .env.example
└── README.md
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

### 4.3 MCP 도구 정의 (14개)

#### 읽기 도구 (7개)

| 도구 | 입력 | 출력 | 설명 |
|------|------|------|------|
| `jhw_search` | `{ query: string }` | 검색 결과 (DB별 그룹) | 전체 DB + 페이지 통합 검색 |
| `jhw_status` | `{ db?: string }` | DB별 레코드 수, 최근 항목 | 워크스페이스 현황 |
| `jhw_context` | `{ project: string }` | 프로젝트 정보 + 관련 결정 + 페이지 본문 | 프로젝트 컨텍스트 로드 |
| `jhw_history` | `{ project: string }` | 시간순 활동 타임라인 | 프로젝트 히스토리 |
| `jhw_recall` | `{ query: string, notionFallback?: boolean }` | 캐시+Notion 검색 결과 | 로컬 캐시 우선 회상 |
| `jhw_retrieve` | `{ topic: string, project?: string }` | 관련 본문 스니펫 | 주제별 결정·지식·문서 조회 |
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

`install.sh`는 `set -euo pipefail`로 build 실패를 보존하고 다음 순서로 동작한다.

1. MCP server와 `jhw-control`을 build한다.
2. Claude/Gemini/OpenCode/Codex 설치 root를 감지한다.
3. canonical skill link와 Codex legacy/prompt link를 검사한다. target이 없거나 이 repository를 가리키는 symlink일 때만 설치/갱신한다. foreign file/symlink이면 보존하고 install을 실패시킨다.
4. `skills/claude/*.md` 정본에서 Codex skill을 생성한 뒤 link한다. generated Codex file을 손편집하지 않는다.
5. Claude/Gemini/OpenCode JSON과 Codex TOML의 `jhw-notion` entry가 정확히 `node <this-repository>/mcp-server/dist/index.js`를 가리킬 때만 갱신한다. semantic TOML alternate/duplicate와 foreign same-name entry는 보존하고 실패한다.
6. configuration은 shell string interpolation 없이 argv로 전달하고, 기존 mode를 적용한 private same-directory temp를 fsync한 뒤 atomic publish하고 directory를 fsync한다. Codex backup은 unique project-marked namespace만 exclusive publish/prune한다.

Uninstall도 같은 ownership proof를 사용한다. 이 repository가 소유한 link/entry만 제거하고 foreign target/config/backup은 건드리지 않는다. 설치 안전성은 `scripts/test-install-safety.sh`의 isolated HOME에서 네 TUI install → reinstall → uninstall → reinstall과 canonical/legacy/foreign case를 검증한다.

### 6.2 업데이트

```bash
cd /path/to/jhw-notion
git pull
npm run build --prefix mcp-server
# 스킬은 심링크라 자동 반영
# MCP 서버는 TUI 재시작 시 반영
```

### 6.3 제거

```bash
./install.sh --uninstall
# 이 repository 소유가 증명된 link와 MCP entry만 제거
```

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
