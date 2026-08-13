# 장기 프로젝트 통제·SSOT·선택적 AI 인계 설계

- **Date**: 2026-08-13
- **Status**: Final — user-approved and independently validated
- **Author**: jhw + Codex
- **Scope**: 개인 GitHub 계정의 다중 프로젝트·다중 저장소, `jhw-notion`, 빌드 서버
- **Priority**: SSOT 충돌 방지 > 다중 프로젝트·병렬 작업 관리 > 명시적 세션 인계

---

## 1. 목적

AI 도구·세션·저장소가 늘어나도 다음 질문에 모호하지 않게 답할 수 있는 운영 체계를 만든다.

1. 이 정보의 현재 정본은 어디인가?
2. 이 프로젝트의 상태와 다음 행동은 무엇인가?
3. 같은 실행 작업을 다른 AI 세션이 이미 수행 중인가?
4. 새 세션이 작업을 재개할 때 최소한 무엇을 읽어야 하는가?

이 설계는 모든 정보를 하나의 도구에 넣는 단일 저장소를 만들지 않는다. **정보 객체별로 편집 가능한 권한 저장소를 하나만 지정**한다. 기존 Notion 기록과 과거 결정은 참고할 이력이지 절대적인 제약이 아니다.

---

## 2. 사용자 확정 원칙

### 2.1 우선순위

1. Git·Notion·문서 간 정본 충돌 방지
2. 프로젝트별 여러 저장소와 여러 AI 세션의 병렬 작업 규칙
3. 세션 인계는 자동 주입하지 않고 명시적 명령으로 수행

### 2.2 운영 원칙

- 정보 유형마다 정본을 하나만 지정한다.
- 중앙 포트폴리오와 저장소별 실행 작업을 분리한다.
- 프로젝트 하나는 저장소 하나 이상과 연결될 수 있다.
- 동일 실행 작업에는 쓰기 세션 하나만 허용한다.
- 서로 다른 실행 작업은 같은 저장소에서도 독립 worktree로 병렬 수행할 수 있다.
- 정식 GitHub Issue가 필요 없는 작은 작업은 규격화된 임시 Task ID를 허용한다.
- 다른 환경의 작업도 고려하되, 초기 구현은 대부분의 작업이 수행되는 현재 빌드 서버를 최적화한다.
- GitHub 연결이 없을 때는 격리된 오프라인 작업을 허용하지만 push·merge·배포는 금지한다.
- 활성 프로젝트 수는 제한하지 않는다. 대신 상태·Health·다음 행동·최근 검토일을 의무화한다.
- 반대 증거가 발견된 기술 지식은 즉시 `disputed`로 표시한다.
- 원본 로그·PCAP·실측 자료의 정본은 빌드 서버에 둔다.
- GitHub Actions 무료 분을 사용하지 않는다.
- 목표 구조와 초기 구현을 분리하고, 실제 실패 증거가 있을 때만 복잡한 기능을 추가한다.

---

## 3. 비목표

초기 버전은 다음을 해결하지 않는다.

- 모든 세션과 문서를 자동으로 통합 검색하는 범용 지식 그래프
- 모든 프로젝트 기록의 일괄 마이그레이션
- GitHub·Notion·Git 간 양방향 동기화
- heartbeat·TTL·자동 takeover를 갖춘 완전한 분산 Lease 서비스
- Knowledge Claim과 ADR의 자동 영향 분석
- content-addressed Evidence object store
- GitHub Project 자동 복원
- Plane·Linear·OpenProject 등 신규 프로젝트 관리 서비스 도입
- 새 세션에 과거 문맥 자동 주입

---

## 4. 권한 저장소 지도

| 객체 | 편집 가능한 정본 | 다른 시스템의 역할 |
|---|---|---|
| 프로젝트 상태·우선순위·Health·검토일 | 비공개 GitHub Project | export는 읽기 전용 백업 |
| 프로젝트 영구 ID·목표·저장소 관계 | 비공개 `project-registry`의 Project Record | 각 저장소는 링크만 보유 |
| 저장소 영구 ID·GitHub identity·현재 slug | Registry Git의 Repository Record | Project Record는 `repo_id`만 참조 |
| 정식 실행 작업 | 대상 저장소 GitHub Issue | Registry는 링크·집계만 보유 |
| 실행 작업 canonical identity | Registry Git의 persistent Task record | 정식 Issue의 내용/lifecycle은 Issue가 소유 |
| 현재 작업 점유 | Registry Git의 활성 Claim 기록 | 오프라인 기록은 잠정 run이며 Claim이 아님 |
| 저장소 범위 결정 | 해당 저장소 ADR | Notion에는 검색용 링크·요약만 허용 |
| 여러 저장소의 프로젝트 결정 | Registry Project ADR | 각 저장소는 참조 링크만 보유 |
| 전체 운영 정책 | Registry Governance ADR | 도구는 이를 읽어 적용 |
| 빠른 관찰·가설·지식 후보 | Notion Knowledge Inbox | AI의 확정 전제로 사용하지 않음 |
| 실제 작업에서 채택해 사용하는 지식 | 저장소/프로젝트/거버넌스 범위별 Git 문서 | Notion에는 승격 링크만 유지 |
| 사용자 작업 선호 | Notion Preferences | 운영 정책과 충돌하면 정책 우선 |
| Evidence 원본과 manifest | 빌드 서버 Evidence 경로와 인접 sidecar manifest | Git·Notion에는 immutable Evidence ID와 링크만 보유 |
| 공식 프로젝트 보고·성과 기록 | Phase 1에서는 Notion Reports/성과 | 프로젝트 현재 상태를 대신하지 않음 |
| 실행 중 세부 상태 | Task별 Handoff/작업 상태 | 공식 lifecycle·완료 여부는 Task가 정본이며 PR/commit은 결과 증거 |
| AI 세션 대화 원문 | 각 AI 도구의 세션 기록 | 명시적 요청에만 상세 조회 |

### 4.1 물리적 저장 계약

`Registry`라는 말은 GitHub 저장소 전체를 가리키는 논리적 이름이다. 실제 객체 표현은 다음처럼 하나로 고정한다.

