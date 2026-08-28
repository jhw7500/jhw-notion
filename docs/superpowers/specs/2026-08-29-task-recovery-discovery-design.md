# Task 복구 발견 UX 설계

- 날짜: 2026-08-29
- 대상: `jhw7500/jhw-notion#86`
- 상태: 사용자 승인

## 목표

새 세션이 현재 checkout과 canonical GitHub Issue URL만으로 기존 formal Task와 현재 Claim 상태를
읽기 전용으로 찾게 한다. inactive Task는 저장된 Work Contract 그대로 재개하고, active Claim은
소유권을 자동 승계하지 않은 채 exact recovery 좌표와 관측 상태를 보여준다.

현재 `jhw-control-host`의 exact v4 command 계약은 유지한다. 새 command나 launcher 버전을 만들지
않고 기존 `task recover --action status`에 checkout 기반 발견 모드를 추가한다.

## 비목표

- 세션 종료나 Claim stale 여부를 추정하지 않는다.
- 발견 중 Task 등록, Issue revision 갱신, contract migration, takeover, force-end를 실행하지 않는다.
- takeover와 force-end의 별도 실행 직전 사용자 승인을 없애지 않는다.
- temporary/child Task를 Issue URL로 역추적하거나 checkout 밖에서 Task를 검색하지 않는다.
- Registry 파일, session history, Notion 또는 로컬 Handoff 파일을 discovery authority로 사용하지 않는다.

## 공개 명령 계약

기존 exact-coordinate recovery는 그대로 유지한다.

```bash
"$HOME/.local/bin/jhw-control-host" task recover \
  --task <tsk-id> --expect <claim-id> --action status
```

신규 발견 모드는 다음 한 형태만 허용한다.

```bash
"$HOME/.local/bin/jhw-control-host" task recover \
  --action status \
  --resolve-from-checkout true \
  --repo-path <absolute-exact-checkout-root> \
  --issue-url https://github.com/<owner>/<repo>/issues/<number>
```

발견 모드는 `--resolve-from-checkout true`, `--repo-path`, `--issue-url` 세 필드를 모두 요구한다.
`--task`, `--expect`, `--session`, `--origin-adapter` 또는 mutation action과 섞으면 source 조회 전에
`INVALID_CLI_ARGUMENT`로 끝난다. exact-coordinate mode는 반대로 발견 필드를 받지 않는다.

`task recover --action status`는 현재 launcher가 이미 허용하고 preflight/mutation lock 없이
전달하는 읽기 전용 v4 surface다. 따라서 `install.sh`의 host contract와 `claude-config` producer는
변경하지 않는다.

## 결과 계약

발견 성공 결과는 두 상태만 갖는다.

inactive 예시:

```json
{
  "kind": "resolved",
  "task_id": "tsk-...",
  "state": "inactive",
  "handoff": {
    "available": false
  }
}
```

exact latest Claim generation이 canonical Handoff를 가진 경우에만 `handoff.available`이 `true`이고,
기존 12 KiB bounded Handoff의 `claim_id`, `handoff_pointer`, `generated_at`, `sections`, `truncated`를
같이 반환한다. Claim history가 없거나 latest generation이 completed, abandoned, create-failed 또는
force-ended이면 `available: false`를 명시한다. 과거 generation의 Handoff를 대신 반환하지 않는다.

active 예시:

```json
{
  "kind": "resolved",
  "task_id": "tsk-...",
  "state": "active",
  "claim": {
    "task_id": "tsk-...",
    "claim_id": "clm-...",
    "host": "build-host",
    "branch": "task/...",
    "worktree_ref": "wt-...",
    "started_at": "2026-08-29T00:00:00.000Z"
  },
  "recovery": {
    "process_exists": false,
    "worktree_mapped": true,
    "dirty": false,
    "ahead": 0
  }
}
```

`claim`은 기존 `ConflictingClaimSummarySchema`의 여섯 필드만 사용한다. `session_id`, absolute path,
Project/Repository 내부 좌표, Work Contract 내용, token과 raw 오류 메시지는 내보내지 않는다.
`process_exists: false`도 관측 사실일 뿐 stale 또는 takeover 허가로 해석하지 않는다.

## 읽기 경계와 데이터 흐름

1. CLI가 두 coordinate mode를 완전 배타적으로 검증한다.
2. `GitHubSourceService`가 absolute exact checkout root, 단 하나의 canonical origin, live Repository
   identity와 canonical Issue URL/node identity를 검증한다. Issue가 checkout Repository와 다르면
   source index를 읽지 않는다.
3. Catalog의 새 읽기 전용 source lookup이 Registry readiness를 확인한다. dirty/diverged Registry는
   여기서 실패하고, clean committed view에서 Issue node source index와 formal Task를 찾는다.
4. Task의 `project_id`, `repo_id`, `issue_node_id`, canonical Issue URL이 verified checkout context와
   모두 일치해야 한다. lookup은 `registerFormalTask`나 `prepareExistingTask`를 호출하지 않으므로
   Task record와 Issue revision을 갱신하지 않는다.
