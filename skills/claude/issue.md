---
description: "GitHub 이슈 생성 · --review 지원 리뷰어 요청·대기·요약 · --no-review 리뷰 생략 · --timeout 대기한도"
argument-hint: "[title/body] [--review|--no-review] [--timeout <min>]"
---

# /jhw:issue — 좁은 GitHub Issue 생성 + 선택적 리뷰

한 개의 nonempty title/body로 현재 저장소에 Issue를 만든다. `--review`는 실행 시 증명된
지원 reviewer만 요청하고, `--no-review`는 `review:skip`을 적용해 mention을 만들지 않는다.
두 옵션을 생략하면 전역 `review.auto`를 따르며, 키가 없으면 호환 기본값 `true`다.

이 명령은 assignee, milestone, project, bulk edit를 지원하지 않는다. 리뷰 결과를 받아도 Issue를
수정·닫기·삭제하거나 구현을 시작하지 않으며 URL과 reviewer별 결과만 보고한다.

## 생성·reviewer preflight 계약

고정 순서는 `옵션/content 검증 → write/라벨 정의 preflight → reviewer 발견 → Issue 생성 →
mode 라벨 reconcile/read-back → reviewer별 actor-owned mention`이다. 명시적 `--review`에서
eligible reviewer가 0명이면 Issue 생성 전에 중단한다.

| Reviewer | Required evidence |
| --- | --- |
| Claude | `.github/workflows/claude.yml` regular file + `workflows.claude.enabled: true` |
| Gemini | `.github/workflows/gemini-dispatch.yml` regular file + `workflows.gemini-dispatch.enabled: true` |
| Codex | 동일 저장소 canary Issue에서 actor-owned Codex 요청 뒤 하나의 Codex bot identity가 응답 |

Gemini Assist와 OpenCode는 PR-only라 Issue reviewer로 추정하지 않는다. secret 값은 조회하거나
존재를 추정하지 않는다. Codex canary 증거는 이 invocation에서만 쓰고 파일·환경 프로필·DB에
저장하지 않는다.

