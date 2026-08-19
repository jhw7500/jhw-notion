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
  --repo-id <repo-id> --slug <owner/name> --repo-path <absolute-checkout-root> \
  [--allow-public true]
```

이 명령은 exact checkout root, 단 하나의 matching GitHub origin, private repository, GitHub node ID를 검증한 뒤 Repository Record를 만든다. public repository는 기본 거부(`REPOSITORY_NOT_PRIVATE`)이며, `--allow-public true`(정확한 리터럴)로만 opt-in할 수 있다 — opt-in은 Record에 영속되어 이후 task start 재검증에도 적용되고, 이때 추가 노출은 push되는 task 브랜치명과 formal Issue 내용뿐이다(Registry·Project는 여전히 private 필수). 동일 node/slug이면서 `--allow-public` 상태도 같은 재호출은 idempotent다. opt-in 상태가 달라지면 Record를 갱신하는 Registry commit이 한 건 생기되, 저장소가 여전히 public이면 무플래그 재호출은 `REPOSITORY_NOT_PRIVATE`로 실패하고 Record의 opt-in은 유지된다(소거는 private 복귀 후 무플래그 재등록에서만 일어난다). 저장소 rename 후 origin과 `--slug`가 새 이름을 가리키더라도 GitHub node ID가 같으면 Repository Record와 종속 formal Task의 Issue URL·현재 정식 alias를 한 Registry transaction에서 갱신한다. 이미 생성된 Claim·Handoff·worktree 좌표가 참조하는 이전 정식 alias는 같은 `task_id`의 호환 alias로 보존하므로 active 작업과 기존 Handoff를 계속 종료·재개할 수 있다. 다른 node 또는 전역 alias 충돌에서는 Registry를 바꾸지 않고 멈춘다.

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

Project write는 이후 read에 **즉시 보이지 않는다**. 등록은 그래서 두 곳에서 기다리되, 두 대기의 예산이 다르다.

- **부재 확인 (2·4초, 최대 6초)**: 레코드가 안 보여도 곧바로 만들지 않고 재조회한다. 직전 실행이 만든 DraftIssue가 아직 복제 중일 때 재시도가 **같은 Project ID로 두 번째 레코드를 만드는 것**이 실측된 정본 오염 경로였다. 이 창은 **조건부**다 — 아래 등록 hint가 "직전 실행이 create에 도달한 적 없다"를 확정해 주면 건너뛴다.
- **최종 검증 (2·4·8초, 최대 14초)**: 쓰기 뒤 확인이 아직 반영되지 않았으면 재조회한다. 이미 보이면 첫 읽기에서 끝나므로 정상 등록에는 비용이 0이다.

등록 hint는 `$JHW_CONTROL_STATE_DIR/project-registrations.json`(`0600`)에 남는 host-local 기록이다. create **직전**에 Project ID를, create **직후**에 `{project_item_id, source_node_id}`를 durable하게 적는다. **등록이 성공해도 지우지 않는다** — 지우면 "기록 없음"이 *만든 적 없음*과 *만들어서 검증까지 끝냄*을 구분하지 못해, 등록 직후 재실행이 대기 없이 중복을 만들 수 있다. 다음 실행은 이 기록으로 네 경우를 구분한다.

| 기록 상태 | 의미 | 동작 |
| --- | --- | --- |
| 파일 자체가 없음 (기능 도입 전 / 삭제 후) | 이 파일보다 오래된 레코드를 대변할 수 없음 | 부재 확인 창을 지불 (호스트당 최초 1회) |
| 파일은 있고 이 Project 항목만 없음 | 이 호스트가 이 레코드를 만든 적 없음 | **부재 확인 대기 0초**로 곧바로 생성 |
| 좌표 있음 | 이 호스트가 만든 레코드가 있음 (진행 중이거나 이미 완료) | `node(id:)` **단건 조회**로 확인해 재사용 |
| Project ID만 있음 / 좌표가 해결 안 됨 / 기록을 읽거나 쓸 수 없음 | 직전 실행 여부를 단정할 수 없음 | 기존 부재 확인 창을 그대로 지불 |

기록은 **authority가 아니라 힌트**다. 조회가 실패하거나, 다른 Project의 item을 가리키거나, 본문의 Project ID가 다르면 조용히 평소 경로로 떨어진다. 재사용 결정 자체는 기록이 아니라 기존 payload gate(제목·본문 exact match)와 종료 직전의 전수 검증이 내린다. 항목은 등록된 Project 수만큼만 쌓이며 상한(256)을 넘으면 기록을 **거부**한다 — 그 경우 다음 등록이 창을 지불할 뿐 레코드를 잃지는 않는다.

파일이 손상되면 읽기가 실패해 창을 지불하는 상태로 떨어진다(안전 측). **등록이 진행 중이 아닐 때에 한해** 파일을 삭제해 복구하며, 삭제 직후 첫 등록은 위 표의 첫 행대로 창을 다시 지불한다. 진행 중에 삭제하면 그 실행의 intent가 사라진다.

두 창은 합성될 수 있다. 부재 확인을 다 쓰고 만든 레코드가 다시 늦게 보이면 **최악 20초**가 걸린다. 그 사이 호스트 전역 lock을 잡고 있으므로 다른 세션의 lifecycle 명령은 `LOCK_CONTENDED`(exit 75)로 즉시 실패한다 — 일괄 등록은 한가한 시간에 한다. **중간에 끊지 않는다.**

실패 코드는 셋으로 갈린다. `PROJECT_REGISTRATION_UNSETTLED`는 쓴 값이 창 안에 정착하지 않은 것이므로 같은 승인 payload로 다시 실행한다 — 재시도는 기존 DraftIssue를 재사용한다. `PROJECT_REGISTRATION_MISMATCH`는 레코드가 **정착했는데 값이 다른** 것이므로 다시 실행하지 말고 Project 보드의 현재 상태를 먼저 확인한다(다른 writer나 수동 편집일 수 있고, 그대로 재실행하면 계속 실패한다). `DUPLICATE_PROJECT_RECORD`는 이미 중복이 생긴 상태이므로 자동 정리하지 않고 수동 해소 후 재실행한다.

잔여 위험이 남는다. 창을 타는 경우 지연이 창보다 길면 여전히 중복이 생길 수 있다. 창을 건너뛰는 판단이 틀리는 경우는 셋이다 — 기록에 **실패한** 실행이 레코드를 만든 경우, 기록 파일을 등록 진행 중에 지운 경우, 그리고 **다른 호스트**가 만든 레코드다. 앞의 둘은 state directory 쓰기 실패(`0700`/디스크)를 즉시 확인해 막고, 마지막은 기록도 호스트 전역 lock도 **한 호스트 안에서만** 성립하므로 다중 호스트 동시 등록이 이 보호 범위 밖이라는 기존 한계 그대로다. 기록 실패는 현재 별도 신호 없이 등록이 다시 느려지는 것으로만 드러난다.

등록 뒤 다섯 운영 필드만 바뀌는 경우 — 진행 중 Task가 생겨 Status와 Next Action을 올리거나, Priority·Health·Last Reviewed를 조정하는 경우 — 에는 Project Record를 다시 등록하지 않고 update를 쓴다.

```bash
jhw-control project update \
  --project <prj-id> \
  [--status <proposed|active|paused|completed|cancelled>] \
  [--priority <P0|P1|P2|P3>] [--health <on-track|at-risk|blocked|unknown>] \
  [--next-action <task:tsk-id-or-wait:condition>] [--last-reviewed <YYYY-MM-DD>]
