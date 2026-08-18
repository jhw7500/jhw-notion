# Project Control Phase 1A 운영 runbook

Phase 1A는 별도 private Registry와 개인 private GitHub Project를 이용하는 **명시적 trial**이다. 기존 Notion이 변경 없이 live authority다. 이 문서는 authority 전환, migration, cutover 절차가 아니다.

## 1. 경계와 사전조건

- 한 대의 Linux build server, Node.js 20, `git`, `gh`, `flock`, 설치된 `jhw-control`
- 이 저장소와 분리된 private Registry 저장소/checkout
- 등록할 private source repository의 정확한 checkout
- 개인 계정 소유 private GitHub Project와 정확히 다섯 필드: `Status`, `Priority`, `Health`, `Next Action`, `Last Reviewed`
- exact title/body의 고정 Project DraftIssue fixture와, Project에 연결하지 않는 Registry `trial` 전용 preflight Issue
- clean, fast-forward 가능한 Registry checkout과 canonical GitHub SSH remote

```bash
command -v git gh flock node jhw-control
node --version
jhw-control --help
```

build server에서 manual/on-demand로만 실행한다. Actions workflow, schedule, heartbeat, cross-host retry를 만들지 않는다.

## 2. 하나의 host identity와 credential 계약

모든 compliant process가 **같은 checkout inode와 같은 lock**을 사용하도록 아래 값을 operator 설정에 한 번 고정한다. 경로는 모두 immutable absolute path여야 한다. symlink, alternate checkout, 상대 경로, process별 state directory를 섞지 않는다.

```bash
export JHW_REGISTRY_DIR=<absolute-registry-checkout>
export JHW_REGISTRY_REMOTE=origin
export JHW_REGISTRY_BRANCH=main
export JHW_WORKTREE_ROOT=<absolute-worktree-root>
export JHW_CONTROL_STATE_DIR=<absolute-control-state-directory>
export JHW_BUILD_HOST=<fixed-build-host-id>
export JHW_GITHUB_OWNER=<personal-owner>
export JHW_PROJECT_NUMBER=<positive-number>
export JHW_REGISTRY_REPOSITORY=<owner/private-registry>
export JHW_PREFLIGHT_PROJECT_ITEM_ID=<PVTI_trial-item>
export JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER=<positive-number>
```

`JHW_REGISTRY_DIR`의 realpath/inode, `JHW_REGISTRY_REPOSITORY`, remote의 단 하나뿐인 SSH URL은 같은 Registry를 가리켜야 한다. `JHW_CONTROL_STATE_DIR`는 이 host의 모든 invocation에서 같아야 `registry.lock`이 전역 mutation lock 역할을 한다. private state/snapshot directory는 `0700`, file은 `0600`이다.

비밀은 host credential store가 **명령 process에만** 주입한다. `.env`, shell history, argument, Git/Handoff, journal, snapshot, report, AI context에 넣지 않는다.

- `GH_PROJECT_TOKEN`: 짧게 만료되는 별도 classic PAT. 정규화된 scope가 정확히 `project` 하나여야 한다. `repo`, `workflow`, `gist`, `user`, admin 계열 등 추가 scope는 금지한다.
- `GH_REPO_TOKEN`: Registry와 등록 대상 source repository만 선택한 별도 repository credential. Registry Issue read/write 및 source repository metadata/Issue read에 필요한 최소 권한만 준다. source Issue 검증과 Repository 등록에도 쓰이므로 “Registry 한 저장소만”으로 잘못 제한하지 않는다.
- 두 token은 서로 달라야 한다. Registry Git fetch/push는 canonical SSH remote의 host credential을 사용한다.

## 3. committed authority — epoch 1 / legacy

다음은 **별도 Registry operator 작업 예시**다. 이 `jhw-notion` 저장소에 authority file을 만들지 않는다.

```bash
cd "$JHW_REGISTRY_DIR"
mkdir -p governance
cat > governance/authority.yaml <<'JSON'
{
  "authority_epoch": 1,
  "mode": "legacy",
  "cutover_at": null,
  "minimum_tool_version": "1.0.0"
}
JSON
git add governance/authority.yaml
git commit -m "governance: initialize legacy authority"
git push origin HEAD:main
```