<!-- issue-review-create-contract:begin -->
```bash
JHW_ISSUE_REVIEW_REQUEST_LABEL='review:request'
JHW_ISSUE_REVIEW_SKIP_LABEL='review:skip'
JHW_ISSUE_REVIEW_REQUEST_COLOR='0E8A16'
JHW_ISSUE_REVIEW_SKIP_COLOR='B60205'
JHW_ISSUE_REVIEW_REQUEST_DESCRIPTION='Explicitly request AI review'
JHW_ISSUE_REVIEW_SKIP_DESCRIPTION='Explicitly skip AI review'

jhw_issue_review_mode_from_args() {
  local arg saw_review=0 saw_no_review=0
  for arg in "$@"; do
    case "$arg" in
      --review) saw_review=1 ;;
      --no-review) saw_no_review=1 ;;
    esac
  done
  (( saw_review == 0 || saw_no_review == 0 )) || {
    echo "--review and --no-review are mutually exclusive" >&2
    return 2
  }
  (( saw_review == 1 )) && { printf 'request\n'; return; }
  (( saw_no_review == 1 )) && { printf 'skip\n'; return; }
  printf 'auto\n'
}

jhw_issue_validate_timeout() {
  local value="${1:-20}"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || {
    echo "invalid --timeout" >&2
    return 2
  }
  printf '%s\n' "$value"
}

jhw_issue_global_auto_enabled() {
  local config_path="${1:-${JHW_ISSUE_CONFIG_PATH:-.github/workflow-config.yml}}"
  if [[ ! -e "$config_path" ]]; then
    printf 'true\n'
    return
  fi
  [[ -f "$config_path" && ! -L "$config_path" ]] || {
    echo "workflow config must be a regular file" >&2
    return 2
  }
  node - "$config_path" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const fail = (message) => { process.stderr.write(message + "\n"); process.exit(2); };
let text;
try {
  text = fs.readFileSync(path, "utf8").replace(/^\uFEFF/, "");
} catch {
  fail("workflow config read failed");
}
let seenReview = false;
let inReview = false;
let childIndent = null;
let seenAuto = false;
let autoValue = null;
for (const rawLine of text.split(/\r?\n/)) {
  if (/\t/.test(rawLine.match(/^\s*/)?.[0] || "")) fail("workflow config tabs are unsupported");
  const trimmed = rawLine.trim();
  if (trimmed === "" || trimmed.startsWith("#")) continue;
  const indent = rawLine.length - rawLine.trimStart().length;
  if (indent === 0) {
    inReview = false;
    childIndent = null;
    const top = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:(.*)$/);
    if (!top) {
      if (/^["']review["']\s*:/.test(trimmed)) fail("quoted review key is unsupported");
      continue;
    }
    if (top[1] !== "review") continue;
    if (seenReview) fail("duplicate review key");
    seenReview = true;
    if (top[2].replace(/\s+#.*$/, "").trim() !== "") fail("inline review mapping is unsupported");
    inReview = true;
    continue;
  }
  if (!inReview) continue;
  if (childIndent === null) childIndent = indent;
  if (indent !== childIndent) continue;
  const child = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:(.*)$/);
  if (!child || child[1] !== "auto") continue;
  if (seenAuto) fail("duplicate review.auto key");
  seenAuto = true;
  const value = child[2].replace(/\s+#.*$/, "").trim();
  if (value !== "true" && value !== "false") fail("review.auto must be boolean");
  autoValue = value;
}
process.stdout.write((seenAuto ? autoValue : "true") + "\n");
NODE
}

jhw_issue_workflow_enabled() {
  local workflow_key="$1" config_path="${2:-${JHW_ISSUE_CONFIG_PATH:-.github/workflow-config.yml}}"
  case "$workflow_key" in claude|gemini-dispatch) ;; *) return 2 ;; esac
  [[ -f "$config_path" && ! -L "$config_path" ]] || { printf 'false\n'; return; }
  node - "$config_path" "$workflow_key" <<'NODE'
const fs = require("node:fs");
const [path, wanted] = process.argv.slice(2);
const fail = (message) => { process.stderr.write(message + "\n"); process.exit(2); };
let text;
try { text = fs.readFileSync(path, "utf8").replace(/^\uFEFF/, ""); }
catch { fail("workflow config read failed"); }
const entries = [];
for (const raw of text.split(/\r?\n/)) {
  if (/\t/.test(raw.match(/^\s*/)?.[0] || "")) fail("workflow config tabs are unsupported");
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("#")) continue;
  const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:(.*)$/);
  if (!match) continue;
  entries.push({ indent: raw.length - raw.trimStart().length, key: match[1], value: match[2].replace(/\s+#.*$/, "").trim() });
}
const workflowRoots = entries.filter((entry) => entry.indent === 0 && entry.key === "workflows");
if (workflowRoots.length > 1) fail("duplicate workflows key");
if (workflowRoots.length === 0 || workflowRoots[0].value !== "") { process.stdout.write("false\n"); process.exit(0); }
const rootIndex = entries.indexOf(workflowRoots[0]);
const afterRoot = entries.slice(rootIndex + 1);
const rootEnd = afterRoot.findIndex((entry) => entry.indent === 0);
const scope = rootEnd < 0 ? afterRoot : afterRoot.slice(0, rootEnd);
const workflowEntries = scope.filter((entry) => entry.key === wanted && entry.value === "");
if (workflowEntries.length > 1) fail("duplicate workflow key");
if (workflowEntries.length === 0) { process.stdout.write("false\n"); process.exit(0); }
const workflow = workflowEntries[0];
const workflowIndex = scope.indexOf(workflow);
const afterWorkflow = scope.slice(workflowIndex + 1);
const workflowEnd = afterWorkflow.findIndex((entry) => entry.indent <= workflow.indent);
const workflowScope = workflowEnd < 0 ? afterWorkflow : afterWorkflow.slice(0, workflowEnd);
const enabled = workflowScope.filter((entry) => entry.indent > workflow.indent && entry.key === "enabled");
if (enabled.length > 1) fail("duplicate workflow enabled key");
if (enabled.length === 0) { process.stdout.write("false\n"); process.exit(0); }
if (enabled[0].value !== "true" && enabled[0].value !== "false") fail("workflow enabled must be boolean");
process.stdout.write(enabled[0].value + "\n");
NODE
}

jhw_issue_validate_context() {
  [[ "${REPO_NWO:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo "invalid REPO_NWO" >&2
    return 2
  }
}

jhw_issue_require_write_permission() {
  local permission
  jhw_issue_validate_context || return
  permission="$(gh repo view "$REPO_NWO" --json viewerPermission -q .viewerPermission)" || return 1
  case "$permission" in
    ADMIN|MAINTAIN|WRITE) ;;
    *) echo "repository write permission required" >&2; return 1 ;;
  esac
}

jhw_issue_ensure_review_labels() {
  local labels
  labels="$(gh label list --repo "$REPO_NWO" --limit 1000 --json name --jq '.[].name')" || return 1
  if ! grep -Fqx -- "$JHW_ISSUE_REVIEW_REQUEST_LABEL" <<<"$labels"; then
    gh label create "$JHW_ISSUE_REVIEW_REQUEST_LABEL" --repo "$REPO_NWO" \
      --color "$JHW_ISSUE_REVIEW_REQUEST_COLOR" --description "$JHW_ISSUE_REVIEW_REQUEST_DESCRIPTION" >/dev/null || return 1
  fi
  if ! grep -Fqx -- "$JHW_ISSUE_REVIEW_SKIP_LABEL" <<<"$labels"; then
    gh label create "$JHW_ISSUE_REVIEW_SKIP_LABEL" --repo "$REPO_NWO" \
      --color "$JHW_ISSUE_REVIEW_SKIP_COLOR" --description "$JHW_ISSUE_REVIEW_SKIP_DESCRIPTION" >/dev/null || return 1
  fi
}

jhw_issue_is_utc_timestamp() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

jhw_issue_codex_canary_eligible() {
  local canary_url="$1" canary_repo canary_issue actor endpoint query raw line
  local request_id request_at extra response_actor response_at response_url identity=""
  local -a requests=()
  [[ -n "$canary_url" ]] || return 1
  if [[ "$canary_url" =~ ^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/issues/([1-9][0-9]*)/?$ ]]; then
    canary_repo="${BASH_REMATCH[1]}"
    canary_issue="${BASH_REMATCH[2]}"
  else
    echo "Codex canary must be a GitHub Issue URL" >&2
    return 1
  fi
  [[ "$canary_repo" == "$REPO_NWO" ]] || {
    echo "Codex canary repository mismatch" >&2
    return 1
  }
  actor="$(gh api user --jq '.login' 2>/dev/null)" || return 1
  [[ "$actor" =~ ^[A-Za-z0-9-]+$ ]] || return 1
  endpoint="repos/$REPO_NWO/issues/$canary_issue/comments?per_page=100"
  query=".[] | select(.user.login == \"$actor\" and ((.body // \"\") | contains(\"<!-- jhw-issue:review-request reviewer=codex -->\"))) | [.id, .created_at] | @tsv"
  raw="$(gh api "$endpoint" --paginate --jq "$query" 2>/dev/null)" || return 1
  if [[ -n "$raw" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && requests[${#requests[@]}]="$line"
    done <<<"$raw"
  fi
  [[ "${#requests[@]}" -eq 1 ]] || return 1
  IFS=$'\t' read -r request_id request_at extra <<<"${requests[0]}"
  [[ "$request_id" =~ ^[1-9][0-9]*$ && -n "$request_at" && -z "$extra" ]] || return 1
  jhw_issue_is_utc_timestamp "$request_at" || return 1
  raw="$(gh api "$endpoint" --paginate --jq '.[] | [.user.login, .created_at, .html_url] | @tsv' 2>/dev/null)" || return 1
  while IFS=$'\t' read -r response_actor response_at response_url; do
    case "$response_actor" in
      chatgpt-codex-connector|chatgpt-codex-connector'[bot]') ;;
      *) continue ;;
    esac
    jhw_issue_is_utc_timestamp "$response_at" || continue
    [[ "$response_at" > "$request_at" && -n "$response_url" ]] || continue
    if [[ -n "$identity" && "$identity" != "$response_actor" ]]; then
      echo "ambiguous Codex bot identity" >&2
      return 1
    fi
    identity="$response_actor"
  done <<<"$raw"
  [[ -n "$identity" ]]
}

jhw_issue_discover_reviewers() {
  local mode="$1" auto_enabled="$2" root="${JHW_ISSUE_REPO_ROOT:-.}"
  local config_path="${JHW_ISSUE_CONFIG_PATH:-$root/.github/workflow-config.yml}"
  case "$mode" in request|skip|auto) ;; *) return 2 ;; esac
  case "$auto_enabled" in true|false) ;; *) return 2 ;; esac
  [[ "$mode" == request || ( "$mode" == auto && "$auto_enabled" == true ) ]] || return 0
  if [[ -f "$root/.github/workflows/claude.yml" && ! -L "$root/.github/workflows/claude.yml" ]] &&
    [[ "$(jhw_issue_workflow_enabled claude "$config_path")" == true ]]; then
    printf 'claude\n'
  fi
  if [[ -f "$root/.github/workflows/gemini-dispatch.yml" && ! -L "$root/.github/workflows/gemini-dispatch.yml" ]] &&
    [[ "$(jhw_issue_workflow_enabled gemini-dispatch "$config_path")" == true ]]; then
    printf 'gemini\n'
  fi
  if jhw_issue_codex_canary_eligible "${JHW_ISSUE_CODEX_CANARY_URL:-}"; then
    printf 'codex\n'
  fi
}

jhw_issue_reconcile_and_verify_policy() {
  local issue="$1" mode="$2" labels has_request=0 has_skip=0
  [[ "$issue" =~ ^[1-9][0-9]*$ ]] || return 2
  labels="$(gh issue view "$issue" --repo "$REPO_NWO" --json labels --jq '.labels[].name')" || return 1
  case "$mode" in
    request)
      grep -Fqx -- "$JHW_ISSUE_REVIEW_SKIP_LABEL" <<<"$labels" &&
        gh issue edit "$issue" --repo "$REPO_NWO" --remove-label "$JHW_ISSUE_REVIEW_SKIP_LABEL" >/dev/null
      grep -Fqx -- "$JHW_ISSUE_REVIEW_REQUEST_LABEL" <<<"$labels" ||
        gh issue edit "$issue" --repo "$REPO_NWO" --add-label "$JHW_ISSUE_REVIEW_REQUEST_LABEL" >/dev/null
      ;;
    skip)
      grep -Fqx -- "$JHW_ISSUE_REVIEW_REQUEST_LABEL" <<<"$labels" &&
        gh issue edit "$issue" --repo "$REPO_NWO" --remove-label "$JHW_ISSUE_REVIEW_REQUEST_LABEL" >/dev/null
      grep -Fqx -- "$JHW_ISSUE_REVIEW_SKIP_LABEL" <<<"$labels" ||
        gh issue edit "$issue" --repo "$REPO_NWO" --add-label "$JHW_ISSUE_REVIEW_SKIP_LABEL" >/dev/null
      ;;
    auto)
      grep -Fqx -- "$JHW_ISSUE_REVIEW_REQUEST_LABEL" <<<"$labels" &&
        gh issue edit "$issue" --repo "$REPO_NWO" --remove-label "$JHW_ISSUE_REVIEW_REQUEST_LABEL" >/dev/null
      grep -Fqx -- "$JHW_ISSUE_REVIEW_SKIP_LABEL" <<<"$labels" &&
        gh issue edit "$issue" --repo "$REPO_NWO" --remove-label "$JHW_ISSUE_REVIEW_SKIP_LABEL" >/dev/null
      ;;
    *) return 2 ;;
  esac
  labels="$(gh issue view "$issue" --repo "$REPO_NWO" --json labels --jq '.labels[].name')" || return 1
  grep -Fqx -- "$JHW_ISSUE_REVIEW_REQUEST_LABEL" <<<"$labels" && has_request=1
  grep -Fqx -- "$JHW_ISSUE_REVIEW_SKIP_LABEL" <<<"$labels" && has_skip=1
  (( has_request == 0 || has_skip == 0 )) || { echo "conflicting review labels" >&2; return 1; }
  case "$mode" in
    request) (( has_request == 1 && has_skip == 0 )) || return 1 ;;
    skip) (( has_request == 0 && has_skip == 1 )) || return 1 ;;
    auto) (( has_request == 0 && has_skip == 0 )) || return 1 ;;
  esac
}

jhw_issue_request_reviewer() {
  local issue="$1" reviewer="$2" command marker body actor endpoint query raw line id created_at extra
  local -a matches=()
  [[ "$issue" =~ ^[1-9][0-9]*$ ]] || return 2
  case "$reviewer" in
    claude) command='@claude 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.' ;;
    gemini) command='@gemini-cli 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.' ;;
    codex) command='@codex 이 이슈의 요구사항·누락 조건·구현 위험을 검토해 주세요.' ;;
    *) echo "unsupported Issue reviewer" >&2; return 2 ;;
  esac
  actor="$(gh api user --jq '.login' 2>/dev/null)" || { echo "FAILED: actor_lookup_failed" >&2; return 1; }
  [[ "$actor" =~ ^[A-Za-z0-9-]+$ ]] || { echo "FAILED: invalid_actor" >&2; return 1; }
  marker="<!-- jhw-issue:review-request reviewer=$reviewer -->"
  body="$command
$marker"
  endpoint="repos/$REPO_NWO/issues/$issue/comments?per_page=100"
  query=".[] | select(.user.login == \"$actor\" and ((.body // \"\") | contains(\"$marker\"))) | [.id, .created_at] | @tsv"
  raw="$(gh api "$endpoint" --paginate --jq "$query" 2>/dev/null)" || {
    echo "FAILED: request_lookup_failed" >&2
    return 1
  }
  if [[ -n "$raw" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && matches[${#matches[@]}]="$line"
    done <<<"$raw"
  fi
  case "${#matches[@]}" in
    0)
      raw="$(gh api "$endpoint" -X POST -f "body=$body" --jq '[.id, .created_at] | @tsv' 2>/dev/null)" || {
        echo "FAILED: request_post_failed" >&2
        return 1
      }
      matches=("$raw")
      ;;
    1) ;;
    *) echo "FAILED: duplicate_request_marker" >&2; return 1 ;;
  esac
  [[ "${#matches[@]}" -eq 1 ]] || { echo "FAILED: invalid_request_response" >&2; return 1; }
  IFS=$'\t' read -r id created_at extra <<<"${matches[0]}"
  [[ "$id" =~ ^[1-9][0-9]*$ && -n "$created_at" && -z "$extra" ]] || {
    echo "FAILED: invalid_request_response" >&2
    return 1
  }
  printf '%s\n' "$id"
}

jhw_issue_create() {
  local title="$1" body="$2" mode="$3" timeout="$4"
  local auto_enabled=false reviewers issue_url issue request_id reviewer
  [[ -n "${title//[[:space:]]/}" ]] || { echo "Issue title is required" >&2; return 2; }
  [[ -n "${body//[[:space:]]/}" ]] || { echo "Issue body is required" >&2; return 2; }
  case "$mode" in request|skip|auto) ;; *) echo "invalid review mode" >&2; return 2 ;; esac
  timeout="$(jhw_issue_validate_timeout "$timeout")" || return
  JHW_ISSUE_TIMEOUT_MIN="$timeout"
  jhw_issue_validate_context || return
  jhw_issue_require_write_permission || return
  jhw_issue_ensure_review_labels || return
  if [[ "$mode" == auto ]]; then
    auto_enabled="$(jhw_issue_global_auto_enabled "${JHW_ISSUE_CONFIG_PATH:-}")" || return
  elif [[ "$mode" == request ]]; then
    auto_enabled=true
  fi
  reviewers="$(jhw_issue_discover_reviewers "$mode" "$auto_enabled")" || return
  if [[ "$mode" == request && -z "$reviewers" ]]; then
    echo "no eligible Issue reviewer" >&2
    return 1
  fi
  issue_url="$(gh issue create --repo "$REPO_NWO" --title "$title" --body "$body")" || return 1
  issue="$(gh issue view "$issue_url" --repo "$REPO_NWO" --json number --jq .number)" || return 1
  [[ "$issue" =~ ^[1-9][0-9]*$ ]] || { echo "invalid created Issue" >&2; return 1; }
  jhw_issue_reconcile_and_verify_policy "$issue" "$mode" || return
  if [[ -n "$reviewers" ]]; then
    while IFS= read -r reviewer; do
      [[ -n "$reviewer" ]] || continue
      request_id="$(jhw_issue_request_reviewer "$issue" "$reviewer")" || return
      [[ "$request_id" =~ ^[1-9][0-9]*$ ]] || return 1
    done <<<"$reviewers"
  fi
  printf '%s\n' "$issue_url"
}
```
<!-- issue-review-create-contract:end -->

