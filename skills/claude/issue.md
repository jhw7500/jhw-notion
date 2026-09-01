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
| Claude | local `claude.yml` regular file + config enabled + 기본 브랜치의 `Claude Code` workflow가 active이고 `issue_comment` event 및 request-comment `run-name` 좌표 지원 |
| Gemini | local `gemini-dispatch.yml` regular file + config enabled + 기본 브랜치의 `Gemini Dispatch` workflow가 active이고 `issue_comment` event 및 request-comment `run-name` 좌표 지원 |
| Codex | 동일 저장소 canary Issue에서 actor-owned 요청 뒤 하나의 Codex bot identity가 실패가 아닌 응답을 반환 |

Gemini Assist와 OpenCode는 PR-only라 Issue reviewer로 추정하지 않는다. secret 값은 조회하거나
존재를 추정하지 않는다. Codex canary 증거는 이 invocation에서만 쓰고 파일·환경 프로필·DB에
저장하지 않는다. usage limit·connector 실패·review 불가를 보고한 canary 응답은 capability 증거가 아니다.

<!-- issue-review-create-contract:begin -->
```bash
JHW_ISSUE_REVIEW_REQUEST_LABEL='review:request'
JHW_ISSUE_REVIEW_SKIP_LABEL='review:skip'
JHW_ISSUE_REVIEW_REQUEST_COLOR='0E8A16'
JHW_ISSUE_REVIEW_SKIP_COLOR='B60205'
JHW_ISSUE_REVIEW_REQUEST_DESCRIPTION='Explicitly request AI review'
JHW_ISSUE_REVIEW_SKIP_DESCRIPTION='Explicitly skip AI review'

jhw_issue_repo_root() {
  local root="${JHW_ISSUE_REPO_ROOT:-}"
  if [[ -z "$root" ]]; then
    root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
      echo "Git repository root lookup failed" >&2
      return 1
    }
  fi
  [[ -n "$root" && "$root" != *$'\n'* && "$root" != *$'\r'* && -d "$root" ]] || {
    echo "invalid repository root" >&2
    return 2
  }
  root="$(cd -P -- "$root" 2>/dev/null && pwd -P)" || return 1
  printf '%s\n' "$root"
}

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
  local config_path="${1-}" root
  if [[ -z "$config_path" ]]; then
    root="$(jhw_issue_repo_root)" || return
    config_path="${JHW_ISSUE_CONFIG_PATH:-$root/.github/workflow-config.yml}"
  fi
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
  local workflow_key="$1" config_path="${2-}" root
  case "$workflow_key" in claude|gemini-dispatch) ;; *) return 2 ;; esac
  if [[ -z "$config_path" ]]; then
    root="$(jhw_issue_repo_root)" || return
    config_path="${JHW_ISSUE_CONFIG_PATH:-$root/.github/workflow-config.yml}"
  fi
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

jhw_issue_remote_workflow_eligible() {
  local workflow="$1" expected_name="$2" metadata content
  case "$workflow" in claude.yml|gemini-dispatch.yml) ;; *) return 2 ;; esac
  case "$expected_name" in 'Claude Code'|'Gemini Dispatch') ;; *) return 2 ;; esac
  metadata="$(gh api "repos/$REPO_NWO/actions/workflows/$workflow" 2>/dev/null)" || return 1
  printf '%s' "$metadata" | node -e '
const fs = require("node:fs");
const [workflow, expectedName] = process.argv.slice(1);
let value;
try { value = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(1); }
const expectedPath = `.github/workflows/${workflow}`;
process.exit(value?.state === "active" && value?.path === expectedPath &&
  value?.name === expectedName ? 0 : 1);
' "$workflow" "$expected_name" || return 1
  content="$(gh api "repos/$REPO_NWO/contents/.github/workflows/$workflow" 2>/dev/null)" || return 1
  printf '%s' "$content" | node -e '
const fs = require("node:fs");
const [workflow] = process.argv.slice(1);
let value;
try { value = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(1); }
if (value?.type !== "file" || value?.path !== `.github/workflows/${workflow}` ||
    value?.encoding !== "base64" || typeof value?.content !== "string") process.exit(1);
const compact = value.content.replace(/\s+/g, "");
if (compact === "" || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) process.exit(1);
const bytes = Buffer.from(compact, "base64");
if (bytes.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) process.exit(1);
const text = bytes.toString("utf8");
const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
const requestScopedRunName = "run-name: jhw-review-comment-${{ github.event.comment.id || github.run_id }}";
if (lines.filter((raw) => raw.replace(/\s+#.*$/, "") === requestScopedRunName).length !== 1) {
  process.exit(1);
}
let onIndex = -1;
let supportsIssueComment = false;
let issueCommentIndex = -1;
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index].replace(/\s+#.*$/, "");
  if (/^on:\s*(?:issue_comment|\[[^\]]*\bissue_comment\b[^\]]*\])\s*$/.test(line)) {
    supportsIssueComment = true;
    continue;
  }
  if (/^on:\s*$/.test(line)) {
    if (onIndex !== -1) process.exit(1);
    onIndex = index;
  }
}
if (!supportsIssueComment && onIndex !== -1) {
  let onChildIndent = null;
  for (let index = onIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].replace(/\s+#.*$/, "");
    if (line.trim() === "") continue;
    const indentMatch = line.match(/^( +)/);
    if (!indentMatch) break;
    const indent = indentMatch[1].length;
    if (onChildIndent === null) onChildIndent = indent;
    if (indent === onChildIndent && /^ +issue_comment:\s*(?:\{.*\})?$/.test(line)) {
      issueCommentIndex = index;
      break;
    }
  }
}
if (!supportsIssueComment && issueCommentIndex !== -1) {
  const eventLine = lines[issueCommentIndex].replace(/\s+#.*$/, "");
  const eventIndent = eventLine.match(/^ */)[0].length;
  const parseScalar = (value) => {
    const match = value.trim().match(/^(?:"([A-Za-z0-9_-]+)"|\x27([A-Za-z0-9_-]+)\x27|([A-Za-z0-9_-]+))$/);
    return match ? (match[1] || match[2] || match[3]) : null;
  };
  const parseFlowList = (value) => {
    const match = value.trim().match(/^\[([^\[\]{}]*)\]$/);
    if (!match) return null;
    if (match[1].trim() === "") return [];
    const result = [];
    for (const item of match[1].split(",")) {
      const parsed = parseScalar(item);
      if (parsed === null) return null;
      result.push(parsed);
    }
    return result;
  };
  const records = [];
  for (let index = issueCommentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].replace(/\s+#.*$/, "");
    if (line.trim() === "") continue;
    const indent = line.match(/^ */)[0].length;
    if (indent <= eventIndent) break;
    records.push({ index, indent, line });
  }
  const inlineValue = eventLine.replace(/^ +issue_comment:\s*/, "");
  if (inlineValue !== "") {
    if (records.length !== 0) process.exit(1);
    if (/^\{\s*\}$/.test(inlineValue)) {
      supportsIssueComment = true;
    } else {
      const inlineTypes = inlineValue.match(/^\{\s*(?:"types"|\x27types\x27|types)\s*:\s*(\[[^\[\]{}]*\])\s*\}$/);
      const values = inlineTypes ? parseFlowList(inlineTypes[1]) : null;
      supportsIssueComment = values !== null && values.includes("created");
    }
  } else if (records.length === 0) {
    supportsIssueComment = true;
  } else {
    const configIndent = Math.min(...records.map((record) => record.indent));
    const direct = records.filter((record) => record.indent === configIndent);
    if (direct.length !== 1) process.exit(1);
    const types = direct[0].line.trim().match(/^(?:"types"|\x27types\x27|types)\s*:\s*(.*)$/);
    if (!types) process.exit(1);
    let values;
    if (types[1] !== "") {
      if (records.some((record) => record.indent > configIndent)) process.exit(1);
      values = parseFlowList(types[1]);
    } else {
      const items = records.filter((record) => record.indent > configIndent);
      if (items.length === 0) process.exit(1);
      const itemIndent = Math.min(...items.map((record) => record.indent));
      if (items.some((record) => record.indent !== itemIndent)) process.exit(1);
      values = [];
      for (const item of items) {
        const match = item.line.trim().match(/^-\s+(.+)$/);
        const parsed = match ? parseScalar(match[1]) : null;
        if (parsed === null) process.exit(1);
        values.push(parsed);
      }
    }
    supportsIssueComment = values !== null && values.includes("created");
  }
}
process.exit(supportsIssueComment ? 0 : 1);
' "$workflow"
}

jhw_issue_is_utc_timestamp() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

jhw_issue_codex_canary_eligible() {
  local canary_url="$1" canary_repo canary_issue actor endpoint query raw line
  local request_id request_at extra response_id response_actor response_at response_url response_success identity=""
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
  raw="$(gh api "$endpoint" --paginate --jq '.[] | [.id, .user.login, .created_at, .html_url, (((.body // "") | test("usage limits?|create an environment|unable to review|cannot review|failed to (?:start|review)|connector[^\\n]*(?:fail|error|unavailable|reject)"; "i")) | not)] | @tsv' 2>/dev/null)" || return 1
  while IFS=$'\t' read -r response_id response_actor response_at response_url response_success extra; do
    [[ "$response_id" =~ ^[1-9][0-9]*$ && "$response_success" == true && -z "$extra" ]] || continue
    case "$response_actor" in
      chatgpt-codex-connector|chatgpt-codex-connector'[bot]') ;;
      *) continue ;;
    esac
    jhw_issue_is_utc_timestamp "$response_at" || continue
    [[ "$response_at" > "$request_at" ||
      ( "$response_at" == "$request_at" && "$response_id" -gt "$request_id" ) ]] || continue
    [[ -n "$response_url" ]] || continue
    if [[ -n "$identity" && "$identity" != "$response_actor" ]]; then
      echo "ambiguous Codex bot identity" >&2
      return 1
    fi
    identity="$response_actor"
  done <<<"$raw"
  [[ -n "$identity" ]] || return 1
  printf '%s\n' "$identity"
}

jhw_issue_discover_reviewers() {
  local mode="$1" auto_enabled="$2" root config_path
  local codex_identity="${3-}" codex_identity_supplied=false
  if (( $# >= 3 )); then codex_identity_supplied=true; fi
  case "$mode" in request|skip|auto) ;; *) return 2 ;; esac
  case "$auto_enabled" in true|false) ;; *) return 2 ;; esac
  [[ "$mode" == request || ( "$mode" == auto && "$auto_enabled" == true ) ]] || return 0
  root="$(jhw_issue_repo_root)" || return
  config_path="${JHW_ISSUE_CONFIG_PATH:-$root/.github/workflow-config.yml}"
  if [[ -f "$root/.github/workflows/claude.yml" && ! -L "$root/.github/workflows/claude.yml" ]] &&
    [[ "$(jhw_issue_workflow_enabled claude "$config_path")" == true ]] &&
    jhw_issue_remote_workflow_eligible claude.yml 'Claude Code'; then
    printf 'claude\n'
  fi
  if [[ -f "$root/.github/workflows/gemini-dispatch.yml" && ! -L "$root/.github/workflows/gemini-dispatch.yml" ]] &&
    [[ "$(jhw_issue_workflow_enabled gemini-dispatch "$config_path")" == true ]] &&
    jhw_issue_remote_workflow_eligible gemini-dispatch.yml 'Gemini Dispatch'; then
    printf 'gemini\n'
  fi
  if [[ "$codex_identity_supplied" == true ]]; then
    case "$codex_identity" in
      chatgpt-codex-connector|chatgpt-codex-connector'[bot]') printf 'codex\n' ;;
      '') ;;
      *) return 2 ;;
    esac
  elif codex_identity="$(jhw_issue_codex_canary_eligible "${JHW_ISSUE_CODEX_CANARY_URL:-}")"; then
    printf 'codex\n'
  fi
}

jhw_issue_unavailable_reviewers() {
  local mode="$1" auto_enabled="$2" eligible="$3" reviewer
  case "$mode" in request|skip|auto) ;; *) return 2 ;; esac
  case "$auto_enabled" in true|false) ;; *) return 2 ;; esac
  [[ "$mode" == request || ( "$mode" == auto && "$auto_enabled" == true ) ]] || return 0
  for reviewer in claude gemini codex; do
    if ! grep -Fqx -- "$reviewer" <<<"$eligible"; then
      printf '%s\n' "$reviewer"
    fi
  done
}

jhw_issue_reconcile_and_verify_policy() {
  local issue="$1" mode="$2" labels has_request=0 has_skip=0
  [[ "$issue" =~ ^[1-9][0-9]*$ ]] || return 2
  labels="$(gh issue view "$issue" --repo "$REPO_NWO" --json labels --jq '.labels[].name')" || return 1
  case "$mode" in
    request)
      if grep -Fqx -- "$JHW_ISSUE_REVIEW_SKIP_LABEL" <<<"$labels"; then
        gh issue edit "$issue" --repo "$REPO_NWO" --remove-label "$JHW_ISSUE_REVIEW_SKIP_LABEL" >/dev/null || return 1
      fi
      if ! grep -Fqx -- "$JHW_ISSUE_REVIEW_REQUEST_LABEL" <<<"$labels"; then
        gh issue edit "$issue" --repo "$REPO_NWO" --add-label "$JHW_ISSUE_REVIEW_REQUEST_LABEL" >/dev/null || return 1
      fi
      ;;
    skip)
      if grep -Fqx -- "$JHW_ISSUE_REVIEW_REQUEST_LABEL" <<<"$labels"; then
        gh issue edit "$issue" --repo "$REPO_NWO" --remove-label "$JHW_ISSUE_REVIEW_REQUEST_LABEL" >/dev/null || return 1
      fi
      if ! grep -Fqx -- "$JHW_ISSUE_REVIEW_SKIP_LABEL" <<<"$labels"; then
        gh issue edit "$issue" --repo "$REPO_NWO" --add-label "$JHW_ISSUE_REVIEW_SKIP_LABEL" >/dev/null || return 1
      fi
      ;;
    auto)
      if grep -Fqx -- "$JHW_ISSUE_REVIEW_REQUEST_LABEL" <<<"$labels"; then
        gh issue edit "$issue" --repo "$REPO_NWO" --remove-label "$JHW_ISSUE_REVIEW_REQUEST_LABEL" >/dev/null || return 1
      fi
      if grep -Fqx -- "$JHW_ISSUE_REVIEW_SKIP_LABEL" <<<"$labels"; then
        gh issue edit "$issue" --repo "$REPO_NWO" --remove-label "$JHW_ISSUE_REVIEW_SKIP_LABEL" >/dev/null || return 1
      fi
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
  return 0
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
  local auto_enabled=false reviewers unavailable issue_url issue issue_created_at request_id reviewer
  local codex_identity=""
  JHW_ISSUE_NUMBER=''
  JHW_ISSUE_URL=''
  JHW_ISSUE_CREATED_AT=''
  JHW_ISSUE_REQUESTED_REVIEWERS=''
  JHW_ISSUE_UNAVAILABLE_REVIEWERS=''
  JHW_ISSUE_REQUEST_RECORDS=''
  JHW_ISSUE_REQUEST_FAILURES=''
  JHW_ISSUE_EXPECTED_CODEX_BOT=''
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
  if [[ "$mode" == request || ( "$mode" == auto && "$auto_enabled" == true ) ]]; then
    if codex_identity="$(jhw_issue_codex_canary_eligible "${JHW_ISSUE_CODEX_CANARY_URL:-}")"; then
      :
    else
      codex_identity=''
    fi
  fi
  reviewers="$(jhw_issue_discover_reviewers "$mode" "$auto_enabled" "$codex_identity")" || return
  if grep -Fqx -- codex <<<"$reviewers"; then
    case "$codex_identity" in
      chatgpt-codex-connector|chatgpt-codex-connector'[bot]') ;;
      *) echo "invalid Codex canary identity" >&2; return 1 ;;
    esac
    JHW_ISSUE_EXPECTED_CODEX_BOT="$codex_identity"
  fi
  export JHW_ISSUE_EXPECTED_CODEX_BOT
  unavailable="$(jhw_issue_unavailable_reviewers "$mode" "$auto_enabled" "$reviewers")" || return
  if [[ "$mode" == request && -z "$reviewers" ]]; then
    echo "no eligible Issue reviewer" >&2
    return 1
  fi
  issue_url="$(gh issue create --repo "$REPO_NWO" --title "$title" --body "$body")" || return 1
  JHW_ISSUE_URL="$issue_url"
  printf '%s\n' "$issue_url"
  issue="$(gh issue view "$issue_url" --repo "$REPO_NWO" --json number --jq .number)" || return 1
  [[ "$issue" =~ ^[1-9][0-9]*$ ]] || { echo "invalid created Issue" >&2; return 1; }
  issue_created_at="$(gh issue view "$issue" --repo "$REPO_NWO" --json createdAt --jq .createdAt)" || return 1
  jhw_issue_is_utc_timestamp "$issue_created_at" || { echo "invalid created Issue timestamp" >&2; return 1; }
  JHW_ISSUE_NUMBER="$issue"
  JHW_ISSUE_CREATED_AT="$issue_created_at"
  JHW_ISSUE_REQUESTED_REVIEWERS="$reviewers"
  JHW_ISSUE_UNAVAILABLE_REVIEWERS="$unavailable"
  jhw_issue_reconcile_and_verify_policy "$issue" "$mode" || return
  if [[ -n "$reviewers" ]]; then
    while IFS= read -r reviewer; do
      [[ -n "$reviewer" ]] || continue
      if request_id="$(jhw_issue_request_reviewer "$issue" "$reviewer")" &&
        [[ "$request_id" =~ ^[1-9][0-9]*$ ]]; then
        [[ -z "$JHW_ISSUE_REQUEST_RECORDS" ]] || JHW_ISSUE_REQUEST_RECORDS+=$'\n'
        JHW_ISSUE_REQUEST_RECORDS+="$reviewer"$'\t'"$request_id"
      else
        [[ -z "$JHW_ISSUE_REQUEST_FAILURES" ]] || JHW_ISSUE_REQUEST_FAILURES+=$'\n'
        JHW_ISSUE_REQUEST_FAILURES+="$reviewer"$'\t'request_failed
      fi
    done <<<"$reviewers"
  fi
  return 0
}
```
<!-- issue-review-create-contract:end -->

