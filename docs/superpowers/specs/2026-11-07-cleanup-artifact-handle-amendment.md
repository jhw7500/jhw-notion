# #220 cleanup artifact verification amendment

상태: 사용자 `진행`으로 권장 설계 승인. 로컬 구현·검증을 재개한다.
2라운드 뒤 사용자 `진행`으로 원격 확인과 최종 로컬 검사를 분리하는 아래 보완도 승인했다.
이후 사용자 `A`로 정상 cleanup과 checkout 부재 복구의 공통 검증 범위 및 상태 게시 직전
검사 설계를 승인했다. 이번 범위는 로컬 수정·검증·커밋이며 새 Tribunal·push·PR·머지·배포와
실제 redmine/Registry 정리는 별도 승인 대상이다.

## 확인한 문제

첫 검토는 검증 후 artifact가 교체될 때의 final fence 누락을 지적했다. 보완 후 재검토에서도
`verifyHistoricalArtifactSnapshot`이 파일을 검증하고 닫은 뒤, cleanup이 새 FD를 여는 사이의
교체를 막지 못했다. 새 FD의 자기 일관성만 검사하면 검증·백업에 결속되지 않은 새 파일을
제거할 수 있다. 이는 최종 syscall 직전의 비협조적 same-UID race 한계와 다른, 고칠 수 있는
검증 수명 문제다. 테스트 통과 수는 이 누락의 해소 증거가 아니다.

AGENTS.md의 “같은 불변식에서 리뷰가 두 번 이상 구멍을 내면 패치를 이어 가지 말고 설계
분기를 사용자에게 올린다” 규칙에 따라 아래 분기를 선택한다.

## 권장: 한 번 연 검증 핸들을 cleanup 범위 끝까지 유지

현재의 검증 후 close/reopen 조합을 없애고 callback 범위의 단일 검증 소유자로 바꾼다.
내부 API 예시는 `withVerifiedHistoricalCleanupProof(input, use)`다. 공개 CLI와 manifest
v1, 정확한 역사적 patch 대응 정책은 유지한다.

- verifier가 각 source artifact를 최초로 열 때 no-follow FD와 안전한 parent descriptor를
  확보한다. 이 FD에서 bytes/hash/mode를 manifest 및 별개 inode의 외부 backup과 비교한다.
- 성공한 검증 FD와 최초 inode/owner/mode/nlink/size/ctimeNs/mtimeNs observation을 callback
  전체에 유지한다. cleanup은 source artifact를 다시 열어 새 snapshot을 만들지 않는다.
- manifest·bundle·artifact backup의 검증된 읽기 핸들과 부모 관계도 같은 소유 범위에 둔다.
  마지막 확인에서 실제 경로가 같은 검증 객체를 가리키는지, 외부 backup이 여전히 같은 bytes와
  안전한 객체인지 확인한다. scratch 복원과 최초 hash 검증은 마지막 Registry fence 전에 한다.
- 비싼 검증 후 Registry/history/successor callback과 원격 origin identity·기본 ref·SHA 확인을
  끝낸다. 그 다음 mapping CAS/uniqueness, source ref/HEAD, worktree HEAD/status를 재확인한다.
  ignored inventory와 retained FD·실제 경로의 bytes/identity/time/mode/link 검사를 마지막으로
  실행하고 plain `git worktree remove`를 호출한다. 마지막 파일 검사 뒤에는 원격 조회나 외부
  callback을 추가하지 않는다.
- callback 성공·실패 모두 finally에서 FD와 scratch를 닫는다. FD나 callback을 persisted
  intent에 직렬화하지 않는다. 같은 proof 재개는 새 bounded 검증 scope를 처음부터 만든다.
- ignored 원본을 미리 unlink하지 않는다. task branch·외부 backup 보존, 기존 ancestor 경로,
  active successor 차단, old-reader fail-closed는 유지한다.