| 객체 | 정확한 표현 |
|---|---|
| Project Record | 비공개 `project-registry` 저장소의 GitHub Issue 한 건 |
| 프로젝트 운영 필드 | Project Record Issue를 item으로 등록한 개인 비공개 GitHub Project 사용자 필드 |
| 프로젝트/거버넌스 ADR | Registry Git의 `projects/<project_id>/adr/`, `governance/adr/` |
| 프로젝트/거버넌스 지식 | Registry Git의 `projects/<project_id>/knowledge/`, `governance/knowledge/` |
| Repository canonical record | Registry Git의 `repositories/<repo_id>.yaml` |
| GitHub Repository source index | Registry Git의 `repositories/by-source/github/<repository-node-id>.yaml` |
| Task canonical record | Registry Git의 `tasks/<task_id>.yaml` |
| GitHub Issue source index | Registry Git의 `tasks/by-source/github/<url-safe-issue-node-id>.yaml` |
| 현재 Claim | Registry Git의 `claims/active/<task_id>.yaml` |
| 종료된 Claim 이력 | Registry Git의 `claims/history/<YYYY>/<task_id>/<claim_id>.yaml` |
| 미완료 작업 Handoff | Registry Git의 `handoffs/<task_id>/<claim_id>.md` |
| Evidence 원본 | 빌드 서버의 `/srv/evidence/<project_id>/...` |
| Evidence metadata | 원본과 같은 디렉터리의 `<evidence_id>.manifest.yaml` |
| Project/Issue/export snapshot | 빌드 서버의 접근 제한 snapshot 디렉터리 |

Git mirror는 Registry Git 파일만 보존한다. Project Record Issue와 GitHub Project 필드는 API snapshot에 별도로 포함한다. 두 백업을 서로 대체 가능하다고 표현하지 않는다.

### 4.2 충돌 규칙

1. 객체 유형으로 권한 저장소를 결정한다.
2. 정본 외 데이터는 직접 편집하지 않는다. 파생본에는 `source_system`, immutable `source_object_id`, `source_revision`, `generated_at`을 기록한다. UI 링크만으로 객체를 식별하지 않는다.
3. 정본과 파생본이 다르면 정본이 우선한다.
4. 정본의 최신 여부를 확인할 수 없으면 `unknown` 또는 `stale`로 표시한다.
5. 모순된 정본 후보를 자동 선택하지 않는다.
6. 대체된 기록은 먼저 `superseded` 관계를 남긴 뒤 보관한다.

### 4.3 금지하는 흐름

- GitHub Project export를 편집해 GitHub에 역동기화
- Notion 지식 후보와 Git 지식을 양쪽에서 계속 편집
- Evidence 원본을 Git·Notion에 복사해 별도 편집
- 세션 요약이나 AI 답변을 자동으로 정본 승격
- Project 상태를 하위 Issue 개수만으로 자동 결정

---

## 5. 프로젝트와 실행 작업

### 5.1 Project Record

프로젝트는 저장소와 독립된 객체다. 한 프로젝트는 하나 이상의 저장소를 포함한다. Project Record 본문에는 변경 빈도가 낮은 식별·목표·관계만 저장한다.

```yaml
id: prj-wlan-platform
objective: 무선 플랫폼의 안정성과 배포 재현성 확보
repositories:
  - repo-wlan-package
  - repo-wlan-opc
dependencies: []
```

Project Record 본문의 초기 필수 필드는 다음으로 제한한다.

- `id`
- `objective`
- `repositories`

Project Record는 Repository mapping을 복제하지 않고 `repo_id` 목록만 소유한다. 각 `repositories/<repo_id>.yaml`이 다음 mapping의 유일한 편집 위치다.

```yaml
id: repo-wlan-package
github_node_id: R_kgDO...
slug: jhw7500/wlan-package
```

`project_id`와 `repo_id`는 한 번 생성하면 변경하거나 재사용하지 않는다. 저장소 이름이 바뀌면 Repository Record의 `slug`만 갱신하고 GitHub node ID와 Registry `repo_id`는 유지한다. 같은 저장소를 여러 프로젝트가 공유해도 모든 Project Record가 같은 `repo_id`를 참조한다. 최초 등록은 `repositories/by-source/github/<repository-node-id>.yaml` source index와 Repository Record를 같은 fast-forward/CAS commit으로 생성하며, 경쟁 시 승리한 `repo_id`를 채택한다.

프로젝트 제목의 유일한 편집 위치는 Project Record GitHub Issue 제목이다. Issue 본문에는 `title`을 중복 저장하지 않는다.

다음 운영 필드는 Project Record 본문에 중복 기록하지 않고 해당 Issue가 등록된 비공개 GitHub Project의 사용자 필드에서만 편집한다. GitHub Project item의 제목은 Project Record Issue 제목을 그대로 표시하는 읽기 전용 표현이며 별도 `Project` 사용자 필드를 만들지 않는다.

```yaml
status: active
priority: P1
health: at-risk
next_action: task:tsk-0198...
last_reviewed: 2026-08-13
```

### 5.2 상태와 Health

프로젝트 상태:

```text
proposed | active | paused | completed | cancelled
```

Health:

```text
on-track | at-risk | blocked | unknown
```

- 상태는 프로젝트 생명주기다.
- Health는 현재 진행 가능성과 위험이다.
- `paused`는 의도적 중지이고, `blocked`는 진행 의사는 있으나 조건 때문에 불가능한 상태다.
- 검토 기한을 넘긴 경우 Health를 자동 변경하지 않고 `stale` 파생 경고를 표시한다.

### 5.3 실행 작업 ID

모든 실행 작업은 Registry가 생성한 변경 불가능한 canonical ID를 가진다.

```text
tsk-<UUIDv7>
```

사람이 읽는 GitHub Issue 또는 임시 문자열은 alias다. Claim, Handoff, history 경로와 동일 작업 판정은 canonical `task_id`만 사용한다.

정식 작업 alias:

```text
<repository>#<issue-number>
```

임시 작업 alias:

```text
<repository>:tmp-<YYYYMMDD>-<sequence>-<slug>
```

예:

```text
gstApp:tmp-20260813-01-encoder-guard
```

Persistent Task record는 Claim과 별개로 `tasks/<task_id>.yaml`에 남는다.

