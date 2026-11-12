# Guard break-glass: 모든 도구가 `GUARD_*` 코드로 막힐 때

이 문서는 Guard hook이 모든 도구 호출을 막아 세션이 작업을 이어 갈 수 없을 때, 사용자가 터미널에서 직접
hook 배선을 잠시 풀고 되돌리는 절차다. 에이전트가 이 절차를 실행하지 않는다. 원인 진단과 Guard 상태 수리는
이 문서의 범위가 아니다.

## 증상

- Claude Code 또는 Codex의 PreToolUse가 모든 도구에 `GUARD_UNAVAILABLE`, `GUARD_PROTOCOL_MISMATCH`,
  `GUARD_HOOK_TIMEOUT` 같은 `GUARD_*` 코드를 돌려주고, 같은 코드가 반복된다.
- 에이전트 세션 안에서는 해소할 수 없다. 에이전트가 hook 설정이나 Guard 상태를 고치려는 시도도 같은 hook에 막힌다.

## 하지 않는 것

- Guard 상태, journal, `registry.lock`, `guard-policy.json`을 편집·삭제·이동하지 않는다.
- `jhw-control-hook` launcher, `SessionEnd` group, 소유하지 않은 foreign hook group을 건드리지 않는다.
- 배포(`install.sh --activate`·`--refresh-bootstrap`·`--rollback`·`--uninstall`)로 해결하려 하지 않는다.

## 절차 (사용자 터미널에서만)

1. 영향받는 세션을 모두 종료한다. 설정을 바꾼 뒤 세션을 다시 시작해야 적용된다(수정이 열린 세션에 즉시
   반영되는지는 확인되지 않았다).
2. 설정 파일을 백업한다. 수정 전 bytes와 mode를 그대로 보존하고, 있는 파일만 백업한다.

   ```sh
   for file in ~/.claude/settings.json ~/.codex/hooks.json; do
     if [ -e "$file" ]; then cp -p "$file" "$file.guard-break-glass.bak"; fi
   done
   ```

3. 편집기로 아래 exact group만 제거한다. 해당 adapter 파일의 `UserPromptSubmit`, `PreToolUse`,
   `PostToolUse` 이벤트에서, handler가 하나뿐이고 command가 다음 문자열과 정확히 같은 group이다.

   ```sh
   "$HOME/.local/bin/jhw-control-hook" --adapter <claude|codex> --event <UserPromptSubmit|PreToolUse|PostToolUse>
   ```

   Claude는 `~/.claude/settings.json`에서 `--adapter claude`, Codex는 `~/.codex/hooks.json`에서
   `--adapter codex` group만 제거한다. `--event SessionEnd` group은 남긴다. command가 조금이라도 다르거나
   matcher가 있거나 handler가 여러 개인 group은 foreign group이므로 건드리지 않는다.
4. 세션을 다시 시작해 도구가 더 이상 `GUARD_*`로 막히지 않는지 확인한다.
5. 막힌 원인을 고친 뒤(예: Task 시작·관찰 기록 문제 해소) 아래 복원 절차로 hook을 되돌린다.

## 복원

- 다음 `install.sh` 실행 전에 백업에서 되돌린다. Guard group이 손으로 제거된 상태에서 `--activate`나
  `--refresh-bootstrap`이 거부하는지는 확인되지 않았다.
- 복원 전에 백업과 현재 파일의 `diff`를 보고, 차이가 3단계에서 제거한 group뿐인지 사용자가 직접 확인한다.
  백업이 없는 파일(2단계에서 존재하지 않았던 파일)은 복원하지 않는다.

  ```sh
  diff ~/.claude/settings.json.guard-break-glass.bak ~/.claude/settings.json
  diff ~/.codex/hooks.json.guard-break-glass.bak ~/.codex/hooks.json
  ```

  확인한 뒤에만 되돌린다. 해당 파일의 백업이 있을 때만 실행한다.

  ```sh
  cp -p ~/.claude/settings.json.guard-break-glass.bak ~/.claude/settings.json
  cp -p ~/.codex/hooks.json.guard-break-glass.bak ~/.codex/hooks.json
  ```

  `diff`에 제거한 group 밖의 차이가 있으면(백업 뒤에 다른 도구가 설정을 바꿨다면) 덮어쓰지 말고 제거한
  group만 같은 위치에 다시 넣는다.
- 복원 확인은 대상 worktree에서 `"$HOME/.local/bin/jhw-control-host" guard preflight`로 한다. `jhw-control`을
  직접 호출하지 않고 launcher를 쓴다(AGENTS.md). 결과 해석은
  `docs/project-control/phase1a-runbook.md`의 「Claude/Codex Guard hook 점검」을 따른다.
