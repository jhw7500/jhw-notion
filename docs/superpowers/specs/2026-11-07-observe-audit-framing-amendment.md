# #195 observe audit framing amendment

상태: 사용자 `진행`으로 권장 설계 승인. 로컬 구현·검증을 재개한다.

## 확인한 문제

첫 검토의 “관찰 기록 실패에도 ALLOW”는 차단하도록 수정했다. 재검토에서는 공용 O_APPEND
helper가 short write로 남긴 불완전 JSON prefix 뒤에 다른 호출의 JSON을 붙일 수 있음이
확인됐다. 뒤 호출은 fsync에 성공해도 독립적으로 읽을 수 있는 자기 관찰 기록 없이 ALLOW할
수 있다. 잠금 밖의 newline/tail 검사만 추가해도 동시 writer 사이의 경합은 남는다.
필수 append 경로의 current UID·special mode bits 확인도 공용 helper에는 빠져 있다.

같은 필수 감사 불변식의 두 번째 누락이므로 AGENTS.md 규칙에 따라 설계 분기를 선택한다.
테스트 통과와 앞선 실패 처리 수정은 이 framing 문제의 해소 증거가 아니다.

## 권장: observe 전용 잠금 안에서 전체 형식 검증과 기록

기존 strict legacy journal과 SessionEnd reader는 유지한다. 이번에 새로 만드는 필수 observe
stream만 기존 supported cross-process flock 패턴을 쓰는 별도 잠금으로 보호한다.
공용 optional append helper를 그대로 감싼 뒤 다시 open하지 않고, 한 FD가 검증·쓰기·sync의
전체 수명을 소유한다. 공개 CLI·Registry 권한·승인 토큰 계약은 바꾸지 않는다.

```text
lock -> open/pin -> validate framing -> append -> fsync -> revalidate -> ALLOW
                     any failure ------------------------------------> DENY
```

- 전용 lock은 request/Registry lock과 다른 private 이름을 쓰고, 지원되는 bounded acquire만
  허용한다. lock 미지원·경합 timeout은 GUARD_UNAVAILABLE이며 무잠금 fallback은 없다.
- 디렉터리와 lock/journal은 no-follow FD 및 parent identity로 결속한다. HOME/private state
  namespace는 current UID 소유, journal/lock은 exact 0600·nlink1, 안전한 부모 mode를 요구한다.
- lock 안에서 bounded stream 전체를 fatal UTF-8·newline framing·closed observation schema로
  검사한다. 불완전/손상된 이전 기록은 자동 truncate·삭제·repair하지 않고 차단한다.
- 검증한 같은 FD에 한 관찰 기록을 추가한다. short write·write 오류·fsync 실패이면 현재
  호출을 차단하고 남은 증거를 보존한다. 뒤 writer도 lock 안에서 손상을 확인해 차단한다.
- append 후에도 같은 FD와 실제 경로의 inode/owner/mode/link/time을 재확인하고, 전체 framing과
  방금 기록한 exact observation이 독립 행임을 확인한 뒤에만 ALLOW한다. 큰 검증은 파일/행 수의
  기존 bounded 한도 안에서 수행한다.
- 필수 observe 기록이 성공한 뒤의 optional legacy journal 실패는 기존 warning으로 처리한다.
  정상 enforce mode의 optional journal 동작은 확대하지 않는다.
- observe lock 안에서는 Registry·request lock이나 네트워크를 새로 호출하지 않는다.
  읽기 전용 guard status/preflight는 이 lock이나 journal을 생성하지 않는다.

한 기록이 물리적으로 두 번 보일 수 있는 실패 경계는 permit이나 authority를 만들지 않는다.
비협조적인 same-UID writer의 전체 syscall 원자 봉쇄 또는 실제 전원 차단 실험 완료를
주장하지 않는다. 운영 journal의 수동 복구·삭제는 별도 승인 범위다.

## 승인 후 필수 검증

1. short write가 남긴 prefix 뒤 두 번째 호출이 ALLOW하는 반례를 먼저 재현한다.
2. 서로 다른 실제 프로세스의 writer 둘로 검사와 쓰기 사이를 교차시킨다. 첫 실패 뒤 다음
   writer도 차단되고, 정상 동시 호출은 각각 독립 schema-valid row를 남기는지 확인한다.
3. lock/file/directory의 UID·mode 04600·symlink·hardlink·path/inode 교체, invalid UTF-8,
   불완전 tail·중간 손상·한도 초과를 검사한다. 실패 때 기존 bytes는 보존해야 한다.
4. write/fsync/lock 실패는 hard DENY, 필수 기록 성공 뒤 legacy-only 실패는 warning인 것을
   실제 production composition fixture에서 검증한다. preflight 무변경도 유지한다.
5. 별도 검토자가 writer의 lock·단일 FD·framing 수명을 재검토한 뒤 MCP 전체 타입·빌드·테스트를
   다시 실행한다. 운영 설정·프로세스·Registry는 건드리지 않는다.

## 대안: host observe 활성화는 이번 배포에서 보류

명시 host 관찰 모드 전환을 배포 대상에서 빼고 기존 SessionEnd-only 및 환경변수 기반
기존 모드를 유지한다. #195는 완료로 표시하지 않는다. 나머지 검증된 변경을 한 번 배포할 수 있다.

이번 선택은 로컬 설계·구현·검증만 포함한다. 운영 배선·프로세스 종료·push·PR·머지·배포는
각각 기존 승인 경계를 따른다.
