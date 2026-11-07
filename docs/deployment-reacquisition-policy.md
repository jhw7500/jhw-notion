# 배포 검증 뒤 재획득 정책

[#206](https://github.com/jhw7500/jhw-notion/issues/206)의 재획득 재시도는 이미
`scripts/runtime-deploy.mjs`에 구현돼 있다. 이 문서는 2026-11-07 기준 동작과
이슈에서 요청한 두 대안의 검토 결정을 기록한다. 운영 복구와 결과 코드의 정본은
[README.md](../README.md)의 배포 절차다.

## 현재 재시도 범위

배포 writer lease는 검증 동안에도 유지하고, admission lease만 검증 probe를 위해
잠시 해제한다. 검증 뒤에는 admission lease를 다시 확보하고 consumer inventory를
다시 확인해야 다음 변경을 할 수 있다. activate·rollback과 bootstrap refresh가
같은 재획득 함수를 사용한다.

- `DEPLOY_INVENTORY_UNCERTAIN` 또는 `DEPLOY_LOCK_CONTENDED`이면 최초 시도를 포함해
  최대 5회 시도하고, 재시도 사이에 200 ms를 기다린다.
- 어떤 consumer 수치라도 0보다 크면 재시도하지 않는다. uncertainty와 consumer가
  함께 관측돼 오류 코드가 `DEPLOY_INVENTORY_UNCERTAIN`이어도 동일하다.
- 마지막 거부의 원래 오류 코드·시도 횟수·inventory를 journal의 `reacquisition`에
  남긴다. lock 획득 실패처럼 inventory가 없으면 `null`이다. 외부 결과는
  `DEPLOY_RECOVERY_REQUIRED` / `maintenance_reacquisition_failed`다.
- 변경 전 최초 quiescence 검사는 이 재시도의 대상이 아니다. 이 정책은 operator의
  전체 배포 명령 자동 재실행이나 consumer 종료를 허용하지 않는다.

## 결정: 전체 PID 관측을 유지한다

새로 생긴 같은 uid PID만 다시 검사하는 최적화는 채택하지 않는다.
`runtime-safety.mjs`는 이미 다른 uid의 process record를 읽지 않지만, PID 목록의
안정성은 전체 목록을 전후 비교한다. 기존 PID도 `exec`로 consumer가 되거나 uid가
바뀔 수 있고, 종료된 PID 번호가 재사용될 수 있다. 새 번호만 검사하는 방식은
이 변화를 놓칠 수 있다.

현재 구현은 같은 uid process의 argv·시작 시점·uid·필요한 cwd와 열린 객체의
안정성을 확인한다. 일시적인 관측 실패는 위의 제한된 재시도로 다룬다. 전체 목록
비교의 일시적 불확실성을 없애기 위해 consumer 발견 범위를 줄이지 않는다.

## 결정: activation의 재획득만 재개하는 경로는 추가하지 않는다

`recovery_blocked`는 검증 성공을 증명하는 phase가 아니다. 검증이 먼저 실패했어도
그 오류를 지역 변수에 둔 채 재획득하다가 실패하면 journal phase가
`recovery_blocked`로 기록된다. 이 phase만 보고 재획득 뒤 finalize하면 실패한
release를 검증 완료로 처리할 수 있다.

따라서 activation의 pending journal은 기존의 검증된 predecessor rollback 경로로
처리한다. predecessor와 pointer 등 복구 조건이 맞지 않으면 operator 검토로
넘기며, journal 삭제나 상태 강제 변경으로 우회하지 않는다. 중단된 bootstrap
refresh는 기존처럼 같은 `--refresh-bootstrap` 경로에서 원래 helper 세트를 결속해
재개한다. 이 둘은 서로 대체 가능한 복구 경로가 아니다.

향후 재획득만 재개하려면 검증 성공·실패를 별도로 내구성 있게 기록하고, exact
pointer·release·wiring과 검증 증거를 다시 확인하는 프로토콜이 먼저 필요하다.
이 변경에서는 journal version·worker 상태 키·phase를 추가하지 않는다.

## 검증 근거

2026-11-07, main `50c9fe70c30ad7d9859bd2b9f31c84144d4dd140`에서 실행했다.

```bash
node --test --test-name-pattern='reacquisition|admission lease again|later validation failure' scripts/test-runtime-deploy.mjs
```

9개 실행, 성공 9개, 실패 0개, skip 0개, 종료 코드 0이었다. activation과 refresh의
일시적 uncertainty, 일시적 lock 경합, 지속 실패 진단, consumer 즉시 거부,
기존 검증 실패와 gated rollback을 포함한다. 기존 회귀 테스트를 재실행한 결과이며,
새 테스트를 추가하거나 실제 운영 배포·rollback을 실행한 결과는 아니다.