## bounded review wait 계약

요청된 reviewer만 private invocation state에서 추적한다. 한 번의 collect/classify pass는 read-only이며,
agent harness가 약 60초 간격으로 모든 요청 reviewer가 terminal이거나 전체 deadline에 도달할 때까지
반복한다. untracked `&`/`nohup`과 60초를 넘는 foreground sleep은 사용하지 않는다.
workflow run은 `jhw-review-comment-<request_comment_id>`라는 정확한 `display_title`을 가진 경우에만
그 reviewer 요청의 acknowledgment·failure 좌표로 사용한다. 뒤이은 다른 reviewer/Codex 멘션이 깨운
같은 이름의 run은 request comment ID가 다르므로 현재 판정에서 제외한다.

<!-- issue-review-wait-contract:begin -->
```bash
jhw_issue_collect_signals() (
  local issue="$1" request_comment_id="$2" issue_created_at="$3" snapshot_path="$4"
  local actor issue_title signal_dir comments_path reactions_path runs_path
  [[ "$issue" =~ ^[1-9][0-9]*$ ]] || return 2
  [[ "$request_comment_id" =~ ^[1-9][0-9]*$ ]] || return 2
  jhw_issue_is_utc_timestamp "$issue_created_at" || return 2
  [[ -f "$snapshot_path" && ! -L "$snapshot_path" ]] || return 2
  actor="$(gh api user --jq '.login' 2>/dev/null)" || return 1
  [[ "$actor" =~ ^[A-Za-z0-9-]+$ ]] || return 1
  issue_title="$(gh issue view "$issue" --repo "$REPO_NWO" --json title --jq .title)" || return 1
  [[ -n "${issue_title//[[:space:]]/}" ]] || return 1
  umask 077
  signal_dir="$(mktemp -d "${TMPDIR:-/tmp}/jhw-issue-signals.XXXXXXXX")" || return 1
  comments_path="$signal_dir/comments.json"
  reactions_path="$signal_dir/reactions.json"
  runs_path="$signal_dir/runs.json"
  trap 'rm -f -- "$comments_path" "$reactions_path" "$runs_path"; rmdir -- "$signal_dir" 2>/dev/null || true' EXIT HUP INT TERM
  gh api "repos/$REPO_NWO/issues/$issue/comments?per_page=100" \
    --paginate --slurp >"$comments_path" 2>/dev/null || return 1
  gh api "repos/$REPO_NWO/issues/comments/$request_comment_id/reactions?per_page=100" \
    --paginate --slurp >"$reactions_path" 2>/dev/null || return 1
  gh api "repos/$REPO_NWO/actions/runs" --method GET \
    -f per_page=100 \
    -f event=issue_comment \
    -f "actor=$actor" \
    -f "created=>=$issue_created_at" \
    --paginate --slurp >"$runs_path" 2>/dev/null || return 1
  node - "$issue" "$request_comment_id" "$issue_created_at" "$actor" "$issue_title" \
    "$comments_path" "$reactions_path" "$runs_path" "$snapshot_path" <<'NODE'
const fs = require("node:fs");
const [
  issue,
  requestCommentId,
  issueCreatedAt,
  requestActor,
  issueTitle,
  commentsPath,
  reactionsPath,
  runsPath,
  snapshotPath,
] = process.argv.slice(2);
const fail = (message) => { process.stderr.write(message + "\n"); process.exit(1); };
const parseJsonFile = (path, name) => {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    fail(`${name} is invalid JSON`);
  }
};
const arrayPages = (path, name) => {
  const pages = parseJsonFile(path, name);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    fail(`${name} must contain array pages`);
  }
  return pages.flat();
};
const commentRows = arrayPages(commentsPath, "comment pages");
const reactionRows = arrayPages(reactionsPath, "reaction pages");
const runPages = parseJsonFile(runsPath, "workflow run pages");
if (!Array.isArray(runPages) || runPages.some((page) => !page || !Array.isArray(page.workflow_runs))) {
  fail("workflow run pages must contain workflow_runs arrays");
}
const snapshot = {
  issue: Number(issue),
  request_comment_id: Number(requestCommentId),
  issue_created_at: issueCreatedAt,
  request_actor: requestActor,
  issue_title: issueTitle,
  comments: commentRows.map((item) => ({
    id: item?.id,
    actor: item?.user?.login,
    actor_type: item?.user?.type,
    created_at: item?.created_at,
    body: item?.body || "",
    url: item?.html_url || "",
  })),
  reactions: reactionRows.map((item) => ({
    actor: item?.user?.login,
    actor_type: item?.user?.type,
    content: item?.content,
    created_at: item?.created_at,
    url: item?.html_url || "",
  })),
  runs: runPages.flatMap((page) => page.workflow_runs)
    .filter((item) => item?.event === "issue_comment" &&
      item?.display_title === `jhw-review-comment-${requestCommentId}` &&
      (item?.actor?.login === requestActor || item?.triggering_actor?.login === requestActor))
    .map((item) => ({
      id: item?.id,
      name: item?.name,
      event: item?.event,
      status: item?.status,
      conclusion: item?.conclusion || "null",
      created_at: item?.created_at,
      url: item?.html_url || "",
      display_title: item?.display_title || "",
      actor: item?.actor?.login || "",
      triggering_actor: item?.triggering_actor?.login || "",
    })),
};
fs.writeFileSync(snapshotPath, JSON.stringify(snapshot) + "\n", { mode: 0o600 });
fs.chmodSync(snapshotPath, 0o600);
NODE
)

jhw_issue_create_signal_file() {
  local state_dir="${JHW_ISSUE_STATE_DIR:-${TMPDIR:-/tmp}}" file
  [[ -d "$state_dir" && ! -L "$state_dir" ]] || return 1
  umask 077
  file="$(mktemp "$state_dir/jhw-issue.signal.XXXXXXXX.json")" || return 1
  chmod 600 "$file" || return 1
  printf '%s\n' "$file"
}

jhw_issue_cleanup_signal_file() {
  local file="$1" state_dir="${JHW_ISSUE_STATE_DIR:-${TMPDIR:-/tmp}}"
  [[ -d "$state_dir" && ! -L "$state_dir" ]] || return 1
  [[ "$file" == "$state_dir"/jhw-issue.signal.*.json ]] || return 2
  [[ -f "$file" && ! -L "$file" ]] || return 1
  rm -f -- "$file"
}

jhw_issue_classify_reviewer() {
  local reviewer="$1" now_epoch="$2" trigger_deadline="$3" review_deadline="$4" signal_file="$5"
  local expected_bot workflow_name result state response diagnostic extra eligible
  [[ "$now_epoch" =~ ^[0-9]+$ && "$trigger_deadline" =~ ^[0-9]+$ && "$review_deadline" =~ ^[0-9]+$ ]] || return 2
  (( review_deadline >= trigger_deadline )) || return 2
  [[ -f "$signal_file" && ! -L "$signal_file" ]] || return 2
  eligible="${JHW_ISSUE_REVIEWER_ELIGIBLE:-true}"
  case "$eligible" in true|false) ;; *) return 2 ;; esac
  case "$reviewer" in
    claude)
      expected_bot="${JHW_ISSUE_EXPECTED_CLAUDE_BOT-}"
      workflow_name='Claude Code'
      ;;
    gemini)
      expected_bot="${JHW_ISSUE_EXPECTED_GEMINI_BOT-}"
      workflow_name='Gemini Dispatch'
      ;;
    codex)
      expected_bot="${JHW_ISSUE_EXPECTED_CODEX_BOT-}"
      [[ -n "$expected_bot" ]] || return 2
      workflow_name=''
      ;;
    *) return 2 ;;
  esac
  [[ -z "$expected_bot" || "$expected_bot" =~ ^[A-Za-z0-9_.-]+(\[bot\])?$ ]] || return 2
  result="$(node - "$reviewer" "$now_epoch" "$trigger_deadline" "$review_deadline" \
    "$expected_bot" "$workflow_name" "$eligible" "$signal_file" <<'NODE'
const fs = require("node:fs");
const [reviewer, nowRaw, triggerRaw, reviewRaw, expectedBot, workflowName, eligibleRaw, signalFile] = process.argv.slice(2);
const now = Number(nowRaw);
const triggerDeadline = Number(triggerRaw);
const reviewDeadline = Number(reviewRaw);
const emit = (state, response, diagnostic) => {
  process.stdout.write([state, response || "-", diagnostic].join("\t") + "\n");
  process.exit(0);
};
if (eligibleRaw === "false") emit("UNAVAILABLE", "", "preflight_unavailable");
let snapshot;
try { snapshot = JSON.parse(fs.readFileSync(signalFile, "utf8")); }
catch { process.stderr.write("invalid signal snapshot\n"); process.exit(1); }
if (!snapshot || typeof snapshot.issue_title !== "string" || snapshot.issue_title.trim() === "" ||
    !Array.isArray(snapshot.comments) || !Array.isArray(snapshot.reactions) || !Array.isArray(snapshot.runs)) {
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
const requestId = Number(request.id);
const expectedRunTitle = `jhw-review-comment-${requestId}`;
const atOrAfterRequest = (value) => {
  const parsed = epoch(value);
  return parsed !== null && parsed >= requestEpoch && parsed >= issueEpoch;
};
const laterComment = (comment) => {
  const parsed = epoch(comment.created_at);
  const id = Number(comment.id);
  return parsed !== null && Number.isSafeInteger(id) && id > 0 &&
    parsed >= issueEpoch &&
    (parsed > requestEpoch || (parsed === requestEpoch && id > requestId));
};
const laterBotComments = snapshot.comments.filter((comment) =>
  comment.actor_type === "Bot" && laterComment(comment));
let effectiveBot = expectedBot;
let acknowledgments = [];
if (!effectiveBot && reviewer === "claude") {
  const signed = laterBotComments.filter((comment) =>
    /^\*\*Claude (?:finished|encountered an error)\b/.test(comment.body || ""));
  const identities = [...new Set(signed.map((comment) => comment.actor))];
  if (identities.length > 1) emit("FAILED", "", "ambiguous_bot_identity");
  if (identities.length === 1) effectiveBot = identities[0];
}
if (!effectiveBot && reviewer === "gemini") {
  acknowledgments = laterBotComments.filter((comment) =>
    /^## 🤖 Gemini CLI \(명령어 기반\)/.test(comment.body || "") &&
    /received your request/i.test(comment.body || ""));
  const identities = [...new Set(acknowledgments.map((comment) => comment.actor))];
  if (identities.length > 1) emit("FAILED", "", "ambiguous_bot_identity");
  if (identities.length === 1) effectiveBot = identities[0];
}
const isGeminiAcknowledgment = (comment) => reviewer === "gemini" &&
  /^## 🤖 Gemini CLI \(명령어 기반\)/.test(comment.body || "") &&
  /received your request/i.test(comment.body || "");
const comments = effectiveBot ? laterBotComments.filter((comment) =>
  comment.actor === effectiveBot && !isGeminiAcknowledgment(comment)) : [];
const reactions = effectiveBot ? snapshot.reactions.filter((reaction) =>
  reaction.actor === effectiveBot && atOrAfterRequest(reaction.created_at)) : [];
const runs = workflowName === "" ? [] : snapshot.runs.filter((run) =>
  run.name === workflowName && run.event === "issue_comment" && atOrAfterRequest(run.created_at) &&
  run.display_title === expectedRunTitle &&
  (run.triggering_actor === snapshot.request_actor || run.actor === snapshot.request_actor));

const runIds = runs.map((run) => Number(run.id));
if (runIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
  process.stderr.write("invalid workflow run id\n");
  process.exit(1);
}
const orderedRuns = [...runs].sort((left, right) =>
  epoch(right.created_at) - epoch(left.created_at) || Number(right.id) - Number(left.id));
const latestRun = orderedRuns[0];
if (latestRun?.status === "completed" && !["success", "neutral", "skipped"].includes(latestRun.conclusion)) {
  emit("FAILED", latestRun.url, "workflow_failed");
}
const latestRunEpoch = latestRun ? epoch(latestRun.created_at) : null;
const latestRunId = latestRun ? Number(latestRun.id) : null;
let latestRunReference = null;
if (latestRun) {
  const runUrl = typeof latestRun.url === "string" ? latestRun.url : "";
  const runUrlMatch = runUrl.match(
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/([1-9][0-9]*)$/,
  );
  if (!runUrlMatch || Number(runUrlMatch[1]) !== latestRunId) {
    process.stderr.write("invalid workflow run URL\n");
    process.exit(1);
  }
  const escapedRunUrl = runUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const runReferenceStart = String.raw`(?:^|[\s(\[<{])`;
  const runReferenceBoundary = String.raw`(?=$|[\s)\]}>]|[.,;:!?](?=$|[\s)\]}>]))`;
  latestRunReference = new RegExp(`${runReferenceStart}${escapedRunUrl}${runReferenceBoundary}`);
}
const isCurrentRunComment = (comment) => {
  const parsed = epoch(comment.created_at);
  return parsed !== null && (parsed > latestRunEpoch ||
    (parsed === latestRunEpoch && latestRunReference.test(comment.body || "")));
};
const currentComments = latestRunEpoch === null
  ? comments
  : comments.filter((comment) => isCurrentRunComment(comment));
const currentReactions = latestRunEpoch === null
  ? reactions
  : reactions.filter((reaction) => epoch(reaction.created_at) > latestRunEpoch);
const orderedComments = [...currentComments].sort((left, right) =>
  epoch(right.created_at) - epoch(left.created_at) || Number(right.id) - Number(left.id));
const verdictComment = orderedComments[0];
const rejectedReaction = currentReactions
  .filter((reaction) => ["-1", "confused"].includes(reaction.content))
  .sort((left, right) => epoch(right.created_at) - epoch(left.created_at))[0];
if (rejectedReaction && verdictComment &&
    epoch(rejectedReaction.created_at) === epoch(verdictComment.created_at)) {
  if (now >= reviewDeadline) emit("TIMEOUT", request.url, "review_timeout");
  emit("PENDING", request.url, "ambiguous_same_second_signal");
}
if (rejectedReaction &&
    (!verdictComment || epoch(rejectedReaction.created_at) > epoch(verdictComment.created_at))) {
  emit("FAILED", rejectedReaction.url, "connector_rejected");
}
if (verdictComment &&
    /Claude encountered an error|unable to (?:review|process)|cannot review|connector[^\n]*(?:reject|denied)|failed to (?:start|review)/i.test(verdictComment.body || "")) {
  emit("FAILED", verdictComment.url, "connector_rejected");
}
const feedbackPattern = /\[(?:CRITICAL|HIGH)\]|(?:^|[^A-Za-z0-9])P[01](?:[^0-9]|$)|missing requirement|implementation risk|risk:/i;
const cleanLine = /^(?:no blockers?(?:\s+(?:found|identified|remaining))?|no blocking (?:findings?|issues?|risks?|requirements? gaps?|concerns?)|(?:the\s+)?(?:requirements?|proposal)\s+(?:(?:look|looks|are|is)\s+)?complete(?:\s+and\s+ready for implementation)?(?:[.;]\s*(?:no blockers?(?:\s+found)?|no blocking (?:findings?|issues?|risks?|requirements? gaps?|concerns?)))?|looks good|ready for implementation|review clean|lgtm)[.!]?$/i;
const negatedFindingLine = /^no (?:(?:missing requirements?|implementation risks?)(?:\s+(?:or|and)\s+(?:missing requirements?|implementation risks?))*|(?:\[(?:CRITICAL|HIGH)\]|P[01])\s+(?:issues?|findings?))[.!]?$/i;
const cleanVerdictLines = (body) => String(body || "").split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) => !/^\*\*Claude finished\b/.test(line));
const hasExplicitCleanVerdict = (body) => {
  const lines = cleanVerdictLines(body);
  return lines.length > 0 && lines.every((line) =>
    cleanLine.test(line) || negatedFindingLine.test(line));
};
if (verdictComment && hasExplicitCleanVerdict(verdictComment.body)) {
  emit("CLEAN", verdictComment.url, "substantive_response");
}
if (verdictComment && feedbackPattern.test(verdictComment.body || "")) {
  emit("FEEDBACK", verdictComment.url, "actionable_feedback");
}
if (verdictComment) emit("FEEDBACK", verdictComment.url, "unclassified_substantive_response");

const acknowledged = acknowledgments.length > 0 ||
  reactions.some((reaction) => ["eyes", "+1", "heart"].includes(reaction.content)) ||
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
const requestedResults = state.results.filter((item) => state.requested.includes(item.reviewer));
let highest = requestedResults.length === 0
  ? (state.unavailable.length > 0 ? "UNAVAILABLE" : "CLEAN")
  : requestedResults[0].status;
for (const result of requestedResults.slice(1)) {
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

jhw_issue_cleanup_execution_files() {
  local cleanup_status=0
  if [[ -n "${JHW_ISSUE_ACTIVE_SIGNAL_FILE:-}" ]]; then
    if [[ -e "$JHW_ISSUE_ACTIVE_SIGNAL_FILE" || -L "$JHW_ISSUE_ACTIVE_SIGNAL_FILE" ]]; then
      if jhw_issue_cleanup_signal_file "$JHW_ISSUE_ACTIVE_SIGNAL_FILE"; then
        JHW_ISSUE_ACTIVE_SIGNAL_FILE=''
      else
        cleanup_status=1
      fi
    else
      JHW_ISSUE_ACTIVE_SIGNAL_FILE=''
    fi
  fi
  if [[ -n "${JHW_ISSUE_STATE_FILE:-}" ]]; then
    if [[ -e "$JHW_ISSUE_STATE_FILE" || -L "$JHW_ISSUE_STATE_FILE" ]]; then
      if jhw_issue_cleanup_state_file "$JHW_ISSUE_STATE_FILE"; then
        JHW_ISSUE_STATE_FILE=''
      else
        cleanup_status=1
      fi
    else
      JHW_ISSUE_STATE_FILE=''
    fi
  fi
  return "$cleanup_status"
}

jhw_issue_trap_handler_from_spec() {
  local spec="$1" signal="$2" expected
  case "$signal" in
    EXIT) expected=EXIT ;;
    HUP) expected=SIGHUP ;;
    INT) expected=SIGINT ;;
    TERM) expected=SIGTERM ;;
    *) return 2 ;;
  esac
  [[ "$spec" == "trap -- "* ]] || return 1
  spec="${spec#trap -- }"
  # `spec` comes only from Bash `trap -p`; eval reconstructs its shell-quoted argv.
  eval "set -- $spec"
  (( $# == 2 )) || return 1
  [[ "$2" == "$expected" ]] || return 1
  printf '%s' "$1"
}

jhw_issue_current_trap_spec() {
  local signal="$1" spec
  case "$signal" in EXIT|HUP|INT|TERM) ;; *) return 2 ;; esac
  spec="$(trap -p "$signal")" || return 1
  if [[ -n "$spec" ]]; then
    jhw_issue_trap_handler_from_spec "$spec" "$signal" >/dev/null || return 1
  fi
  printf '%s' "$spec"
}

jhw_issue_restore_trap_spec() {
  local spec="$1" signal="$2"
  case "$signal" in EXIT|HUP|INT|TERM) ;; *) return 2 ;; esac
  if [[ -n "$spec" ]]; then
    jhw_issue_trap_handler_from_spec "$spec" "$signal" >/dev/null || return 1
    # The validated command was emitted by Bash itself and restores the exact caller handler.
    eval "$spec"
  else
    trap - "$signal"
  fi
}

jhw_issue_restore_execution_traps() {
  local restore_status=0
  jhw_issue_restore_trap_spec "${JHW_ISSUE_PREV_EXIT_TRAP:-}" EXIT || restore_status=1
  jhw_issue_restore_trap_spec "${JHW_ISSUE_PREV_HUP_TRAP:-}" HUP || restore_status=1
  jhw_issue_restore_trap_spec "${JHW_ISSUE_PREV_INT_TRAP:-}" INT || restore_status=1
  jhw_issue_restore_trap_spec "${JHW_ISSUE_PREV_TERM_TRAP:-}" TERM || restore_status=1
  return "$restore_status"
}

jhw_issue_cleanup_on_exit() {
  local status="$1" previous_spec="${JHW_ISSUE_PREV_EXIT_TRAP:-}"
  jhw_issue_cleanup_execution_files >/dev/null 2>&1 || true
  trap - EXIT HUP INT TERM
  JHW_ISSUE_EXECUTION_CLEANUP_INSTALLED=false
  if [[ -n "$previous_spec" ]]; then
    # Run the caller EXIT trap once in a child exit context so `$?` remains the original status.
    ( eval "$previous_spec"; exit "$status" ) || true
  fi
  exit "$status"
}

jhw_issue_handle_execution_signal() {
  local signal="$1" status="$2" previous_spec=''
  case "$signal" in
    HUP) previous_spec="${JHW_ISSUE_PREV_HUP_TRAP:-}" ;;
    INT) previous_spec="${JHW_ISSUE_PREV_INT_TRAP:-}" ;;
    TERM) previous_spec="${JHW_ISSUE_PREV_TERM_TRAP:-}" ;;
    *) return 2 ;;
  esac
  jhw_issue_cleanup_execution_files >/dev/null 2>&1 || true
  jhw_issue_restore_execution_traps >/dev/null 2>&1 || trap - EXIT HUP INT TERM
  JHW_ISSUE_EXECUTION_CLEANUP_INSTALLED=false
  [[ -z "$previous_spec" ]] || kill -s "$signal" "$$"
  exit "$status"
}

jhw_issue_install_execution_cleanup() {
  [[ "${JHW_ISSUE_EXECUTION_CLEANUP_INSTALLED:-false}" == false ]] || return 2
  JHW_ISSUE_PREV_EXIT_TRAP="$(jhw_issue_current_trap_spec EXIT)" || return 1
  JHW_ISSUE_PREV_HUP_TRAP="$(jhw_issue_current_trap_spec HUP)" || return 1
  JHW_ISSUE_PREV_INT_TRAP="$(jhw_issue_current_trap_spec INT)" || return 1
  JHW_ISSUE_PREV_TERM_TRAP="$(jhw_issue_current_trap_spec TERM)" || return 1
  trap 'jhw_issue_cleanup_on_exit "$?"' EXIT
  trap 'jhw_issue_handle_execution_signal HUP 129' HUP
  trap 'jhw_issue_handle_execution_signal INT 130' INT
  trap 'jhw_issue_handle_execution_signal TERM 143' TERM
  JHW_ISSUE_EXECUTION_CLEANUP_INSTALLED=true
}

jhw_issue_clear_execution_cleanup() {
  local restore_status=0
  [[ "${JHW_ISSUE_EXECUTION_CLEANUP_INSTALLED:-false}" == true ]] || return 2
  jhw_issue_restore_execution_traps || restore_status=1
  JHW_ISSUE_EXECUTION_CLEANUP_INSTALLED=false
  JHW_ISSUE_PREV_EXIT_TRAP=''
  JHW_ISSUE_PREV_HUP_TRAP=''
  JHW_ISSUE_PREV_INT_TRAP=''
  JHW_ISSUE_PREV_TERM_TRAP=''
  return "$restore_status"
}

jhw_issue_initialize_state_file() {
  local state_file="$1"
  [[ -n "${JHW_ISSUE_STATE_FILE:-}" && "$state_file" == "$JHW_ISSUE_STATE_FILE" ]] || return 2
  [[ -f "$state_file" && ! -L "$state_file" ]] || return 1
  JHW_ISSUE_INIT_NUMBER="$JHW_ISSUE_NUMBER" \
  JHW_ISSUE_INIT_URL="$JHW_ISSUE_URL" \
  JHW_ISSUE_INIT_CREATED_AT="$JHW_ISSUE_CREATED_AT" \
  JHW_ISSUE_INIT_REQUESTED="$JHW_ISSUE_REQUESTED_REVIEWERS" \
  JHW_ISSUE_INIT_UNAVAILABLE="$JHW_ISSUE_UNAVAILABLE_REVIEWERS" \
  JHW_ISSUE_INIT_REQUESTS="$JHW_ISSUE_REQUEST_RECORDS" \
  JHW_ISSUE_INIT_FAILURES="$JHW_ISSUE_REQUEST_FAILURES" \
  node - "$state_file" <<'NODE'
const fs = require("node:fs");
const stateFile = process.argv[2];
const fail = (message) => { process.stderr.write(message + "\n"); process.exit(1); };
const reviewers = new Set(["claude", "gemini", "codex"]);
const lines = (name) => (process.env[name] || "").split("\n").filter(Boolean);
const uniqueReviewers = (name) => {
  const values = lines(name);
  if (values.some((value) => !reviewers.has(value)) || new Set(values).size !== values.length) {
    fail(`invalid ${name}`);
  }
  return values;
};
const records = (name, valuePattern) => {
  const result = new Map();
  for (const line of lines(name)) {
    const fields = line.split("\t");
    if (fields.length !== 2 || !reviewers.has(fields[0]) || !valuePattern.test(fields[1]) || result.has(fields[0])) {
      fail(`invalid ${name}`);
    }
    result.set(fields[0], fields[1]);
  }
  return result;
};
const issue = Number(process.env.JHW_ISSUE_INIT_NUMBER);
const issueUrl = process.env.JHW_ISSUE_INIT_URL || "";
const issueCreatedAt = process.env.JHW_ISSUE_INIT_CREATED_AT || "";
if (!Number.isSafeInteger(issue) || issue <= 0) fail("invalid Issue number");
if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(issueUrl)) fail("invalid Issue URL");
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(issueCreatedAt)) fail("invalid Issue timestamp");
const requested = uniqueReviewers("JHW_ISSUE_INIT_REQUESTED");
const unavailable = uniqueReviewers("JHW_ISSUE_INIT_UNAVAILABLE");
if (requested.some((reviewer) => unavailable.includes(reviewer))) fail("reviewer plan overlap");
const requestRecords = records("JHW_ISSUE_INIT_REQUESTS", /^[1-9][0-9]*$/);
const failures = records("JHW_ISSUE_INIT_FAILURES", /^request_failed$/);
for (const reviewer of requested) {
  if (Number(requestRecords.has(reviewer)) + Number(failures.has(reviewer)) !== 1) {
    fail("requested reviewer must have one request result");
  }
}
if ([...requestRecords.keys(), ...failures.keys()].some((reviewer) => !requested.includes(reviewer))) {
  fail("request result outside reviewer plan");
}
const results = requested.map((reviewer) => requestRecords.has(reviewer)
  ? { reviewer, status: "PENDING", response: "", diagnostic: "awaiting_response" }
  : { reviewer, status: "FAILED", response: "", diagnostic: "request_failed" });
for (const reviewer of unavailable) {
  results.push({ reviewer, status: "UNAVAILABLE", response: "", diagnostic: "preflight_unavailable" });
}
const state = {
  issue,
  issue_url: issueUrl,
  issue_created_at: issueCreatedAt,
  requested,
  unavailable,
  requests: [...requestRecords].map(([reviewer, id]) => ({ reviewer, id: Number(id) })),
  results,
};
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
fs.chmodSync(stateFile, 0o600);
NODE
}

jhw_issue_state_metadata() {
  local state_file="$1"
  [[ -f "$state_file" && ! -L "$state_file" ]] || return 1
  node - "$state_file" <<'NODE'
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Number.isSafeInteger(state.issue) || state.issue <= 0 ||
    typeof state.issue_url !== "string" || typeof state.issue_created_at !== "string") process.exit(1);
process.stdout.write(`${state.issue}\t${state.issue_url}\t${state.issue_created_at}\n`);
NODE
}

jhw_issue_pending_requests() {
  local state_file="$1"
  [[ -f "$state_file" && ! -L "$state_file" ]] || return 1
  node - "$state_file" <<'NODE'
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(state.requests) || !Array.isArray(state.results)) process.exit(1);
const statuses = new Map(state.results.map((item) => [item.reviewer, item.status]));
for (const request of state.requests) {
  if (statuses.get(request.reviewer) === "PENDING") {
    process.stdout.write(`${request.reviewer}\t${request.id}\n`);
  }
}
NODE
}

jhw_issue_update_result() {
  local state_file="$1" reviewer="$2" status="$3" response="$4" diagnostic="$5"
  [[ -f "$state_file" && ! -L "$state_file" ]] || return 1
  node - "$state_file" "$reviewer" "$status" "$response" "$diagnostic" <<'NODE'
const fs = require("node:fs");
const [stateFile, reviewer, status, response, diagnostic] = process.argv.slice(2);
const reviewers = new Set(["claude", "gemini", "codex"]);
const statuses = new Set(["PENDING", "CLEAN", "FEEDBACK", "FAILED", "TIMEOUT"]);
if (!reviewers.has(reviewer) || !statuses.has(status) || typeof response !== "string" || !diagnostic) process.exit(1);
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
if (!Array.isArray(state.requested) || !state.requested.includes(reviewer) || !Array.isArray(state.results)) process.exit(1);
const matches = state.results.filter((item) => item.reviewer === reviewer);
if (matches.length !== 1) process.exit(1);
Object.assign(matches[0], { status, response, diagnostic });
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
fs.chmodSync(stateFile, 0o600);
NODE
}

jhw_issue_pending_count() {
  local state_file="$1"
  [[ -f "$state_file" && ! -L "$state_file" ]] || return 1
  node - "$state_file" <<'NODE'
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(state.results)) process.exit(1);
process.stdout.write(String(state.results.filter((item) => item.status === "PENDING").length) + "\n");
NODE
}

jhw_issue_fail_pending() {
  local state_file="$1" diagnostic="$2" pending reviewer request_id
  pending="$(jhw_issue_pending_requests "$state_file")" || return 1
  while IFS=$'\t' read -r reviewer request_id; do
    [[ -n "$reviewer" ]] || continue
    jhw_issue_update_result "$state_file" "$reviewer" FAILED '' "$diagnostic" || return 1
  done <<<"$pending"
}

jhw_issue_poll_once() {
  local state_file="$1" trigger_deadline="$2" review_deadline="$3"
  local metadata issue issue_url issue_created_at extra pending reviewer request_id signal_file now_epoch remaining update_status
  [[ "$trigger_deadline" =~ ^[0-9]+$ && "$review_deadline" =~ ^[0-9]+$ ]] || return 2
  metadata="$(jhw_issue_state_metadata "$state_file")" || return 1
  IFS=$'\t' read -r issue issue_url issue_created_at extra <<<"$metadata"
  [[ "$issue" =~ ^[1-9][0-9]*$ && -n "$issue_url" && -n "$issue_created_at" && -z "$extra" ]] || return 1
  now_epoch="${JHW_ISSUE_NOW_EPOCH:-$(date +%s)}"
  [[ "$now_epoch" =~ ^[0-9]+$ ]] || return 1
  pending="$(jhw_issue_pending_requests "$state_file")" || return 1
  while IFS=$'\t' read -r reviewer request_id; do
    [[ -n "$reviewer" ]] || continue
    if ! signal_file="$(jhw_issue_create_signal_file)"; then
      jhw_issue_update_result "$state_file" "$reviewer" FAILED '' signal_file_create_failed || return 1
      continue
    fi
    JHW_ISSUE_ACTIVE_SIGNAL_FILE="$signal_file"
    update_status=0
    if jhw_issue_collect_signals "$issue" "$request_id" "$issue_created_at" "$signal_file"; then
      if jhw_issue_classify_reviewer "$reviewer" "$now_epoch" "$trigger_deadline" "$review_deadline" \
        "$signal_file" >/dev/null; then
        jhw_issue_update_result "$state_file" "$reviewer" "$JHW_ISSUE_REVIEW_STATUS" \
          "$JHW_ISSUE_REVIEW_RESPONSE" "$JHW_ISSUE_REVIEW_DIAGNOSTIC" || update_status=1
      else
        jhw_issue_update_result "$state_file" "$reviewer" FAILED '' classifier_failed || update_status=1
      fi
    else
      jhw_issue_update_result "$state_file" "$reviewer" FAILED '' signal_collection_failed || update_status=1
    fi
    if jhw_issue_cleanup_signal_file "$signal_file"; then
      JHW_ISSUE_ACTIVE_SIGNAL_FILE=''
    else
      update_status=1
    fi
    (( update_status == 0 )) || return 1
  done <<<"$pending"
  remaining="$(jhw_issue_pending_count "$state_file")" || return 1
  [[ "$remaining" =~ ^[0-9]+$ ]] || return 1
  (( remaining == 0 )) && return 0
  return 3
}

jhw_issue_execute() {
  local title="$1" body="$2" mode="$3" timeout="$4"
  local start_epoch trigger_deadline review_deadline interval poll_status render_status=0
  interval="${JHW_ISSUE_POLL_SECONDS:-60}"
  case "$interval" in
    [1-9]|[1-5][0-9]|60) ;;
    *) return 2 ;;
  esac
  JHW_ISSUE_STATE_FILE="$(jhw_issue_create_state_file)" || return 1
  JHW_ISSUE_ACTIVE_SIGNAL_FILE=''
  export JHW_ISSUE_STATE_FILE JHW_ISSUE_ACTIVE_SIGNAL_FILE
  if ! jhw_issue_install_execution_cleanup; then
    jhw_issue_cleanup_execution_files >/dev/null 2>&1 || true
    return 1
  fi
  if ! jhw_issue_create "$title" "$body" "$mode" "$timeout"; then
    render_status=1
  elif ! jhw_issue_initialize_state_file "$JHW_ISSUE_STATE_FILE"; then
    render_status=1
  elif ! start_epoch="$(date +%s)" || [[ ! "$start_epoch" =~ ^[0-9]+$ ]]; then
    render_status=1
  else
    trigger_deadline=$(( start_epoch + 180 ))
    review_deadline=$(( start_epoch + JHW_ISSUE_TIMEOUT_MIN * 60 ))
    (( trigger_deadline <= review_deadline )) || trigger_deadline="$review_deadline"
    while true; do
      if jhw_issue_poll_once "$JHW_ISSUE_STATE_FILE" "$trigger_deadline" "$review_deadline"; then
        poll_status=0
      else
        poll_status=$?
      fi
      case "$poll_status" in
        0) break ;;
        3)
          if ! sleep "$interval"; then
            jhw_issue_fail_pending "$JHW_ISSUE_STATE_FILE" wait_failed || render_status=1
            break
          fi
          ;;
        *)
          jhw_issue_fail_pending "$JHW_ISSUE_STATE_FILE" poll_failed || render_status=1
          break
          ;;
      esac
    done
    if (( render_status == 0 )); then
      jhw_issue_render_summary "$JHW_ISSUE_URL" "$JHW_ISSUE_STATE_FILE" || render_status=$?
    fi
  fi
  jhw_issue_cleanup_execution_files || render_status=1
  jhw_issue_clear_execution_cleanup || render_status=1
  return "$render_status"
}
```
<!-- issue-review-wait-contract:end -->