- 정식 GitHub Issue Task: canonical ID, immutable Issue node ID/revision, alias, `project_id`, `repo_id`와 URL만 소유한다. 목표·완료 조건·lifecycle은 GitHub Issue가 소유하며 Registry에 복제하지 않는다.
- 임시 Task: canonical ID, alias, `project_id`, `repo_id`, 목표, 완료 조건, 예상 변경 범위와 lifecycle을 소유한다.

동일 GitHub Issue의 동시 최초 등록이 서로 다른 UUID를 만들지 않도록 `tasks/by-source/github/<url-safe-issue-node-id>.yaml`에 Issue node ID → canonical `task_id` 매핑을 영구 저장한다. source index와 Task record는 같은 fast-forward/CAS commit으로 생성한다. 충돌 시 승리한 mapping의 `task_id`를 모든 호출자가 채택한다. 저장소 rename은 alias 표시만 갱신하며 canonical ID와 Claim 경로에는 영향을 주지 않는다.

### 5.4 Issue 승격 조건

다음 중 하나라도 해당하면 임시 Task를 GitHub Issue로 승격한다.

- 하루 이상 지속
- 여러 저장소 또는 세션이 관련
- 다른 작업과 의존·차단 관계 존재
- 사용자 결정이나 추가 승인 필요
- 릴리스·배포 영향

승격은 Issue source index와 Task record 변경을 같은 fast-forward/CAS commit으로 수행한다. source index가 비어 있거나 같은 `task_id`를 가리키면 idempotent하게 성공하고 기존 canonical `task_id`를 유지한다. 이미 다른 `task_id`를 가리키면 승격을 실패시키며, 사용자가 명시적으로 merge/supersede 관계를 결정하기 전에는 어느 ID나 mapping도 자동 변경하지 않는다. source-index 획득에 성공한 뒤 Task record에서 임시 내용/lifecycle의 소유권을 동결하고 immutable Issue node ID/revision, URL, 이전 alias를 기록한다. 이후 내용과 lifecycle은 Issue만 편집한다.

---

## 6. 병렬 AI 작업 규칙

### 6.1 동일 작업 판정

```text
동일 작업 키 = canonical task_id
```

- 온라인 상태에서 규칙을 준수하는 도구가 중앙 Claim을 획득한 동일 Task에는 쓰기 세션 하나만 허용한다.
- 서로 다른 Task는 같은 저장소에서도 병렬 허용한다.
- 읽기 전용 조사·리뷰는 점유 없이 병렬 허용한다.
- 파일 범위 중첩은 동일 작업 판정이 아니라 충돌 경고 대상이다.
- raw Git 명령으로 규칙을 우회하는 행위까지 파일시스템 수준에서 강제하지는 않는다.

### 6.2 초기 Claim 모델

초기 구현은 heartbeat·TTL·자동 takeover를 만들지 않는다. Persistent Task와 별개인 `claims/active/<task_id>.yaml`과 일반 fast-forward push를 이용해 durable Claim을 등록한다. 사용자 명령은 세부 단계를 묶어 제공한다.

```text
task start
task status
task finish
task recover
```

활성 Claim 예:

```yaml
task_id: tsk-0198...
task_alias: jhw7500/wlan-package#153
project_id: prj-wlan-platform
repo_id: repo-wlan-package
claim_id: clm-0198...
session_id: codex-123
host: cantopsbuildserver
branch: task/153-roaming-regression
worktree_ref: wt-153-roaming-regression
started_at: 2026-08-13T10:00:00+09:00
```

Claim 프로토콜:

1. 최신 Registry ref를 fetch하고 `claims/active/<task_id>.yaml` 존재 여부를 확인한다.
2. 비어 있으면 새로운 immutable `claim_id`를 포함한 commit을 만든다.
3. 현재 빌드 서버의 공유 Registry checkout은 fetch/check/commit/push/refetch verification 전체 구간에서 host-global OS 파일 잠금을 유지해 로컬 경쟁을 직렬화한다.
4. 원격에는 force 없이 fast-forward push한다.
5. `claim_id`는 `clm-<UUIDv7>` 형식으로 생성한다. push 성공 뒤 refetch하여 현재 `task_id`와 `claim_id`가 일치할 때만 Claim 성공을 반환한다.
6. non-fast-forward이면 fetch 후 재검사한다. 같은 Task가 점유됐으면 명시적 충돌을 반환하고, 무관한 Task 변경일 때만 rebase 후 다시 시도한다.
7. `task finish`와 release는 현재 Registry의 `claim_id`가 호출자가 기대한 값과 일치할 때만 성공한다.

공유 push, PR 생성, merge, 배포를 수행하는 통제 명령도 직전에 현재 `claim_id` 소유권을 다시 확인한다. 이 검사는 raw GitHub/Git 명령의 직접 사용까지 막지는 않으므로 준수 도구의 안전 규칙이다.

정상 release는 active Claim을 삭제만 하지 않는다. 결과 상태, branch, head SHA, 검증 요약, release 시각, Handoff pointer를 `claims/history/<YYYY>/<task_id>/<claim_id>.yaml`에 남긴 뒤 같은 commit에서 active Claim을 제거한다. Persistent Task record는 유지하고 필요한 lifecycle만 해당 Task authority에서 갱신한다.

비정상 종료는 자동 만료시키지 않는다. `task recover --expect <claim_id>`가 세션·프로세스·worktree·dirty/unpushed 상태를 표시한다. 강제 종료만 선택하면 기대한 Claim을 조건부 archive/remove한다. 인수하면 하나의 CAS commit에서 기대한 이전 Claim을 history로 archive하고 새로운 `clm-<UUIDv7>`, session, owner를 active Claim으로 설치한다. 이전 `claim_id`를 재사용하지 않는다. 과거 세션은 다른 `claim_id`를 release하거나 공유 push/PR/merge할 수 없다.

Phase 1A dry-run은 빌드 서버 한 호스트로 제한한다. host-global lock을 사용하고 시작 시 원격 divergence가 있으면 자동 rebase/retry하지 않고 실패한다. Phase 1A가 scorecard의 마찰 기준을 통과한 뒤에만 Phase 1B에서 위 cross-host non-fast-forward 재검사/retry를 활성화한다.

