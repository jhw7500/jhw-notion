# 관리형 Notion 읽기 중계 #261 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the integrated runtime path and track verification below.

**목표** — 기존 사용자 UID의 관리형 MCP와 Control이 키 없이 허용된 Notion 조회를 수행한다.

**구성** — 기존 관리형 broker가 호출에 고정된 PID와 release/bootstrap pair를 검증하고, 별도 credential UID의 서비스에 해당 읽기 작업을 전달한다. 보호된 서비스에 운영자가 등록한 Notion 연결을 사용한다.

**명세** — [관리형 실행 경계](../specs/2026-11-24-managed-execution-boundary-261.md#관리형-notion-자격증명-중계-설계안).

## 공통 제약

- Linux pidfd, 루트가 보호하는 Python 프로그램 및 프로필, Node 22 이상을 사용한다. 일반 런타임과 v1 관리형 writer 프로필의 스키마를 보존한다.
- 세션과 모든 관리형 selector의 환경에서 `NOTION_API_KEY`를 제거한다. 읽기 중계에 연결할 수 없으면 관리형 MCP와 Control의 Notion 조회를 거부한다.
- 관리형 쓰기 승인 발행과 운영 변경은 후속 작업이다. 시험은 합성 키와 격리한 임시 상태를 사용한다.

## 1. 프로세스 결속과 보호 서비스

- [x] `scripts/test_runtime_managed_notion.py`에서 승인된 읽기, 고정된 preflight 경로, 유효하지 않은 요청, 원격 오류의 축약, 중계 부재를 확인한다. `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_runtime_managed_notion.py'`에서 구현 전 실패를 확인한다.
- [x] `scripts/runtime_managed_notion.py`가 v1 관리형 profile 옆의 root 소유 `<profile>.notion.json`을 읽는다. 서비스는 분리된 UID가 소유한 `0600` 키 파일과 해당 UID가 소유하는 socket directory를 사용하고, 고정 Notion HTTPS endpoint에 읽기 요청만 구성한다. `request`는 `{operation,...}`이고 응답은 `{status,body}`다. 4096B 제어 패킷과 8MiB sealed 응답 한도를 지킨다.
- [x] `scripts/runtime_managed.py`에 보호 서비스 진입과 읽기 헬퍼를 연결한다. broker는 실제 헬퍼의 직접 부모를 pidfd로 확인하고, 해당 호출의 selector와 세션 pair를 확인한다. MCP에는 6개 읽기 작업을, Control에는 `preflight`를 허용한다.
- [x] `runtime-store.mjs`가 managed Notion 계약을 지원하는 MCP bundle을 표시한다. `runtime-managed-invocation.cjs`가 확인된 표시를 요구하고 MCP 및 Control preflight에 불변 `__JHW_MANAGED_NOTION_RELAY__` 함수를 제공한다. 이 함수는 보호된 Python 실행 경로로 JSON 한 건을 보내고 `{status,body}`를 받는다.

## 2. SDK와 Control preflight

- [x] 키가 없는 MCP 조회 6개, 쓰기 거부, 일반 SDK 회귀와 Control의 실패 JSON을 Vitest로 고정하고 구현 전 실패를 확인한다.
- [x] `mcp-server/src/notion/managed-relay.ts`에 `Client` 어댑터를 둔다. `search`, `queryDataSource`, `retrievePage`, `retrieveDatabase`, `retrieveDataSource`, `listBlockChildren`만 중계한다. `preflight`는 `DATABASE_SCHEMAS`의 `{databaseId,dataSourceId}` 목록을 보호 서비스가 가진 목록과 대조하고 조회로 관계를 검증한다.
- [x] `notion-client.ts`와 `env.ts`는 관리형 진입에서 중계 서비스 자격증명만 사용한다. `control/cli.ts`는 보호 서비스 오류를 `NOTION_GUARD_INDETERMINATE`로 반환한다. 기존 사용자 상태 경로와 일반 설치에 대한 테스트를 통과한다.

## 3. 통합 시험

- [x] 세 UID의 별도 프로세스에서 새 MCP가 읽기 응답을 받고 자식·기록에 합성 키가 남지 않는지 확인한다. 기존 세션의 pair와 새 세션의 pair를 전환과 회수 중 대조하고, 보호 서비스가 없는 동안에는 조회가 거부되는지 확인한다.
- [x] `README.md`의 관리형 설정을 키가 없는 세션 구성으로 갱신한다.
- [x] MCP build·typecheck·Vitest, 런타임 Node/Python 시험, 스킬 동기화와 `git diff --check`를 실행한다.

## 검증 결과

- MCP build와 typecheck는 exit 0이다. Vitest는 2,666개 통과, 1개 skip, exit 0이다.
- 격리 Linux에서 관리형 Python 42개와 Node scope 8개가 통과했다. Node 관리형 loader·worker·artifact 검증 12개가 통과했고 같은 실행에서 별도 격리가 필요한 scope 7개는 skip됐다.
- 일반·v2 런타임 회귀 시험은 첫 실행에서 507개 통과, 1개 skip이었다. 테스트 사본에 Git 이력과 빌드 산출물을 준비한 뒤 실패했던 나머지 17개가 모두 통과했다.
- 세 UID 격리 수락 시험 1회는 4세션에서 556회 반복을 완료했다. `A -> B -> A` 전환과 C 회수, 중계 중단 시 조회 거부, 같은 B 세션에서 중계 재시작 뒤 조회 성공을 확인했다.
- 스킬 동기화 상태와 `git diff --check`는 exit 0이다.
- 운영 Notion 및 실제 승인 `PostToolUse` 검증은 운영 배포 확인 단계에 해당한다.

## 공동 배포 후보 검증

- A-R1-001은 별도 UID의 읽기 중계와 세션 환경 정리로 수정했다. A-R1-002는
  `.jhw-atomic-probe.v1` 재사용으로 수정했다. 초기화의 여섯 중단 지점과 교환 중단,
  다른 객체 보존, 검사 잠금, prune 처리를 직접 검증했다.
- `test_runtime_managed_acceptance.py --trials 10`은 격리 Linux에서 10/10회, exit 0이다.
  40세션에서 5,220회 반복했으며 A→B→A와 C 회수, 검사 공간 하나 유지,
  전체 Control preflight 성공과 중계 중단 시 거부, 같은 MCP의 재시작 후 조회를 확인했다.
  일반 hook 최대는 5,050.50ms, SessionEnd 최대는 319.33ms였다.
  수락 로그 SHA-256은 `db031451c93a4797c87411745fc5ce7874b2cd9a3f9688dc8737242e0f08cc03`이다.
- MCP 빌드·타입 검사, Vitest 2,666개(1개 skip), 대상 Node 회귀 57개,
  격리 관리형 Python 42개와 Node scope 8개, 설치 안전성 검증이 exit 0이다.
  첫 Vitest 사본의 의존성 링크를 실물 디렉터리로 교체해 재검증했다.
- 전체 Node 실행에서 Codex 설정 이행의 빌드 산출물 의존 시험이 실패했고, 산출물을 갖춘
  사본에서 해당 파일을 다시 실행해 58/58 통과했다. 일반 v2의 프로세스 검사 실패는
  수정 전 HEAD에서도 재현됐다. 별도 감독 프로세스를 제거한 격리 실행에서 기본
  회수 시험이 통과했고, 연속 호출 중 일반 v2 회수는 `DEPLOY_INVENTORY_UNCERTAIN`으로
  중단하며 세대와 실행 중인 세션을 보존했다.
