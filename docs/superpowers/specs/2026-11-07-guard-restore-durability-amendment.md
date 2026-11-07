# #195 Guard restore durability amendment

상태: 사용자 `진행`으로 권장 설계 승인. 로컬 구현·검증을 재개한다.

## 두 차례 검토에서 확인한 점

첫 검토의 외부 파일 overwrite·완료 상태 재검증·복구 경계·reverse lookup·HOME 결속을
보완했지만, 재검토에서 다음 세 조건이 재현됐다. 기존 전용 21개 테스트 통과는 해소 증거가 아니다.

- ready를 쓴 뒤 첫 file fsync 전에 중단하면, 재개가 그 파일을 한 번도 fsync하지 않고 완료한다.
- capture unlink 뒤 parent fsync 전에 중단하면, 재개가 그 디렉터리를 한 번도 fsync하지 않고 완료한다.
- 완료된 live 파일에 무관한 hard link를 만들어도 nlink=2를 허용한 채 완료한다.

실제 전원 차단을 실험한 것은 아니다. 확인한 것은 fsync 호출 의무와 잘못된 완료 판정이다.
같은 내구성·완료 진실성 불변식의 두 번째 누락이므로 AGENTS.md에 따라 설계 분기를 올린다.

## 권장: 재개 시 fsync 의무와 link 귀속을 다시 증명

진행 marker와 현재 bytes가 맞다는 사실을 이전 fsync의 증명으로 사용하지 않는다.
파일 데이터, namespace 변경, 진행 기록의 내구성을 별도 조건으로 명시한다.
모든 원본 bytes는 이미 durable한 private before.json에 보존하고, 어떤 복구 성공도
현재 세 live 파일과 남은 evidence를 재검증한 뒤에만 반환한다.

```text
verified data -> file fsync -> publish -> parent fsync -> unlink -> parent fsync
                       durable progress records describe each boundary
resume -> verify current objects -> repeat outstanding sync obligations -> complete
```

- ready가 이미 있더라도 같은 FD로 owner/mode/nlink/inode/bytes를 재검증하고 file fsync를
  다시 수행한다. 이미 한 fsync를 반복하는 것은 허용하며, 존재만 보고 건너뛰지 않는다.
- link/rename/unlink의 결과가 이미 보이더라도, 관련 parent의 fsync 의무를 재실행한 뒤
  다음 durable marker와 완료 단계로 넘어간다. “이미 없음”은 삭제 내구성의 증명이 아니다.
- 중간 nlink=2 허용은 evidence에 이름과 inode가 정확히 결속된 live/ready 또는 live/capture
  쌍으로 한정한다. 무관한 alias나 설명되지 않는 link는 차단한다. terminal은 nlink=1과
  모든 자기 소유 임시 entry의 정리를 확인해야 한다.
- before.json을 포함한 progress 갱신 자체도 file fsync와 parent fsync가 끝난 뒤에만
  durable로 취급한다. update 실패는 증거를 보존하며 성공으로 바꾸지 않는다.
- restore 시작/재개 전에 세 파일의 모든 허용 조합을 검사하고, 각 mutation 직전과 terminal
  재진입 때 다시 검사한다. 충돌하는 외부 파일을 덮어쓰거나 자동 정리하지 않는다.
- filesystem 전이표에 각 syscall 직전·직후·각 fsync 직전·직후를 빠짐없이 표시하고,
  정상/중단/재개에서 수행해야 할 sync 의무를 각 행에 적는다.

현재 driver 시험에서 드러난 인터페이스 결속도 함께 명확히 한다. runtime-store의 현재
activation은 세 ID 필드뿐 아니라 pointer observation도 포함한다. 모듈이 세 필드만 받는
mock을 기준으로 실제 객체를 거부하지 않도록, 정본 selector와 frozen observation의 역할을
문서화하고 모든 실제 호출·복구 비교를 같은 타입 경계에 맞춘다. pointer 동시성 fence를
느슨하게 하거나 필드를 조용히 버리는 fallback은 만들지 않는다.

## 필수 검증

1. 위 세 반례를 먼저 실패로 고정한다. 잘못된 성공 판정과 정확한 실패 reason을 함께 본다.
2. 모든 파일/namespace syscall 및 fsync 전후 fault point에서 중단하고, 새 프로세스로 재개해
   필요한 file/parent fsync가 실제로 다시 호출되는지 확인한다.
3. 각 중간 상태의 허용 link 두 개를 exact inode/name으로 검증하고, 무관한 hardlink는
   시작·중간·terminal 모두에서 거부한다. 외부 bytes와 pointer는 보존한다.
4. 실제 runtime-store activation 객체, old retained helper, 정상 전환·실패·origin pointer-intent
   중단·일반 activate/refresh·중간 rollback을 end-to-end fixture에서 검증한다.
5. 새로운 검토자가 전이표와 구현을 다시 검토한다. 논리적 fault/fsync 순서 검증과 실제 전원
   차단 실험을 구분하고, 하지 않은 실험은 완료라고 말하지 않는다.

## 대안

이번 배포의 host observe 전환을 보류한다. 기존 SessionEnd-only 설치와 기존 모드만 유지하며
#195는 완료로 표시하지 않는다. 이 대안은 감사 로그 설계 보류와도 같은 배포 범위를 만든다.

선택 범위는 로컬 설계·구현·검증이다. 실제 HOME/Registry 변경·프로세스 종료·push·PR·머지·배포는
각각 별도 승인 경계를 따른다. worker KEYS·phase·bootstrap 파일 집합은 그대로 유지한다.
