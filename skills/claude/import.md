---
description: Notion AI Workspace에서 프로젝트/키워드 관련 내용을 검색하여 현재 프로젝트 memory 폴더로 불러오기
argument-hint: "[키워드... | \"구문\" | k1, k2; k3] (콤마/세미콜론/공백 구분, 무인자=cwd 프로젝트명)"
---

# /jhw:import — Notion → 로컬 메모리 불러오기

Notion AI Workspace에서 프로젝트명이나 키워드로 관련 페이지를 검색한 뒤, 선택한 페이지들을 **현재 프로젝트의 memory 폴더**로 가져와 로컬 참조 파일로 저장한다.

## 흐름

1. **질의어 파악 (다중 키워드 지원)**
   - 인자를 **콤마(`,`)** 또는 **세미콜론(`;`)** 으로 분리하여 각각을 독립된 키워드로 처리
   - 콤마/세미콜론이 없으면 **큰따옴표(`"..."`)** 로 감싼 문자열을 단일 구문으로, 나머지는 공백 기준 다중 키워드로 처리
   - 예:
     - `/jhw:import file_check_reboot` → 키워드 1개
     - `/jhw:import file_check_reboot, chk_cam_operate` → 키워드 2개
     - `/jhw:import "ord_vcm_conf retry"; pim-package-jhw` → `"ord_vcm_conf retry"`(구문) + `pim-package-jhw`(키워드) 총 2개
     - `/jhw:import RTC DS1307 max9296` → 공백 분리 키워드 3개 (단, 큰따옴표 없을 때만)
   - 인자가 없으면 현재 작업 디렉토리(cwd)의 프로젝트 이름을 단일 기본 질의어로 사용
   - 키워드는 최대 8개까지 받고, 초과 시 앞 8개만 사용하며 사용자에게 알림

2. **현재 프로젝트 memory 경로 결정**
   - cwd를 기준으로 `~/.claude/projects/<slug>/memory/` 경로 계산
   - slug 규칙: cwd 절대경로의 `/` → `-` 치환, 앞에 `-` 붙임 (예: `/home/jhw/ai/foo` → `-home-jhw-ai-foo`)
   - 폴더가 없으면 생성

3. **Notion 병렬 검색 (다중 키워드)**
   - 각 키워드마다 `mcp__notion__notion-search`를 **한 번의 메시지에서 모두 병렬 호출** (`query_type: "internal"`)
   - References / Knowledge Base / Projects / Decision Log 모두 포함
   - 결과 병합 규칙:
     - 동일 페이지가 여러 키워드에 걸려도 **중복 제거**(URL 기준)
     - 각 페이지에 **매칭된 키워드 목록**을 부착(후보 테이블 `Matched` 열로 표시)
     - 정렬: 매칭 키워드 수(많은 순) → 최근 수정일(신→구)
   - 어떤 키워드에서도 결과가 없으면 사용자에게 빈 키워드를 알림

4. **후보 제시 (매칭 키워드 표시)**
   ```
   📥 Notion import 후보
   키워드: [file_check_reboot], [chk_cam_operate], [재부팅]
   ─────────────────────────────────────────────────────────────────────
   #  DB/Type       제목                                날짜        Matched
   1  References    file_check_reboot 동작 명세         2026-04-17  ①②③
   2  Knowledge     chk_cam_operate.sh retry 단계       2026-04-11  ②
   3  Decision Log  재부팅 정책 변경                    2026-03-20  ③
   4  References    ord_vcm_conf.json 스키마            2026-02-10  ①
   ─────────────────────────────────────────────────────────────────────
   Matched 표기: ①=file_check_reboot, ②=chk_cam_operate, ③=재부팅
   전체 가져오기? 또는 번호 지정 (예: "1,2")
   ```

5. **승인 수신 후 연속 실행** (전역 CLAUDE.md의 Notion 저장 흐름 규칙 준수 — 중간 중단 없이):
   - 선택된 페이지를 `mcp__notion__notion-fetch`로 상세 조회 (병렬)
   - 각 페이지를 memory 파일로 저장:
     - 파일명: `imported_<slug>_<YYYYMMDD>.md`
     - slug: 페이지 제목을 소문자+하이픈으로 정규화, 50자 이내
     - 프런트매터 유지(type: reference), 원본 URL을 `source:` 필드에 기록
   - `MEMORY.md` 인덱스에 `## Imported` 섹션을 만들고 각 파일을 한 줄로 추가

6. **결과 보고**
   - 저장된 파일 경로 리스트
   - 저장 실패한 항목이 있으면 사유 보고

## 파일 템플릿

```markdown
---
name: {원본 제목}
description: {원본 summary 또는 첫 문단 100자}
type: reference
source: {Notion 페이지 URL}
imported_at: {YYYY-MM-DD}
query: {검색에 사용한 질의어}
---

{Notion fetch 결과 본문 (Markdown)}
```

## 사용 예시

- `/jhw:import pim-package-jhw` — 단일 키워드
- `/jhw:import file_check_reboot, chk_cam_operate, 재부팅` — 콤마 구분 다중 키워드
- `/jhw:import "ord_vcm_conf retry"; pim-package-jhw` — 큰따옴표 구문 + 세미콜론 구분
- `/jhw:import RTC DS1307 max9296` — 공백 구분 다중 키워드 (큰따옴표 없을 때)
- `/jhw:import` (인자 없음) — cwd 기반 프로젝트명으로 자동 검색

## 규칙

- **조회/저장 전용**: Notion 데이터를 수정하지 않는다. 항상 로컬 memory로만 가져온다.
- **덮어쓰기 금지**: 동일 파일명이 이미 존재하면 suffix(`-2`, `-3`)를 붙여 신규 저장.
- **대용량 보호**: 페이지 본문이 50KB를 넘으면 헤더 + 첫 200줄만 가져오고 끝에 `(truncated — 원본 URL에서 계속 읽기)` 표시.
- **프로젝트 특화 경로**: 질의어에 특정 프로젝트명이 포함되어 있고 cwd와 다른 경우, 해당 프로젝트의 memory 폴더로 가져올지 사용자에게 확인.
- **승인 이후 연속 실행**: 승인 후 fetch → 파일 저장 → 인덱스 갱신까지 한 흐름. 중간 "진행할까요?" 금지 (전역 CLAUDE.md 규칙).
- **승인은 필수**: 검색 리콜에 무관한 결과가 섞일 수 있어 자동 저장하지 않는다. 반드시 사용자의 번호 선택 또는 "전체/취소" 응답을 받은 뒤에만 저장을 시작.
- **병렬 검색 필수**: 다중 키워드는 **한 메시지 안에서 모두 병렬** `notion-search` 호출. 순차 호출 금지(전역 규칙 Rule 1).

## 사용 시점

- 새 세션 시작 시 해당 프로젝트의 과거 결정/가이드/참조 문서를 로컬로 불러와 즉시 context로 활용하고 싶을 때
- 특정 키워드(예: 증상, 함수명, 설정 키)에 대한 Notion의 축적된 지식을 memory 폴더로 영구 보관할 때
- 오프라인 환경 또는 Notion API 제한이 걱정될 때 선제적으로 로컬 캐시 확보
