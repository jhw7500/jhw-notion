# 장기 프로젝트 통제·SSOT·선택적 AI 인계 설계

- **Date**: 2026-08-13
- **Status**: User-approved; independent validation pending
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
| 정식 실행 작업 | 대상 저장소 GitHub Issue | Registry는 링크·집계만 보유 |
| 임시 실행 작업 | Registry의 구조화 Task 기록 | 완료 후 커밋 연결 또는 Issue 승격 |
| 현재 작업 점유 | 초기: Registry 활성 Task 기록 | 오프라인 기록은 잠정 상태 |
| 저장소 범위 결정 | 해당 저장소 ADR | Notion에는 검색용 링크·요약만 허용 |
| 여러 저장소의 프로젝트 결정 | Registry Project ADR | 각 저장소는 참조 링크만 보유 |
| 전체 운영 정책 | Registry Governance ADR | 도구는 이를 읽어 적용 |
| 빠른 관찰·가설·지식 후보 | Notion Knowledge Inbox | AI의 확정 전제로 사용하지 않음 |
| 실제 작업에서 채택해 사용하는 지식 | 범위에 따른 Git 문서 | Notion에는 승격 링크만 유지 |
| 사용자 작업 선호 | Notion Preferences | 운영 정책과 충돌하면 정책 우선 |
| 원본 로그·PCAP·실측 데이터 | 빌드 서버 Evidence 경로 | Git·Notion에는 ID·요약·checksum·경로 |
| 공식 프로젝트 보고·성과 기록 | Notion 또는 별도 보고 계층 | 프로젝트 현재 상태를 대신하지 않음 |
| 실행 중 세부 상태 | Task별 Handoff/작업 상태 | 공식 완료 여부는 Task/PR이 정본 |
| AI 세션 대화 원문 | 각 AI 도구의 세션 기록 | 명시적 요청에만 상세 조회 |

### 4.1 충돌 규칙

1. 객체 유형으로 권한 저장소를 결정한다.
2. 정본 외 데이터는 직접 편집하지 않고 `source_id` 또는 링크로 연결한다.
3. 정본과 파생본이 다르면 정본이 우선한다.
4. 정본의 최신 여부를 확인할 수 없으면 `unknown` 또는 `stale`로 표시한다.
5. 모순된 정본 후보를 자동 선택하지 않는다.
6. 대체된 기록은 먼저 `superseded` 관계를 남긴 뒤 보관한다.

### 4.2 금지하는 흐름

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
title: WLAN Platform
objective: 무선 플랫폼의 안정성과 배포 재현성 확보
repositories:
  - wlan-package
  - wlan-opc
  - pcap-analyzer
```

Project Record 본문의 초기 필수 필드는 다음으로 제한한다.

- `id`
- `title`
- `objective`
- `repositories`

다음 운영 필드는 Project Record 본문에 중복 기록하지 않고 해당 Issue가 등록된 비공개 GitHub Project의 사용자 필드에서만 편집한다.

```yaml
status: active
priority: P1
health: at-risk
next_action: wlan-package#153
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

정식 작업:

```text
<repository>#<issue-number>
```

임시 작업:

```text
<repository>:tmp-<YYYYMMDD>-<sequence>-<slug>
```

예:

```text
gstApp:tmp-20260813-01-encoder-guard
```

임시 Task는 최소한 목표, 완료 조건, 프로젝트, 저장소, 예상 변경 범위를 기록한다.

### 5.4 Issue 승격 조건

다음 중 하나라도 해당하면 임시 Task를 GitHub Issue로 승격한다.

- 하루 이상 지속
- 여러 저장소 또는 세션이 관련
- 다른 작업과 의존·차단 관계 존재
- 사용자 결정이나 추가 승인 필요
- 릴리스·배포 영향

승격 후에도 임시 ID와 정식 Issue 연결을 보존한다.

---

## 6. 병렬 AI 작업 규칙

### 6.1 동일 작업 판정

```text
동일 작업 키 = repository + task_id
```

- 동일 Task에는 쓰기 세션 하나만 허용한다.
- 서로 다른 Task는 같은 저장소에서도 병렬 허용한다.
- 읽기 전용 조사·리뷰는 점유 없이 병렬 허용한다.
- 파일 범위 중첩은 동일 작업 판정이 아니라 충돌 경고 대상이다.

