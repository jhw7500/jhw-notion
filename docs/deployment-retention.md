# 배포 기록 보존과 정리

`.jhw-runtime`의 release, activation, `current`, live bootstrap은 자동 정리 대상이 아니다. 정리 명령은 정상 완료가 입증된 배포 journal과 그 journal이 순서를 입증하는 일부 이전 bootstrap만 제한적으로 다룬다.

## 명령

- `./install.sh --prune`은 advisory 계획만 계산한다. lock, journal, metadata를 만들거나 파일을 삭제하지 않는다.
- `./install.sh --prune --apply`는 계획을 다시 계산한 뒤 삭제한다. 배포와 별개의 maintenance 작업이며 실행 직전 별도 운영 승인이 필요하다.

apply는 consumer quiescence를 확인하고 deploy lease와 exclusive admission lease를 모두 획득한 뒤 quiescence를 다시 확인한다. pending 또는 판정할 수 없는 journal, 이전 prune의 미완료 증거, scan 상한 초과가 하나라도 있으면 전체 삭제 건수는 0이다.

## 보존 정책

- 정상 성공 journal은 완료 시각 기준 30일 이상 보존하고 sequence 기준 최근 32개 이상을 보존한다. 최근 32개 경계와 완료 시각이 같은 journal은 모두 보존한다.
- 실패, 거절, 복구, detached/incomplete 상태, preimage와 listing 증거는 삭제하지 않는다.
- 이전 bootstrap은 최소 30일과 sequence로 입증된 최신 1개를 보존한다. legacy 또는 순서를 입증할 수 없는 previous와 보존 journal이 참조하는 previous는 보존한다.
- 이름 정렬과 directory mtime은 순서 증거로 사용하지 않는다. 정상 완료 journal의 `retention.json`과 runtime root의 `.retention-sequence.v1.json`만 부가 순서 증거로 사용한다.

## 안전 경계와 중단 복구

scanner는 runtime root 8,192 entries, state 파일당 256 KiB, 전체 state 32 MiB, 삭제 후보 검증 64 MiB로 제한된다. 삭제 대상은 current-user 소유, mode `0600`, link count 1인 닫힌 파일 집합과 mode `0700` 디렉터리여야 한다. symlink, 다른 소유자, unknown child 또는 관측한 identity 변경은 삭제하지 않는다.

scan 시작 전에 검증한 runtime root FD를 plan/apply 종료까지 유지한다. 이후 journal, retained previous, intent와 capture 접근은 모두 이 FD에 상대적으로 고정하며, 현재 pathname이 최초 inode를 계속 가리키는지도 재검사한다. 정상 성공 journal은 operation별 `previous`, `destination`, `current`, `bootstrap`, `variables` 구조가 완전하고 서로 일관될 때만 후보가 된다.

apply는 전체 preflight 뒤 `.prune.v1`에 private intent/state를 기록한다. 이어서 모든 후보의 닫힌 regular 파일을 후보 총량 한도 64 MiB 안에서 private recovery 디렉터리에 exclusive create로 복사한다. 각 복사본은 원본 snapshot과 byte, SHA-256 digest, mode, source/recovery identity를 다시 대조하고 파일과 recovery namespace를 `fsync`한다. 모든 후보의 inventory와 복사본이 검증되고 durable 상태가 기록되기 전에는 원본을 `rename`하거나 `unlink`하지 않는다. 공간 부족, 복사 실패, 원본 byte·owner·mode·link·identity 변화가 있으면 원본 namespace는 그대로 둔다.

durable recovery 경계를 통과한 후보만 identity를 다시 검증해 private capture로 옮긴다. rename 뒤 destination인 evidence parent를 먼저 `fsync`하고 source인 runtime parent를 나중에 `fsync`한다. capture 안의 regular 자식은 하나씩 `unlink`하고 매 변경마다 parent를 동기화하며, 빈 디렉터리만 `rmdir`한다. recursive removal은 사용하지 않는다. 모든 후보의 원본 삭제와 parent 동기화가 끝난 뒤 batch `originals_durable` 상태를 파일과 evidence parent에 기록·동기화한다. 이 전체 batch 경계 전에는 어느 recovery 사본도 제거하지 않는다. 경계를 통과한 별도 cleanup loop에서만 recovery를 제거하고, 최종 evidence 제거 뒤 runtime parent를 동기화한다.

intent 생성 이후 최종 evidence 제거 전까지 실패하거나 crash가 발생하면 `.prune.v1`과 recovery inventory, 복사 진행 상태, 남은 capture가 조사 증거로 남는다. 복사 단계 실패에서는 원본이 남는다. 원본 namespace 변경이 시작된 뒤에는 앞 후보의 삭제가 이미 내구화됐더라도 batch 전체가 `originals_durable`에 도달할 때까지 모든 recovery 사본을 유지한다. 따라서 뒤 후보 처리 중 중단돼도 이미 삭제된 각 후보는 검증된 recovery bytes·mode·digest·inventory를 갖는다. marker가 남은 다음 apply는 이를 자동 재개하거나 rollback하지 않고 `DEPLOY_PRUNE_BLOCKED`의 `previous_prune_incomplete`로 중단한다. 미완료 evidence가 생긴 실행과 일부 삭제가 끝난 뒤의 실패는 `DEPLOY_PRUNE_PARTIAL`이며, 운영자가 실제 원본·복사본·진행 상태를 검토하고 별도 복구 절차를 결정해야 한다.

모든 원본 삭제와 recovery cleanup, intent/state 제거가 내구화된 뒤 `.prune.v1` rmdir은 성공했지만 runtime parent `fsync`가 실패하면 marker는 현재 namespace에 없고 제거의 내구성만 확인되지 않은 상태다. 이 예외는 `DEPLOY_PRUNE_PARTIAL`의 `evidence_removed_unsynced`로 구분한다. 영구 fence나 자동 복구는 만들지 않으며, 이후 사용자가 새 apply를 명시적으로 실행해 0건을 처리하는 것은 이전 삭제의 자동 resume가 아니다. 마지막 recovery 제거가 시작된 뒤의 강제 전원 차단에 대해 원본 복원 가능성을 주장하지 않으며, 테스트 fault point는 호출 순서와 관측 가능한 파일 상태만 검증한다.

정상 배포 뒤 retention counter 또는 receipt 기록이 실패해도 이미 성공한 배포를 실패로 바꾸지 않는다. 결과의 `warnings: ["retention_receipt_unavailable"]`로 알리고 해당 journal은 자동 정리하지 않는다.
