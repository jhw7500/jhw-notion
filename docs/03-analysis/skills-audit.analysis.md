# jhw-notion 커스텀 스킬 평가 (Skills Audit)

> 작성일: 2026-06-17
> 대상: `skills/claude/*.md` 17개(활성 9 + deprecated alias 8) + 백엔드 `mcp-server/src/tools/*.ts` 12개 도구
> 방법: 4클러스터 병렬 정독 → 4축(기능/사용성/중복/최적화) 평가 → 적대적 검증 → P0/P1 핵심 주장 직접 재검증
> 종합 점수: **5.5 / 10** — 기능·안전성 기반은 견고, 통합의 후반부(도구 surface·캐시 연동·문서 동기화·표현 정합)가 미완

---

## 1. 구조 개요

| 계층 | 통합 진입점 | deprecated alias | 고아/불일치 |
|---|---|---|---|
| **스킬(17)** | save · project · recall · review · compact · match · status · import · cclog (9) | record · note · delete · search · context · history · start · close (8) | `report.md` **부재** |
| **MCP 도구(12)** | — (jhw_save/project/match/compact/import **없음**) | jhw_record/note/delete/start/close/search/context/history **전부 등록·노출** (`server.ts:21-32`) | jhw_recall · jhw_report_preview · jhw_report_export = **스킬이 안 감쌈** |

**핵심 패턴**: 통합이 *스킬 문서 레이어에서만* 일어났고 MCP 도구 표면은 옛 granular 구조 그대로. 이 2계층 드리프트가 사용성·중복·최적화 세 축에 일관되게 번진다. `save`/`match`/`compact`/`project`/`import`는 순수 스킬계층 오케스트레이션이며, 대응하는 `jhw_save` 등의 MCP 도구는 존재하지 않는다(= `save.md:52`도 `jhw_record/note/delete`를 직접 호출).

## 2. 차원별 점수

| 차원 | 점수 | 한 줄 평 |
|---|---|---|
| **기능** | 6.5/10 | schema 단일소스·5층 안정성 레이어·자동 paragraph split 등 기반은 출하 완료. 단 close 부분일치 오종료·page-cache 미작동·`--hard` 오표기가 잔존 결함 |
| **사용성** | 5.5/10 | 통합 진입점·한국어 승인 UX는 강점이나 `--hard` 의미 배신·recall 이름충돌·cclog 하드코딩 경로가 멘탈모델 마찰 누적 |
| **중복** | 5/10 | 스킬은 8종 통합됐지만 MCP granular 8종 잔존 + 저장가치·paragraph 가드·report 매핑 문서 중복으로 drift 위험 |
| **최적화** | 5/10 | 도구 surface 미축소·page-cache write 미연동·paragraph 가드 ~40줄 중복이 토큰/retrieval 비효율, report 도구는 진입점 없이 방치 |

## 3. 우선순위별 핵심 발견

### 🔴 P0 — 데이터/신뢰 직결

**P0-1. `--hard`="완전 삭제" 표기가 실제 동작(휴지통 이동)과 배신** `[직접 검증 ✅]`
- `save.md:25/85`·`delete.md:9`·`compact.md:22`는 `--hard`를 "완전 삭제"로 약속하나, `delete.ts:54-62` delete 모드는 `archived:true`만 수행 — archive fallback(`:39-42`)과 **동일 API 호출**. Notion 휴지통(30일 복구 가능)일 뿐 영구 삭제 아님. zod 설명(`delete.ts:8`)조차 "완전 삭제"로 표기.
- 기본 archive는 status를 "폐기"로 **mutate**(`delete.ts:26`)해 `save.md:24`의 "이력 보존"과도 어긋남.
- **권고**: Notion API는 영구삭제를 노출하지 않으므로 *문서를 실제 동작에 맞춤*. `--hard`="Notion 휴지통으로 이동(영구 아님)", archive="status를 폐기로 변경(데이터는 남되 필드 덮어씀)"으로 정정.

**P0-2. `/jhw:project --close` 부분일치 오종료** `[직접 검증 ✅]`
- `close.ts:28-42`가 `title contains` + `results[0]`로 첫 매칭을 잡고, `resolve-project.ts:29`의 exact-우선 resolver를 import조차 안 함. `close("jhw-notion")`이 "jhw-notion-v2"를 잡으면 무관 프로젝트 status를 "완료"로 mutate(`close.ts:50`).
- **권고**: `close.ts`가 `resolveProject`(exact 우선, 동률 시 모호성 보고)를 쓰도록 수정.

**P0-3. page-cache가 recall.ts에서만 채워져 retrieval 레이어 사실상 미작동** `[직접 검증 ✅]`
- `defaultPageCache`를 import하는 파일은 `tools/recall.ts` 하나뿐. write 경로(record/note/start/close)도 다른 read 경로(search/context/history)도 `.set()` 미호출 → in-memory Map이 매 프로세스 빈 채로 시작.
- roadmap(`plan §2.2`)이 "jhw_context/search 호출 시 자동 캐시"를 계획했으나 출하분에 누락 — *계획 대비 미구현*.
- **권고**: write 경로가 생성 직후 `defaultPageCache.set()` 하도록 공통 헬퍼 추가(이후 read 경로 확장).

