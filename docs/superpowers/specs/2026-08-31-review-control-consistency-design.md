# Review Control 정합성 점검 설계

- 날짜: 2026-08-31
- 대상: `jhw7500/jhw-notion#71`
- 상태: 사용자 승인

## 목표

명시적으로 선택한 `/jhw:review --control`에서 세션 종료 시점의 Notion 저장 후보와
GitHub Issue, Project Control Project, Task/Claim 후속 액션을 구분해 제안한다. Project Control
조회는 현재 repository, Codex/Claude/Gemini/OpenCode session, host-local worktree를 함께 대조해
active Task를 `none`, `unique`, `ambiguous`로 판정한다.

읽기 단계는 어떤 Issue, Project, Task, Claim도 변경하지 않는다. 제안된 변경은 authority별로
분리된 사용자 승인 뒤 기존 `/jhw:project`와 `/jhw:task` 계약을 통해서만 실행한다.

## 비목표

- 기본 `/jhw:review`와 `/jhw:review --match`의 저장·대조 동작을 바꾸지 않는다.
- 세션 종료, 프로세스 부재, dirty 상태를 근거로 Claim을 stale이라고 추정하지 않는다.
- owner mismatch나 ambiguous 결과에서 Task를 자동 finish, handoff, force-end, takeover하지 않는다.
- 완료된 작업을 위해 Task를 소급 생성하지 않는다.
- GitHub Issue, Project Control Project, Notion Projects를 하나의 승인이나 하나의 상태 모델로
  합치지 않는다.
- 새 host launcher command나 contract version을 만들지 않는다.

## 선택한 접근

기존 `task status`에 checkout 기반 current-context mode를 추가한다. exact Task mode는 그대로
유지한다.

```bash
"$HOME/.local/bin/jhw-control-host" task status \
  --resolve-from-checkout true \
  --repo-path "$REPOSITORY_PATH" \
  --origin-adapter '<claude|codex|gemini|opencode>' \
  --session '<session-id>'
```

새 `task current` command는 의미가 분명하지만 host allowlist와 소비자 contract를 함께 바꿔야 한다.
현재 launcher v4가 이미 허용하는 읽기 전용 `task status`를 확장하면 같은 기능을 더 작은 배포
표면으로 제공할 수 있다. 반대로 skill이 Registry나 worktree state를 직접 읽는 방식은 pinned
Registry view, exact checkout 검증, 민감정보 리댁션을 재현할 수 없으므로 사용하지 않는다.

## 공개 CLI 계약

### 두 mode의 배타성

exact Task mode:

```bash
"$HOME/.local/bin/jhw-control-host" task status \
  --task <tsk-id> [--claim <active-claim-id>]
```

current-context mode:

```bash
"$HOME/.local/bin/jhw-control-host" task status \
  --resolve-from-checkout true \
  --repo-path <absolute-exact-checkout-root> \
  --origin-adapter <adapter> \
  --session <exact-session-id>
```

current-context mode는 네 필드를 모두 요구한다. `--task`, `--claim`, registration field, recovery
field와 섞으면 service 호출 전에 `INVALID_CLI_ARGUMENT`로 끝난다. `--resolve-from-checkout` 값은
정확히 `true`만 허용한다. exact Task mode의 기존 입력과 출력은 변경하지 않는다.

`task status`는 계속 read-only command이며 host mutation lock과 preflight fixture write를 실행하지
않는다. launcher가 보호된 config와 credential을 child environment에 주입하는 유일한 진입점이다.
호출자가 config를 source하거나 credential을 조립하는 fallback은 제공하지 않는다.

### 후보 정의

먼저 checkout의 live GitHub repository identity와 Registry의 canonical Repository/Project association을
검증한다. 그 pinned repository에 속한 active Claim 중 다음 둘 중 하나를 만족하는 Claim을 후보로
모은다.

1. `session match`: adapter-bound Claim의 `(origin_adapter, session_id, host)`가 호출자의 exact tuple과
   일치한다.
2. `worktree match`: Claim의 host-local active worktree mapping이 `--repo-path`의 exact checkout root와
   일치한다.

후보는 두 집합의 합집합이다. 따라서 현재 session이 같은 repository의 다른 Task worktree를
소유하면서 현재 checkout은 다른 session의 Claim에 매핑된 경우 두 후보가 되어 `ambiguous`로
끝난다. repository만 같고 session과 worktree가 모두 다른 Claim은 현재 context 후보가 아니다.

legacy Claim처럼 `origin_adapter`가 없으면 session 문자열이 같아도 session match로 인정하지 않는다.
worktree match는 보고할 수 있지만 current ownership은 검증 불가다.

### 결과 shape

후보가 없으면:

```json
{
  "kind": "resolved",
  "project_id": "prj-...",
  "repo_id": "repo-...",
  "match": "none"
}
```

후보가 하나면:

```json
{
  "kind": "resolved",
  "project_id": "prj-...",
  "repo_id": "repo-...",
  "match": "unique",
  "task": {
    "task_id": "tsk-...",
    "kind": "formal",
    "issue_url": "https://github.com/owner/repository/issues/71"
  },
  "claim": {
    "task_id": "tsk-...",
    "claim_id": "clm-...",
    "host": "build-host",
    "branch": "task/...",
    "worktree_ref": "wt-...",
    "started_at": "2026-08-31T00:00:00.000Z"
  },
  "relation": {
    "session_match": true,
    "worktree_match": true,
    "owner": "current"
  }
}
```

`task.kind`는 `formal|temporary|child`다. formal이면 canonical `issue_url`을 포함하고
`task_role`이 있으면 함께 반환한다. temporary/child이면 저장된 `lifecycle`을 포함하고 child이면
`parent_task_id`를 포함한다. 이 값들은 mutation authority가 아니라 후속 제안 분류용 canonical
metadata다.

`relation.owner`는 다음처럼 계산한다.

- `current`: adapter-bound exact session match와 exact worktree match가 모두 참이다.
- `mismatch`: 둘 중 하나만 참이거나 둘 다 거짓이다. unique 후보는 합집합 정의상 일반적으로 하나가
  참이지만, 최종 검증에서 관계가 바뀌면 결과를 내지 않고 fail-closed한다.
- `unverifiable`: legacy Claim의 worktree만 일치해 exact adapter ownership을 증명할 수 없다.

후보가 둘 이상이면 개별 후보를 고르거나 좌표를 펼치지 않는다.

```json
{
  "kind": "resolved",
  "project_id": "prj-...",
  "repo_id": "repo-...",
  "match": "ambiguous",
  "candidate_count": 2
}
```

모든 결과에서 `session_id`, absolute checkout/worktree/config path, repository identity path,
Work Contract 내용, raw credential과 raw error message를 제외한다. unique Claim은 기존
`ConflictingClaimSummarySchema`의 여섯 필드만 사용한다.

## 읽기 경계와 데이터 흐름

1. CLI가 두 status mode를 완전히 배타적으로 파싱한다.
2. `GitHubSourceService`가 absolute exact checkout root, 단 하나의 fetch/push origin, live GitHub
   repository identity, Repository Record와 unique Project association을 검증한다.
3. source callback 안에서 `ClaimService.listActiveClaims()`를 사용해 같은 committed Registry view의
   active Claim을 읽는다. repository, tasks, active claims를 포함한 view가 끝날 때 Registry HEAD 이동을
   확인하고 움직였으면 `REGISTRY_MOVED_DURING_READ`로 전체 결과를 폐기한다.
4. `WorktreeManager`가 private host-local state를 한 번의 secure snapshot으로 읽고 각 local Claim의
   exact generation, repository identity, mapped path와 lifecycle을 검증한다. path는 내부 비교에만
   사용한다.
5. `TaskService`가 session 후보와 worktree 후보의 합집합을 만들고 `none|unique|ambiguous`를 결정한다.
6. unique이면 Task record의 `task_id`, `project_id`, `repo_id`가 Claim과 resolved checkout context에
   모두 일치하는지 검증한 뒤 bounded public projection을 만든다.
7. CLI는 projection을 12 KiB 이하 JSON envelope로 반환한다.

Registry와 worktree state가 중간 lifecycle 전이 때문에 서로 맞지 않으면 빈 결과로 완화하지 않는다.
기존 `REGISTRY_*`, `WORKTREE_*`, `HOST_MISMATCH` 계열 stable error로 끝낸다. malformed state를
`ambiguous`로 바꾸지 않는다. `ambiguous`는 각각 유효한 후보가 둘 이상인 경우에만 사용한다.

## `/jhw:review --control` workflow

### 플래그와 기본 동작

- 허용 조합은 기본 review, `--match`, `--control`, `--match --control`이다.
- `--control`이 없으면 현재 review 본문을 그대로 실행한다.
- `--control` 실패는 Notion 후보를 버리거나 저장 승인을 확대하지 않는다. Notion section은 정상
  표시하고 Project Control section만 stable diagnostic과 함께 unavailable로 표시한다.
- `--match --control`은 Notion 후보에만 기존 match verdict를 적용한다. Project Control 제안에는
  NEW/SIMILAR/AUGMENT/DUPLICATE를 사용하지 않는다.

### 읽기 단계

control mode는 상태 변경 전에 다음 사실만 읽는다.

