# Project Control Phase 1A 운영 runbook

Phase 1A는 별도 Registry checkout과 개인 GitHub Project를 이용한 **명시적 dry-run**이다. 기존 Notion은 변경 없이 현재 live authority이며, 이 문서는 authority 전환이나 데이터 migration 절차가 아니다. 아래 10개 절을 순서대로 수행한다.

## 1. 사전조건

- 한 대의 build server(Linux)와 `git`, GitHub CLI `gh`, `flock`
- Node.js 20과 이 저장소에서 빌드된 `jhw-control`
- 이 저장소와 **분리된** 비공개 `project-registry` GitHub 저장소 및 build server checkout
- 개인 계정 소유의 비공개 trial GitHub Project, 정확히 다섯 필드: `Status`, `Priority`, `Health`, `Next Action`, `Last Reviewed`
- Registry의 `trial` 전용 preflight Issue 및 그 Issue를 가리키는 Project item
- SSH Registry remote와 fast-forward 가능한 깨끗한 Registry checkout

설치 후 확인:

```bash
command -v git gh flock node jhw-control
node --version                    # v20.x
jhw-control --help
```

Phase 1A는 build server에서 수동·on-demand로만 운용한다. GitHub Actions workflow를 만들지 않고 Actions minutes에 의존하지 않으며 schedule도 두지 않는다.

## 2. 비밀이 아닌 설정과 host credential 주입

비밀이 아닌 좌표를 build server의 operator 전용 설정에서 주입한다. 예시는 경로이며 값은 실제 환경에 맞춘다.

```bash
export JHW_REGISTRY_DIR=/srv/jhw/project-registry
export JHW_REGISTRY_REMOTE=origin
export JHW_REGISTRY_BRANCH=main
export JHW_WORKTREE_ROOT=/srv/jhw/worktrees
export JHW_BUILD_HOST=cantopsbuildserver
export JHW_GITHUB_OWNER=<personal-owner>
export JHW_PROJECT_NUMBER=<positive-number>
export JHW_REGISTRY_REPOSITORY=<owner/private-registry>
export JHW_PREFLIGHT_PROJECT_ITEM_ID=<PVTI_trial-item>
export JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER=<positive-number>
export JHW_CONTROL_STATE_DIR="$HOME/.local/state/jhw-control"
```

`JHW_REGISTRY_DIR`, `JHW_WORKTREE_ROOT`, `JHW_CONTROL_STATE_DIR`는 absolute local path다. state/snapshot 디렉터리는 `0700`, 파일은 `0600`으로 유지한다.

비밀 `GH_PROJECT_TOKEN`과 `GH_REPO_TOKEN`은 build server의 credential store/keyring이 **해당 프로세스에만** 주입한다. `.env`, shell history, 명령 인자/출력, snapshot, Git/Handoff, 로그, AI context에 넣지 않는다.

- Project token: 개인 Project 제한 때문에 짧게 만료되는 별도 classic PAT, 필요한 `project` scope만 사용하고 `repo` scope는 금지한다.
- Registry token: 가능한 경우 Registry 한 저장소만 선택한 별도 fine-grained PAT.
- 두 토큰을 재사용하거나 자동으로 scope를 넓히지 않는다. 개인 Project classic PAT는 특정 Project 하나로 제한되지 않아 blast radius가 더 크다.

## 3. Registry authority를 epoch 1 / legacy로 초기화

이 단계는 **별도 Registry checkout**의 operator 예시다. 이 `jhw-notion` 저장소에 `governance/authority.yaml`을 만들지 않는다.

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

다시 읽어 epoch 1 / `legacy`임을 확인한다. Phase 1A 동안 이 값을 `registry`로 바꾸지 않는다. 중앙 파일만 authority를 선택하며 local cache나 `JHW_NOTION_WRITES_DISABLED`는 쓰기를 더 제한할 수 있을 뿐 authority를 전환할 수 없다.

## 4. live preflight와 stable exit 해석

