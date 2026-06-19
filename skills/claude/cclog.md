---
description: "Claude Code 세션 대화기록 시간순 조회 · --tools 도구호출포함 · --last N 최근N턴 · 인자로 세션경로|all"
argument-hint: "[세션파일경로|all] [--tools] [--last N]"
---

# /jhw:cclog — Claude Code 세션 대화 기록 조회

현재 작업 디렉터리(cwd)의 Claude Code 세션 JSONL을 시간순으로 펼쳐본다.
입력(user)·출력(assistant) 및 선택적으로 도구 호출까지 포함.

## 인자

- `$1` — 세션 파일 경로. 생략 시 최신 세션 자동 선택. `all`이면 세션 목록 나열.
- `--tools` — 도구 호출(tool_use/tool_result)까지 포함
- `--last N` — 마지막 N개 메시지만 출력 (기본: 전체)

예:
- `/jhw:cclog` — 현재 세션 전체
- `/jhw:cclog --last 20` — 최근 20턴
- `/jhw:cclog --tools` — 도구 호출 포함
- `/jhw:cclog all` — 세션 목록

## 동작 순서

1. **세션 디렉터리 확정** (cwd 기반 동적 — `import.md`와 동일 slug 규칙)
   - `SESSION_DIR="$HOME/.claude/projects/$(pwd -P | sed 's#/#-#g')"`
   - 현재 작업 디렉터리 절대경로의 `/`를 `-`로 치환한 slug (예: `/home/jhw/ai/opencode/projects/jhw-notion` → `-home-jhw-ai-opencode-projects-jhw-notion`)

2. **대상 파일 선택**
   - `$1`이 경로면 해당 파일 사용
   - `$1`이 `all`이면 세션 목록 테이블로 표시 후 종료
     ```
     ls -lt "$SESSION_DIR"/*.jsonl | grep -v '/agent-' | head -20
     ```
     각 파일의 첫 user 메시지 요약을 `jq -r 'select(.type=="user") | .message.content' | head -1`로 첨부
   - 그 외에는 `agent-*` 제외한 가장 최근 `.jsonl` 선택:
     ```bash
     ls -t "$SESSION_DIR"/*.jsonl | grep -v '/agent-' | head -1
     ```

3. **시간순 출력** (Bash + jq)
   - 기본 필터: `select(.type=="user" or .type=="assistant")`
   - `--tools` 있으면 `tool_use` / `tool_result` 블록도 포함
   - `--last N` 있으면 `tail -n N` 적용 (JSONL은 append-only라 단순 tail로 시간순 유지)

4. **포맷**
   ```
   ━━━ [타임스탬프] USER ━━━
   (사용자 입력 본문)

   ━━━ [타임스탬프] ASSISTANT ━━━
   (어시스턴트 응답 본문)

   ▸ [tool_use] ToolName (--tools 옵션 시)
     입력: {...축약...}
   ◂ [tool_result]
     결과: ...축약...
   ```

5. **요약 라인** — 끝에 `총 N턴 (user M / assistant K)` 출력

## 구현 예시 (Bash)

```bash
SESSION_DIR="$HOME/.claude/projects/$(pwd -P | sed 's#/#-#g')"

# 대상 파일
if [ "$1" = "all" ]; then
  ls -lt "$SESSION_DIR"/*.jsonl | grep -v '/agent-' | head -20
  exit 0
fi

FILE="${1:-$(ls -t $SESSION_DIR/*.jsonl | grep -v '/agent-' | head -1)}"

# 메시지 추출 (시간순)
jq -r '
  select(.type=="user" or .type=="assistant") |
  "\n━━━ [\(.timestamp // "?")] \(.type|ascii_upcase) ━━━\n" +
  (if (.message.content|type)=="string" then .message.content
   else (.message.content
         | map(
             if .type=="text" then .text
             elif .type=="tool_use" then "▸ [tool_use] \(.name)\n  입력: \(.input|tostring|.[0:300])"
             elif .type=="tool_result" then "◂ [tool_result]\n  \((.content|tostring)[0:300])"
             else ""
             end)
         | join("\n"))
   end)
' "$FILE"
```

`--last N` 옵션 처리 시 `jq` 출력 뒤에 구분자로 분할 후 마지막 N블록만 표시(또는 파일 자체를 `tail -n $((N*2))` 처리 후 jq).

## 규칙

- **경로 규칙** — base는 `$HOME/.claude/projects/`(install.sh가 호출 사용자 홈에 설치하므로 이식성 확보), slug는 cwd에서 동적 계산(`pwd -P` → `/`를 `-`로 치환).
- `agent-*.jsonl`은 서브에이전트 로그이므로 기본 제외
- 민감정보(토큰/키) 노출 우려 시 사용자에게 경고 후 출력
- 출력이 길면 `less -R`로 파이프 권장
- 도구 호출 본문은 300자로 절단(전체 보려면 `--tools --full` 확장 고려)

## 사용 시점

- 현재 세션에서 무엇을 주고받았는지 시간순으로 확인
- 특정 세션 복기 (`/jhw:cclog <path>`)
- 최근 N턴만 빠르게 훑기 (`--last N`)