```

다섯 운영 필드 중 최소 하나를 명시해야 하고, 생략한 필드는 현재 값 그대로 둔다. title, objective, repository 목록은 Project Record의 불변 정체성이므로 이 명령으로 바꾸지 않는다. 병합된 필드셋에 enum과 active Status의 Next Action·Health 정합을 검증한다. `task:` Next Action은 이 명령으로 **명시했을 때만** Registry Task 존재를 검증한다 — 현재 값과 같더라도 명시하면 검증하고, Next Action을 주지 않은 패치는 레코드가 이미 갖고 있던 참조 때문에 막히지 않는다. 등록이 언제나 검증하는 것과 다른 점이다. 대상 Project Record가 없거나 둘 이상이면 만들지도 고르지도 않고 멈춘다. 실제로 값이 바뀐 필드만 쓰고, 쓴 뒤에는 bounded backoff로 다시 읽어 다섯 필드와 DraftIssue 정체성이 요청과 정확히 일치할 때만 성공으로 보고한다. 쓴 값이 정착하지 않으면 `PROJECT_UPDATE_UNSETTLED`로, 다른 writer가 이겨 값이 달라졌으면 `PROJECT_UPDATE_MISMATCH`로 재작성 없이 멈춘다. 전자는 같은 플래그로 다시 실행하고, 후자는 현재 상태를 다시 읽어 확인한 뒤 판단한다. 쓰기 도중 실패하면 그 시점까지 적용된 필드는 Project에 남는다. 같은 플래그로 다시 실행하면 남은 필드만 써서 수렴하므로 재실행이 안전하다.

Status는 active로 들어갈 때 마지막에, active에서 나올 때 처음에 쓴다. 그래서 그 두 전이에서는 reader가 거부하는 상태가 생기지 않는다 — 일부 필드만 반영된 중간 상태는 여전히 관측되지만 유효하다. active인 채로 Health와 Next Action을 함께 바꾸는 재구성만 짧은 부분 적용 창이 남는다 — Project API에 다중 필드 원자 mutation이 없기 때문이다. 그 창에 겹친 `portfolio status`/`portfolio export`는 `INVALID_PROJECT_ITEM`으로 실패할 수 있고, 다시 실행하면 해소된다.

active 레코드를 재구성하다 쓰기가 중단되면 Health와 Next Action이 어긋난 채 남는다. 다섯 필드는 모두 존재하지만 `portfolio status`/`portfolio export`는 그 레코드 하나 때문에 `INVALID_PROJECT_ITEM`으로 실패한다. 이 상태는 update로 복구한다 — 유효한 조합을 만드는 패치(예: `--health on-track`)를 주면 되고, 여전히 무효인 조합은 write 없이 `INVALID_PROJECT_NEXT_ACTION`으로 거부된다.

운영 필드가 비어 있거나 Project 옵션 정의와 어긋나는 경우는 다르다. update는 write 없이 `INVALID_PROJECT_ITEM`으로 막히므로, 승인된 원래 payload로 `project register`를 다시 실행해 다섯 필드를 채운 뒤 update를 재개한다.

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

push되는 branch 이름에 Task alias가 그대로 포함되므로 temporary alias에 비밀·내부 코드네임 같은 민감 라벨을 넣지 않는다.

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

exact `pending-remove`는 이 cleanup이 재개하는 상태다. active successor, 다른 host/coordinates, dirty worktree, source checkout에 통합되지 않은 commit, `pending-create`, 또는 다른 generation의 ambiguous pending state면 stop하고 evidence를 보존한다. 자동 reset/rebase/force push, 경로 삭제, Claim 재생성으로 우회하지 않는다.

worktree 제거는 commit 개수가 아니라 **통합 여부**로 판정한다. source checkout이 branch를 체크아웃한 상태에서 그 HEAD가 worktree의 HEAD에 도달 가능하면 허용하고, 도달 불가능하거나 checkout이 detached면 `WORKTREE_UNPUSHED`로 멈춘다. detached HEAD는 통합 지점이 아니므로 신뢰하지 않는다. 제거해도 **commit은 `refs/heads/task/...` branch ref에 그대로 남아** `git worktree add <path> <branch>`로 완전 복원된다. 다만 **gitignore된 로컬 파일은 worktree와 함께 삭제된다**(`dist/`·`node_modules/` 등) — 재생성 불가능한 로컬 산출물을 worktree 안에 두지 않는다. 따라서 병합 전에 `completed`로 끝내면 worktree가 남는다. **병합을 먼저 하고 나서 종료하거나, 이미 종료했다면 병합 뒤 위 cleanup을 released Claim ID로 실행한다.** 이 판정이 도입되기 전에 완료돼 남아 있는 worktree도 같은 방법으로 정리한다.

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