실행 시작 시 private summary state와 현재 활성 signal snapshot 좌표를 추적하고
`jhw_issue_install_execution_cleanup`으로 `EXIT/HUP/INT/TERM` 정리를 등록한다. partial failure,
timeout, 중단 신호에서도 summary state와 0600 signal snapshot만 제거하며 생성된 Issue는 보존한다.
설치 전에 있던 caller-owned trap 사양은 정상 epilogue와 신호 처리 모두에서 그대로 복원한다.
GitHub의 UTC 시각은 초 단위이므로 요청과 응답이 같은 초에 기록될 수 있다. 댓글은 같은 초일 때
요청 댓글보다 큰 comment ID만 후속 신호로 인정하고, reaction은 정확한 요청 댓글의 reactions
endpoint에 종속되므로 같은 초를 허용한다. workflow run도 정확한 request comment ID를
`display_title`에 담으므로 요청 시각과 같은 초부터 인정하되, 다른 멘션의 run은 제외한다.
같은 요청에 여러 relevant workflow run이 있으면 `created_at`, run ID 순으로 가장 최신 run만
workflow 실패 판정에 사용하므로 성공한 재시도는 이전 실패를 대체한다. relevant run ID가 양의
safe integer가 아니면 정렬 권한을 정할 수 없어 classifier가 fail-closed한다. bot 댓글도 같은
순서의 최신 substantive 댓글만 판정하며, 거절 reaction은 그 댓글이 없거나 더 나중일 때만 우선한다.
최신 run과 같은 초의 bot 댓글은 본문이 그 run의 검증된 `html_url`을 정확히 참조할 때만
fast response로 인정한다. 좌표 없는 같은 초 댓글과 run 좌표를 담을 수 없는 reaction은 인정하지 않는다.
댓글과 reaction이 같은 초면 교차 타입 순서를 증명할 수 없어 `PENDING`으로 재poll한다. 최신 retry
run보다 오래되거나 같은 초지만 상관 좌표가 없는 댓글·reaction도 terminal 신호에서 제외한다. 요청 reviewer가 없고 capability
부재로 unavailable reviewer가 있으면 highest disposition은 `UNAVAILABLE`이다. 명시적 skip이나
`review.auto=false`처럼 unavailable도 없는 의도적 no-review는 기존 `CLEAN`을 유지한다.

## 실행 규칙

- title/body를 먼저 확정한다. 내용이 모호하면 생성 전에 한 번만 질문한다.
- `--timeout` 기본값은 20분이며 양의 정수만 허용한다.
- `--reviewers` 같은 임의 capability override는 없다. eligible matrix를 통과한 reviewer만 요청한다.
- partial reviewer unavailable은 나머지 eligible reviewer 요청을 막지 않는다.
- mention 이후 실패해도 생성된 Issue URL을 보존하고, Issue edit/close/delete/PATCH나 자동 구현을 하지 않는다.