이는 검증된 객체의 수명을 결속한다. 비협조적 same-UID writer를 전체 syscall 동안 원자
봉쇄한다고 주장하지 않는다. 새로운 의존성·Registry 권한 전환·실제 worktree 삭제는 없다.

## 2라운드 보완: 원격 확인 뒤 최종 로컬 검사

`A-R2-001`은 마지막 파일 검사 뒤 원격 조회가 실행되는 새 대기 구간을 지적했다. 이 사이에
ignored 파일이 교체되면 보존한 FD는 이전 백업 객체를 증명하지만 Git은 새 파일을 삭제할 수
있다. 원격 재검사를 마지막 파일 검사 뒤에 추가한 순서를 다음 두 단계로 고정한다.

```text
remote checks / callbacks
          |
          v
local generation / refs / status
          |
          v
inventory / retained FD / paths
          |
          v
git worktree remove
```

원격 확인은 그 시점의 통합 허용 조건이다. 원격과 로컬 파일을 분산 원자적으로 고정한다는
보장을 만들지 않는다. 원격 확인 중 변경된 로컬 상태는 그 뒤의 최종 검사에서 거부한다.
기존 원격 SHA·기본 ref·fetch·push URL drift 검사는 유지한다.

## A 보완: checkout 부재 복구와 상태 게시까지 같은 소유 범위 유지

`A-R1-001`은 checkout이 이미 제거된 `pending-remove-equivalent` 재개에서 backup-only 검증이
핸들을 닫은 뒤 외부 callback과 tombstone 저장을 실행하는 누락을 확인했다. 정상 경로에서만
핸들을 보존하는 것으로는 부족하므로 두 경로가 아래 공통 검증 소유자를 사용한다.

- manifest·bundle·artifact backup은 최초 검증한 파일 FD와 root부터 열린 부모 디렉터리
  chain을 callback 반환까지 유지한다. 각 하위 객체는 retained parent FD 기준으로 no-follow
  open한다. 성공·callback 실패·부분 획득 실패 모두 finally에서 열린 자원을 닫는다.
- 같은 경로 prefix의 directory FD는 공통 scope의 pool이 한 번만 열고 닫으며 경로별 chain과
  missing-component 관측은 따로 유지한다. 파일 FD는 각 파일 소유자가 닫는다. manifest를 읽은 뒤
  현재 `/proc` FD 사용량·soft limit과 앞으로 유지할 backup/source leaf·고유 parent·임시 I/O 여유를
  비교해 부족하면 intent/Git 제거 전에 `scope_unsupported`로 중단한다. schema의 4096개는 입력
  상한이며 모든 OS FD 한도에서 실행을 보장하지 않는다. 이 관측은 FD 예약이 아니므로 이후
  `EMFILE`·`ENFILE`도 계속 안전하게 중단하며 프로세스 한도를 자동 변경하지 않는다.
- source·worktree·common Git directory·managed roots의 경로와 디렉터리 identity도 보존한다.
  backup은 이 금지 root 밖이어야 하며 lexical 경로와 열린 디렉터리 identity를 함께 검사한다.
  처음부터 없는 root는 가장 가까운 현존 ancestor와 남은 경로의 부재를 검사한다. 이번 정상
  제거로 사라진 worktree leaf만 retained FD의 link count가 0이면 허용하고 부모 교체는 거부한다.
- checkout 부재 재개도 proof digest·외부 backup·branch head·Git registration 부재를 다시
  검증한다. 외부 callback과 `beforeSave`, temp state write/fsync/close 뒤에 최종 guard를 실행한다.
  guard는 동일한 retained state directory에서 정확한 pending state 전체를 읽어 비교하고,
  backup을 다시 검사한 뒤 state를 한 번 더 비교한다. 그 다음에만 temp state를 rename한다.
- guard 실패는 이번 temp state만 지운다. durable pending intent와 다른 writer의 최신 state를
  덮어쓰지 않으며 task branch·외부 backup을 보존한다. Git 제거가 이미 끝난 경우에는 checkout이
  없고 pending intent가 남을 수 있으므로 같은 proof 명시 재개 절차를 따른다.
