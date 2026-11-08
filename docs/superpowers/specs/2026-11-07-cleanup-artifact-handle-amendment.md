# #220 cleanup artifact verification amendment

상태: 사용자 `진행`으로 권장 설계 승인. 로컬 구현·검증을 재개한다.
2라운드 뒤 사용자 `진행`으로 원격 확인과 최종 로컬 검사를 분리하는 아래 보완도 승인했다.

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