5. 같은 pinned Registry view 안에서 active Claim을 읽는다. active이면 existing recovery-status
   inspection을 실행하고, inactive이면 exact latest Claim history만 조회한다.
6. Handoff가 필요한 경우 exact latest history의 Claim ID로 기존 bounded Handoff loader를 호출한다.
   마지막 fence 전에 Registry HEAD가 움직이면 `REGISTRY_MOVED_DURING_READ`로 결과를 폐기한다.

새 subsystem이나 새 command file은 만들지 않는다. 기존 `catalog.ts`, `github-source.ts`,
`task-service.ts`, `cli.ts`의 책임에 각각 source lookup, verified resolution, recovery snapshot, CLI
projection을 추가한다.

## 재개와 복구 흐름

### Inactive Task

발견 결과의 canonical `task_id`로 registration field 없이 기존 resume을 실행한다.

```bash
"$HOME/.local/bin/jhw-control-host" task start \
  --task <resolved-tsk-id> --repo-path <same-checkout-root> \
  --origin-adapter <adapter> --session <new-session-id>
```

이 경로는 저장된 Work Contract를 그대로 사용한다. resume start도 exact latest Claim generation만
Handoff 후보로 삼도록 바꾼다. 따라서 force-end 뒤 더 오래된 Handoff가 `latest_handoff`로 다시
나타나지 않는다.

### Active Claim

발견 결과를 먼저 사용자에게 보여주고 멈춘다. 자동 status 반복, takeover, force-end 또는 Registry
수정은 없다. 사용자가 실행 직전에 별도 승인한 뒤에만 발견된 exact Task/Claim 좌표로 기존 recovery
명령을 호출한다.

Takeover 성공 시 반환된 새 Claim ID로 `task status`를 다시 실행한다. force-end 뒤 재개하려면 먼저
발견 status를 다시 확인해 inactive와 `handoff.available: false`를 확인하고, 별도 resume start를
실행한다.

## 오류와 안내

- source index가 없으면 `TASK_NOT_FOUND`; 새 Task를 자동 등록하지 않는다.
- checkout/root/origin/repository/Issue/Project association 불일치는 기존 stable source 오류를 유지한다.
- duplicate source index, record mismatch, malformed history/Handoff는 `REGISTRY_CORRUPT`로 끝낸다.
- dirty, diverged, moved Registry는 각각 기존 `REGISTRY_DIRTY`, `REMOTE_DIVERGED`,
  `REGISTRY_MOVED_DURING_READ` 경계를 유지하며 자동 retry하지 않는다.
- `TASK_CONTRACT_MISMATCH` 안내는 같은 checkout과 Issue URL로 발견 status를 실행한 뒤, inactive면
  registration field 없이 `task start --task`를 사용하라고 명시한다. 계약 변경은 기존 inactive
  `task contract` 절차로 분리한다.
- `TASK_ALREADY_CLAIMED` 안내는 bounded conflict 좌표로 exact recovery status를 확인하고 멈춘다.
  takeover/force-end는 계속 별도 승인이 필요하다.

새 `reason` 식별자는 추가하지 않는다. 필요한 조치 분기는 result의 `active|inactive`와
`handoff.available` discriminant로 표현한다.

## 테스트

- Catalog/source unit: 정상 lookup, 미등록 source, cross-repository Issue, Project ambiguity, source
  mismatch, dirty/corrupt/moved Registry가 모두 mutation 없이 종료되는지 검증한다.
- CLI unit: 두 coordinate mode의 배타성, discovery가 status에서만 허용되는지, active/inactive 결과
  shape와 12 KiB 경계를 검증한다.
- Privacy unit: active 결과가 Claim 여섯 필드만 포함하고 session ID, absolute path, raw message를
  포함하지 않는지 검증한다.
- Task service unit: exact latest handoff만 반환하고, newer force-ended generation 뒤 older Handoff를
  반환하지 않는지 검증한다.
- E2E: 정상 handoff → inactive 발견 → resume, active Claim의 비정상 세션 종료 관측, 승인된 takeover
  → 새 Claim ID → status 재검증, force-end → inactive 발견 → Handoff 명시적 부재를 검증한다.
- Skill contract: `TASK_CONTRACT_MISMATCH`와 `TASK_ALREADY_CLAIMED` 안내가 discovery/status를 거쳐
  자동 takeover 없이 멈추는지 고정한다.

최종 게이트는 `npm run typecheck`, `npm run build`, `npm test`, Codex skill sync check,
Task skill contract test와 install safety test다.

## 문서와 배포

정본 `skills/claude/task.md`에 발견, inactive resume, active 승인 경계를 추가하고 Codex 생성물은 sync
script로만 갱신한다. README와 Phase 1A runbook의 public recovery 예시를 같은 명령으로 맞춘다.

host contract v4와 `install.sh`의 exact command 목록은 변경하지 않는다. merge 뒤 삭제 예정이 없는
영구 checkout에서 기존 설치 절차를 실행하고, 설치된 `jhw-control-host --contract`가 계속 v4인지와
신규 recovery status 결과의 privacy boundary를 검증한다.