### 6.3 Worktree

- 순서는 Claim 성공 → worktree 생성 → 작업 → durable outcome/Handoff → 조건부 release → 선택적 worktree 제거다.
- 모든 쓰기 작업은 독립 브랜치와 worktree를 사용한다.
- 기본 작업 디렉터리에서 기능 구현을 수행하지 않는다.
- worktree 생성 실패 시 해당 `claim_id`를 조건부 release하거나 `abandoned` 이력을 남긴다.
- 작업 종료 시 완료·인계·폐기 중 하나를 기록한 뒤 조건부 release한다.
- worktree 제거 전 dirty 파일과 unpushed commit을 검사한다.
- worktree 제거와 Claim 해제를 동일 동작으로 간주하지 않는다.

### 6.4 오프라인 작업

GitHub 또는 Registry 원격 상태를 확인할 수 없을 때:

허용:

- 중앙 Claim이 아닌 unique provisional run ID를 가진 로컬 브랜치·worktree
- 코드 수정, 로컬 커밋, 빌드, 테스트
- 작업 목표와 시작 시각 기록

금지:

- 공유 브랜치 push
- PR 생성·병합
- 릴리스·배포
- 중앙 점유가 확인됐다고 주장

오프라인 run은 단일 writer 보장의 대상이 아니다. 재연결 후 중앙 Claim을 새로 획득하거나 기존 Claim과 명시적으로 조정하기 전에는 공유 작업으로 승격할 수 없다. 중앙 Task와 충돌하면 자동 병합하지 않고 인계·분할·폐기 중 하나를 선택한다.

### 6.5 분산 Lease 확장 조건

다른 환경에서 동일 Task 중복 작업이 실제로 두 차례 발생하면 전용 Git ref Lease와 heartbeat/TTL 필요성을 재검토한다. 그 전에는 일반 commit/push Claim과 수동 recovery를 유지한다.

---

## 7. 중앙 포트폴리오 운영

### 7.1 운영 필드

GitHub Project에는 Project Record Issue 제목과 다음 다섯 사용자 필드만 우선 사용한다.

```text
Status
Priority
Health
Next Action
Last Reviewed
```

Project Record 본문은 영구 ID·목표·범위·저장소 관계를 보유한다. GitHub Project 필드는 최신 운영 상태를 보유한다.

### 7.2 규칙

- `Priority`는 `P0 | P1 | P2 | P3`만 허용한다.
- 모든 활성 프로젝트의 `Next Action`은 다음 두 형식 중 정확히 하나다.
  - 비차단: `task:<canonical-task-id>`이며 status/export 시 실제 Task 존재 여부를 검증한다.
  - blocked: `wait:<short-condition>`이며 존재하지 않는 dummy Task를 만들지 않는다.
- blocked 프로젝트의 다음 검토 기한은 별도 필드를 추가하지 않고 `Last Reviewed + 적용 cadence`로 계산한다. 일반 blocked는 3일이며 P0처럼 더 짧은 조건이 함께 적용되면 최단 주기를 사용한다. Phase 1에서는 개별 날짜 override를 제공하지 않는다.
- 동시 활성 프로젝트 수는 제한하지 않는다.
- 한 실행 작업은 하나의 주 프로젝트에 귀속한다.
- 프로젝트 간 의존성은 Project Record에 명시한다.
- 검토 기한을 넘기면 `stale`로 경고한다.

### 7.3 기본 검토 주기

| 조건 | 기본 주기 |
|---|---:|
| P0 | 1일 |
| blocked 또는 at-risk | 3일 |
| 일반 active | 7일 |
| proposed | 14일 |
| paused | 30일 |
| completed/cancelled | 정기 검토 없음 |

자동화는 Health를 변경하지 않고 기한 초과 사실만 계산한다.
둘 이상의 조건이 적용되면 가장 짧은 주기를 선택한다.

---

## 8. Notion 역할 변경

기존 Notion 데이터를 초기 운영에서 일괄 삭제·이동하지 않는다. 신규 쓰기의 권한 경계는 아래 cutover 사전조건이 충족된 시각부터 변경한다. 그 전에는 기존 Notion이 운영 정본이며 새 Registry는 시험 데이터로만 사용한다.

| 기존 영역 | 새로운 역할 | 신규 쓰기 정책 |
|---|---|---|
| Projects | 과거 기록·Registry 진입 링크 | 현재 프로젝트 상태 신규 기록 중단 |
| Decision Log | 과거 결정 검색·ADR 승격 후보 | 새 정식 결정 원문 저장 중단 |
| Knowledge Base | Knowledge Inbox | 관찰·가설·미검토 후보만 저장 |
| References | 기존 참고자료 | 우선 유지, 이후 별도 평가 |
| Preferences | 사용자 선호 정본 | 계속 사용 |
| Reports/성과 | 파생 보고·개인 기록 | 프로젝트 현재 상태와 분리해 유지 가능 |

### 8.1 신규 정보 라우팅

```text
프로젝트 현재 상태     → GitHub Project 사용자 필드
프로젝트 ID·목표·저장소 관계 → Registry Project Record
저장소 결정            → 해당 저장소 ADR
프로젝트 공통 결정      → Registry ADR
운영 정책              → Registry Governance ADR
관찰·가설·지식 후보     → Notion Knowledge Inbox
작업에서 채택한 기술 지식 → 범위에 따른 Git 문서
사용자 선호            → Notion Preferences
```

### 8.2 기존 레코드 처리

기존 레코드의 분류 정본은 Registry Git의 `migration/notion-records.yaml`이다. 검증 이후 다음 중 하나로 분류한다.

```text
legacy-reference | promoted | superseded | archive-candidate
```

`legacy-reference`는 아직 승격되지 않은 과거 참고자료이며 운영 정본이라는 뜻이 아니다. 승격 시 Notion 원문을 동결하고 canonical ID, 대상 링크, cutover revision을 기록한다. 초기 2주 동안 과거 전체를 마이그레이션하지 않는다. 새 구조에서 실제로 필요해진 기록만 선별 승격한다.

### 8.3 JHW 명령에 미치는 영향

현재 JHW 쓰기 라우팅을 권한 지도에 맞게 바꾸는 것은 cutover 사전조건이다.

