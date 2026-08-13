---
description: Use when the user requests status for the existing Notion AI Workspace or one of its databases
argument-hint: "[db명] (projects|preferences|decisionLog|knowledgeBase|references)"
---

# /jhw:status — Notion 워크스페이스 현황

1. `jhw_status` MCP 도구를 호출한다. 인자가 있으면 해당 Notion DB만 조회한다.
2. DB별 레코드 수와 최근 항목을 읽기 전용 표로 보여준다.
3. 필요하면 상세 조회를 제안한다.

```text
/jhw:status
/jhw:status projects
```

## Phase 1A 경계

- 이 명령은 계속 **기존 Notion live authority**의 현황이다. 데이터를 수정하지 않는다.
- Project Control 시험 현황은 사용자가 명시적으로 `/jhw:portfolio status`를 요청할 때만 조회한다.
- 일반 `/jhw:status`를 Registry나 portfolio로 자동 라우팅하거나 두 결과를 자동 병합하지 않는다.