1. 현재 checkout root를 `git rev-parse --show-toplevel`로 확정한다.
2. host launcher의 current-context `task status`를 한 번 실행한다.
3. session 대화에 직접 등장한 Issue/PR URL이나 unique lookup이 반환한 formal Issue URL만 GitHub에서
   읽는다. repository 전체 history를 자동 검색하지 않는다.
4. resolved `project_id`가 있으면 기존 bounded `portfolio status --project`로 Project metadata와
   stale 표식을 읽는다. pagination은 기존 portfolio 계약을 따른다.
5. credential/config 누락, Registry 이동, Project/Repository 미등록·ambiguous, owner mismatch는
   추측으로 보완하지 않는다.

`jhw-control-host preflight`는 fixture write/restore가 포함되므로 review의 read stage에서 자동 실행하지
않는다. 승인된 mutation의 기존 launcher workflow가 필요할 때 자체 gate를 수행한다.

### 출력 구분

기존 카드 section의 이름을 `Notion 저장 후보`로 유지하되 Projects DB 후보에는
`Notion Projects DB`를 명시한다. 별도 section은 다음 제목을 사용한다.

```text
Project Control 후속 제안 — GitHub Project 기반
```

각 후속 제안은 다음 metadata를 갖는다.

- authority: `GitHub Issue | Project Control Project | Project Control Task`
- evidence: 현재 세션과 bounded read에서 직접 확인한 사실
- proposed action: 제안만 표시하며 아직 실행되지 않았음을 명시
- approval route: `/jhw:project`, `/jhw:task`, 또는 별도 GitHub Issue mutation
- blocked reason: owner mismatch, ambiguous, unavailable이면 stable code 또는 relation

### 제안 매트릭스

위에서 먼저 일치하는 안전 경계를 적용하고, 서로 다른 authority의 액션은 별도 카드로 유지한다.

| 관측 | 제안 | 금지 |
|---|---|---|
| Project/Repository 미등록 + 반복·다중 세션 작업 | Project/Repository 등록 또는 control 없이 진행 | 자동 등록, 임의 ID 생성 |
| 미래·미착수 backlog | GitHub Issue 생성 또는 보류 | Task 선점, Temporary Task 자동 생성 |
| 즉시 착수 + `match=none` + 등록 repository | Formal Issue Task / Temporary Task / Task 없음 선택 | 무승인 `task start` |
| 완료 증거 + `unique/current` active Claim | completion-ready와 completed finish 제안 | 증거 생성, 자동 finish |
| 진행 중 + `unique/current` active Claim | 현재 Task 유지 또는 명시적 handoff 제안 | 불필요한 새 Task 생성 |
| `unique/mismatch` 또는 `unique/unverifiable` | exact status/handoff/recovery 확인 제안 | 현재 owner 취급, 자동 takeover/force-end |
| `match=ambiguous` | 후보 정합성 조사와 recovery status 제안 | 후보 선택, 좌표 추측 |
| 완료된 Task + GitHub Issue open | Issue close를 별도 제안 | Task finish 승인으로 Issue까지 닫기 |
| Project metadata stale | Project update를 별도 제안 | Task/Issue 승인과 묶어 update |
| 이미 완료된 작업 + active Task 없음 | Issue close·Project update 등 남은 tracker 작업만 제안 | 소급 Task 생성 |
| control lookup unavailable | stable diagnostic과 수동 확인 제안 | cached/session 기억으로 owner 판정 |

완료 증거는 현재 세션에서 실제 수행한 validation, merged PR, closed Issue처럼 직접 확인 가능한 사실만
쓴다. 단순히 대화가 끝났거나 프로세스가 없다는 사실은 완료 증거가 아니다.

### 승인 분리

기존 `OK`, `전체 저장`, 번호 조정은 Notion 저장 후보에만 적용한다. control 카드에는 적용하지 않는다.
control mutation은 사용자가 authority와 액션을 명시적으로 선택한 새 요청이어야 한다.

- Project/Repository 등록·갱신: 기존 `/jhw:project` 계약
- Task start, completion-ready, finish, handoff, recovery: 기존 `/jhw:task` 계약
- GitHub Issue 생성·닫기: 별도 GitHub mutation 제안과 승인

한 authority의 승인은 다른 authority에 전파되지 않는다. 특히 Notion Projects 완료 저장은 Task finish나
Issue close 승인이 아니며, Task completed finish는 Issue close나 Project update 승인이 아니다.

## 오류 처리

- `PROJECT_REPOSITORY_NOT_FOUND`: 등록 제안만 표시하고 current Task를 추측하지 않는다.
- `PROJECT_REPOSITORY_AMBIGUOUS`: association 정리 제안만 표시하고 임의 Project를 고르지 않는다.
- `REGISTRY_MOVED_DURING_READ`: 결과를 버리고 stable diagnostic을 표시한다. 자동 retry하지 않는다.
- credential/config 오류: stable code만 표시하며 raw config key value, credential provider path와 token을
  출력하지 않는다.