```text
/jhw:project start   → Registry
정식 결정 저장       → Git ADR
/jhw:save 관찰·가설  → Notion Knowledge Inbox
/jhw:save preference → Notion Preferences
/jhw:recall          → 기존 Notion + 새 Registry의 선택적 조회
```

사전조건:

1. 중앙 `governance/authority.yaml`이 monotonic `authority_epoch`, `mode`, cutover timestamp, 적용 도구 버전을 소유한다. 모든 host/TUI는 이 중앙 epoch를 읽고 로컬 설정으로 다른 authority를 선택할 수 없다.
2. 로컬 설정은 `writes_disabled=true`처럼 쓰기를 더 제한할 수만 있고 authority를 되돌릴 수 없다.
3. 첫 cutover 직전 legacy 충돌 쓰기를 일시 freeze하고 dry-run Registry record를 Notion과 reconcile한다. 양쪽 baseline revision과 reconciliation 결과를 Governance ADR에 기록한 뒤 epoch를 `legacy → registry`로 한 번만 전환한다.
4. `registry` epoch에서 `jhw_start`, `jhw_close`, Projects 대상 record/save는 Registry 경로로 전환하거나 server-side에서 fail-closed로 거절한다.
5. `registry` epoch에서 Decision Log 정식 결정 쓰기는 Git ADR 경로를 안내하고 server-side에서 거절한다.
6. Notion Knowledge Inbox와 Preferences 쓰기는 계속 허용한다.

경고만 출력한 뒤 기존 Notion에 쓰는 동작은 허용하지 않는다. Phase 1에서는 cutover 이후 `legacy`로 되돌리는 local rollback을 제공하지 않고 실패 시 fail-closed/fix-forward한다. Notion을 다시 authority로 복구해야 한다면 전체 쓰기 freeze, Registry→Notion 명시적 reconciliation, snapshot, 새 authority epoch를 요구하는 별도 reverse-cutover 설계를 승인받아야 한다. cutover 전 Registry 시험 데이터는 정본으로 가장하지 않는다.

---

## 9. 지식과 Evidence

### 9.1 초기 지식 모델

정교한 Claim 시스템은 초기 구현에서 제외한다.

- Notion: 빠른 관찰·가설·후보
- 저장소 범위 지식: 해당 저장소의 `docs/knowledge/`
- 여러 저장소의 프로젝트 지식: Registry Git의 `projects/<project_id>/knowledge/`
- 전체 운영 지식: Registry Git의 `governance/knowledge/`

Git 지식 문서는 최소 메타데이터만 사용한다.

```yaml
status: current
scope: 88W9098 / FW p149-p151
updated_at: 2026-08-13
```

상태:

```text
current | disputed | obsolete
```

승격 시 immutable `knowledge_id`를 생성한다. Notion 후보는 동결하고 canonical Git 링크만 유지한다. 유효한 반대 증거가 하나라도 발견되면 즉시 `disputed`로 전환하고 찬성·반대 근거를 본문에 기록한다. `verified`, `final`, `truth` 상태는 사용하지 않는다.

### 9.2 결정과 지식의 분리

- 지식 문서는 현재 증거가 지지하는 설명이다.
- ADR은 불확실성 속에서 현재 무엇을 실행할지 선택한 기록이다.
- 지식이 `disputed`가 되어도 ADR을 자동 폐기하지 않는다.
- 영향이 있으면 ADR을 재검토하고 별도 Task를 만든다.

### 9.3 Evidence

원본 로그·PCAP·실측 자료는 빌드 서버에 저장한다. 초기에는 기존 파일 저장 구조를 활용하며 다음만 의무화한다.

- 변경 불가능하고 재사용하지 않는 `evidence_id`
- 생성 시각
- 프로젝트·Task 연결
- checksum
- 장비·FW·코드 SHA 등 재현에 필요한 환경
- 원본과 파생 결과 구분

각 Evidence의 canonical metadata는 원본과 인접한 `<evidence_id>.manifest.yaml` 한 곳에서만 편집한다. manifest가 checksum, 현재 locator, provenance, project/task link, 환경, 원본/파생 관계를 소유한다. 파일 경로는 변경 가능한 locator이지 identity가 아니다. Git·Notion에는 `evidence_id`와 manifest 링크의 읽기 전용 projection만 둔다.

원본은 수정하지 않는다. 가공 결과는 새 `evidence_id`와 별도 파일로 생성한다. 별도 디스크 또는 NAS 복사는 현재 인프라에 맞게 운영하되, content-addressed object store는 실제 검색·유실 문제가 발생하기 전에는 구현하지 않는다.

---

## 10. 명시적 인계와 Recall

### 10.1 원칙

- 새 세션에 과거 기록을 자동 주입하지 않는다.
- 프로젝트 또는 Task를 지정했을 때만 필요한 정보를 조회한다.
- 세션 전체 요약보다 현재 Task 상태와 Git 상태를 우선한다.
- 원본 세션·로그는 사용자가 명시적으로 요청할 때만 상세 조회한다.

### 10.2 초기 명령

```text
portfolio status
task start
task status
task finish
task recover
portfolio export
```

`task start`가 ID 생성/선택, Claim, branch, worktree 생성을 묶는다. `task finish`가 결과·검증·이력 저장과 조건부 release를 묶는다. 별도 Handoff는 미완료 상태로 세션을 넘길 때만 생성한다. `portfolio status <project_id>`가 초기 project recall 역할을 겸하므로 별도 `recall project` 명령은 Phase 1에서 만들지 않는다.

### 10.3 Handoff

```markdown
# Handoff: tsk-0198...

source_task_id: tsk-0198...
source_task_revision: <revision>
claim_id: clm-0198...
generated_at: 2026-08-13T10:00:00+09:00

## Progress Since Last Checkpoint
## Git State
## Validation Performed
## Failures and Uncertainty
## Session-Local Next Step
## Related ADR and Evidence
```

Task 목표, 완료 조건, 공식 lifecycle과 완료 여부는 GitHub Issue 또는 Registry 임시 Task만 소유한다. Handoff는 이를 수정하지 않고 source revision으로 참조한다. PR/commit은 완료의 정본이 아니라 Task 결과의 증거다. Handoff는 과거 대화를 재현하지 않으며 세션 진행, Git 상태, 실제 검증, 불확실성, 다음 단계만 제공한다.