파일은 regular HEAD blob이어야 한다. installed `jhw-control` version은 `minimum_tool_version` 이상이어야 하며 관찰한 epoch를 되돌릴 수 없다. Phase 1A 동안 `mode`를 `registry`로 바꾸거나 `cutover_at`을 설정하지 않는다. local cache와 `JHW_NOTION_WRITES_DISABLED`는 권한을 더 제한할 수만 있고 authority를 선택하지 않는다.

## 4. live preflight와 stable outcome

credential을 주입한 동일 host shell에서 매 운영 시작 전에 실행한다.

```bash
jhw-control preflight
rc=$?
```

성공은 `status: ready`와 아래 **일곱 check**가 모두 `ok`인 경우뿐이다.

1. `credentials` — token 분리와 Project token exact scope
2. `authority` — committed regular HEAD authority, epoch/legacy/no-cutover/minimum version
3. `notion_guard` — database/data-source ancestry를 포함한 read-only Notion route 검증
4. `project` — private Project, 정확한 필드, 고정 canonical DraftIssue fixture identity/content와 field write/restore
5. `registry_repository` — configured Registry GitHub repository가 private
6. `registry_issue` — 지정 trial Issue identity/label/unchanged write
7. `registry_git` — 정확히 하나인 matching SSH remote, fetch, dry-run push

Authority/Notion/repository prerequisite가 먼저 통과한 뒤에만 두 preflight fixture를 건드린다. Project fixture는 exact title `[TRIAL] Project Control Preflight Fixture`, body `unchanged`인 고정 DraftIssue여야 하고 field는 원래 값으로 복구된다. Registry Issue는 Project에 붙이지 않는 독립 fixture이며 body가 byte-identical해야 한다. 실패를 cached 결과로 덮지 않는다.

| Exit | 의미와 조치 |
|---:|---|
| `0` | command가 성공했다. `journal_warning.code=JOURNAL_WRITE_FAILED`가 있어도 authoritative mutation은 이미 성공했으므로 **재시도하지 말고 measurement gap만 기록**한다. |
| `2` | command/flag/ID가 잘못됐다. 인자만 수정한다. |
| `4` | Claim conflict/mismatch/not found. immutable Claim 좌표를 다시 확인하고 자동 takeover하지 않는다. |
| `75` | host lock contention/acquisition timeout 또는 Registry dirty/diverged/remote verification 실패. stop; rebase/reset/force/retry로 우회하지 않는다. Lock helper spawn/setup/acquire 실패는 일반 command에서 `1`이고 preflight NO-GO에서는 `78`이다. |
| `78` | authority/version/Notion guard/credential/scope/privacy/remote/preflight timeout NO-GO. operator가 원인을 수정한 뒤 live preflight부터 다시 실행한다. |
| `1` | integrity, sensitive-data, worktree/snapshot/Handoff 등 fail-closed 오류. artifact와 stable `error.code`를 감사하고 복구한다. |

실패 command에서 journal append도 실패하면 원래 nonzero exit와 원래 `error.code`가 유지되고 `journal_warning`만 추가된다. raw stderr, token, private path를 복사하지 않는다.

### 기존 Issue-backed Project fixture 전환

구 구현으로 만든 Issue-backed Project item이 있으면 새 reader는 이를 Project Record로 무시하지 않고 fail-closed한다. 전환은 자동 migration이나 authority cutover가 아니라 승인된 trial fixture 정리이며 다음 순서를 지킨다.

1. 기존 Project item ID와 Registry Issue 번호를 비공개 operator evidence로 보존한다. token이나 private path는 기록하지 않는다.
2. exact `project` scope credential로 title `[TRIAL] Project Control Preflight Fixture`, body `unchanged`인 DraftIssue를 생성하고 반환된 DraftIssue/item identity와 내용을 다시 읽어 검증한다.
3. `JHW_PREFLIGHT_PROJECT_ITEM_ID`를 새 DraftIssue item ID로 갱신하고 설정 파일 mode를 유지한다.
4. Project에서 **구 Issue-backed attachment만** 제거한다. Registry preflight Issue 자체와 그 body/label은 삭제·변경하지 않는다.
5. 새 `jhw-control preflight`가 `ready`인지 확인한 뒤 `jhw-control portfolio status`로 전용 Project에 fixed fixture 외 non-DraftIssue/null content가 없음을 증명한다.

