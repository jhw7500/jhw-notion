# Registry lock bounded-wait 설계

작성: 2026-08-29. 상태: 승인된 단순 설계, 구현 전.

## 1. 목표

호스트 전역 `registry.lock`의 직렬화 안전성은 유지하면서, 정상적인 짧은 중첩이
즉시 `LOCK_CONTENDED`로 실패하지 않게 한다. bounded wait가 끝나도 lock이
점유 중이면 민감정보 없는 최소 holder 진단을 반환한다.

## 2. 확정 정책

- 일반 Registry writer는 `flock -w 30 -E 75`로 최대 30초 기다린다.
- Guard의 Registry mutation authority는 기존 5초 wait override를 유지한다.
- Board의 `boards.lock`도 기존 5초 정책을 유지한다.
- `registry.lock`은 프로젝트별로 나누지 않는다. 동일 state directory를 쓰는 모든
  프로젝트와 세션에 같은 host-global 정책이 적용된다.
- wait가 끝나면 `LOCK_CONTENDED`, exit 75, reason `registry_state_lock`을 반환한다.
- helper watchdog은 wait보다 길게 유지해 정상적인 `flock -w 30`을 조기에 죽이지
  않으며, helper 자체가 멈추면 기존 `LOCK_ACQUIRE_TIMEOUT`으로 fail closed한다.

`MutationLock`의 production Registry profile에 30초 wait와
`registry_state_lock` reason을 둔다. Guard는 같은 lock inode를 사용하지만 내부
`runGuard`가 5초를 명시적으로 override한다. Guard provenance는 production에서
생성된 concrete `MutationLock`, 원본 prototype/method, `registry.lock` 좌표 검증을
계속 요구한다. 일반 writer가 bounded wait를 사용한다는 이유만으로 Guard 자격을
잃지는 않는다.

## 3. 최소 holder 진단

별도 sidecar를 만들지 않는다. lock을 획득한 프로세스가 이미 검증된 0600
`registry.lock` 파일에 다음의 작은 JSON 레코드를 기록한다.

```json
{
  "version": 1,
  "command": "preflight",
  "acquired_at": "2026-08-29T00:00:00.000Z",
  "pid": 12345
}
```

- CLI는 lock 대상인 닫힌 command 이름만 `MutationLock.run` context로 전달한다.
- command 전체 argv, project, repository path, session, Claim, 환경변수는 기록하지
  않는다.
- 레코드 쓰기는 진단용 best effort다. 쓰기 실패가 Registry mutation의 안전성을
  바꾸거나 이미 획득한 lock을 임의로 해제하지 않는다.
- contention 시에만 최대 1KiB를 읽고 strict schema로 검증한다. 부재, 초과 크기,
  손상, 알 수 없는 command이면 holder 진단을 생략한다.
- `elapsed_ms`는 검증된 `acquired_at`과 현재 시각의 차이를 음수가 되지 않도록
  계산한다.
- PID 원값은 공개하지 않는다. `kill(pid, 0)` 성공 또는 `EPERM`은 `alive`,
  `ESRCH`는 `dead`, 그 밖의 결과는 `unknown`으로만 공개한다.
- PID 상태는 관측용 진단이며 lock 회수나 소유권 판정에 사용하지 않는다. 따라서
  단순 진단을 위해 PID start-time/boot-id 상태 모델을 추가하지 않는다.

공개 오류의 optional holder shape은 다음으로 고정한다.

```json
{
  "error": {
    "code": "LOCK_CONTENDED",
    "reason": "registry_state_lock",
    "lock_holder": {
      "command": "preflight",
      "acquired_at": "2026-08-29T00:00:00.000Z",
      "elapsed_ms": 30012,
      "pid_state": "alive"
    }
  }
}
```

`controlErrorResult`는 `LOCK_CONTENDED`일 때만 strict
`LockHolderSummarySchema`를 통과한 네 필드를 내보낸다. raw `ControlError.details`는
계속 공개하지 않으며 journal에는 기존처럼 code와 등록된 reason만 남긴다.

## 4. 종료와 경합 경계

- lock authority는 계속 kernel flock이다. metadata 내용은 authority가 아니다.
- holder가 정상 종료하거나 비정상 종료하면 FD가 닫히면서 kernel이 lock을
  해제한다. 별도 cleanup과 `registry.lock` 삭제는 필요하지 않다.
- 다음 holder는 획득 직후 기존 metadata를 덮어쓴다.
- timeout 직후 holder가 끝나는 race가 있을 수 있으므로 진단은 해당 실패 시점의
  best-effort 관측으로만 취급한다.
- malformed 또는 stale metadata만으로 lock을 회수하거나 mutation을 진행하지
  않는다.

## 5. 검증

테스트는 다음을 고정한다.

1. production Registry writer는 30초 wait, Guard와 Board는 각각 기존 5초 wait.
2. 짧은 holder가 test wait 안에 끝나면 독립 contender가 성공한다.
3. 긴 holder는 bounded timeout 뒤 exit 75와 등록 reason을 반환한다.
4. 유효한 holder metadata는 네 개의 공개 필드로만 축약된다.
5. PID, session, path, argv와 내부 metadata는 stderr와 journal에 노출되지 않는다.
6. holder 프로세스 종료 후 lock 파일 삭제 없이 다음 명령이 성공한다.
7. 서로 다른 프로젝트의 명령도 같은 state directory에서 직렬화된다.
8. 기존 symlink/hardlink/mode, helper timeout, Guard provenance 테스트가 유지된다.

구현 후 `npm run typecheck`, `npm run build`, `npm test`와 스킬 동기화 검사를 모두
실행한다.

## 6. 비범위

- preflight 네트워크 검증을 lock 밖으로 이동하는 two-phase 재설계
- preflight와 후속 Task mutation 사이 proof/cache 도입
- 프로젝트별 Registry lock 또는 lock sharding
- daemon, heartbeat, metadata 기반 강제 회수

이 항목들은 실제 30초 timeout이 계속 관측될 때 별도 변경으로 평가한다.
