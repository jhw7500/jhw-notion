# #261 관리형 실행 경계 설계

관리형 환경에 한정해 무중단 전환을 지원하는 안을 설계 검증 대상으로 선택했다. 전담 서비스가 관리 릴리스, current, 세대 lease 및 회수 경로를 소유한다. 격리 시험에서 이 자원을 일반 클라이언트의 직접 접근과 분리하고, 등록과 게시를 직렬화하면서 기존 결속 호출을 계속 처리할 수 있음을 확인했다. 제품의 클라이언트 결속과 Guard 권한 연결은 [관리형 세션과 writer 연결](#관리형-세션과-writer-연결)에 기록했다.

## 일반 호스트 진단

릴리스 검증을 PID 검사 밖으로 옮긴 뒤에도 연속 호출이 만드는 PID 목록 변화와 개별 프로세스 소실이
남았다. 임시 배타 잠금 안에서 독립 프로세스가 생성되고 종료될 수 있어서, 잠금과 반복 관측만으로
그 구간의 전체 프로세스 수명을 증명할 수 없었다. 일반 호스트에서는 기존 소비자 검사를 적용하고
관측이 불확실하면 중단한다. [진단 자료](#이전-진단-원본)

## 관리 범위

```text
user client -> authenticated local request -> trusted runtime service
                                                  |
                                      session worker + pair lease
                                                  |
                        writer -> publication lock + private generation store
```

- 전담 UID와 서비스 소유 디렉터리에서 관리 자원의 접근 경계를 강제한다. 전담 UID로 실행되는 프로그램은 검증한 서비스와 전환 작업으로 한정한다. 사용자의 일반 셸, 도구, 외부 proxy 및 legacy 경로는 경계 바깥에 있다. 실행 파일 복사본, 열린 descriptor 및 같은 저장소를 쓰는 기존 설치가 관리 자원과 연결되는 경로를 이행 전에 확인해야 한다. [현재 public router](../../../scripts/jhw-runtime-entry#L99) · [기존 관리 모드와 정지 조건](../../../README.md#세션을-유지하는-호환-mcp-업데이트)
- 서비스는 선택 가능한 pair, 요청 종류, 호출자의 권한과 수명을 확인한다. 접속 시 `SO_PEERCRED`는 커널이 본 peer 자격을 확인하는 한 단계다. 같은 UID의 서로 다른 세션과 접속 FD의 전달을 구분하려면 신뢰하는 시작 경로와 각 요청의 root·pair 결속이 필요하다. 클라이언트 PID를 서비스 PID namespace에서 해석할 수 있는 조건도 따로 확인한다. IPC 연결 성공은 Guard의 승인 근거에 포함하지 않는다. [Unix 소켓 권한과 peer credentials](https://man7.org/linux/man-pages/man7/unix.7.html) · [PID namespace 가시 범위](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)
- 새 root는 publication 잠금을 얻기 전에 current와 선택한 pair를 선검증한다. `admission SH -> publication SH -> generation SH -> session-index EX` 순서를 따라 잠금을 획득하고 current와 준비 증거를 재검증한 뒤 등록한다. writer의 publication EX는 새 root 등록과 직렬화한다. 기존 invocation은 부모에 고정된 pair와 세대 SH를 보유해 계속 실행한다. C 회수는 기존 generation EX와 인덱스·관측·복구 절차를 따른다. [v2 잠금 계약](./2026-11-16-bootstrap-generations-261-design.md#5-잠금과-호출-등록) · [세대 회수 구현](../../../scripts/runtime-store.mjs#L847)

## 기존 사용자 권한과 연결하는 조건

현재 owner와 ancestry 검증은 `process.getuid()`에 결합돼 있다. wrapper의 `session -- <command>`는 같은 UID로 사용자가 지정한 실행을 시작한다. 전담 UID로 이 명령을 시작하면 사용자 실행 정책이 달라진다. 별도 서비스는 지정된 selector와 검증한 작업만 시작할 수 있어야 하며, 일반 사용자가 지정한 임의 argv를 서비스 UID로 넘기는 경로는 허용하지 않는다. [현재 owner·ancestry 검증](../../../scripts/runtime-store.mjs#L2106) · [wrapper 실행 지점](../../../scripts/runtime-entry.mjs#L701)

Guard는 기존 사용자의 HOME·stateDir·registry·승인 상태를 참조한다. 별도 UID와 HOME으로 실행하는 현재 호출 경로는 다른 사용자 상태를 읽게 된다. 제안하는 경계는 **managed release 수명·선택**과 **기존 사용자 요청의 권한 결정**을 분리해 증명한다. 제품 설계에서는 기존 Guard가 검증한 요청과 서비스에서 시작되는 특정 호출의 root·pair·작업·종료를 연결할 계약을 먼저 검토한다. 클라이언트가 전달하는 승인 주장이나 접속 UID로 권한을 확정할 수 없다. 런타임 artifact를 사용자 프로세스에 건네주는 방식은 실제 실행의 시작·종료를 별도로 증명해야 하므로 이번 경계 증거를 그대로 적용할 수 없다. [사용자 상태 위치](../../../mcp-server/src/control/config.ts#L113) · [Guard adapter 환경](../../../mcp-server/src/control/hook-adapter.ts#L508) · [control host 설치 계약](../../../scripts/install-wiring.sh#L44)

작업 시작 후에는 실제 실행기 또는 신뢰하는 supervisor가 invocation·generation·parent lease를 유지한다. 연결이 끊겼을 때는 이미 시작한 작업의 종료 증거에 따라 정리한다. 서비스 장애 뒤에는 새 등록을 열기 전에 보존 기록·실제 생존 owner·열린 lease를 재확인한다. 재구성할 수 없는 기록이나 lease가 있으면 회수를 중단한다. 기존 journal과 record 검증을 재사용할 수 있는지 확인하고, 이전 완료 증거를 가진 객체만 복구·회수한다. [현재 FD 전달](../../../scripts/runtime-entry.mjs#L721) · [binding 종료 흐름](../../../scripts/runtime-store.mjs#L2949) · [flock descriptor 수명](https://man7.org/linux/man-pages/man2/flock.2.html#DESCRIPTION)

## 격리 검증

2026-11-24에 고정한 로컬 이미지를 읽기 전용 root, private PID·네트워크 namespace, capability 0과 `no-new-privileges`로 실행했다. 전담 서비스 UID와 허용 클라이언트 UID, 별도의 미등록 UID가 동일한 임시 pathname 소켓을 사용했다. 파일들은 시험용 A·B·C와 lease였고 writer는 시험 서비스 내부에서 실행했다. 등록과 게시의 직렬화는 한 프로세스의 `threading.Lock`으로 모델링했다. 세대에는 실제 `flock`을 사용했다. 제품의 publication 파일 잠금, session index와 별도 writer 프로세스는 통합 검증 대상으로 남는다. 같은 절차를 새 디렉터리에서 한 번 더 검증했다. 아래는 마지막 회차의 결과다.

| Fixture check | Evidence |
| --- | --- |
| Direct reads from the authorized client UID | 3 x EACCES |
| Connection from another UID | Service denied the nonmatching kernel-reported UID |
| Publication and rollback | A -> B -> A |
| Bound reads concurrent with the writer | A read during A -> B, B read during B -> A |
| New open requests during the writer lock | 2, selected B and A after each commit |
| Exclusive lock on live A and B leases | 2 refusals |
| Capture | C only, with A and B retained |
| Worker after broker dropped its own FD | Exclusive refused while alive, acquired after exit |

처음 열린 A와 B의 읽기는 writer가 시험용 mutex를 보유한 동안 실제 파일을 읽었고, 전환 뒤 각 결과도 기존 pair였다. 허용 클라이언트는 세대 파일 직접 열기, current 읽기, C lease 열기 모두 `EACCES`였다. 서비스가 보고한 C capture의 디렉터리와 보존된 A·B, 최종 current A를 별도로 대조했다. 서비스·두 클라이언트·lease 상속 대조군의 종료코드는 모두 0이다. 상속 시험은 부모 FD의 정상 close부터 자식의 정상 종료까지만 재현했다.

이 시험은 접근 권한, 한 프로세스 안에서 등록과 게시를 직렬화할 수 있는 조건 및 상속 lease의 동작을 확인했다. 현재 v2 record의 UID 규칙, `jhw-control-host` 및 실제 Guard 요청, MCP 실행기, 실제 journal 복구와 제품 C 삭제는 통합 시험이 필요하다. 독립 설계 검토에서 특히 같은 UID의 owner 검사를 socket peer 정보 하나로 대체하지 않고, 기존 사용자 상태와 요청 승인에 서비스 권한을 부여하지 않는 조건을 확인했다.

현재 v2의 동일 UID 회귀 두 사례에서 기존 bound 호출과 신규 진입의 publication 잠금 경합, router 선택 뒤 current가 바뀐 경우의 재검증을 확인했다. 두 시험 통과, 실패·생략 0, 종료코드 0이다. 이 결과의 TAP SHA-256은 `613763ea70f1d7d211eb7f9525fbf9743f7bf5eecf33ce22c210ee6e8c78510e`이다. [잠금 경합과 current 재검증 회귀](../../../scripts/test-runtime-v2-entry.mjs#L170)

격리 시험의 요약 SHA-256은 `3801a753249d06d5709bbe6befa8c4d0fd56d9e8d1de2ac5f86dab36f400d07f`, 서비스와 클라이언트 시험 코드 SHA-256은 `dab2c5ca828792ea6e49d1d92546b1f7f3388f0d1de9659ca2e2b9aa5f89474b`, lease 상속 대조 코드 SHA-256은 `1de341c6fa816520958f6b65a3c80285a35386959f64df90ad37b24e825a4033`이다.

## 제품 경로의 writer 중단과 복구

현재 후보 소스 `7b358c5`와 작업 중인 diff의 격리 복사본에서 Node 24.21.0과 실제 의존성으로 두 사례를 실행했다. Guard는 fixture의 로컬 Registry를 읽었고 `enforce`에서 Claim 없이 동작했다. 각 호출의 release·bootstrap pair, parent binding, 열린 세대·호출·부모 lease를 대조했다.

- 별도 writer가 deploy EX와 publication EX를 잡은 상태에서 A에 이미 결속된 control·MCP·네 hook 6건이 모두 해당 pair에서 실행됐다. 새 root는 잠금 아래 `DEPLOY_MAINTENANCE`를 반환했고, 잠금 해제 뒤 입장했다. 거부 응답까지 걸린 전체 시간은 592ms였다. 이 사례는 `current`를 그대로 둔다.
- 별도 writer가 B를 게시한 직후 종료되어 `pointer_intent` journal 하나가 남았다. `--prune --apply`는 `pair_journal_pending`으로 거부됐다. A 세션이 기존 pair에서 호출했고, 새로 시작한 세션은 B에 결속됐다. 새 프로세스에서 실행한 공개 `--rollback`은 기존 journal을 `pointer_published`로 확정하고 기본 pair를 A로 되돌렸다. 복구 대기는 0건이 됐고 두 기존 root는 각자의 pair와 lease를 유지했다. 복구 대기 및 복구 후 호출 18건에서 같은 결속을 확인했다.

두 시험 모두 통과했고 실패·생략은 0건이며 종료코드는 0이다. 집계한 24개 호출 중 일반 hook과 `SessionEnd`가 각 deadline을 넘긴 횟수 및 예기치 않은 거부는 0건이다. 가장 긴 호출은 약 1.75초였다. Claim 없는 `Read`에는 예상한 `GUARD_REQUEST_NOT_FOUND`가 4건 있었다. 승인된 `PostToolUse`와 연속 호출 중 C 정리는 기존 수락 시험에 남는다. 이 실행의 TAP SHA-256은 `30f92930020b955b03093d6be3878083fa068348ba53f9092bce8bccde688c54`이다.

별도 UID 대조에서는 원래 UID가 후보의 v2 `current`와 `--status`를 읽었다. 다른 UID에서는 같은 `0700` 저장소의 경로 접근이 `EACCES`였고, 직접 activation 판독도 `DEPLOY_UNTRUSTED_PATH`로 거부됐다. 별도 UID 서비스와 기존 사용자 실행을 연결할 때는 검증된 root·호출·세대 수명을 결속하는 인터페이스가 필요하다.

## 서비스 재시작에서 유지할 계약

- 새 프로세스는 같은 UID에서도 파일과 잠금을 다시 검증한다. 생존 owner의 확인에는 boot ID·PID 시작 시각·UID·실행 파일 identity와 열린 lease를 사용한다. 이전 프로세스의 메모리에만 있는 준비 증거는 다시 만든다. [owner·lease 검증](../../../scripts/runtime-store.mjs#L2106)
- owner가 먼저 종료되어도 상속 lease가 살아 있으면 root·invocation 기록을 보존한다. 그 root로 새 호출을 붙이면 `DEPLOY_SESSION_INVALID`가 반환된다. 독립 프로세스가 확인과 회수를 실행하는 시험에서 종속 worker의 정상 종료와 `SIGKILL`을 각각 대조한다. [독립 프로세스 회귀](../../../scripts/test-runtime-v2-entry.mjs#L264)
- writer 재시작은 배타 deploy 잠금 아래에서 실제 `current`와 정확한 journal·witness를 확인한다. 생존 worker가 writer lease를 상속한 동안 새 writer는 복구를 시작할 수 없다. 불완전한 기록 및 기존 prune 복구 사본은 검토 대상으로 보존한다. [pair journal 조정](../../../scripts/runtime-deploy.mjs#L1007)
- 서비스 자신이 root owner라면 그 서비스가 종료된 뒤에는 새 root로 세션을 시작해야 한다. broker 장애 뒤 같은 root를 다시 쓰려는 경우에는 살아 있는 별도 실행기 또는 supervisor와 재접속하는 요청을 검증하는 계약이 추가로 필요하다.

## 제품 검증의 진입 조건

1. 지원하는 실행 경로와 provisioned 서비스 UID를 정의한다. 기존 client, proxy, launcher 및 legacy 설치가 관리 자원에 접근하는 경로를 명시하고 일반 호스트와 관리 환경을 구분할 증거를 정한다.
2. 실제 사용자 control/hook 요청 하나의 기존 Guard 권한·상태 경계를 유지하면서, 서비스로 넘어가는 invocation의 root·pair·종료를 연결할 방법을 검증한다. 원래 launcher 및 hook의 출력·종료코드 계약도 확인한다.
3. 별도 writer 프로세스와 서비스에서 실제 파일 잠금 순서와 인덱스를 확인한다. 잠금 경합 때 신규 root가 게시 완료 후 검증한 pair로 등록되는지와 bound 호출의 지속 여부를 대조한다. writer·서비스의 중단과 재시작, worker 조기 종료와 부모 연결 종료에서 기존 journal, 생존 owner·세대·lease를 검증한다. 잠금 역전, 누락, 혼합 버전, 소유자 변경과 조회 실패는 안전하게 중단돼야 한다.
4. 기존 publication 검사 1초, 새 root 및 인덱스 500ms, 일반 hook 12초·SessionEnd 3초 조건에서 실제 A→B→A와 C 정리 수락을 10/10회 확인한다. 승인된 대화형 `PostToolUse`와 C5는 별도 배포 승인을 받은 뒤 확인한다. [기존 수락 기준](../plans/2026-11-16-bootstrap-generations-261.md#task-10-실제-의존성동시-세션-통합-검증과-운영-문서)

현재 단계에서 파일 접근 경계, 동일 UID 제품의 writer 잠금과 journal 복구, 생존 lease 보존을 확인했다. 전담 UID와 실제 사용자 Guard 권한의 결속, 일반 호스트의 전체 프로세스 증거, 10/10 연속 호출 수락은 미입증이다.

## 옵션 구현 순서

2026-11-24에 관리형 모드를 선택 가능한 실행 경로로 구현하기로 했다. 전담 UID는 관리 저장소·세대 선택·회수를 맡고, 기존 사용자의 Guard는 원래 UID에서 실행한다. 전담 서비스의 클라이언트 값은 Task·Claim·승인의 증거로 사용하지 않는다.

1. `scripts/runtime_managed_transport.py`에서 pathname Unix `SOCK_SEQPACKET` 연결의 UID와 peer pidfd를 얻는다. 요청마다 커널이 붙인 PID·UID·GID와 등록 peer의 생존을 확인한다. 상속된 연결을 다른 PID가 사용하는 경우, 길이·보조 데이터가 잘리거나 예상 FD 집합이 다를 때 연결을 폐기한다. 이 계층은 적용 권한을 결정하지 않는다. [Unix 소켓 계약](https://man7.org/linux/man-pages/man7/unix.7.html) · [Linux 6.8 소켓 옵션](https://github.com/torvalds/linux/blob/v6.8/include/uapi/asm-generic/socket.h)
2. 등록한 root 아래에서 고정 selector와 해당 invocation을 연결한다. 연결에 사용한 PID가 만든 요청인지 검증하고, 사용자 측 supervisor에서 후손을 확인한다. 서비스는 검증된 읽기 전용 artifact를 전달하고 lease를 서비스 측에서 제어한다. 기존 사용자 쪽 Guard가 자신의 상태와 승인 기록으로 요청을 판단하는 것을 먼저 실물 시험한다.
3. 관리 저장소의 root 등록·release 게시·세대 회수를 기존 잠금 순서로 연결한다. 배포 호출은 관리자 경로에서 명시적으로 받는다. broker가 중단된 동안에도 상속이나 독립 holder가 붙잡고 있는 lease와 writer journal을 대조한다. 불명확한 owner·invocation·pending 기록이 남으면 기존 보호 경로대로 중단한다.
4. 격리된 관리형 옵션에서 연속 호출을 유지한 A→B→A+C 회수 시험 10/10을 확인한다. 승인된 배포 후 기존 사용자 Guard의 대화형 `PostToolUse`와 C5를 확인한다.

### 전송·번들·수명 확인 결과

전송 계층은 연결 시의 peer와 각 패킷의 PID·UID·GID를 대조하며, 소켓을 상속한 다른 PID의 패킷을 거부한다. 서비스 쪽 번들 선택은 기존 v2 binding을 다시 검증하고 `mcp`, `control`, `hook` 중 하나를 고른다. 해시 검사는 FD의 읽기 위치를 보존한다. [전송 코드](../../../scripts/runtime_managed_transport.py) · [binding에 따른 번들 선택](../../../scripts/runtime-managed-artifact.mjs)

두 UID의 격리 시험에서 서비스가 기존 v2 wrapper로 연 실제 control 번들을 봉인한 FD에 넣어 전달했다. 사용자 UID는 서비스 전용 release 디렉터리를 직접 읽을 수 없었고, 동일한 PID로 Node를 `exec`한 뒤 기존 사용자 환경의 로컬 Registry에서 `guard status`를 읽었다. 결과는 `enforce`, `available`, Claim `none`이었다. 실행 요약 SHA-256은 `4fa52da317ce33112d7b46090aa022e53e9b2d61eb20c02ea6dc3064fe9473bd`이다.

번들 전송 전에 독립 holder와 디스크에 기록한 실행 의도를 사용한 대조에서는 broker 종료코드가 137이었다. 새 프로세스가 확인했을 때 사용자 실행이 남아 있는 동안 의도 기록도 남았고, 세대의 배타 잠금은 거부됐다. 사용자가 실행을 끝낸 뒤 holder가 pidfd로 실제 종료를 확인해 기록을 제거했고, 새 프로세스가 배타 잠금을 얻었다. 관측 소실로 중단한 경우에는 별도 시험에서 다음 검사가 남은 기록을 거부했다. [수명 코드](../../../scripts/runtime_managed_lifetime.py) · 실행 요약 SHA-256 `816da3216fe7313ba48b00e19638a8d6986c6b0362797e230b89ced01911a6e6`.

같은 경로로 전달한 실제 hook 번들도 원래 사용자 UID에서 네 이벤트의 응답을 반환했다. 처리 시간은 `UserPromptSubmit` 11ms, `PreToolUse` 7ms, `PostToolUse` 3ms, `SessionEnd` 2ms였다. 승인 요청이 없는 fixture의 `PostToolUse`는 `GUARD_REQUEST_NOT_FOUND`를 반환했다. 기존 통합 입력에 빠져 있던 `SessionEnd`의 `transcript_path`를 보완한 뒤 adapter 본체가 `{}`를 반환하는 것을 확인했다. 실행 종료코드는 0이다. 실행 요약 SHA-256은 `5e9f0aa401fa098093c5c2b87cba2d577c23eb66837ccde075af7fe558dc1ee2`다.

최종 전송·수명 Python 시험은 격리 환경의 실제 UID 대조를 포함해 11건 통과, 실패·생략 0, 종료코드 0이었다. 번들·기존 entry Node 시험은 70건 통과, 실패 0, 성능 계측 1건 생략, 종료코드 0이었다. 이전 전체 런타임 회귀에서는 844건 통과, 실패 2건, 생략 2건이었다. root 종료 사례의 기대값을 현 검사 규칙과 맞춘 뒤 관련 두 시험 파일의 98건이 통과했다. 남은 v1 기록 정리 사례는 독립 재실행에서 통과했다.

이 연결을 배포 경로에 적용하려면 기존 사용자 supervisor의 실제 후손 검증과 서비스에 등록한 실행 PID를 결속해야 한다. broker가 재시작할 때 새 요청과 게시·정리를 열기 전에 확인할 기록과 남아 있는 holder를 대조한다. 관리 저장소의 writer는 이 검사를 공통으로 사용해야 하며, writer와 holder가 모두 사라진 경우에는 복구가 확인될 때까지 회수할 수 없다.

### 관리형 세션과 writer 연결

root 소유 프로필과 실행 파일을 사용해 전담 서비스 UID와 기존 사용자 UID를 분리했다.
세션 연결값은 첫 요청 프로세스의 pidfd와 서비스 v2 root에 결속된다. 같은 UID의 다른 root가
연결값을 복사해도 후손 검사를 통과할 수 없다. 서비스가 반환한 번들은 기존 사용자의 HOME과
Guard 환경에서 그 요청에 사용한 PID로 실행한다.
[관리형 명령](../../../README.md#전담-서비스-uid로-세션을-유지하는-관리형-옵션)

게시와 회수는 기존 v2 publication lock, 세션 인덱스, generation lease 및 저널을 재사용한다.
별도 writer는 root 소유 프로필의 읽기 전용 FD와 전담 UID가 소유한 저장소를 검증한다.
일반 설치 명령은 관리형 저장소 전환과 회수를 거부한다. C의 배타 generation lease를 획득한
뒤 C의 실행 기록도 없을 때만 C를 제거할 수 있다.
[writer 경계](../../../scripts/runtime-managed-scope.mjs) · [회수 경로](../../../scripts/runtime-prune.mjs)

격리된 두 UID의 통합 시험에서 A→B→A, 새 세션의 B 선택, A 세션의 호출 유지와 C 회수를
확인했다. C의 디스크 기록을 남긴 상태에선 C를 보존했다. 서비스에 SIGKILL을 보낸 뒤에도
실행 중인 A의 lease가 유지됐고, 실행 종료 뒤 서비스 재시작과 새 세션 호출을 확인했다.
[격리 통합 시험](../../../scripts/test_runtime_managed_integration.py)

실제 번들을 반복 호출하는 시험에서 한 호출의 시간 초과가 같은 세션의 후속 호출을 끊는
문제를 발견했다. 수신 작업을 끝낸 서비스 연결과 종료한 호출자 연결을 분리했고, 세션마다
검증한 봉인 번들을 재사용하면서 호출별 pidfd와 실행 기록은 계속 확인한다.
[재발 방지 시험](../../../scripts/test_runtime_managed_broker.py)

### 실제 번들 반복 검증

격리된 Linux PID namespace에서 Node 24와 실제 npm 의존성으로 A, B, C를 빌드했다.
모든 회차에 A로 시작한 세 세션과 B로 시작한 한 세션에서 MCP 연결을 유지했다. 기존 사용자
UID의 로컬 Registry에서 control과 네 Guard hook을 반복 호출하며 별도 writer 프로세스로
호환 활성화, 롤백, C 회수를 수행했다.

재현 시험은 PID namespace와 임시 파일시스템이 분리된 Linux 컨테이너에서 실행한다.
`review_image`에는 Node 24(`/usr/local/bin/node`), Python 3.10 이상, Git과 flock이 있는
로컬 이미지를 지정한다. 검증 호스트에서는 `jhw-notion-261-qa:node24`를 사용했다.
npm 패키지 취득 네트워크가 필요하다. 검토할 Git HEAD의 파일과 모드를 임시 작업
디렉터리에 복원해 UID 1003에 넘긴다.

```bash
set -o pipefail
git archive HEAD |
  docker run --rm -i --pull never --user 0:0 --read-only \
    --security-opt no-new-privileges --cap-drop ALL \
    --cap-add SETUID --cap-add SETGID --cap-add CHOWN --cap-add KILL \
    --tmpfs /work:rw,exec,mode=0755 --tmpfs /tmp:rw,exec,mode=1777 \
    --workdir /work --entrypoint /bin/sh "${review_image:?검증 이미지 지정}" -ec '
      umask 022
      tar --no-same-owner -xf -
      git init -q
      git add .
      git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm snapshot
      chown -R 1003:1003 /work
      JHW_MANAGED_TEST_ISOLATED=1 python3 -B scripts/test_runtime_managed_acceptance.py --trials 1
    '
```

한 회차는 준비·정리까지 포함해 187초, 시험 본체는 144.63초가 걸린 기록이 있다. 외부 실행
제한은 300초로 잡고, 단계별 소요시간은 stderr에서 확인한다. 10회 반복은 `--trials 10`으로
실행하고 회차 수에 맞춰 외부 제한을 늘린다.

다음은 재현 스크립트를 작성하기 전, 같은 코드의 격리 시험에서 수집한 결과다.

| 검증 항목 | 결과 |
| --- | --- |
| A -> B -> A 및 C 회수 | 10/10, 종료코드 0 |
| 기존 A 세션 3개와 B 세션 1개의 pair 유지 | 10/10 |
| Control 1회와 네 hook을 포함하는 반복 루프 | 6,493회 |
| 일반 hook 최대 | 4,705ms |
| SessionEnd 최대 | 245ms |
| Python 관리형 격리 회귀 | 31/31, 종료코드 0 |
| Node 관리형 scope 회귀 | 8/8, 종료코드 0 |
| Node 런타임 회귀 | 487 통과, 실패 0, 생략 1, 종료코드 0 |
| TypeScript 타입 검사 | 종료코드 0 |

10회 실행 요약의 원본 바이트를 아래에 보관한다. SHA-256은 `88b67aa0d4696b7ad0d9dfa92f18e453cfa0755729d510cf1466233268dd271c`이다.

```text
Real v2 fixture prepared
{"round": 1, "sessions": 4, "iterations": 657, "seconds": 152.88, "maxMs": {"control": 4336.594489, "UserPromptSubmit": 4704.970468, "PreToolUse": 248.337695, "PostToolUse": 279.125487, "SessionEnd": 245.056272}}
{"round": 2, "sessions": 4, "iterations": 665, "seconds": 151.61, "maxMs": {"control": 4256.865589, "UserPromptSubmit": 4207.003645, "PreToolUse": 250.349532, "PostToolUse": 246.33669, "SessionEnd": 231.817389}}
{"round": 3, "sessions": 4, "iterations": 649, "seconds": 143.54, "maxMs": {"control": 3869.804144, "UserPromptSubmit": 3781.447773, "PreToolUse": 228.580721, "PostToolUse": 241.110606, "SessionEnd": 239.81702}}
{"round": 4, "sessions": 4, "iterations": 640, "seconds": 142.81, "maxMs": {"control": 3891.667045, "UserPromptSubmit": 4052.965055, "PreToolUse": 244.61436, "PostToolUse": 253.448031, "SessionEnd": 235.639003}}
{"round": 5, "sessions": 4, "iterations": 638, "seconds": 144.38, "maxMs": {"control": 4148.381218, "UserPromptSubmit": 4073.911991, "PreToolUse": 232.060241, "PostToolUse": 254.036335, "SessionEnd": 234.129943}}
{"round": 6, "sessions": 4, "iterations": 636, "seconds": 140.15, "maxMs": {"control": 3796.169041, "UserPromptSubmit": 3879.597295, "PreToolUse": 228.56518, "PostToolUse": 215.218462, "SessionEnd": 236.950798}}
{"round": 7, "sessions": 4, "iterations": 646, "seconds": 136.28, "maxMs": {"control": 3802.295997, "UserPromptSubmit": 3941.274026, "PreToolUse": 203.642412, "PostToolUse": 211.915252, "SessionEnd": 199.947336}}
{"round": 8, "sessions": 4, "iterations": 654, "seconds": 132.37, "maxMs": {"control": 3845.371415, "UserPromptSubmit": 3716.318014, "PreToolUse": 194.649947, "PostToolUse": 185.845965, "SessionEnd": 187.495981}}
{"round": 9, "sessions": 4, "iterations": 654, "seconds": 132.43, "maxMs": {"control": 3702.527143, "UserPromptSubmit": 3759.583436, "PreToolUse": 196.318868, "PostToolUse": 199.174255, "SessionEnd": 200.674977}}
{"round": 10, "sessions": 4, "iterations": 654, "seconds": 131.52, "maxMs": {"control": 3684.927911, "UserPromptSubmit": 3818.735118, "PreToolUse": 177.718842, "PostToolUse": 173.673694, "SessionEnd": 168.519445}}
{"passed": 10, "requested": 10}
```

원본의 첫 줄부터 마지막 줄까지 다음 명령으로 대조한다.

```bash
sed -n '/^Real v2 fixture prepared$/,/^{"passed": 10, "requested": 10}$/p' \
  docs/superpowers/specs/2026-11-24-managed-execution-boundary-261.md | sha256sum
```

Claim 없는 fixture의 `PostToolUse`는 `GUARD_REQUEST_NOT_FOUND`를 반환했다. 실제 사용자가 승인한
대화형 호출의 `PostToolUse`와 기존 Codex 설정을 통한 C5는 승인된 운영 배포 뒤에 확인한다.

### 이전 진단 원본

일반 호스트의 PID 변동과 prune 계측 원자료는 작업 호스트의 로컬 보관본에 저장했다.
다음 파일명과 SHA-256으로 설계 기록이 참조한 원본을 대조할 수 있다.

| 파일 | SHA-256 |
| --- | --- |
| `2026-11-23-prune-locked-candidates-261.json` | `8554d22b7f881cf003a5e5d03af23e3bf22e55601af121a77f4dc19511d35a2c` |
| `2026-11-23-prune-public-pid-transitions-261.json` | `d31d6166a91406b43e06a6c5bc3a89990b7425ddcae229b72cfe0c06bb8eb2ef` |
| `2026-11-23-prune-retained-evidence-261.json` | `0b409eb80621f37b1e3ab2688d6e6e809b902cc35dfd261e0c8fad59515974ca` |
| `2026-11-23-prune-scan-comparison-261.json` | `b0a981ca564722fcf4b9c79726fe5c5772312041e959c8e10191f18c62c51140` |
| `2026-11-23-prune-scan-comparison-probe.mjs` | `f35f66d1889e7630656c8da34ef4c307fe7389d2927dfed5a3968db35d522ceb` |
| `2026-11-23-public-inventory-cause-probe.mjs` | `07a24adec4d8a1ec1049d0961c7fc6469a2dc50440e46a9b140311609d1520ff` |
| `2026-11-23-public-inventory-cause-probe.test.mjs` | `e89badc70d0385f80e2175b00e47273fa830b5c0bc81bfc848a50e7c034f5986` |
| `2026-11-23-public-inventory-cause-results-261.json` | `e700553f4abd91323ac6ec9792598514afd42c3185291e04e9f9802b85046cca` |
| `2026-11-23-runtime-process-evidence-261-generation-prune.json` | `ce058b830d46524a501cd86058e8a68c7aec4893dcbb44920bf2d1d69c2ffc00` |
| `2026-11-23-runtime-process-evidence-261-observations.json` | `e440ce74a40b63805356b2a5fafce93f44794efc3936c660b0081af12962c245` |
| `2026-11-23-runtime-process-evidence-261-prune-inventory.json` | `80d0317f8fec4039c9a44f3b8b7178127815d9f54be758bed1d1bd463a2c0e71` |
| `2026-11-23-runtime-process-evidence-261-prune-plan.json` | `494953f8e20366df1813118674533ddac03d82a67a8e887e3e3a7ad5feace071` |
| `2026-11-23-runtime-process-evidence-261-prune-profiler.mjs` | `199e90b851392f582b8d24d98c4283b81d5a700c1420d59472f2616145609d48` |
| `2026-11-23-runtime-process-evidence-261-prune-timing.json` | `61d836b2f4c7e759ee7d6351737a40059c86605f484540c4c7695a0e4c87e684` |
| `2026-11-23-runtime-process-evidence-261-transitions.json` | `a30920e436215db4fe977317270c4219ff954240d20e431bac6c57604ae176bf` |
| `2026-11-23-pid-lifetime-evidence-261.md` | `d19e4efa8799302a6b00ab6cbe5902a0ae3486a1c83eaef247351250b89cf913` |
| `2026-11-23-prune-session-evidence-261.md` | `6918a54346b6fda520cd71bc52c118f43394bb30d2384fc112a4fd13ff276b72` |
| `2026-11-23-runtime-process-evidence-261.md` | `4cb8d4cd769f2af8ca88ba8024e4bc04bf5fca602f46bae38bb35b849a2bed7e` |
