---
description: Notion AI Workspace에 확정된 정보를 즉시 저장
---

# /jhw:record — Notion 즉시 저장

1. 사용자 입력 또는 현재 컨텍스트에서 저장할 내용과 대상 DB를 파악한다.

2. DB 판별 기준:
   - 기술 결정 (A vs B 선택, 도구 변경 등) → db: "decisionLog"
   - AI 사용 선호도/피드백 → db: "preferences"
   - 프로젝트 등록/상태 변경 → db: "projects"
   - 참조 문서 (외부 가이드/MCP 문서/플러그인) → db: "references"
   - 기술 지식/사실/팁 → `/jhw:note` 사용을 안내 (knowledgeBase DB)

3. **`report` 자동 추론**: 작업 디렉토리(`pwd`)에서 슬러그를 뽑아 아래 매핑으로 기본값 추론:

   | 슬러그 (디렉토리) | report |
   |---|---|
   | `pim-check` | `pim-test` |
   | `pim-package`, `pim-package-jhw` | `pim-app` |
   | `max9296` | `pim-driver-cam` |
   | `sc16is7xx` | `pim-driver-spi` |
   | `wlan-driver`, `wlan-driver-v1`, `wlan-driver-v2`, `mwifiex-mode1` | `wlan-driver` |
   | `wlan-package`, `wlan-package-bak`, `wlan-package-jhw`, `wlan-bridge`, `wpa-supplicant` | `wlan-app` |
   | `pcap-analyzer`, `wifi-sniff`, `ping-gui` | `wlan-test` |
   | `gstApp`, `gstApp-v2`, `streamApp` | `pim-app` |
   | `automation`, `cts-*`, `jhw-notion`, `redmine`, `personal-ops`, `org`, `nxp-mcu` | `etc` |
   | (그 외) | **묻기** — 강제 기본값 박지 않음 |

   매칭되지 않으면 사용자에게 한 번 묻는다. preferences DB에서는 `report`를 묻지 않고 자동으로 `etc` (또는 `none`).

4. 미리보기를 보여주고 승인을 받는다 (**`report` 줄 항상 표시**):
   ```
   📝 Notion 저장 미리보기
   ─────────────────────
   DB:     Decision Log
   제목:   [제목]
   상태:   확정
   report: wlan-driver  ← 자동 추론 / 사용자 입력
   project: [프로젝트 키워드 (있으면)]
   근거:   [근거]
   ─────────────────────
   저장할까요?
   ```

5. 승인 후 `jhw_record` MCP 도구를 호출한다 (`properties.report` 포함).

6. 결과 URL을 반환한다.

## 사용 예시

- `/jhw:record` — 직전 대화 컨텍스트 + cwd에서 자동 판별
- `/jhw:record libpcap 대신 raw socket 선택` — 내용 직접 지정
- `/jhw:record report=wlan-bsp 어떤 결정` — report 명시

## 규칙

- 중간 결과나 미확정 정보는 저장하지 않는다.
- 저장 전 반드시 사용자 승인을 받는다.
- 상태 필드 기본값은 "확정" (decisionLog) / "진행중" (projects).
- **`report` 자동 추론 우선, 매칭 실패 시 묻기**. 강제 기본값 안 박음.
- `jhw_record` MCP 도구가 불가능하여 `notion-create-pages`를 직접 호출할 때, date 프로퍼티는 반드시 expanded 키 사용: `"date:date:start":"YYYY-MM-DD"`.
