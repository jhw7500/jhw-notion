---
description: 작업내역 통합 조회 — 세션·노션·깃을 시간순 타임라인으로 머지 (다중 소스 옵션)
argument-hint: "[--source session,notion,git] [--last N] [--since <when>] [--tools] [--author <name>]"
---

# /jhw:load — 작업내역 통합 조회 (세션 · 노션 · 깃)

현재 프로젝트(cwd)의 작업내역을 **세 소스에서 끌어와 하나의 시간순 타임라인**으로 머지한다.

- **세션** — Claude Code 세션 JSONL (입력/출력, 옵션으로 도구 호출) — `/jhw:cclog` 백엔드와 동일
- **노션** — Notion AI Workspace 프로젝트 타임라인 (시작 + 결정 이벤트) — `jhw_history` MCP 도구
- **깃** — 현재 레포의 커밋 로그 (`git log`)

세 소스는 모두 "현재 프로젝트/cwd"라는 공통 축으로 묶인다. 조회 전용이며 어떤 데이터도 수정하지 않는다.

## 인자 / 옵션

- `--source <list>` — 콤마 구분 부분집합 `{session, notion, git}`. **생략 시 셋 다.**
  - 단축 플래그 `--session` / `--notion` / `--git` 중 하나라도 있으면 **명시된 것만** 사용 (기본 전체를 덮어씀)
  - `--source`와 단축 플래그가 함께 오면 **`--source`가 우선**이며 단축 플래그는 무시된다
- `--last N` — 소스별 최근 N개 (깃: 커밋 N개, 세션: 메시지 N턴, 노션: 이벤트 N개). **기본값: 깃 20 · 세션 30 · 노션 20.** (cclog의 기본 "전체"와 달리, 머지 타임라인을 한정하려 소스별 상한을 둔다.)
- `--since <when>` — 기간 경계. 깃 `--since`로 전달, 세션·노션은 그 날짜 이후 이벤트만. 예: `--since today`, `--since "1 week ago"`, `--since 2026-06-01`. (`--since` 지정 시 `--last` 상한은 보조로 함께 적용)
- `--tools` — 세션 소스에 도구 호출(tool_use) 요약까지 포함 (cclog `--tools`와 동일)
- `--author <name>` — 깃 author 필터 (기본: 전체)

## 동작 순서

1. **소스 · 기간 파싱**
   - `--source` 또는 단축 플래그로 활성 소스 집합 결정 (둘 다 오면 `--source` 우선, 기본 셋 다)
   - `--last` / `--since` 로 소스별 한도 변수 설정 (`GIT_N`, `SES_N`, `SINCE`)
   - `PROJECT="$(basename "$(pwd -P)")"` — 노션 프로젝트 resolve 키워드

2. **로컬 타임라인 생성 (bash — 세션 + 깃)**
   - 세션·깃은 로컬에서 `EPOCH<TAB>[src]<TAB>본문` 라인으로 뽑아 epoch 기준 머지·정렬 (아래 구현 예시)
   - epoch는 절대시각이라 두 소스를 안전하게 한 줄로 섞을 수 있고, 출력은 **로컬 타임존**으로 변환해 표기

3. **노션 이벤트 조회 (MCP — bash 파이프 불가)**
   - 노션 소스가 활성일 때만 `jhw_history` 호출: `project = PROJECT`
   - 반환 JSON의 `timeline[]` (각 `{date, type, title, status}`)을 사용
   - 노션 이벤트는 **날짜 단위(date-only)** — 시각이 없으므로 해당 날짜 `00:00`(그 날짜 블록 맨 앞)에 배치
   - `--since` / `--last` 가 있으면 `date >= SINCE`로 필터한 뒤 최근 N개로 절단 (깃과 동일 순서)

4. **머지 출력 (어시스턴트)**
   - 2의 로컬 타임라인(시각 있음)과 3의 노션 이벤트(날짜만)를 **시각 기준으로 인터리브**하여 단일 타임라인으로 출력
   - 한 줄 포맷: `MM-DD HH:MM  [src]      본문`
   - 날짜가 바뀌면 구분선/날짜 헤더로 가독성 보강 (date-only 노션 이벤트는 그 날짜 블록 맨 앞 = 00:00으로 정렬)
   ```
   06-19 00:00  [notion]   decision: worklog 스킬 신설 (in-progress)
   06-19 12:01  [git]      feat(cclog): 이식성 수정
   06-19 12:04  [session]  U: 작업내역 스킬 만들어줘
   06-19 12:09  [session]  A: 설계 확정 — /jhw:load …
   06-19 14:02  [git]      docs(skills): AGENTS 동기화
   ```

5. **요약 라인** — 끝에 `총 N건 (session S / notion K / git G) · 기간 …` 출력

## 구현 예시 (로컬 타임라인 — 세션 + 깃)