- 최종 backup/boundary 검증의 I/O 오류는 `snapshot_changed`로 반환한다. 외부 callback 자체의
  오류는 이 정규화 범위 밖에 두고 원래 오류를 보존한다.
- `A-R1-002`의 권한 검사는 `07777` 전체를 비교한다. manifest·bundle은 정확히 `0600`,
  private backup parent는 정확히 `0700`이다. artifact source와 backup은 manifest에 선언된
  일반 권한(`0000`–`0777`)을 서로 일치시키며 `0644`·`0755`도 유지한다. setuid·setgid·sticky는
  모든 파일과 private parent에서 거부한다. 모든 artifact를 `0600`으로 바꾸는 정책은 아니다.

최종 guard와 rename 사이에 외부 callback이나 Git 조회를 두지 않는다. 여러 파일과 state를
비협조적 same-UID writer로부터 하나의 원자 연산으로 고정하는 보장은 없으며, rename 이후
오류의 기존 결과 불확실성도 그대로 남는다. 새 CLI 플래그·manifest schema·오류 reason·의존성은
추가하지 않는다.

회귀는 실제 임시 Git 저장소에서 backup 교체·부모/ancestor 교체·금지 root 교체·특수 mode bit,
checkout 부재 callback 및 `beforeSave`/temp fsync 뒤 교체·더 최신 state의 보존·열린 FD 수명과
모든 종료 경로의 close를 확인한다. source/backup bytes가 같은 새 inode도 교체로 판정한다.
배포 전 CLI/host/MCP fixture 검증과 배포 후 실제 새 세션의 Guard 확인·승인된 redmine 정리는
서로 다른 증거다. 격리 fixture 통과를 실제 운영 확인 완료로 보고하지 않는다.

실제 임시 Git 작업본에서 두 번째 source-trust 확인 중 artifact bytes, byte-identical 새 inode,
새 ignored 경로, source HEAD, worktree HEAD/status, mapping을 변경하는 회귀를 둔다. 각 경우
Git 제거 호출과 removed tombstone이 생기지 않고 작업본·branch·외부 backup이 남아야 한다.

## 승인 후 필수 반례

1. 첫 검증 반환 직후와 cleanup이 FD를 열던 기존 gap에서 다른 bytes 또는 byte-identical 새
   inode로 바꾸는 두 반례를 먼저 실패로 재현한다. 기존 FD-open 뒤 callback 교체 반례도 유지한다.
2. verifier가 검증한 source FD와 마지막 확인에 쓰는 FD가 동일한 것을 실제 Git fixture에서
   관찰한다. 재open·FD 누수·잘못된 close 경로를 검사한다.
3. source/backup/manifest/bundle의 교체, mode/link/parent 교체, 검증 중 bytes 변경은 삭제 0건으로
   끝나야 한다. 허용하지 않는 source inventory 경로도 동일하다.
4. git remove 실패·tombstone 저장 실패 후 같은 proof 재개, stale registration/branch 이동,
   partial patch 대응·raw path·binary/type·canonical origin negative 회귀를 다시 실행한다.
5. 수정 구현자와 다른 검토자가 이 handle 수명 설계를 새로 검토한다. CLI/host/typecheck/build와
   전체 테스트를 입력이 고정된 상태에서 통합 검증한다.

## 대안: 이번 배포에서 증명 기반 정리 보류

새 historical cleanup의 destructive 경로를 배포 대상에서 빼고 기존 ancestor cleanup만
유지한다. redmine의 현재 non-ancestor/ignored artifact 사례는 자동 정리하지 않으며 #220을
완료로 표시하지 않는다. 나머지 이슈를 먼저 마치고 한 번 배포할 수 있다.

이 선택은 로컬 설계·구현·검증 범위다. 실제 redmine/Registry 변경·삭제와 push·PR·머지·배포는
각각 기존 승인 경계를 따른다.