### 6.2 초기 Claim 모델

초기 구현은 분산 Git ref Lease를 만들지 않는다. Registry에 활성 Task 기록을 두고 다음 명령만 제공한다.

```text
task claim
task status
task release
```

활성 Task 예:

```yaml
task_id: wlan-package#153
project_id: prj-wlan-platform
repository: wlan-package
session_id: codex-123
host: cantopsbuildserver
branch: task/153-roaming-regression
worktree: /path/to/worktree
started_at: 2026-08-13T10:00:00+09:00
```

현재 빌드 서버에서는 파일 잠금으로 Claim 갱신을 원자화한다. 다른 환경에서는 작업 시작 전에 Registry를 동기화하고 Claim 변경을 push한다. 원격 경쟁이 실제 문제로 반복되기 전에는 heartbeat, TTL, 자동 takeover를 추가하지 않는다.

### 6.3 Worktree

- 모든 쓰기 작업은 독립 브랜치와 worktree를 사용한다.
- 기본 작업 디렉터리에서 기능 구현을 수행하지 않는다.
- 작업 종료 시 완료·인계·폐기 중 하나를 기록한 뒤 명시적으로 release한다.
- worktree 제거와 Claim 해제를 동일 동작으로 간주하지 않는다.

### 6.4 오프라인 작업

GitHub 또는 Registry 원격 상태를 확인할 수 없을 때:

허용:

- 오프라인 상태를 명시한 로컬 브랜치·worktree
- 코드 수정, 로컬 커밋, 빌드, 테스트
- 작업 목표와 시작 시각 기록

금지:

- 공유 브랜치 push
- PR 생성·병합
- 릴리스·배포
- 중앙 점유가 확인됐다고 주장

재연결 후 중앙 Task와 충돌하면 자동 병합하지 않고 인계·분할·폐기 중 하나를 선택한다.

### 6.5 분산 Lease 확장 조건

다른 환경에서 동일 Task 중복 작업이 실제로 두 차례 발생하면 Git ref 기반 분산 Lease를 재검토한다. 그 전에는 구현하지 않는다.

---

## 7. 중앙 포트폴리오 운영

### 7.1 운영 필드

GitHub Project에는 다음 여섯 필드만 우선 사용한다.

```text
Project
Status
Priority
Health
Next Action
Last Reviewed
```

Project Record 본문은 영구 ID·목표·범위·저장소 관계를 보유한다. GitHub Project 필드는 최신 운영 상태를 보유한다.

### 7.2 규칙

- 모든 활성 프로젝트는 정확히 하나의 `next_action`을 가진다.
- `next_action`은 GitHub Issue 또는 임시 Task ID를 가리킨다.
- 동시 활성 프로젝트 수는 제한하지 않는다.
- 한 실행 작업은 하나의 주 프로젝트에 귀속한다.
- 프로젝트 간 의존성은 Project Record에 명시한다.
- 검토 기한을 넘기면 `stale`로 경고한다.
- 2회 연속 검토에서 같은 다음 행동이 유지되고 진척이 없으면 `stalled` 검토 대상으로 표시한다.

### 7.3 기본 검토 주기

| 조건 | 기본 주기 |
|---|---:|
| P0 또는 blocked | 1일 |
| at-risk | 3일 |
| 일반 active | 7일 |
| proposed | 14일 |
| paused | 30일 |
| completed/cancelled | 정기 검토 없음 |

자동화는 Health를 변경하지 않고 기한 초과 사실만 계산한다.

---

## 8. Notion 역할 변경

기존 Notion 데이터를 초기 운영에서 일괄 삭제·이동하지 않는다. 그러나 **신규 쓰기의 권한 경계는 즉시 변경**한다.

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

기존 레코드는 검증 이후 다음 중 하나로 분류한다.

```text
legacy-current | promoted | superseded | archive-candidate
```

초기 2주 동안 과거 전체를 마이그레이션하지 않는다. 새 구조에서 실제로 필요해진 기록만 선별 승격한다.

### 8.3 JHW 명령에 미치는 영향