작업 중 임시 생성 위치는 Task worktree의 `.ai/handoff.md`다. 미완료 release 또는 cross-session handoff 전에는 checkpoint commit을 만들고 Registry의 `handoffs/<task_id>/<claim_id>.md`에 durable copy를 저장한 뒤 Task history에서 참조한다. 같은 호스트 인계는 로컬 checkpoint commit을 허용한다. 다른 호스트로 인계하려면 checkpoint를 해당 Task branch에 push한 뒤 Handoff에 remote ref와 commit SHA를 기록해야 하며, push되지 않은 상태를 durable handoff라고 표시할 수 없다. `.ai/handoff.md`는 최종 제품 브랜치에 병합하지 않는다. 완료 작업은 commit/PR과 검증 결과만 history에 기록하며 별도 Handoff를 요구하지 않는다.

### 10.4 Recall 출력

`portfolio status <project-id>`의 초기 출력:

- 프로젝트 목표·상태·Health·stale 여부
- 다음 행동
- 연결 저장소
- 활성·차단 Task
- 직접 관련된 활성 ADR 링크
- `disputed` 지식 경고
- 최신 프로젝트 검토

과거 전체 타임라인, 세션 원문, Evidence 원본은 자동 포함하지 않는다. 기본 AI 전달 payload는 최대 12 KiB 또는 20개 항목 중 먼저 도달한 한도로 자르고 `truncated`, 전체 항목 수, 추가 조회 ID를 표시한다.

---

## 11. Context Gateway 목표 구조

Context Gateway는 채택된 목표 구조지만 초기 서비스 구현 대상은 아니다.

### 11.1 초기 대체물

```text
portfolio.md
handoff.md
```

- `portfolio.md`: 빌드 서버 export로 생성하는 경량 L0 프로젝트 인덱스. 기본 파일도 12 KiB 또는 20개 항목 제한을 적용하고, 초과분은 page 파일과 추가 조회 ID로 연결한다.
- `handoff.md`: 현재 Task의 명시적 인계물

AI는 우선 이 두 문서와 지정된 Task만 읽는다.

### 11.2 향후 Gateway 원칙

Recall 크기가 반복적으로 문제가 될 경우 단일 Context Gateway를 추가한다.

```text
L0 Index:   ID·상태·경고·다음 Task
L1 Working: 목표·완료 조건·직접 ADR/지식
L2 Support: 문서 전문·Evidence manifest·journal delta
L3 Raw:     세션 원문·로그·전체 이력
```

- L0/L1만 기본 제공한다.
- L2/L3는 명시적 확장이다.
- GitHub·Notion·Git·Evidence의 원본 API 응답을 AI에 그대로 노출하지 않는다.
- 오래된 cache/export를 최신으로 가장하지 않는다.

Gateway 추가 조건은 일반 Task Recall이 반복적으로 불필요하게 크거나, AI가 분산 저장소를 반복 순회하는 경우다.

---

## 12. 백업과 비용

### 12.1 GitHub 비용 경계

- 비공개 GitHub Project와 Registry를 사용한다.
- 이 통제 시스템은 GitHub-hosted workflow를 새로 만들거나 Actions 분을 소비하지 않는다. 계정의 다른 저장소·Copilot review가 사용하는 Actions 분까지 0으로 만든다는 뜻은 아니다.
- 현재 빌드 서버의 `systemd timer` 또는 명시적 명령으로 export한다.
- Actions 분을 아끼기 위해 내부 포트폴리오를 public으로 전환하지 않는다.

### 12.2 Phase 1 보안 계약

- [GitHub가 명시한 fine-grained PAT 제한](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations)상 개인 계정 소유 Projects에는 fine-grained PAT를 사용할 수 없으므로 Project API용으로 만료일이 짧은 classic PAT를 별도 사용한다. read-only export는 `read:project`, 상태 변경은 `project` scope만 부여한다.
- classic PAT의 Project scope는 특정 개인 Project 하나로 제한할 수 없어서 접근 가능한 개인 Projects 전체에 더 큰 blast radius를 가진다. 또한 classic PAT는 저장소를 개별 선택할 수 없으므로 `repo` scope를 추가하면 개인 private 저장소 전반으로 권한이 넓어진다. 특정 Project에만 격리된 credential이라고 주장하지 않는다.
- Registry Contents/Issues 접근은 가능한 경우 Registry 저장소만 선택한 별도 fine-grained PAT로 분리한다. Project classic PAT를 Git push나 Registry Issue 변경에 재사용하지 않는다.
- Phase 1A preflight에서 classic PAT에 `repo` scope 없이 다섯 운영 필드와 필요한 Project item ID를 읽고 쓸 수 있는지 실제 API로 확인한다. private Issue content 때문에 `repo` scope가 필요하면 이를 자동 추가하지 않고 Project 자동화를 fail-closed로 중단한 뒤 수동 UI 운영 또는 조직 소유 Project 대안을 다시 승인받는다.
- 두 credential은 빌드 서버에서만 사용하고 짧은 만료, 정기 rotation, 사용 종료 즉시 revoke를 적용한다. Project별 격리가 필수 요구가 되면 개인 Project 자동화를 중단하거나 GitHub App을 사용할 수 있는 조직 소유 Project로 이전하는 설계를 별도 검토한다.
- credential은 Git, Handoff, snapshot, command output, 로그, AI context에 포함하지 않는다.
- 빌드 서버 credential/snapshot 디렉터리는 소유자만 접근하고 디렉터리 `0700`, 파일 `0600`을 기본값으로 한다.
- Claim에는 host alias와 `worktree_ref`만 저장하고 실제 absolute path는 host-local mapping에 둔다.
- export와 Recall은 allowlist된 필드만 포함한다. token, raw Evidence, 고객 식별자, 비밀 경로, 환경변수는 제외한다.
- credential 폐기·교체 절차를 문서화하고 cutover·reverse-cutover 시 사용하지 않는 credential을 즉시 revoke한다.
- snapshot 보존 기본값은 daily 30개와 weekly 12개다. 더 긴 보존은 근거가 있을 때만 추가한다.