- `unique/mismatch|unverifiable`: Claim 여섯 좌표와 relation만 표시하고 멈춘다. session ID는 표시하지
  않는다.
- `ambiguous`: candidate count만 표시한다. candidate 좌표를 펼치지 않는다.
- Project status pagination이나 GitHub read가 불완전하면 stale/closed를 확정하지 않고 해당 제안을
  blocked로 표시한다.

새 `reason` 식별자는 만들지 않는다. 조치 분기는 result의 `match`와 `relation.owner` discriminant로
표현한다. 구현 중 같은 stable code 안에서 운영자 조치가 갈리는 새 오류가 발견되면 별도 설계 승인을
받고 `ERROR_REASONS`, canonical task skill, 테스트를 함께 갱신한다.

## 파일 책임

- `mcp-server/src/control/github-source.ts`: exact checkout에서 verified Repository/Project context를
  pinned callback으로 제공한다.
- `mcp-server/src/control/claim-service.ts`: bounded active Claim enumeration을 기존 committed read
  경계 안에서 제공한다.
- `mcp-server/src/control/worktree.ts`: active Claim과 exact current checkout의 host-local mapping
  관계를 private path 노출 없이 판정한다.
- `mcp-server/src/control/task-service.ts`: 후보 합집합, `none|unique|ambiguous`, ownership relation과
  Task metadata validation을 담당한다.
- `mcp-server/src/control/cli.ts`: status mode 배타성, 입력 검증, bounded public JSON projection을
  담당한다.
- `skills/claude/review.md`: `--control` 읽기 흐름, 구분된 UI, 제안 매트릭스, 승인 분리를 정본으로
  정의한다.
- `scripts/test-review-skill-contract.mjs`: review control의 선언적 matrix와 안전 문구를 고정한다.
- `scripts/test-install-safety.sh`: review skill contract test를 설치 안전 게이트에 포함한다.
- `README.md`, `docs/project-control/phase1a-runbook.md`: public command와 운영 예시를 문서화한다.
- `skills/codex/jhw-review/*`: sync script의 생성물이며 직접 수정하지 않는다.

## 테스트

### Unit

- CLI: exact mode 회귀, current mode 필수 플래그, mode 혼합 거부, `true` literal 검증.
- Task service: none, exact current owner, session elsewhere, worktree owner mismatch, legacy
  unverifiable, valid two-candidate ambiguity.
- Worktree manager: exact mapped root, repository가 같지만 다른 worktree, malformed/duplicate mapping,
  symlink와 unsafe state refusal.
- Source: unregistered repository, ambiguous Project association, checkout remote mismatch, Registry move.
- Privacy: success와 모든 failure envelope에 session ID, absolute path, raw credential/config 값이 없는지
  검증한다.

### Integration/E2E

- active Claim의 own worktree에서 unique/current를 반환한다.
- 같은 session이 다른 worktree를 소유한 상태에서 unrelated checkout을 조회하면
  unique/session-only mismatch를 반환한다.
- current worktree가 다른 session 소유이면 unique/worktree-only mismatch를 반환한다.
- 같은 session의 다른 worktree와 현재 checkout의 다른 owner Claim이 동시에 있으면 ambiguous와
  candidate count만 반환한다.
- lifecycle 도중 Registry HEAD가 이동하면 `REGISTRY_MOVED_DURING_READ`로 결과를 폐기한다.
- 기존 `task status --task`, 기본 review, `--match`가 같은 결과를 유지한다.

### Skill/생성물

- review contract test가 모든 matrix 행, Notion/Project Control label 분리, approval 분리, no automatic
  mutation/takeover/retry/retrospective Task 규칙을 검증한다.
- `node scripts/sync-codex-skills.mjs`로 wrapper/reference를 생성하고 `--check`로 drift가 없음을 검증한다.

최종 필수 게이트는 `npm run typecheck`, `npm run build`, `npm test`, review skill contract,
`node scripts/sync-codex-skills.mjs --check`, install safety test다.

## 배포

새 command를 추가하지 않으므로 `jhw-control-host` contract는 v4를 유지한다. `task status`의 새 flag
조합이 설치된 launcher를 통해 전달되는지 install safety fixture로 검증한다. 병합 뒤 삭제 예정이 없는
영구 checkout에서 `install.sh`를 실행하고 다음을 확인한다.

- installed `jhw-control-host --contract`가 계속 v4다.
- current-context status의 `none|unique|ambiguous` 결과가 정본과 일치한다.
- unique/mismatch와 ambiguous 결과에 session ID와 private path가 없다.
- `/jhw:review --control`의 canonical Claude skill과 Codex wrapper/reference가 설치본에서 동기화된다.