어느 단계든 identity/content/field restore가 불명확하거나 명령이 실패하면 즉시 중단한다. Notion, authority file/cache, Registry Issue, Registry Git record를 수정해 우회하지 않으며 자동 rollback·재생성·scope 확장을 시도하지 않는다.

### Registry dirty/ahead fail-stop 진단

exit `75`에서 자동 retry하지 말고 동일 canonical checkout과 remote identity를 먼저 read-only로 진단한다.

```bash
git -C "$JHW_REGISTRY_DIR" status --short --branch
git -C "$JHW_REGISTRY_DIR" remote get-url --all "$JHW_REGISTRY_REMOTE"
git -C "$JHW_REGISTRY_DIR" rev-parse HEAD
git -C "$JHW_REGISTRY_DIR" ls-remote --heads \
  "$JHW_REGISTRY_REMOTE" "refs/heads/$JHW_REGISTRY_BRANCH"
```

unique matching SSH remote가 맞다고 operator가 확인한 뒤에만 remote-tracking ref를 갱신하고 좌우 count/diff를 진단한다. `fetch`는 checkout/remote authority content를 바꾸지 않지만 local Git metadata를 갱신하므로 이 명시적 진단 단계에서만 수행한다.

```bash
git -C "$JHW_REGISTRY_DIR" fetch "$JHW_REGISTRY_REMOTE" "$JHW_REGISTRY_BRANCH"
git -C "$JHW_REGISTRY_DIR" rev-list --left-right --count \
  "HEAD...$JHW_REGISTRY_REMOTE/$JHW_REGISTRY_BRANCH"
git -C "$JHW_REGISTRY_DIR" diff --name-status \
  "$JHW_REGISTRY_REMOTE/$JHW_REGISTRY_BRANCH...HEAD"
```

dirty/ahead/diverged content의 의도와 소유 workflow를 operator가 확인하기 전에는 수정·push·다음 control command를 수행하지 않는다. clean behind-only checkout만 `git -C "$JHW_REGISTRY_DIR" merge --ff-only "$JHW_REGISTRY_REMOTE/$JHW_REGISTRY_BRANCH"`로 전진할 수 있다. ahead commit은 승인된 Registry owner recovery가 content/record 불변식을 감사한 뒤에만 non-forced push로 완결한다. dirty 또는 diverged checkout은 증거를 보존하고 별도 governance review로 복구한다. `reset`, `rebase`, `push --force`, 임의 `stash`, alternate checkout, Registry record 손편집으로 우회하지 않는다.

복구 완료 조건은 `git status --porcelain` 빈 output과 `rev-list`의 `0 0`, unique matching SSH remote다. 이 조건을 만족한 뒤 `jhw-control preflight`를 다시 실행하고 `ready`일 때만 중단된 operator flow를 **새로 명시해** 재개한다.

## 5. Repository와 Project bootstrap

실제 active Project 2–3개만 고른다. synthetic/과거 전체 등록은 하지 않는다. Registry record를 손편집하지 않는다.

각 source checkout마다 operator가 승인한 canonical `repo-...` ID를 사용해 한 번 실행한다.

```bash
jhw-control repository register \
  --repo-id <repo-id> --slug <owner/name> --repo-path <absolute-checkout-root>
```

이 명령은 exact checkout root, 단 하나의 matching GitHub origin, private repository, GitHub node ID를 검증한 뒤 Repository Record를 만든다. 동일 node/slug 재호출은 idempotent다. 저장소 rename 후 origin과 `--slug`가 새 이름을 가리키더라도 GitHub node ID가 같으면 Repository Record와 종속 formal Task의 Issue URL·현재 정식 alias를 한 Registry transaction에서 갱신한다. 이미 생성된 Claim·Handoff·worktree 좌표가 참조하는 이전 정식 alias는 같은 `task_id`의 호환 alias로 보존하므로 active 작업과 기존 Handoff를 계속 종료·재개할 수 있다. 다른 node 또는 전역 alias 충돌에서는 Registry를 바꾸지 않고 멈춘다.

그 다음 `/jhw:project --trial`에서 Project ID, title, objective, repository ID 목록, 다섯 운영 필드를 하나의 제안으로 보고 한 번 승인한다.

