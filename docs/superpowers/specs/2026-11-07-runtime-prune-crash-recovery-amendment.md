# #196 정리 중단 복구 설계 분기

상태: 사용자 `진행`으로 권장 설계 승인. 로컬 구현·검증을 재개한다.
대상: 아직 배포하지 않은 `--prune --apply`의 삭제 단계다.

## 확인된 문제

첫 독립 검토에서 정리 namespace의 parent fsync가 빠져 있었다.
보완 뒤 두 번째 검토에서는 rename 이후 source parent를 destination보다 먼저
fsync하는 순서가 남아 있었다. source의 제거만 확정되고 capture의 생성은 아직
확정되지 않은 중단 창에서는 복구 자료가 남는다고 보장할 수 없다.

같은 crash-evidence 불변식에서 검토 누락이 두 번 발생했으므로 AGENTS.md의
설계 분기 규칙을 적용한다. 현재 15개 테스트가 통과해도 이 결함의 해결 증거가 되지 않는다.

## 권장안: 복구 복사본을 먼저 확정한 뒤 정리한다

기존 보존 정책·dry-run·전체 preflight·두 lease·quiescence·root FD 고정은 유지한다.
삭제가 시작되기 전에 후보의 검증된 regular 파일 전부를 private recovery 사본으로
복사하고, 원본 snapshot과 바이트·mode·digest를 다시 대조한다.

1. `.prune.v1`과 intent를 만들고 runtime parent까지 fsync한다.
2. 후보별 복구 사본을 exclusive create로 만들고 각 파일과 recovery namespace를 fsync한다.
3. 모든 사본과 inventory가 원본 snapshot과 일치하고 durable하다는 상태를 기록·fsync한다.
4. 이 경계 전에는 원본을 rename·unlink하지 않는다. 공간 부족·copy 실패는 원본을 보존한다.
5. 경계를 통과한 후보만 다시 검증하고 capture한다. destination parent fsync를 먼저,
   source parent fsync를 나중에 수행한다. 원본에 대한 exact identity 검사를 유지한다.
6. regular 자식을 개별 unlink하고 빈 디렉터리만 제거한다. 각각의 namespace 변경을 fsync한다.
7. 중단 시 복구 사본·inventory·진행 상태를 보존하고 다음 apply는 자동 재개하지 않는다.
8. 원본 정리의 내구성까지 확인한 정상 완료에서만 복구 사본을 제거한다. 마지막 증거 제거 후
   fsync 실패는 증거가 남았다고 주장하지 않고 실제 제거 여부와 내구성 미확인을 구분한다.

복사본은 기존 candidate 총량 한도 64 MiB 안에서 만든다. 추가 공간은 정리 실행 중에만
필요하다. release·activation·live bootstrap은 여전히 삭제하지 않고, 실제 운영 적용은
정리 계획을 확인한 별도 승인 후에만 한다. 자동 복원·전체 batch rollback은 제공하지 않는다.

## 필요한 증거

- 복사·검증·fsync 완료 전 원본 rename/unlink 호출 0회.
- copy 중 공간 부족·바이트 변화·owner/mode/link 변화에서 원본 보존.
- 복구 사본 작성 중, durable 경계 직후, destination/source fsync 사이,
  첫 원본 unlink 뒤, 마지막 증거 제거 전후의 child process 중단 회귀.
- 각 중단 단계에서 원본 또는 검증된 복구 사본으로 파일 바이트를 복원할 수 있음.
- incomplete 상태에서 다음 apply가 아무것도 삭제하지 않음.
- 보존 정책·4096/4097·root 교체·mixed retained version 회귀 유지.
- 기존 구현자와 다른 검토자가 복구 경계를 독립 검토한 뒤 전체 runtime 검사를 재실행.

## 대안

#196의 실제 삭제 기능을 이번 배포에서 보류하고 조회·정책만 남긴다.
이 경우 실제 정리 구현은 미완료로 기록하고 이슈를 완료했다고 처리하지 않는다.
다른 이슈의 구현·검증은 두 선택 모두 계속 진행한다.
