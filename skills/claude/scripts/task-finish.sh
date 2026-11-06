#!/usr/bin/env bash
# Canonical status-sensitive Task finish contract. Validation values are argv.
finish_status="$JHW_FINISH_STATUS"
current_task_id="$JHW_CURRENT_TASK_ID"
current_claim_id="$JHW_CURRENT_CLAIM_ID"
finish_outcome="${JHW_FINISH_OUTCOME-}"
source_task_revision="${JHW_SOURCE_TASK_REVISION-}"
active_work_minutes="${JHW_ACTIVE_WORK_MINUTES-}"
handoff_progress="${JHW_HANDOFF_PROGRESS-}"
handoff_failures="${JHW_HANDOFF_FAILURES-}"
handoff_next_step="${JHW_HANDOFF_NEXT_STEP-}"
handoff_related_evidence="${JHW_HANDOFF_RELATED_EVIDENCE-}"

test -n "$current_task_id" || exit 1
test -n "$current_claim_id" || exit 1
test "$#" -ge 1 || exit 1
finish_args=(task finish --task "$current_task_id" --claim "$current_claim_id" --status "$finish_status")
case "$finish_status" in
  completed)
    test -n "$finish_outcome" || exit 1
    test -z "$source_task_revision$handoff_progress$handoff_failures$handoff_next_step$handoff_related_evidence" || exit 1
    finish_args+=(--outcome "$finish_outcome")
    ;;
  handoff)
    test -z "$finish_outcome" || exit 1
    if [ -n "$handoff_progress" ]; then finish_args+=(--progress "$handoff_progress"); fi
    if [ -n "$handoff_failures" ]; then finish_args+=(--failures "$handoff_failures"); fi
    if [ -n "$handoff_next_step" ]; then finish_args+=(--next-step "$handoff_next_step"); fi
    if [ -n "$handoff_related_evidence" ]; then
      finish_args+=(--related-adr-and-evidence "$handoff_related_evidence")
    fi
    if [ -n "$source_task_revision" ]; then
      test "$source_task_revision" != "unknown" || exit 1
      finish_args+=(--source-task-revision "$source_task_revision")
    fi
    ;;
  abandoned)
    test -z "$finish_outcome$source_task_revision$handoff_progress$handoff_failures$handoff_next_step$handoff_related_evidence" || exit 1
    ;;
  *) exit 1 ;;
esac

if [ -n "$active_work_minutes" ]; then
  finish_args+=(--active-work-minutes "$active_work_minutes")
fi
for validation in "$@"; do
  test -n "$validation" || exit 1
  finish_args+=(--validation "$validation")
done

"$HOME/.local/bin/jhw-control-host" "${finish_args[@]}"
finish_rc=$?
test "$finish_rc" -eq 0 || exit "$finish_rc"