```bash
jhw-control project register \
  --project <prj-id> --title <title> --objective <objective> \
  --repo-id <repo-id> [--repo-id <repo-id> ...] \
  --status <proposed|active|paused|completed|cancelled> \
  --priority <P0|P1|P2|P3> --health <on-track|at-risk|blocked|unknown> \
  --next-action <task:tsk-id-or-wait:condition> --last-reviewed <YYYY-MM-DD>
```

Project Record는 개인 비공개 GitHub Project의 DraftIssue 한 건이다. DraftIssue 제목과 exact `{id, objective, repositories}` 본문, 같은 item의 다섯 운영 필드를 Project-only token으로 생성·검증한다. 부분 실패 시 **같은 승인 payload와 정확히 하나인 같은 DraftIssue만** 재사용한다. 중복 Project ID/source/item, 다른 title/body, field mismatch, Issue/null content는 corruption으로 중단한다. Registry Issue를 만들거나 Project Record와 결합하지 않는다.

## 6. 기존 Notion baseline 5회

첫 trial Task 전에 기존 `/jhw:status`·`/jhw:recall` 방식으로 실제 lookup 5회를 측정한다. 매번 현재 상태, 다음 행동, 차단 원인, 재개 지점의 같은 네 질문을 사용한다. project/query, 시작·종료 시각, elapsed seconds, 답변 가능 여부만 비밀 없는 operator scorecard에 기록한다. Project Control이 Notion이나 과거 session을 자동 로드하게 만들지 않는다.

## 7. 자연 Task cycle

실제 업무가 생길 때만 `/jhw:task`를 명시적으로 사용해 **정확히 세 번의 자연 Task cycle**을 관찰한다. 숫자를 채우는 synthetic Task/Handoff를 만들지 않는다. 세 cycle이 아직 자연스럽게 발생하지 않았으면 evidence는 `insufficient evidence`다.

### 새 formal Issue

Issue node ID와 revision은 서버가 current GitHub Issue에서 도출한다. independently verified expectation이 있을 때만 optional expectation flag를 쓴다.

```bash
jhw-control task start \
  --project <prj-id> --repo-id <repo-id> --repo-path <absolute-checkout-root> \
  --issue-url https://github.com/<owner>/<repo>/issues/<number> --session <session-id>
```

### 새 temporary Task

```bash
jhw-control task start \
  --project <prj-id> --repo-id <repo-id> --repo-path <absolute-checkout-root> \
  --temp-alias <alias> --goal <goal> \
  --done <condition> [--done <condition> ...] \
  --scope <scope> [--scope <scope> ...] --session <session-id>
```

### 기존 Task 재개

Project/repository/source registration flag를 다시 주지 않는다. 같은 Task ID를 검증하고 새 Claim generation을 만든다. 성공 output에 latest bounded Handoff가 있으면 그것만 명시적 재개 context로 사용한다.

```bash
jhw-control task start \
  --task <tsk-id> --repo-path <absolute-checkout-root> --session <session-id>
```

재개 전에 cleanup이 남아 있으면 `WORKTREE_CLEANUP_REQUIRED`로 멈춘다. start가 이를 자동 reconcile하거나 새 Claim을 만들지 않는다.

### status와 on-demand Handoff

```bash
jhw-control task status --task <tsk-id> [--claim <active-claim-id>]
jhw-control task handoff --task <tsk-id> [--claim <released-handoff-claim-id>]
```

`task handoff`는 exact Claim 또는 unambiguous latest Handoff history가 가리키는 regular HEAD blob 하나만 읽는다. output은 12 KiB fixed schema다. 다른 history/session을 자동 확장하지 않는다.

### temporary → formal promotion

Task ID를 보존한 채 verified Issue authority로 승격한다.

```bash
jhw-control task promote --task <tsk-id> \
  --repo-path <absolute-checkout-root> \
  --issue-url https://github.com/<owner>/<repo>/issues/<number>
```

### finish

모든 finish에는 validation이 1개 이상 필요하다. completed에는 outcome도 필요하다. Claim acquisition 때 frozen된 `source_task_revision`이 Handoff에 사용되므로 caller가 새 revision을 만들지 않는다. optional `--source-task-revision`을 주면 frozen 값과 exact match해야 한다.

```bash
jhw-control task finish --task <tsk-id> --claim <current-claim-id> \
  --status completed --outcome <result> \
  --validation <evidence> [--validation <evidence> ...] \
  [--active-work-minutes <positive-number>]

jhw-control task finish --task <tsk-id> --claim <current-claim-id> \
  --status handoff --validation <evidence> \
  [--progress <text>] [--failures <text>] [--next-step <text>] \
  [--related-adr-and-evidence <text>] [--active-work-minutes <positive-number>]
```