### 12.3 초기 export

```text
GitHub Project / Registry
        ↓ 단방향
portfolio.json
portfolio.md
snapshots/
```

- 초기 dry-run은 명시적 실행만 사용하고, cutover pilot부터 매일 1회 실행한다.
- 추가 실행: 프로젝트 검토 직후
- 성공한 경우에만 현재 snapshot 포인터 갱신
- 실패하면 직전 성공본을 유지하되 `generated_at`과 `stale`을 표시
- export 파일에서 GitHub로 역동기화하지 않음
- snapshot에는 `schema_version`, `generated_at`, source revision, Project 필드 정의와 option, item/source ID, total count, checksum을 포함한다.
- GraphQL connection은 `hasNextPage=false`까지 pagination하고 export count와 `totalCount`가 일치하지 않으면 실패로 처리한다.
- 불완전한 snapshot은 current 포인터를 갱신하지 않는다.

### 12.4 최소 복구 검증

- Registry는 일반 Git mirror 또는 clone으로 보존한다.
- Project Record Issue 본문·source ID와 GitHub Project 다섯 필드·field option은 구조화 JSON으로 보존한다.
- 빌드 서버에만 존재하는 export는 `snapshot`이라고 부른다. 다른 장비/저장소에 검증된 복사본이 생긴 뒤에만 `backup`이라고 부른다.
- pilot 중 빈 임시 디렉터리에 Registry Git을 복원하고 snapshot으로 모든 활성 Project Record source ID와 다섯 운영 필드를 재구성하는 수동 drill을 한 번 수행한다. GitHub에 실제로 되쓰지는 않는다.
- Evidence를 `재생성 가능`과 `대체 불가능`으로 분류한다. 대체 불가능 Evidence는 다른 물리 저장소 복제가 완료되어야 보호된 것으로 표시한다.
- GitHub Project snapshot은 Registry Project Record를 복원하는 자료가 아니라 해당 Record에 연결된 운영 필드 배정을 복원하는 자료다.

---

## 13. 단계적 전환

### Phase 1A — 최소 dry-run

- 실제 활성 프로젝트 2~3개만 Registry와 GitHub Project에 시험 등록한다.
- Project Record Issue 제목과 GitHub Project 사용자 필드 다섯 개만 사용한다.
- `task start/status/finish/recover`, 독립 worktree, 미완료 Handoff, `portfolio status`, on-demand export만 제공한다.
- Registry 시험 레코드는 `trial`로 표시하며 이 기간의 운영 정본은 기존 Notion이다.
- 최소 3개의 자연스러운 Task cycle로 Claim과 관리 마찰을 확인한다.
- cutover 사전조건인 중앙 authority epoch와 JHW server-side fail-closed guard/reroute를 검증한다.
- 과거 전체 기록은 마이그레이션하지 않는다.

### Phase 1B — 2주 cutover pilot

- 사전조건을 모두 충족한 뒤 cutover timestamp를 기록하고 8장의 신규 쓰기 권한을 적용한다.
- 기존 Notion 데이터는 일괄 변경하지 않지만 conflicting 신규 쓰기는 fail-closed로 차단한다.
- 매일 snapshot timer를 활성화한다.
- 최소 10개의 자연스러운 Task cycle과 3개의 실제 미완료 Handoff를 관찰한다. 미달이면 성공/실패가 아니라 `insufficient evidence`로 판정한다.

### Phase 2 — 운영 평가

다음을 평가한다.

- 프로젝트 현황 파악 시간이 줄었는가?
- 다음 행동이 실제 실행 Task를 가리키는가?
- 같은 Task 중복 작업을 막았는가?
- Handoff가 새 세션 재개에 충분했는가?
- Notion과 Git에 같은 내용을 이중 편집했는가?
- 관리 명령이 번거로워 우회됐는가?

실패한 규칙은 자동화로 덮지 않고 삭제하거나 단순화한다.

### Phase 3 — Notion 선별 재분류

최소 운영이 유효할 때만 기존 Notion 기록을 `legacy-reference`, `promoted`, `superseded`, `archive-candidate`로 선별 분류한다. 필요해진 기록만 ADR·Git 지식으로 승격한다.

### Phase 4 — 증거 기반 확장

| 관찰된 실패 | 검토할 확장 |
|---|---|
| 다른 환경에서 동일 Task 중복 작업이 2회 발생 | Git ref 기반 분산 Lease |
| Recall이 반복적으로 너무 큼 | Context Gateway |
| 뒤집힌 지식 때문에 잘못된 구현 발생 | 정식 Claim–Evidence 모델 |
| Evidence 위치·무결성을 반복해서 잃음 | manifest catalog/object store |
| GitHub Project 복구 요구 발생 | 복원 도구 |
| GitHub 포트폴리오 UX가 실제 병목 | Plane·Linear 등 재평가 |

---

## 14. 검증 기준

### 14.1 SSOT

- 임의 정보 10건의 정본 위치를 Authority Map으로 단일 판정할 수 있다.
- GitHub Project, Registry, Notion 사이에 양방향 편집 대상이 없다.
- 오래된 export가 최신 정본처럼 표시되지 않는다.
- 신규 프로젝트 상태와 정식 결정이 Notion에 중복 저장되지 않는다.

### 14.2 프로젝트 관리

- 모든 활성 프로젝트에 Health가 있고, 비차단 프로젝트의 `Next Action`은 `task:<canonical-task-id>`, blocked 프로젝트는 `wait:<short-condition>` 형식이다.
- blocked 프로젝트의 다음 검토일은 `Last Reviewed + 적용 조건 중 최단 cadence`로 단일 계산되며 별도 override 필드는 없다.
- 프로젝트 하나가 여러 저장소를 연결할 수 있다.
- stale 프로젝트를 한 명령으로 식별할 수 있다.
- 프로젝트 현황을 1분 이내 파악할 수 있다.

### 14.3 병렬 작업

- 온라인 상태에서 규칙을 준수하는 도구가 동일 Task를 Claim하면 두 번째 Claim이 거절되거나 명시적 충돌을 반환한다.
- 쓰기 작업은 독립 worktree를 사용한다.
- 세션 종료 뒤에도 활성 Task와 결과를 확인할 수 있다.
- 다른 Task의 병렬 작업은 제한하지 않는다.