credential store가 두 토큰을 주입한 동일 host shell에서 실행한다.

```bash
jhw-control preflight
rc=$?
```

성공 결과는 `status: ready`와 credentials/project/registry_issue/registry_git 네 `ok` check다. **live preflight가 매 운영 시작의 go/no-go**다. 실패를 cached 결과로 덮지 않는다.

| Exit | 의미 | 조치 |
|---:|---|---|
| `0` | 성공 | 다음 단계 진행 |
| `2` | 잘못된 command/flag/ID | 인자만 수정; 실행된 것으로 계산하지 않음 |
| `4` | Claim conflict/mismatch/not found | owner와 immutable Claim을 다시 확인; 자동 takeover 금지 |
| `75` | host lock 또는 Registry remote divergence | 중단; rebase/retry/force 금지 |
| `78` | authority, credential, Project/Registry policy 불가 | **NO-GO**; credential/scope/config/policy를 operator가 수정한 뒤 live preflight 재실행 |
| `1` | 예기치 않은 오류, corrupt state, journal/snapshot/preflight restore 실패 등 | 변경을 신뢰하지 말고 중단·감사·복구 |

stderr의 안정적 JSON `error.code`를 함께 기록하되 token이나 raw 환경은 복사하지 않는다.

## 5. 2–3개 active trial Project와 Repository Record 등록

실제로 현재 진행 중인 프로젝트 중 **2–3개만** 선정한다. synthetic work나 과거 전체를 등록하지 않는다.

1. Registry에서 각 GitHub Repository node ID와 slug에 대해 canonical `repo-...`를 정하고 기존 operator 관리 경로로 `repositories/<repo_id>.yaml` 및 `repositories/by-source/github/<source-key>.yaml`을 검증·등록한다. 현재 public CLI에는 repository-register 명령이 없으므로 AI가 ID를 추측하거나 새 명령을 만들면 안 된다. 정본 파일을 ad-hoc로 손편집하는 절차가 아니며, Repository Record가 준비되지 않았으면 trial Project 등록을 멈춘다.
2. `/jhw:project --trial`로 각 프로젝트의 `project_id`, title, objective, repository IDs, 다섯 운영 필드를 한 통합 제안으로 확인하고 한 번 승인한다.
3. skill이 전체 인자를 한 번 전달한다:

```bash
jhw-control project register \
  --project <prj-id> --title <title> --objective <objective> \
  --repo-id <repo-id> [--repo-id <repo-id> ...] \
  --status active --priority <P0-P3> --health <health> \
  --next-action <task:tsk-id-or-wait:condition> --last-reviewed <YYYY-MM-DD>
```

registration JSON 파일을 만들거나 읽지 않는다. 기존 canonical repo/task ID는 반드시 Registry의 값만 쓴다.

## 6. 기존 Notion baseline lookup 5회

trial Task를 시작하기 **전에** 기존 `/jhw:status`·`/jhw:recall` 방식으로 실제 프로젝트 표본 5회를 측정한다. 매회 같은 네 질문을 답한다.

1. 현재 상태는 무엇인가?
2. 다음 행동은 무엇인가?
3. 차단 원인은 무엇인가?
4. 어디서 재개해야 하는가?

표본별 project/query, 시작·종료 시각, elapsed lookup seconds, 답변 가능 여부를 비밀 없는 operator scorecard에 기록한다. 이 baseline 측정은 Notion 데이터를 이동·수정하지 않는다. Project Control 명령이 이전 세션이나 Notion을 자동 주입하게 만들지 않는다.

## 7. 정확히 세 번의 자연 Task cycle

도구 설치 완료와 pilot evidence는 다르다. 실제 업무가 발생할 때만 `/jhw:task`로 **정확히 세 cycle**을 수행한다. 숫자를 채우기 위한 Task를 만들지 않는다.

각 cycle:

1. 명시적 Issue 또는 temporary work 요청으로 `task start` 한 번; 반환된 immutable `task_id`, `claim_id`, branch/worktree를 기록한다.
2. 재개 시에는 먼저 `task status`; 충돌을 자동 해제하지 않는다.
3. 공유 push/PR/merge/deploy 직전에 `task assert-owner`를 각각 실행한다.
4. 실제 검증과 결과를 포함해 `task finish` 한 번. 종료 때 실제 active-work minutes 근사치를 `--active-work-minutes`로 기록한다.
5. recovery가 필요하면 먼저 `recover --action status`; `force-end`/`takeover` 직전에 사용자 승인을 받으며 takeover의 새 `claim_id`만 사용한다.

세 자연 cycle이 아직 발생하지 않았으면 evidence 상태는 **`insufficient evidence`**다. tooling completion을 pilot 성공으로 보고하지 않는다.

## 8. Claim history, bypass, 관리 시간, payload 감사

세 cycle 뒤 다음을 대조한다.

- Registry `claims/active/`, `claims/history/<YYYY>/<task_id>/`, `tasks/`, `handoffs/`에서 Claim 구간, owner, takeover 관계, 결과와 branch head
- `${JHW_CONTROL_STATE_DIR}/pilot-journal.jsonl`의 command, task/claim ID, timestamps, `elapsed_ms`, `ok/error_code`, `bypass_reason`, `payload_bytes`, `active_work_minutes`
- 모든 bypass는 빈 값으로 숨기지 말고 별도 operator 기록에 사유를 명시한다. CLI journal이 자동으로 채우지 못한 수동 bypass도 포함한다.
- admin time = start + finish + Handoff 작성 stopwatch 합계; active work 대비 비율도 계산한다.
- portfolio/status/Handoff payload가 12 KiB/20 item 경계를 지켰고 truncated 결과에 `next_page_id`가 있었는지 확인한다.

portfolio 전체가 필요할 때만 사용자가 다음 페이지를 명시적으로 요청한다. export는 on-demand 단방향이며 import나 역동기화가 없다.

## 9. 즉시 중단 조건

다음 중 하나라도 발생하면 추가 cycle, 등록, export, cutover를 중단하고 증거를 보존한다.

- 동일 Task의 중복/겹치는 성공 Claim
- 잘못된 owner 또는 `claim_id`가 release/push/PR/merge/deploy에 성공
- Notion authority guard 우회 또는 legacy/registry 권한 혼동
- token/credential이 출력, state, snapshot, Git, AI context에 노출
- 운영 마찰이 수용 불가(관리 시간이 실제 작업보다 커지거나 안전 절차를 반복 우회)

stable nonzero exit, remote divergence, preflight restore 실패도 해결 전 NO-GO다. 자동 scope 확대, force push, authority flip으로 우회하지 않는다.

## 10. Phase 1B / cutover 경계

로컬 14-scenario adversarial gate, 전체 테스트, build가 모두 통과해도 그것은 **tooling completion**일 뿐 Phase 1A pilot 성공 증거가 아니다. merge 뒤 operator가 live preflight를 통과하고 위의 정확히 세 자연 Task cycle을 실제 업무에서 완료해야 한다. 그 cycle이 발생하지 않았으면 evidence 상태는 계속 **`insufficient evidence`**이며, Phase 1B 계획·pilot 성공·cutover 승인을 주장할 수 없다.

세 자연 cycle을 완료한 경우에도 마찰을 보는 최소 증거일 뿐 Phase 1B 승인이나 cutover가 아니다. Phase 1B, daily schedule, cross-host retry, `legacy → registry` authority 변경, Notion reconciliation/migration은 **별도로 승인된 새 계획**이 있어야 한다.

그 계획이 승인되기 전에는:

- 기존 Notion이 변경 없이 live authority다.
- Registry trial record는 시험 데이터이며 Notion 정본을 대체하지 않는다.
- `governance/authority.yaml`은 epoch 1 / `legacy`다.
- build server에서 manual/on-demand operation만 하며 GitHub Actions workflow/minutes와 schedule을 사용하지 않는다.