### 🟠 P1 — 구조·일관성

| # | 발견 | 검증 | 권고 |
|---|---|---|---|
| P1-1 | paragraph 2000자 가드 ~40줄이 `blocks.ts:47-61` 자동 split과 중복(save/review/project/compact/match + 외부 절대경로) | 직접 ✅ | `review.md §3.5` 단일 정본, 나머지는 "자동 분할됨" 1줄 참조. 외부 홈경로 cross-ref 제거 |
| P1-2 | `/jhw:recall` 스킬 ↔ `jhw_recall` 도구 이름충돌 — 도구는 PageCache 전용·고아, `notion.search` 이중 구현 | 직접 ✅ | `jhw_recall` rename 또는 recall search 모드 백엔드로 연결, `notion.search` 단일 경로 수렴 |
| P1-3 | MCP granular 8종이 deprecation 표기 없이 등록 → tool-list 토큰·LLM 선택 편향 | 직접 ✅ | description에 "(내부용)" 표기, 중기적으로 도구 surface 12→6~7 축소 |

> ⚠️ **교정**: 초안의 "compact/match가 deprecated 도구를 위선적으로 우회" 프레이밍은 부정확. `jhw_save` MCP 도구가 없고 `save.md:52` 자신도 동일 프리미티브를 호출하므로 compact/match는 *동급 호출*. 유효 잔여는 "도구 surface 미축소 + 마커 부재"뿐(P1-3).

### 🟡 P2 — 정리·문서

| # | 발견 | 검증 | 권고 |
|---|---|---|---|
| P2-1 | `jhw_report_preview/export`(캐시 완비) 구현됐으나 `report.md` 스킬 부재 → 고아 자산. `AGENTS.md:19` "(3주차 신규 예정)" stale | 직접 ✅ | `report.md` 작성 또는 AGENTS 표기 현실화 |
| P2-2 | deprecated stub 8개(81줄) 삭제 버전/날짜 없음 + argument-hint 소실로 발견성↓ | 직접 ✅ | 버전/날짜 핀 + `deprecated:true` 카탈로그 숨김 |
| P2-3 | `cclog.md:8/67/75` `-home-jhw-ai-opencode` 경로 하드코딩 → 타 프로젝트에서 오작동 | 검증 ✅ | `import.md:22-24` cwd→slug 동적 계산으로 교체 |
| P2-4 | cwd→report 매핑표가 `save.md:30-44` → `review.md:17` 텍스트 복붙 | 직접 ✅ | save.md 정본, 나머지는 참조 위임 |
| P2-5 | 저장가치 5기준 `review.md §3.6` ↔ `compact.md:45-49` 재서술 / `import.md` 칩명 오타(DS1307/DS1305) | 검증 ✅ | §3.6 단일 정본 / 오타 통일 |
| P2-6 | `AGENTS.md:9`·`README.md:6` "도구 9개"인데 실제 12개, README는 deprecated alias를 1급 나열 | 직접 ✅(server.ts) | 통합 완료분/미완분 분리해 갱신 |

## 4. 강점 (유지)

- **진입점 통합 설계가 명료** — 13→8 슬림화, deprecated alias로 마이그레이션 일관 안내.
- **`status` 스킬은 도구와 1:1 정합** — 스킬↔도구 드리프트 0의 모범.
- **`review` 저장가치 게이트**(재사용성/검색가치/비자명성/지속성/중복 + 상중하 + 옵트인) — Notion 오염 방지.
- **도구 레이어 방어 깊이** — `blocks.ts` 자동 split, `api.ts` 5층 안정성 레이어, `schema.ts` 단일소스.
- **파괴적 동작 전 미리보기+승인 게이트**가 match(6단계)·compact(7단계)에 일관 존재.

## 5. 검증 투명성

- 멀티에이전트 평가 워크플로우의 적대적 검증 단계가 레이트리밋으로 25건 중 22건 미수행(검증 미수행 ≠ 반박).
- 따라서 **P0/P1 load-bearing 주장 4건은 원본 코드/스킬을 직접 열어 재검증**(`delete.ts`/`close.ts`/page-cache grep/`blocks.ts`) — 모두 성립.
- 워크플로우가 스스로 반박한 1건(compact/match 우회)은 재확인 후 프레이밍 교정(§3 P1-3 주석).

## 6. 처리 로드맵

1. **P0** (이 분석 직후 PR): `--hard`/archive 표기 정정 + `close.ts` resolveProject + page-cache write 연동.
2. **P1**: paragraph 가드 단일 정본화 + recall 이름충돌 해소 + 도구 description 마커.
3. **P2**: report.md 작성 + deprecated stub 정리 + cclog 이식성 + 문서 카운트 동기화.