## bounded review wait 계약

요청된 reviewer만 private invocation state에서 추적한다. 한 번의 collect/classify pass는 read-only이며,
agent harness가 약 60초 간격으로 모든 요청 reviewer가 terminal이거나 전체 deadline에 도달할 때까지
반복한다. untracked `&`/`nohup`과 60초를 넘는 foreground sleep은 사용하지 않는다.

<!-- issue-review-wait-contract:begin -->
```bash
jhw_issue_collect_signals() {
  local issue="$1" request_comment_id="$2" issue_created_at="$3"
  local actor comments reactions runs
  [[ "$issue" =~ ^[1-9][0-9]*$ ]] || return 2
  [[ "$request_comment_id" =~ ^[1-9][0-9]*$ ]] || return 2
  jhw_issue_is_utc_timestamp "$issue_created_at" || return 2
  actor="$(gh api user --jq '.login' 2>/dev/null)" || return 1
  [[ "$actor" =~ ^[A-Za-z0-9-]+$ ]] || return 1
  comments="$(gh api "repos/$REPO_NWO/issues/$issue/comments?per_page=100" --paginate \
    --jq '[.[] | {id, actor:.user.login, created_at:.created_at, body:(.body // ""), url:.html_url}]' 2>/dev/null)" || return 1
  reactions="$(gh api "repos/$REPO_NWO/issues/comments/$request_comment_id/reactions?per_page=100" --paginate \
    --jq '[.[] | {actor:.user.login, content:.content, created_at:.created_at, url:.html_url}]' 2>/dev/null)" || return 1
  runs="$(gh api "repos/$REPO_NWO/actions/runs?per_page=100" --paginate \
    --jq '[.workflow_runs[] | {id, name:.name, event:.event, status:.status, conclusion:(.conclusion // "null"), created_at:.created_at, url:.html_url}]' 2>/dev/null)" || return 1
  JHW_ISSUE_COMMENTS_JSON="$comments" \
  JHW_ISSUE_REACTIONS_JSON="$reactions" \
  JHW_ISSUE_RUNS_JSON="$runs" \
  node - "$issue" "$request_comment_id" "$issue_created_at" "$actor" <<'NODE'
const [issue, requestCommentId, issueCreatedAt, requestActor] = process.argv.slice(2);
const fail = (message) => { process.stderr.write(message + "\n"); process.exit(1); };
const parseArray = (name) => {
  try {
    const value = JSON.parse(process.env[name] || "");
    if (!Array.isArray(value)) fail(`${name} must be an array`);
    return value;
  } catch {
    fail(`${name} is invalid JSON`);
  }
};
const snapshot = {
  issue: Number(issue),
  request_comment_id: Number(requestCommentId),
  issue_created_at: issueCreatedAt,
  request_actor: requestActor,
  comments: parseArray("JHW_ISSUE_COMMENTS_JSON"),
  reactions: parseArray("JHW_ISSUE_REACTIONS_JSON"),
  runs: parseArray("JHW_ISSUE_RUNS_JSON"),
};
process.stdout.write(JSON.stringify(snapshot) + "\n");
NODE
}

jhw_issue_classify_reviewer() {
  local reviewer="$1" now_epoch="$2" trigger_deadline="$3" review_deadline="$4"
  local expected_bot workflow_name result state response diagnostic extra eligible
  [[ "$now_epoch" =~ ^[0-9]+$ && "$trigger_deadline" =~ ^[0-9]+$ && "$review_deadline" =~ ^[0-9]+$ ]] || return 2
  (( review_deadline >= trigger_deadline )) || return 2
  eligible="${JHW_ISSUE_REVIEWER_ELIGIBLE:-true}"
  case "$eligible" in true|false) ;; *) return 2 ;; esac
  case "$reviewer" in
    claude)
      expected_bot="${JHW_ISSUE_EXPECTED_CLAUDE_BOT:-claude-review[bot]}"
      workflow_name='Claude Code'
      ;;
    gemini)
      expected_bot="${JHW_ISSUE_EXPECTED_GEMINI_BOT:-gemini-review[bot]}"
      workflow_name='Gemini Dispatch'
      ;;
    codex)
      expected_bot="${JHW_ISSUE_EXPECTED_CODEX_BOT:-chatgpt-codex-connector[bot]}"
      workflow_name=''
      ;;
    *) return 2 ;;
  esac
  [[ "$expected_bot" =~ ^[A-Za-z0-9_.-]+(\[bot\])?$ ]] || return 2
  result="$(node - "$reviewer" "$now_epoch" "$trigger_deadline" "$review_deadline" \
    "$expected_bot" "$workflow_name" "$eligible" <<'NODE'
const [reviewer, nowRaw, triggerRaw, reviewRaw, expectedBot, workflowName, eligibleRaw] = process.argv.slice(2);
const now = Number(nowRaw);
const triggerDeadline = Number(triggerRaw);
const reviewDeadline = Number(reviewRaw);
const emit = (state, response, diagnostic) => {
  process.stdout.write([state, response || "-", diagnostic].join("\t") + "\n");
  process.exit(0);
};
if (eligibleRaw === "false") emit("UNAVAILABLE", "", "preflight_unavailable");
let snapshot;
try { snapshot = JSON.parse(process.env.JHW_ISSUE_SIGNAL_JSON || ""); }
catch { process.stderr.write("invalid signal snapshot\n"); process.exit(1); }
if (!snapshot || !Array.isArray(snapshot.comments) || !Array.isArray(snapshot.reactions) || !Array.isArray(snapshot.runs)) {
  process.stderr.write("invalid signal snapshot\n"); process.exit(1);
}
const epoch = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
  const parsed = Date.parse(value) / 1000;
  return Number.isInteger(parsed) ? parsed : null;
};
const issueEpoch = epoch(snapshot.issue_created_at);
if (issueEpoch === null) { process.stderr.write("invalid Issue timestamp\n"); process.exit(1); }
const marker = `<!-- jhw-issue:review-request reviewer=${reviewer} -->`;
const requests = snapshot.comments.filter((comment) =>
  Number(comment.id) === Number(snapshot.request_comment_id) &&
  comment.actor === snapshot.request_actor &&
  typeof comment.body === "string" && comment.body.includes(marker) &&
  epoch(comment.created_at) !== null && epoch(comment.created_at) >= issueEpoch);
if (requests.length !== 1) {
  if (now >= triggerDeadline) emit("FAILED", "", "request_marker_invalid");
  emit("PENDING", "", "request_marker_pending");
}
const request = requests[0];
const requestEpoch = epoch(request.created_at);
const later = (value) => {
  const parsed = epoch(value);
  return parsed !== null && parsed > requestEpoch && parsed >= issueEpoch;
};
const comments = snapshot.comments.filter((comment) =>
  comment.actor === expectedBot && later(comment.created_at));
const reactions = snapshot.reactions.filter((reaction) =>
  reaction.actor === expectedBot && later(reaction.created_at));
const runs = workflowName === "" ? [] : snapshot.runs.filter((run) =>
  run.name === workflowName && ["issue_comment", "issues", "workflow_dispatch"].includes(run.event) && later(run.created_at));

const failedRun = runs.find((run) => run.status === "completed" && !["success", "neutral", "skipped"].includes(run.conclusion));
if (failedRun) emit("FAILED", failedRun.url, "workflow_failed");
const rejectedReaction = reactions.find((reaction) => ["-1", "confused"].includes(reaction.content));
if (rejectedReaction) emit("FAILED", rejectedReaction.url, "connector_rejected");
const rejectedComment = comments.find((comment) =>
  /unable to review|cannot review|connector[^\n]*(?:reject|denied)|failed to (?:start|review)/i.test(comment.body || ""));
if (rejectedComment) emit("FAILED", rejectedComment.url, "connector_rejected");
const feedbackComment = comments.find((comment) =>
  /\[(?:CRITICAL|HIGH)\]|(?:^|[^A-Za-z0-9])P[01](?:[^0-9]|$)|missing requirement|implementation risk|risk:/i.test(comment.body || ""));
if (feedbackComment) emit("FEEDBACK", feedbackComment.url, "actionable_feedback");
if (comments.length > 0) emit("CLEAN", comments[0].url, "substantive_response");

const acknowledged = reactions.some((reaction) => ["eyes", "+1", "heart"].includes(reaction.content)) ||
  runs.some((run) => ["queued", "in_progress", "completed"].includes(run.status));
if (acknowledged && now >= reviewDeadline) emit("TIMEOUT", request.url, "review_timeout");
if (!acknowledged && now >= triggerDeadline) emit("FAILED", request.url, "trigger_unacknowledged");
emit("PENDING", request.url, acknowledged ? "acknowledged" : "awaiting_acknowledgment");
NODE
)" || return 1
  IFS=$'\t' read -r state response diagnostic extra <<<"$result"
  case "$state" in PENDING|CLEAN|FEEDBACK|FAILED|TIMEOUT|UNAVAILABLE) ;; *) return 1 ;; esac
  [[ -n "$response" && -n "$diagnostic" && -z "$extra" ]] || return 1
  [[ "$response" == - ]] && response=""
  JHW_ISSUE_REVIEW_STATUS="$state"
  JHW_ISSUE_REVIEW_RESPONSE="$response"
  JHW_ISSUE_REVIEW_DIAGNOSTIC="$diagnostic"
  printf '%s\n' "$state"
}

jhw_issue_highest_disposition() {
  local state rank best_rank=0 best=CLEAN
  (( $# > 0 )) || return 2
  for state in "$@"; do
    case "$state" in
      CLEAN) rank=1 ;;
      FEEDBACK) rank=2 ;;
      TIMEOUT) rank=3 ;;
      FAILED) rank=4 ;;
      PENDING|UNAVAILABLE) rank=0 ;;
      *) return 2 ;;
    esac
    if (( rank > best_rank )); then
      best_rank="$rank"
      best="$state"
    fi
  done
  printf '%s\n' "$best"
}

jhw_issue_create_state_file() {
  local state_dir="${JHW_ISSUE_STATE_DIR:-${TMPDIR:-/tmp}}" file
  [[ -d "$state_dir" && ! -L "$state_dir" ]] || return 1
  umask 077
  file="$(mktemp "$state_dir/jhw-issue.XXXXXX.state")" || return 1
  chmod 600 "$file" || return 1
  printf '%s\n' "$file"
}

jhw_issue_render_summary() {
  local issue_url="$1" state_file="$2" issue_repo
  if [[ "$issue_url" =~ ^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/issues/[1-9][0-9]*$ ]]; then
    issue_repo="${BASH_REMATCH[1]}"
  else
    return 2
  fi
  [[ "$issue_repo" == "$REPO_NWO" ]] || return 2
  [[ -n "${JHW_ISSUE_STATE_FILE:-}" && "$state_file" == "$JHW_ISSUE_STATE_FILE" ]] || return 2
  [[ -f "$state_file" && ! -L "$state_file" ]] || return 1
  node - "$issue_url" "$state_file" <<'NODE'
const fs = require("node:fs");
const [issueUrl, stateFile] = process.argv.slice(2);
const fail = (message) => { process.stderr.write(message + "\n"); process.exit(1); };
let state;
try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); }
catch { fail("invalid Issue review state"); }
if (!state || !Array.isArray(state.requested) || !Array.isArray(state.unavailable) || !Array.isArray(state.results)) {
  fail("invalid Issue review state");
}
const reviewers = new Set(["claude", "gemini", "codex"]);
const statuses = new Set(["PENDING", "CLEAN", "FEEDBACK", "FAILED", "TIMEOUT", "UNAVAILABLE"]);
const uniqueReviewers = (values, field) => {
  if (values.some((value) => typeof value !== "string" || !reviewers.has(value))) fail(`invalid ${field}`);
  if (new Set(values).size !== values.length) fail(`duplicate ${field}`);
};
uniqueReviewers(state.requested, "requested reviewer");
uniqueReviewers(state.unavailable, "unavailable reviewer");
if (state.requested.some((reviewer) => state.unavailable.includes(reviewer))) fail("reviewer cannot be requested and unavailable");
const seen = new Set();
for (const result of state.results) {
  if (!result || !reviewers.has(result.reviewer) || !statuses.has(result.status)) fail("invalid reviewer result");
  if (seen.has(result.reviewer)) fail("duplicate reviewer result");
  seen.add(result.reviewer);
  if (typeof result.response !== "string" || typeof result.diagnostic !== "string") fail("invalid reviewer result fields");
}
if (state.requested.some((reviewer) => !seen.has(reviewer))) fail("requested reviewer result missing");
const cell = (value) => (value || "-").replace(/[\r\n|]+/g, " ").trim() || "-";
const rank = { PENDING: 0, UNAVAILABLE: 0, CLEAN: 1, FEEDBACK: 2, TIMEOUT: 3, FAILED: 4 };
let highest = "CLEAN";
for (const result of state.results.filter((item) => state.requested.includes(item.reviewer))) {
  if (rank[result.status] > rank[highest]) highest = result.status;
}
const lines = [
  `Issue URL: ${issueUrl}`,
  `Requested reviewers: ${state.requested.length ? state.requested.join(", ") : "none"}`,
  `Unavailable reviewers: ${state.unavailable.length ? state.unavailable.join(", ") : "none"}`,
  "Reviewer | Status | Response | Diagnostic",
  "--- | --- | --- | ---",
  ...state.results.map((result) =>
    `${result.reviewer} | ${result.status} | ${cell(result.response)} | ${cell(result.diagnostic)}`),
  `Highest disposition: ${highest}`,
];
process.stdout.write(lines.join("\n") + "\n");
NODE
}

jhw_issue_cleanup_state_file() {
  local state_file="$1" state_dir="${JHW_ISSUE_STATE_DIR:-${TMPDIR:-/tmp}}"
  local parent base
  [[ -n "${JHW_ISSUE_STATE_FILE:-}" && "$state_file" == "$JHW_ISSUE_STATE_FILE" ]] || return 2
  parent="${state_file%/*}"
  base="${state_file##*/}"
  [[ "$parent" == "$state_dir" && "$base" == jhw-issue.*.state ]] || return 2
  [[ ! -L "$state_file" ]] || return 1
  [[ ! -e "$state_file" || -f "$state_file" ]] || return 1
  [[ -e "$state_file" ]] || return 0
  rm -f -- "$state_file"
}
```
<!-- issue-review-wait-contract:end -->

실행 시작 시 `JHW_ISSUE_STATE_FILE="$(jhw_issue_create_state_file)"`로 private state를 만들고 export한
뒤 `trap 'jhw_issue_cleanup_state_file "$JHW_ISSUE_STATE_FILE"' EXIT`를 등록한다. partial failure와
timeout에서도 summary와 Issue URL을 먼저 출력하고 trap으로 state만 제거한다.

## 실행 규칙

- title/body를 먼저 확정한다. 내용이 모호하면 생성 전에 한 번만 질문한다.
- `--timeout` 기본값은 20분이며 양의 정수만 허용한다.
- `--reviewers` 같은 임의 capability override는 없다. eligible matrix를 통과한 reviewer만 요청한다.
- partial reviewer unavailable은 나머지 eligible reviewer 요청을 막지 않는다.
- mention 이후 실패해도 생성된 Issue URL을 보존하고, Issue edit/close/delete/PATCH나 자동 구현을 하지 않는다.