`handoff`는 durable Registry copy/history를 만들고 same-host worktree를 유지한다. `completed|abandoned` release 후 local cleanup 실패는 Claim을 되살리지 않는다. exact released Claim cleanup으로 복구한다.

Formal Task에서 `--status completed`는 **그 Claim generation의 결과를 archive하고 release할 뿐** GitHub Issue를 닫거나 Task lifecycle을 완료하지 않는다. Formal lifecycle authority는 GitHub Issue의 open/closed 상태다. Issue가 open이거나 다시 열렸다면 같은 Task ID를 검증해 새 Claim으로 재개할 수 있고, terminal 종료가 필요하면 Issue authority에서 별도로 close한다.

### raw Git 공유 경계

push/PR/merge/deploy 직전에 실행한다.

```bash
jhw-control task assert-owner --task <tsk-id> --claim <current-claim-id>
```

**중요:** 이 확인은 raw Git 명령을 통합 enforcement하지 않는 advisory check라서 확인 직후 승인된 takeover와 race할 수 있다. push/PR 안전을 보장하는 wrapper가 아니다. 실패하거나 owner가 바뀌면 공유 동작을 중단한다.

## 8. recovery와 dirty/ahead fail-stop

활성 Claim 상태를 먼저 읽는다.

```bash
jhw-control task recover --task <tsk-id> --expect <active-claim-id> --action status
```

stale을 자동 추정하지 않는다. `force-end` 또는 `takeover`는 결과와 대상 Claim을 보여준 뒤 실행 직전에 별도 승인을 받는다.

```bash
jhw-control task recover --task <tsk-id> --expect <active-claim-id> --action force-end
jhw-control task recover --task <tsk-id> --expect <active-claim-id> --action takeover --session <new-session-id>
```

Takeover 성공 후 반환된 **새 Claim ID**로 status를 다시 확인한다. old ID를 재사용하지 않는다. force-end temporary lifecycle은 `handoff`로 남아 명시적 재개가 가능하다.

이미 release됐지만 worktree cleanup이 남은 exact generation은 다음만 사용한다.

```bash
jhw-control task recover --task <tsk-id> --expect <released-claim-id> --action cleanup
```

exact `pending-remove`는 이 cleanup이 재개하는 상태다. active successor, 다른 host/coordinates, dirty/ahead, `pending-create`, 또는 다른 generation의 ambiguous pending state면 stop하고 evidence를 보존한다. 자동 reset/rebase/force push, 경로 삭제, Claim 재생성으로 우회하지 않는다.

## 9. audit와 즉시 중단 조건

자연 cycle 뒤 다음을 대조한다.

- Registry `repositories/`, `projects/`, `tasks/`, `claims/active/`, `claims/history/`, `handoffs/`
- `${JHW_CONTROL_STATE_DIR}/pilot-journal.jsonl`의 command, task/claim ID, timestamps, elapsed, ok/error, payload bytes, active-work minutes, measurement gap
- branch/head, Project field, Handoff pointer와 worktree cleanup generation
- portfolio/status/Handoff 12 KiB 및 status 20-item/page 경계

다음이면 즉시 NO-GO다: 중복 active Claim/Project item, wrong owner release/share, Notion guard 우회, secret/private path 노출, authority rollback/flip, Registry remote mismatch/divergence, fixture restore 실패, 반복되는 manual bypass. 해결 전 추가 cycle/export/registration을 하지 않는다.

## 10. evidence와 Phase 1B 경계

로컬 test/build/e2e/preflight fixture 구현 완료는 pilot evidence가 아니다. 실제 업무에서 정확히 세 자연 cycle이 아직 발생하지 않았으면 상태는 `insufficient evidence`다. 이 문서나 테스트를 근거로 synthetic cycle/Handoff를 만들거나 live preflight 결과를 꾸미지 않는다.

자연 evidence가 생겨도 Phase 1B, daily schedule, cross-host retry, Notion reconciliation/migration, `legacy → registry` cutover는 별도 승인 계획이 필요하다. 그 전에는 Notion이 live authority이고 Registry는 trial control data다.