```bash
SESSION_DIR="$HOME/.claude/projects/$(pwd -P | sed 's#/#-#g')"
GIT_N="${GIT_N:-20}"; SES_N="${SES_N:-30}"

emit_git() {
  git rev-parse --git-dir >/dev/null 2>&1 || return 0
  git log -n "$GIT_N" ${SINCE:+--since="$SINCE"} ${AUTHOR:+--author="$AUTHOR"} \
    --pretty=format:'%ct%x09[git]%x09%s' 2>/dev/null
  echo
}

emit_session() {
  local f
  f="$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | grep -v '/agent-' | head -1)"
  [ -n "$f" ] || return 0
  jq -r '
    select(.type=="user" or .type=="assistant") | select(.timestamp) |
    ((if (.message.content|type)=="string" then .message.content
      else (.message.content|map(select(.type=="text")|.text)|join(" ")) end)
     | gsub("\\s+";" ") | gsub("^ | $";"")) as $txt |
    select($txt|length>0) |
    select($txt|test("^<(command-|local-command|bash-|system-reminder|task-notification)")|not) |
    ((try (.timestamp|sub("\\.[0-9]+";"")|fromdateiso8601) catch 0)|tostring)
      + "\t[session]\t" + (.type[0:1]|ascii_upcase) + ": " + ($txt[0:160])
  ' "$f" | tail -n "$SES_N"
}

# 활성 소스만 emit (기본 둘 다). 정렬·로컬TZ 변환.
{ emit_git; emit_session; } \
  | awk -F'\t' '($1+0)>0' \
  | sort -n -k1,1 -s \
  | while IFS=$'\t' read -r ep src txt; do
      printf '%s  %-9s %s\n' "$(date -d "@$ep" '+%m-%d %H:%M' 2>/dev/null || echo '??-?? ??:??')" "$src" "$txt"
    done
```

- `--source`에서 빠진 로컬 소스는 해당 `emit_*` 호출을 생략한다.
- `--tools` 지정 시 `emit_session`의 jq를 `cclog.md` §구현 예시의 `tool_use` 분기와 같이 `tool_use` 블록(`▸ 도구명`)까지 포함하도록 확장한다.
- 노션은 위 파이프에 못 섞으므로(MCP 결과는 셸이 아닌 어시스턴트로 반환) 별도 조회 후 4단계에서 어시스턴트가 머지한다.

## 노션 조회 예시 (MCP)

```
jhw_history(project="<cwd basename>")
→ { project, totalEvents, timeline: [ {date, type:"project|decision", title, status} ] }
```

- `type:"project"` = 프로젝트 시작, `type:"decision"` = 결정 로그 항목
- 각 이벤트 → `MM-DD 00:00  [notion]  <type>: <title> (<status>)` 로 변환해 로컬 타임라인과 인터리브

## 규칙

- **조회 전용** — 세션/노션/깃 어느 것도 수정하지 않는다.
- **경로 규칙** — 세션 base는 `$HOME/.claude/projects/`, slug는 cwd 절대경로의 `/`→`-` 치환 (cclog/import와 동일).
- **타임존 일관성** — 세션 타임스탬프(UTC Z)와 깃 `%ct`(epoch)는 모두 절대시각이므로 `date -d @epoch`로 **로컬 TZ 통일** 표기. 노션은 날짜만 있어 `00:00`에 배치.
- **세션 파싱 전제** — 세션 소스는 `jq` 필요. 타임스탬프는 UTC-Z 포맷을 가정하며, 파싱 실패 행은 조용히 제외된다. 하니스 주입 노이즈(`<command-*>` / `<local-command*>` / `<bash-*>` / `<system-reminder>` / `<task-notification>`)로 시작하는 행도 제외.
- **노션 결손 허용** — `jhw_history`가 "프로젝트를 찾을 수 없습니다" 또는 어떤 오류(timeout/auth 등)든 반환하면 노션 소스만 빈 채로 두고 세션/깃 타임라인은 그대로 출력 (전체 중단 금지).
- **빈 결과** — 모든 활성 소스가 0건이면 빈 타임라인 대신 「조회 결과 없음 (소스: …)」를 출력한다.
- **에이전트 로그 제외** — `agent-*.jsonl`은 서브에이전트 로그이므로 기본 제외 (cclog와 동일).
- **민감정보** — 토큰/키 노출 우려 시 사용자에게 경고 후 출력. 본문은 160자로 절단.
- **`--last` 의미** — 소스별 "최근 N개"라 소스마다 커버하는 기간이 다를 수 있다(깃 20커밋 vs 세션 30턴). 기간을 맞추려면 `--since`를 쓴다.

## 사용 예시

- `/jhw:load` — 현재 프로젝트의 세 소스 최근 작업내역을 통합 타임라인으로
- `/jhw:load --session --git` — 로컬(세션+깃)만, 노션 MCP 생략 (빠름)
- `/jhw:load --source notion,git --since "1 week ago"` — 최근 1주 노션 결정 + 깃 커밋
- `/jhw:load --last 50 --tools` — 더 길게 + 세션 도구 호출까지
- `/jhw:load --git --author hwjo --since today` — 오늘 내 커밋만

## 사용 시점

- "오늘/이번 주 뭐 했지" 회고 — 세션 대화 + 커밋 + 결정 로그를 한눈에
- 세션 복기와 형상 변경(깃)·의사결정(노션)을 **같은 시간축**에서 대조
- 단일 소스만 빠르게 보려면 기존 `/jhw:cclog`(세션) · `/jhw:recall <프로젝트> --history`(노션) 직접 호출

## 참고

- 세션만: `/jhw:cclog` — 본 스킬 세션 소스의 단일·상세 버전 (`--tools`, `--last N`, 특정 세션 경로 지정)
- 노션만: `/jhw:recall <프로젝트명> --history` — 본 스킬 노션 소스의 단일 버전
- 깃 단독 조회 스킬은 없음 — 본 스킬의 `--git`이 그 역할