최종 구현에서는 현재 JHW 쓰기 라우팅을 권한 지도에 맞게 바꿔야 한다.

```text
/jhw:project start   → Registry
정식 결정 저장       → Git ADR
/jhw:save 관찰·가설  → Notion Knowledge Inbox
/jhw:save preference → Notion Preferences
/jhw:recall          → 기존 Notion + 새 Registry의 선택적 조회
```

구현 전에는 기존 명령을 제거하지 않는다. 권한이 겹치는 쓰기 명령에는 경고를 제공하고 이중 쓰기를 금지한다.

---

## 9. 지식과 Evidence

### 9.1 초기 지식 모델

정교한 Claim 시스템은 초기 구현에서 제외한다.

- Notion: 빠른 관찰·가설·후보
- Git: 실제 코드·결정에 반복 사용되는 지식

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

유효한 반대 증거가 하나라도 발견되면 즉시 `disputed`로 전환하고 찬성·반대 근거를 본문에 기록한다. `verified`, `final`, `truth` 상태는 사용하지 않는다.

### 9.2 결정과 지식의 분리

- 지식 문서는 현재 증거가 지지하는 설명이다.
- ADR은 불확실성 속에서 현재 무엇을 실행할지 선택한 기록이다.
- 지식이 `disputed`가 되어도 ADR을 자동 폐기하지 않는다.
- 영향이 있으면 ADR을 재검토하고 별도 Task를 만든다.

### 9.3 Evidence

원본 로그·PCAP·실측 자료는 빌드 서버에 저장한다. 초기에는 기존 파일 저장 구조를 활용하며 다음만 의무화한다.

- 안정적인 Evidence ID 또는 경로
- 생성 시각
- 프로젝트·Task 연결
- checksum
- 장비·FW·코드 SHA 등 재현에 필요한 환경
- 원본과 파생 결과 구분

원본은 수정하지 않는다. 가공 결과는 별도 파일로 생성한다. 별도 디스크 또는 NAS 복사는 현재 인프라에 맞게 운영하되, content-addressed object store는 실제 검색·유실 문제가 발생하기 전에는 구현하지 않는다.

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
task claim
task status
task release
handoff
recall project
portfolio export
```

### 10.3 Handoff

```markdown
# Handoff: wlan-package#153

## Goal
## Done Conditions
## Completed
## Remaining
## Git State
## Validation Performed
## Failures and Uncertainty
## Next Action
## Related ADR and Evidence
```

Handoff는 과거 대화를 재현하지 않는다. 다음 세션이 안전하게 작업을 재개할 수 있는 최소 상태만 제공한다.

초기 저장 위치는 Task worktree의 `.ai/handoff.md`다. 같은 빌드 서버의 다음 세션은 이 파일을 직접 읽는다. 다른 환경으로 인계할 때는 checkpoint commit과 task branch push를 먼저 수행하고, Handoff를 Registry의 `handoffs/<task-id>.md`에 복사해 공유한다. `.ai/handoff.md`는 기본적으로 최종 제품 브랜치에 병합하지 않는다. 공식 Task 상태와 완료 여부는 계속 GitHub Issue 또는 Registry 임시 Task가 정본이다.

### 10.4 Recall 출력

`recall project <project-id>`의 초기 출력:

- 프로젝트 목표·상태·Health·stale 여부
- 다음 행동
- 연결 저장소
- 활성·차단 Task
- 직접 관련된 활성 ADR 링크
- `disputed` 지식 경고
- 최신 프로젝트 검토

과거 전체 타임라인, 세션 원문, Evidence 원본은 자동 포함하지 않는다.

---

## 11. Context Gateway 목표 구조

Context Gateway는 채택된 목표 구조지만 초기 서비스 구현 대상은 아니다.

### 11.1 초기 대체물

```text
portfolio.md
handoff.md
```

- `portfolio.md`: 빌드 서버 export로 생성하는 경량 프로젝트 인덱스
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
- GitHub-hosted Actions를 사용하지 않는다.
- 현재 빌드 서버의 `systemd timer` 또는 명시적 명령으로 export한다.
- Actions 분을 아끼기 위해 내부 포트폴리오를 public으로 전환하지 않는다.

### 12.2 초기 export

```text
GitHub Project / Registry
        ↓ 단방향