### 14.4 컨텍스트·토큰

- 새 세션에 과거 기록을 자동 주입하지 않는다.
- `portfolio status <project_id>`는 지정 프로젝트만 반환한다.
- 일반 Task 재개에 전체 세션 원문이 필요하지 않다.
- Handoff만으로 다음 행동, Git 상태, 실제 검증, 미완료 항목을 식별할 수 있다.
- 기본 AI payload는 12 KiB/20개 항목 제한과 truncation metadata를 지킨다.

### 14.5 운영 부담

- 작업 시작과 종료의 추가 명령은 각각 한 번이다.
- 일반 Task마다 ADR·지식·Evidence 객체를 모두 만들 필요가 없다.
- 이 통제 시스템이 GitHub-hosted workflow를 생성하거나 Actions 분을 소비하지 않는다.
- 관리 자동화 유지보수가 실제 프로젝트 작업보다 커지지 않는다.

### 14.6 2주 pilot scorecard

Phase 1A 시작 전에 기존 Notion 방식으로 동일한 표준 질문(현재 상태, 다음 행동, 차단 원인, 재개 지점)을 답하는 lookup/restart 표본 5회를 측정해 baseline으로 보존한다. pilot 동안 `task`/`portfolio` 명령은 비밀을 제외한 command, task/claim ID, 시작·종료 시각, 성공/실패, bypass 사유, payload bytes를 빌드 서버의 pilot measurement journal에 구조화 기록한다. 이는 운영 정본이 아니라 scorecard 계산용 파생 관측치다. 사용자는 각 Task 종료 시 실제 active work minutes의 근사값만 기록하며, 관리 시간은 명령 실행과 Handoff 작성 stopwatch 합계로 계산한다.

cutover 전에 격리된 시험 Registry에서 다음 경쟁·복구 시나리오를 결정적으로 실행한다.

1. 두 프로세스가 동일 GitHub Issue를 동시에 최초 등록해도 source index와 canonical Task ID가 하나만 남는다.
2. 두 checkout이 동일 Task를 동시에 Claim하면 한 Claim만 활성화된다.
3. Phase 1A에서 원격 divergence는 안전하게 실패하고, Phase 1B 후보 프로토콜에서는 무관한 변경만 재검사/retry된다.
4. 잘못된 `claim_id`로 release와 공유 작업을 시도하면 거절된다.
5. push 성공 직후 클라이언트가 중단돼도 refetch/recover가 원격 Claim을 식별한다.
6. takeover는 이전 Claim을 archive하고 새 `claim_id`를 발급해 과거 owner의 후속 동작을 막는다.
7. 오프라인 provisional run은 재연결 후 중앙 Claim 없이 push·PR·merge할 수 없다.

pilot 종료 시 모든 Task의 source index, active/history Claim 구간, takeover 관계, Task branch head를 사후 대조한다. 중복 안전성은 "감지되지 않음"이 아니라 이 감사에서 **동일 Task의 겹치는 성공 Claim 구간이 0건**이고, 조건 불일치 release가 0건인 것으로 판정한다.

| 지표 | 통과 기준 |
|---|---|
| 표본량 | 자연 Task cycle 10개 이상, 실제 미완료 Handoff 3개 이상. 미달은 `insufficient evidence` |
| 현황 조회 | 표준 질문 표본 5회 모두 60초 이내이며 Phase 1A baseline도 함께 보고 |
| SSOT | cutover 이후 신규 authoritative Projects/Decision Notion 쓰기 0건, 이중 정본 쓰기 0건 |
| Claim 안전성 | 사후 감사에서 겹치는 성공 Claim 구간 0건, 조건 불일치 release 0건, 위 7개 시험 모두 통과 |
| 절차 준수 | `task start/finish` 준수율 90% 이상, 모든 bypass 사유 기록 |
| 관리 비용 | 측정 journal 기준 start+finish+Handoff 중앙값 2분 이하이며, 사용자 기록 active work minutes 대비 중앙 비율 10% 이하 |
| Context | 기본 status/Handoff payload p95 12 KiB 이하, truncation 시 추가 조회 ID 제공 |
| Snapshot | cutover pilot 14일 중 성공 snapshot 13일 이상, 불완전 snapshot current 승격 0건 |
| 복구 | 빈 임시 위치 수동 restore drill 1회 성공 |

scorecard를 pilot 시작 전에 고정한다. 종료 후 결과에 맞춰 기준을 바꾸지 않는다.

---

## 15. 중단·재설계 조건

다음 중 하나가 scorecard에서 실패하면 기능을 확대하지 않고 우선 단순화·중단·재설계 중 하나를 선택한다.

- Registry와 GitHub Project 중 어디를 수정해야 하는지 혼란
- Task Claim 누락 또는 우회
- Handoff 작성 비용이 재개 절약보다 큼
- Project 상태가 실제 작업과 지속적으로 불일치
- Notion과 Git의 동일 내용 이중 편집
- 관리 시스템 유지보수가 실제 프로젝트 작업보다 큼

---

## 16. 독립 검증 결과

2026-08-13 세 독립 검토자가 구현 전 스펙을 읽기 전용으로 검증했다.

1. **SSOT 검토**: Registry 물리 표현, mutable field authority, ID와 migration cutover 모호성을 지적했다.
2. **병렬 작업 검토**: 원격 Claim CAS, ownership-safe release, crash recovery, offline 보장 범위를 지적했다.
3. **운영/YAGNI 검토**: Notion fail-closed cutover, 보안 계약, snapshot/backup 구분, pilot scorecard와 command bundling을 지적했다.

Must-fix는 4.1, 5, 6, 8.3, 9, 10.2~10.4, 12, 13, 14.6에 반영했다. heartbeat·TTL·자동 takeover, 지식 그래프, object store, 자동 복원은 실제 발생 조건이 없어 계속 초기 범위에서 제외했다.

최종 보정 후 세 검토자가 현재 문서를 다시 읽고 각각 **SSOT/authority PASS**, **동시성·복구 PASS**, **운영·YAGNI·보안 PASS**로 판정했다. 구현 전 남은 must-fix는 없다.