portfolio.json
portfolio.md
snapshots/
```

- 기본 주기: 매일 1회
- 추가 실행: 프로젝트 검토 직후
- 성공한 경우에만 현재 snapshot 포인터 갱신
- 실패하면 직전 성공본을 유지하되 `generated_at`과 `stale`을 표시
- export 파일에서 GitHub로 역동기화하지 않음

### 12.3 최소 복구 검증

- Registry는 일반 Git mirror 또는 clone으로 보존한다.
- GitHub Project 핵심 필드는 구조화 JSON으로 보존한다.
- Evidence는 별도 디스크·NAS 등 다른 물리 저장소 복제를 권장한다.
- 초기에는 자동 복원 도구를 만들지 않고 snapshot을 읽어 Project Record를 재구성할 수 있는지만 확인한다.

---

## 13. 단계적 전환

### Phase 1 — 2주 최소 운영

- 현재 활성 프로젝트만 Registry에 등록한다.
- GitHub Project 필드 여섯 개만 사용한다.
- `claim/status/release`, worktree, handoff, project recall, export만 제공한다.
- 기존 Notion 데이터는 일괄 변경하지 않는다.
- 신규 쓰기는 8장의 권한 경계를 즉시 적용한다.
- 과거 전체 기록은 마이그레이션하지 않는다.

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

최소 운영이 유효할 때만 기존 Notion 기록을 `legacy-current`, `promoted`, `superseded`, `archive-candidate`로 선별 분류한다. 필요해진 기록만 ADR·Git 지식으로 승격한다.

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

- 모든 활성 프로젝트에 Health와 다음 행동이 있다.
- 프로젝트 하나가 여러 저장소를 연결할 수 있다.
- stale 프로젝트를 한 명령으로 식별할 수 있다.
- 프로젝트 현황을 1분 이내 파악할 수 있다.

### 14.3 병렬 작업

- 동일 Task의 두 번째 Claim이 거절되거나 명시적 충돌을 반환한다.
- 쓰기 작업은 독립 worktree를 사용한다.
- 세션 종료 뒤에도 활성 Task와 결과를 확인할 수 있다.
- 다른 Task의 병렬 작업은 제한하지 않는다.

### 14.4 컨텍스트·토큰

- 새 세션에 과거 기록을 자동 주입하지 않는다.
- Project Recall은 지정 프로젝트만 반환한다.
- 일반 Task 재개에 전체 세션 원문이 필요하지 않다.
- Handoff만으로 다음 행동, Git 상태, 실제 검증, 미완료 항목을 식별할 수 있다.

### 14.5 운영 부담

- 작업 시작과 종료의 추가 명령은 각각 한 번이다.
- 일반 Task마다 ADR·지식·Evidence 객체를 모두 만들 필요가 없다.
- GitHub Actions 분을 사용하지 않는다.
- 관리 자동화 유지보수가 실제 프로젝트 작업보다 커지지 않는다.

---

## 15. 중단·재설계 조건

다음 중 하나가 반복되면 기능을 확대하지 않고 구조를 재검토한다.

- Registry와 GitHub Project 중 어디를 수정해야 하는지 혼란
- Task Claim 누락 또는 우회
- Handoff 작성 비용이 재개 절약보다 큼
- Project 상태가 실제 작업과 지속적으로 불일치
- Notion과 Git의 동일 내용 이중 편집
- 관리 시스템 유지보수가 실제 프로젝트 작업보다 큼

---

## 16. 독립 검증 계획

구현 계획 전에 독립 검증을 수행한다.

1. **SSOT 검증**: 객체별 권한 경계, Project Record와 GitHub Project의 이중 정본 가능성
2. **병렬 작업 검증**: Claim 원자성, worktree, 다른 환경·오프라인 충돌
3. **운영/YAGNI 검증**: 1차 범위가 여전히 복잡한지, 실제 사용자가 우회할 지점
4. **복구·보안·토큰 검증**: 비공개 정보, export, credential, Recall 비용

검증 결과의 must-fix는 스펙에 반영한다. 향후 확장 제안은 실제 발생 조건이 없으면 초기 범위에 추가하지 않는다.
