# #261: bootstrap 세대와 bound 호출 연속성 설계

상태: A안 선택 완료, builder check OKAY, 2026-11-16 사용자 상세 설계 승인 완료.
기준: main `75a50711661b547d303f53000d699a683785fa4d`.
관련: #261, #246, #254 / PR #262. 제품 구현이나 live 배포 결과를 나타내는 문서가 아니다.

## 1. 목표와 선택

기존 wrapper 세션이 release와 bootstrap helper를 함께 고정하도록 한다.
새 default를 게시하거나 이전 default로 rollback해도 기존 세션의 다음 hook/control/MCP 호출은
원래 쌍을 사용한다. 호환 전환 journal을 prune이 판독하고, 참조가 끝난 bootstrap 복사본을
기존 삭제 안전성 계약 안에서 회수한다. C5에서 확인한 Codex 환경 전달 누락도 수정한다.

사용자는 별도 bootstrap 세대 저장소를 두는 A안을 선택했다.

| Option | Selection | Reclamation | Decision |
|---|---|---|---|
| A: independent bootstrap copies | release + bootstrap pair | bootstrap copies only | selected |
| B: helpers inside release | release only | retain helpers or add release GC | rejected |

A는 pair 기록과 이행 비용이 있지만 release/activation 삭제 정책을 확대하지 않는다.
B는 선택이 단순하지만 helper만 회수할 수 없어 이번 범위에 맞지 않는다.

아래 세부 사항은 구현자가 제안한 설계 결정이며 이 문서 승인 전에는 확정된 사용자 요구로
취급하지 않는다. 특히 v2 namespace, 잠금 분리, 별도 Codex 설정 이행 명령은 이 문서의 제안이다.

비목표: 실행 중인 MCP 재로딩, 기존 unbound 세션 자동 편입, 프로세스 종료, Task/Claim 조작,
Project Control 권한 cutover, release/activation 전체 GC, 일반 공유 상태의 비호환 변경 허용.
claude-config 소유 `jhw-control-host`와 SSH/shared app-server의 환경 전달 연동도 범위 밖이다.
이번 control 연속성은 bound 세션에서 stable managed control entry를 직접 사용하는 경로다.
운영 Task/Claim 조작은 계속 host launcher 절차를 따르며, 이 시험으로 host 통합 완료를 주장하지 않는다.
stable verifier/router 자체나 영속 계약이 달라지는 갱신은 소비자 정지 경계에 남긴다.
모든 helper 변경을 무조건 무중단으로 허용하지 않는다.

## 2. 현재 코드의 장애물

- `scripts/jhw-runtime-entry`는 고정 bootstrap 물리 경로, v1 manifest와 여섯 파일을 검증한다.
  symlink만 세대 경로로 바꾸는 것은 no-follow 검사와 맞지 않는다.
- session v1은 release와 compatibility digest만 고정한다. token은 manifest bytes에 묶여 있고,
  session/activation v1은 닫힌 schema라 새 키나 sidecar를 제자리 추가할 수 없다.
- `requireBootstrapGeneration()`은 후보 helper와 현재 helper의 byte/mode 일치를 요구한다.
  #254의 지문에서도 helper 내용은 보호 대상이다.
- publication EX 안에서 inventory, release compatibility, activation 게시가 중첩된 full-tree
  검증을 수행한다. entry는 publication SH 경합을 즉시 거부한다.
- prune은 compatible journal의 파일명, 추가 키, 빈 variables를 거부하고 compatible 성공에는
  retention receipt도 없다.
- Codex 등록은 기본 binding 전달을 만들지 않으며 owned 재등록은 사용자 env를 보존하지 않는다.
  현재 activate/refresh-bootstrap에는 기존 managed 설정을 갱신하는 경로가 없다.

이 설계는 위 검사를 삭제하는 대신 형식, 실행 선택, 잠금 소유와 회수 증거를 함께 변경한다.

## 3. 저장 구조와 신뢰 루트

```text
.jhw-runtime/
|-- bootstrap/                    stable verifier + selector wrappers
|-- current -> v2/activations/a-*/
|-- releases/r-*/                 existing immutable releases
|-- activations/a-*/              retained v1 history
|-- sessions/                     retained v1 records
|-- v2/
|   |-- bootstrap-catalog/b-*.json  retained generation manifests
|   |-- bootstraps/b-*/
|   |   |-- manifest.json
|   |   |-- lease
|   |   |-- runtime-entry.mjs
|   |   |-- runtime-safety.mjs
|   |   `-- runtime-store.mjs
|   |-- activations/a-*/
|   |-- sessions/s-*/             wrapper/root bindings
|   |-- invocations/b-*/i-*/      descendants, grouped by bootstrap
|   |-- session-index.lock
|   |-- invocation-index/
|   |   `-- b-*.lock
|   `-- migrations/m-*/           retained initial-transition anchors
|-- deploy.lock
|-- admission.lock
`-- publication.lock
```

v1 디렉터리와 파일은 그대로 보존한다. v2 객체를 v1 닫힌 디렉터리에 섞지 않는다.
current는 v1 또는 v2 activation을 가리키는 기존 단일 물리 symlink이며, v2 판독기는
두 경로를 명시적으로 구분한다. current 관측은 target/dev/ino/ctimeNs를 계속 포함한다.

stable bootstrap은 `jhw-runtime-entry`, `jhw-runtime-control`, `jhw-runtime-hook`와
닫힌 router manifest를 가진다. 외부 MCP/제어/hook wiring의 경로는 유지한다.
router manifest v2는 version, sourceReleaseId, routerContract, files를 가지며,
routerContract=1과 정확한 세 실행 파일 이름/mode/hash를 고정한다. 기존처럼 source release의
content-derived ID, manifest, 해당 원본 bytes에 묶는다. 디스크 경로에서 검증 후 다시 import하지 않는다.

세대 manifest v1은 version, bootstrapId, runtimeContract, sourceReleaseId, files만 가진다.
runtimeContract=2이며 files는 위 세 mjs의 정렬된 이름/mode/SHA-256 집합이다.
bootstrapId는 자기 bootstrapId 필드를 제외한 canonical manifest의 SHA-256에 `b-`를 붙인다.
같은 helper 집합을 재사용할 때는 기존 세대의 sourceReleaseId와 manifest를 그대로 유지하고,
후보 release에도 동일한 helper 집합이 있음을 증명한다. manifest를 새 source에 재결합하지 않는다.

catalog는 같은 manifest bytes를 current-user 소유 regular 0600 파일로 별도 보존한다.
세대 복사본의 manifest와 catalog는 byte-identical이어야 하며 source release를 함께 검증한다.
catalog는 bootstrap 복사본 회수 뒤에도 남는다. 재구성은 catalog의 원래 sourceReleaseId를 사용해
같은 bootstrapId를 복원한다. helper가 같은 후속 release를 임의의 새 source로 삼지 않는다.
catalog와 migration anchor의 GC는 이번 범위에 없으며 크기·참조 검증은 생략하지 않는다.

세대 디렉터리는 0700, manifest/lease는 0600, mjs는 0644이며 owner/nlink/no-follow/정확한
자식 집합을 검증한다. lease는 내용이 빈 독립 regular file이며 세대 복사본의 수명 lease다.
신뢰 루트와 세대 manifest를 함께 고쳐도 원본 release의 봉인된 helper bytes와 달라지면 거부한다.

## 4. 선택과 형식 계약

공개 current snapshot의 닫힌 형식은 다음 두 가지다. 필드 혼합이나 unknown key는 거부한다.

- v1: `{activationId, releaseId, predecessorActivationId, observation}`. version 키를 추가하지 않는다.
- v2: `{version:2, activationId, releaseId, bootstrapId, runtimeContract, compatibilityDigest,
  predecessorActivationId, migrationId, observation}`.
- observation은 기존 `{target, dev, ino, ctimeNs}`를 유지한다. 마지막 세 값은 기존 decimal string,
  target은 해당 버전의 정확한 상대 경로다. v2는 `v2/activations/<activationId>`만 인정한다.
- activationId/releaseId와 predecessor는 기존 ID 문법을 유지한다. bootstrapId는 `b-`와 64자리
  lowercase hex, migrationId는 null 또는 `m-`와 32자리 lowercase hex다. runtimeContract=2이며
  compatibilityDigest는 검증된 v2 지문의 64자리 lowercase hex다.

`validCurrent`는 null 또는 위 union, `isActivationSnapshot`은 null 없는 union을 검사한다.
Guard 전환 증거, deploy/recovery, prune은 같은 판독 함수를 사용한다. v1의 bytes/허용 범위는 유지한다.

v2 activation manifest의 정확한 키는 version(2), activationId, releaseId, bootstrapId,
runtimeContract, compatibilityDigest, predecessorActivationId, migrationId, createdAt, priorCurrent다.
mcp-server/scripts/skills와 bootstrap 링크 네 개를 정확히 검증한다. priorCurrent는 v2 snapshot
또는 null이며 predecessorActivationId는 그 activationId 또는 null과 일치해야 한다.
일반 v2 activation 생성은 migrationId=null이다. 최초 정지 이행은 priorCurrent/predecessor=null과
검증된 migrationId를 쓰고 v1 origin/rollback 대상은 그 영구 anchor에 보존한다(7절).
신규 v2 설치는 priorCurrent/predecessor/migrationId가 모두 null이다.
pointer intent의 destination은 v2 snapshot에서 아직 존재하지 않는 observation만 뺀 형식이며,
게시 후 실제 symlink observation을 포함한 snapshot을 기록한다. origin은 위 nullable union이다.
v2 rollback은 release와 bootstrap을 하나의 activation으로 복원한다.

v2 wrapper record는 v1의 owner/repository/manifest/lease identity를 유지하며,
version2, bootstrapId, runtimeContract를 추가하고 새 namespace에 쓴다.
root id는 s-32hex, invocation id는 i-32hex다. 부모가 있는 invocation은 releaseId,
bootstrapId, compatibilityDigest, runtimeContract가 부모와 모두 같아야 한다.
root token은 `v2:<bootstrapId>:<sessionId>:<recordSha256>`이며 digest는 canonical record bytes다.
token의 bootstrapId는 안전한 경로 선택 힌트이지 authority가 아니다.

router는 trusted ancestry와 token 문법/record bytes/세대 provenance를 확인한 뒤,
검증해 읽은 해당 세대 helper bytes만 import한다. 세대 helper의 ABI는 payload 또는 credential을
열기 전에 token digest, manifest/lease inode, 실제 lease 보유, owner PID/startTime/boot ID/executable,
후손 관계와 pair를 모두 재검증하는 것이다. helper 선택 자체가 Task 권한을 부여하지 않는다.
helper import 단계에는 payload 실행·credential 접근·공유 상태 쓰기 부작용을 허용하지 않는다.

실제 자식 실행 전 admission SH, generation lease SH, binding lease를 잡아 유지한다.
generation lease는 새 전용 FD 7, invocation이 유지하는 parent root lease는 FD 8을 사용한다.
기존 admission FD 3, credential FD 5, 자신의 binding FD 6을 재사용하지 않는다.
invocation의 부모 token은 wrapper root token이며, 후손 환경에도 그 root token을 전달한다.
root를 새 invocation으로 바꾸는 임의의 부모 체인은 만들지 않는다.
shell fallback/SSH/shared external app-server의 자동 편입은 하지 않는다.

```text
current -> activation B -> (release B, bootstrap B)
session A token -------> (release A, bootstrap A)
session B token -------> (release B, bootstrap B)
```

generation helper ABI, v2 record/namespace/lock 이름, FD 배치를 golden 계약으로 고정한다.
기존 `runtime-compatibility.json`의 선언 shape는 유지하고 generation을 2로 올린다.
v2 지문은 version3 envelope에 generation, guardFloor, runtimeContract, routerContract를 포함한다.
기존 보호 config/schema/영속 writer/실행 스킬/의존성·경로·mode/symlink 정책은 유지한다.
새로 내용 차이를 허용하는 파일은 세대별 runtime-entry/safety/store 세 파일뿐이다.
stable selector/router 및 deploy/prune/wiring 구현은 계속 byte-pinned다.
generation/guardFloor/계약이 다르거나 알 수 없는 helper/파일 집합이면 정지 배포가 필요하다.
v1 지문 계산은 그대로 남기고 v1↔v2 compatible 전환은 거부한다.

## 5. 잠금과 호출 등록

잠금 획득 순서는 아래 표의 왼쪽부터다. 경로별 필요한 잠금만 획득하며 역순으로 닫는다.
대상 세대가 여러 개면 bootstrapId의 byte 정렬 순서를 사용한다.

| Path | Lock order |
|---|---|
| Bound invocation | admission SH -> generation SH -> invocation-index EX |
| New wrapper/root | admission SH -> publication SH -> generation SH -> session-index EX |
| Compatible writer | deploy EX -> publication EX -> session-index SH (brief) |
| Root retirement | admission SH -> generation SH -> session-index EX -> root binding EX (try) |
| Invocation retirement | admission SH -> generation SH -> invocation-index EX -> own binding EX (try) |
| Generation reclaim | deploy EX -> publication EX -> generation EX (try) -> indexes SH -> binding EX (try) |
| Stopped maintenance | deploy EX -> admission EX -> publication EX |

bound 호출은 current를 읽지 않고 부모 pair만 사용하므로 publication을 획득하지 않는다.
대신 generation lease SH가 회수와 경합을 막고 invocation-index가 완성된 record의 원자 등록을
보장한다. 공개되지 않은 staging record는 보유 index 아래에서 만들고 fsync 후 rename한다.
검증·해시·owner/부모 증명은 index 밖에서 준비하고 등록 직전에 부모의 bytes/inode/lease/owner를
다시 확인한다. .creating/.retired의 복구·bounded reclaim 강도는 기존 계약을 유지한다.

root와 invocation namespace를 분리하는 이유는 기존 세션의 잦은 tool 호출이 root membership을
바꾸지 않게 하기 위함이다. root 생성은 publication SH 아래에서만 가능하다. bound 자식은 검증된
부모 pair만 계승하므로 compatible writer가 검사한 root의 pair 집합을 넓힐 수 없다.
writer가 session-index SH를 보유한 동안 root 집합은 고정된다. 해당 index를 놓은 뒤에도
publication EX 아래에서는 root retirement에 의한 축소만 가능하다. index 없이 record를 지우지 않는다.
orphan lease/불명확한 부모/알 수 없는 consumer는 기존처럼 fail-closed한다.

invocation은 부모가 유효할 때 parent root lease SH를 FD 8로 획득하고 부모 identity/owner를
다시 증명한 뒤 자신의 record를 공개한다. payload도 FD 8을 상속해 종료할 때까지 유지한다.
root owner가 먼저 종료돼도 살아 있는 invocation의 FD 8 때문에 root record는 회수되지 않는다.
owner가 사라진 token으로 새 호출은 허용하지 않으며 이미 시작한 payload는 자신의 lease로 보호한다.

종료자는 admission/generation SH를 유지하고 자신의 binding SH FD 6을 닫은 뒤 위 retirement
순서를 따른다. binding EX를 잡지 못하면 record를 남긴다. invocation은 own record 처리가 끝난 뒤
parent FD 8을 닫고, generation/admission은 마지막에 닫는다. root도 retirement 시도 뒤 세대를 놓는다.
retirement와 .creating/.retired 복구는 해당 index EX 아래에서 original inode/bytes와 lease를 검증한다.
다른 프로세스의 lease는 nonblocking으로만 시도하며 불명확한 record는 보존한다.
reaper가 index로 후보를 찾았다면 index를 놓고 generation을 먼저 획득한 뒤 index 아래 재검증한다.
index를 보유한 채 generation을 기다리지 않는다. GC는 generation EX를 보유하므로 새 호출·종료자와
경합하지 않는 상태에서 indexes SH로 무참조를 확인하고, record가 남으면 먼저 별도 retirement 절차로
정리한 후 다음 시도에서 회수한다. GC가 index SH 아래 record를 삭제하지 않는다.
root reclaim은 bound 호출의 hot path에 넣지 않으며 invocation reclaim은 해당 세대 index에 한정한다.

새 root는 publication 밖에서 current pair를 미리 검증한다. SH를 획득한 뒤 current identity와
준비 증거를 다시 확인하고 원자 등록한다. current가 움직였으면 잠금을 풀고 새 snapshot으로
준비부터 다시 하며 3회까지만 재시도한다. 다른 release나 bootstrap으로 이미 발행한 token을 바꾸지 않는다.
직접 unbound invocation은 같은 선택 절차를 쓰지만 기존대로 compatible deployment를 막는
unbound consumer이며 wrapper 세션으로 간주하지 않는다.

session/invocation index 대기는 각각 기존 500ms 한도를 유지하고 full-tree walk, 프로세스
inventory, log fsync를 index 안에서 수행하지 않는다. generation EX는 회수 시 nonblocking으로
시도하고, 잡히지 않으면 해당 세대를 보존한다. 배포를 위해 bound 호출의 lease를 끊지 않는다.

## 6. 준비 증거와 publication

전체 검증을 `walkTree:false`로 생략하거나 manifest hash 하나로 대신하지 않는다.

준비 단계는 release와 bootstrap을 원래 강도로 해시하며, 동시에 이번 호출에서만 쓸 증거를 만든다:
canonical manifest bytes/hash, root directory identity, 모든 entry의 상대 경로/type/mode/owner/
nlink/size/mtimeNs/ctimeNs/dev/ino, directory별 정확한 자식 이름, symlink target.
각 파일은 descriptor 기반 읽기 전후 stat을 비교한다. 실제 실행할 bundle/helper bytes는 별도로
descriptor에서 읽고 해시한 bytes를 사용한다. credential bytes는 증거/로그에 넣지 않는다.
증거는 process-local이며 디스크 cache나 다음 호출의 검증 면제 토큰이 아니다.

준비 후 재검증은 모든 entry의 identity/metadata와 directory 자식 집합, symlink target을
descriptor-relative no-follow 순회로 비교한다. mode/크기/mtime를 되돌린 in-place edit도 ctimeNs로
검출하며 inode 교체와 추가 파일도 거부한다. source/manifest/hash/실행 artifact의 보호를 유지한다.
전체 entry를 다시 보지 않는 root-only shortcut은 없다. 파일 변경이 관측되면 게시하지 않는다.
현재 구현도 임의의 동시 외부 writer에 대한 filesystem snapshot을 제공하지는 않는다.
이 설계는 그보다 강한 원자 snapshot을 주장하지 않으며 실행 직전의 artifact byte 검증을 유지한다.

전환 순서:

```text
deploy EX
  -> full validation + root/consumer inventory + MCP probes
  -> immutable candidate bootstrap + activation prepared
  -> durable journal: prepared
  -> publication EX
       -> exact current + root/consumer identity recheck
       -> complete prepared-evidence metadata recheck
       -> durable journal: pointer_intent
       -> atomic current rename + parent fsync
  -> publication released
  -> verify resulting pair + complete journal + receipt + log fsync
```

candidate activation은 current에 연결하기 전에 완성·fsync한다. 게시 함수는 전체 release 검증을
숨겨서 반복하지 않는 별도 내부 API이며, 준비 증거와 retained directory handles가 없으면 호출할 수 없다.
공개 CLI/환경변수로 이 API나 증거를 주입할 수 없다.

최종 consumer 확인은 실제 PID/시작 시각/부모/lease/record identity를 다시 확인한다.
동일 release에 대한 중복 content hash는 준비 증거의 전체 metadata 재검증으로 대체하며,
새롭거나 검증하지 않은 pair, v1/legacy/proxy, 불확실한 consumer를 허용하지 않는다.
publication EX 아래에서는 새 root가 등록되지 못한다. root가 끝나면 제거된 root를 증명하여
제외할 수 있으나 새로운 root를 준비 집합에 조용히 포함하지 않는다.

exclusive 구간에는 content hashing/MCP probe/대용량 log fsync/전체 wiring 검증이 없다.
metadata 순회는 파일 수에 비례하므로 고정 상수 시간이라고 주장하지 않는다.
구현 목표는 게시 전 검사 1초 이내다. 한도를 넘으면 pointer 변경 전에 배포를 거부하고 기존
bound 호출은 계속 허용한다. fsync의 OS 지연까지 hard real-time 상한으로 약속하지 않는다.
새 unbound/root 진입의 publication 대기는 500ms 한도이며 경합 시간 초과는 기존 maintenance
진단으로 반환한다. 정상 bound 호출은 이 대기의 영향을 받지 않는다.

시간 계측은 admission/세대 선택/검증/index 등록/payload 실행을 포함한다.
Codex 외부 hook timeout은 일반 12초/SessionEnd 3초다. SessionEnd에 6초 대기를 숨기거나
내부 watchdog만 재서 통과로 보고하지 않는다. 실제 의존성·3개 bound 세션 조건에서
전환과 rollback 동안 거부 0건 및 외부 deadline 내 완료를 수락 게이트로 삼는다.

## 7. rollback, 초기 이행, 복구

v2 `--activate-compatible <release>`는 후보의 검증된 helper 세대를 생성/재사용하고 pair를 게시한다.
`--refresh-bootstrap`의 v2 동작은 current release의 검증된 helper 집합과 일치 여부를 확인한다.
이미 pair가 정확하면 no-op이며 HOME wiring을 변경하지 않는다. helper를 바꾼 release는
prepare 후 activate-compatible로 갱신한다. router 변경은 stopped maintenance 경로만 사용한다.

v2 `--rollback`은 predecessor pair를 대상으로 호환성을 검사한다. 호환되고 v2 bound consumer만
있으면 같은 publication 경로를 사용한다. 기존 세션은 각각 자신의 pair에 남는다.
MCP tool 계약 제거, generation/guardFloor 변경 등 비호환이면 자동으로 정지 배포를 실행하지 않고
정지 필요를 보고한다. 소비자 정지 후 재실행한 rollback은 admission EX 경로로 복원한다.
과거 세대 복사본이 회수된 경우 rollback이 deploy EX 아래 catalog와 retained source release에서
같은 세대를 자동 재구성·완전 검증한다. 별도 사전 명령은 없다. source/catalog 부재·불일치면
current를 바꾸기 전에 거부한다. 재구성된 lease는 새 inode이며 과거 token을 부활시키지 않는다.

최초 v1→v2는 현재 운영 결정대로 모든 관련 구현 병합 후 한 번의 정지 window에서 수행한다.
구체적 순서는 아래와 같다. A는 현재 v1 release, B는 이번 구현이 포함된 release다.

```text
--prepare B
  -> --status (clear: true, uncertain: 0)
  -> --activate B                  v1 activation B; old bootstrap retained
  -> --migrate-codex-config        additive binding forwarding, section 9
  -> --refresh-bootstrap          explicit v1-to-v2 router + pair transition
  -> --status + validation         then operator reopens clients
```

각 명령은 자기 잠금과 소비자 상태를 새로 검증한다. 사용자 승인을 대체하는 자동 연속 실행은 없다.
managed v1의 일반 activate는 pointer-only 의미를 유지한다. B는 이 중간 상태를 위해 v1
activation/session/token 판독·실행도 지원해야 하며, generation2 선언만으로 v2 token을 강제하지 않는다.
초기 v2 신규 설치는 기존 최초 wire 단계에서 v2 router/pair를 바로 생성하고 위 legacy 이행은 생략한다.

activate 실패는 기존 복구 계약을 따른다. config 이행이 pending이면 같은 명령으로 먼저 복구하고
다른 mutation은 거부한다. config 이행 성공 후 bootstrap 이행이 실패해도 additive env 설정은 유지한다.
v1도 같은 binding 이름을 사용하므로 설정을 역변환하거나 사용자 env를 되돌릴 이유가 없다.

refresh는 최초 mutation 전에 다음 anchor를 `v2/migrations/m-*/`에 준비·봉인한다:
preMigrationCurrent(v1 B snapshot), legacyRollbackTarget(v1 A snapshot), 원래 bootstrap의 source/
manifest/bytes/identity와 복구 복사본, 새 router/세대, 최초 v2 activationId.
legacyRollbackTarget은 destination이 preMigrationCurrent와 정확히 일치하는 **성공한 activate B
journal의 origin과 receipt**로 증명한다. 임의의 이전 디렉터리·mtime으로 추정하지 않으며 증명이 없으면
refresh는 변경 전에 거부한다. 첫 v2 activation은 이 anchor의 migrationId와 상호 참조한다.
anchor와 이전 bootstrap/router 복구 재료는 이번 범위에서 영구 보존한다. 별도 finalize 명령은 없다.

이행 journal은 anchor identity/hash와 다음 상태를 가진 닫힌 별도 schema다:
`prepared -> router_intent -> router_published -> current_intent -> pair_published -> validation -> complete`.
각 intent를 먼저 durable하게 기록하고 원래 bootstrap을 보존한 채 router를 게시한 다음 current를
v2 activation으로 바꾼다. admission EX 아래 두 rename을 실행하며 사이 상태는 entry가 fail-closed한다.
MCP validation에 admission을 풀어야 하는 구간은 기존 maintenance 계약을 따른다. 운영자는 계속
클라이언트를 닫아 두며, 다음 mutation 전 EX 재획득·재조사에서 새 consumer를 발견하면 pending으로
중단한다. 프로세스를 종료하거나 live consumer 위로 복구를 강행하지 않는다.

중단 후 같은 `--refresh-bootstrap`은 anchor/journal의 exact origin·중간·destination 중 하나임을
검증한 경우에만 앞으로 완료하거나 preMigrationCurrent B와 원래 bootstrap으로 복원한다.
복원으로 끝난 뒤 A가 필요하면 일반 `--rollback`을 실행한다. 다른 객체·foreign 수정은 pending을
유지한다. 원래 bootstrap을 새 router 위로 추정 복사하는 복구는 없다.

완료된 최초 v2 activation에서 predecessor=null, migrationId가 있으면 기존 `--rollback`이
anchor의 legacyRollbackTarget A와 원래 bootstrap을 선택한다. 별도 rollback 명령은 추가하지 않는다.
이 v1 복원은 정지 상태에서만 지원하며 live v2 root/invocation 또는 orphan lease가 있으면 거부한다.
뒤의 v2 C에서 rollback하면 먼저 v2 B로 돌아가고, B에서 다시 rollback할 때 위 정지 경계가 적용된다.
신규 v2 설치처럼 predecessor/migrationId 모두 null이면 rollback 대상 없음으로 거부한다.
v1로 복원한 뒤 다시 이행하면 새 anchor/activation을 만들고 이전 anchor는 덮어쓰지 않는다.

v2 객체를 v1 parser가 이해한다고 가정하지 않는다. 새 deployer가 이행·복구·v1 복원을 맡고 구버전
worker에 새 phase/KEYS를 넘기지 않는다. retained release에 없는 기능을 현재 worker가 제공하는
것처럼 호출하지 않는다. 각 경로의 실행 worker와 capability 선택은 mixed-version 시험으로 고정한다.

일반 v2 pair publication journal은 `prepared -> pointer_intent -> published -> complete`다.
게시 전 실패는 unchanged current를 검증한 뒤 rejected evidence로 끝낸다.
pointer_intent 이후 중단은 exact origin/destination 관측이 일치할 때만 복구한다.
origin이면 unpublished evidence, destination이면 published completion/receipt로 마무리한다.
다른 pointer/manifest/identity면 pending을 유지하고 다음 mutation을 거부한다.
불확실한 상태에서 current를 추정 복원하거나 journal을 지우지 않는다.
이전 세대의 정상 bound 호출은 자신의 세대가 검증되는 한 pending publication과 독립적으로 동작한다.

## 8. 보존 root와 prune

세대 보존 root는 다음의 합이다.

- current pair와 current의 즉시 predecessor pair.
- 유효한 live root/invocation binding과 모든 generation lease holder.
- pending/복구 중 journal의 origin/destination/candidate.
- 초기 이행의 정지 rollback에 필요한 이전 bootstrap과 router source.
- 보존 정책상 최근 세대 최소 1개 및 30일 미만 세대.

모든 과거 activation을 영구 보존 root로 삼지는 않는다. 과거 activation은 삭제하지 않지만
그 helper 복사본이 회수됐다면 retained source release와 manifest에서 같은 bootstrapId/bytes를
재구성한 뒤에만 과거 activation으로 rollback할 수 있다. source release는 이번 작업에서 삭제하지 않는다.
정본 manifest는 복사본과 별도로 보존한 bootstrap catalog에서 가져온다.
즉시 predecessor는 재구성 없이 rollback할 수 있도록 반드시 보존한다.

prune plan은 advisory이며 apply는 deploy EX 아래에서 root 집합과 candidate identity/bytes를 다시 검증한다.
세대별 EX lease를 획득한 뒤 참조가 없고 해당 root/invocation record가 모두 안전하게 퇴역했는지
다시 확인하고, 기존 quarantine/recovery copy/fsync/
exact-child unlink 경로를 사용한다. 마지막 검증 뒤 새 bound 등록은 generation SH 때문에
진입할 수 없으며, 존재하는 root는 lease와 record 양쪽으로 보존된다.
live consumer를 보존한 채 미참조 세대만 회수한다. 모호한 owner/lease/record는 보존 또는 차단하며
삭제 허가로 해석하지 않는다.

#246의 기존 v1 compatible journal도 정확히 인식한다. candidate-probe.log, compatible 세 키,
variables={}는 compatible variant에서만 허용하고 일반 journal의 KEYS 검증은 완화하지 않는다.
완료+receipt가 있는 정상 전환만 age/recent 정책의 삭제 후보가 된다.
거부/중단 완료는 evidence로 보존하고 unresolved pending은 prune 전체를 차단한다.
기존 receipt 없는 성공 기록은 legacy 보존이다. 새 compatible 성공은 retention receipt를 기록한다.
v2 journal/receipt도 독립된 정확한 schema로 같은 분류를 구현한다.

## 9. Codex 환경 전달과 명시적 설정 이행

신규 등록 및 legacy adopt는 기본 env_vars에 JHW_RUNTIME_SESSION_BINDING를 한 번 넣는다.
기존 사용자 env 이름과 env child table은 검증해 보존한다. 동일 key/모호한 TOML/금지 loader 변수는
수정 전에 거부한다. 기본 binding만 있는 uninstall은 envDropped=[]이고 사용자 env 제거만 보고한다.

기존 managed 설치에는 명시적 `--migrate-codex-config` 동작을 추가한다.
이 동작은 deploy EX + admission EX 아래에서 Codex MCP 설정 한 파일만 변경하며,
일반 activate/refresh-bootstrap에 묵시적 전체 install-wiring 재실행을 추가하지 않는다.
초기 v2 이행과 같은 정지 window에서 별도로 실행한다. 사용자 세션을 자동 종료하지 않는다.

사전 검증은 기존 owned command/args를 인정하고 binding 필수 검증은 migration 뒤에 적용한다.
현재 검증된 release의 editor에서 지원 capability를 확인해 호출한다. 구버전 editor에 없는
command를 넘기거나 단순 register-codex로 대체하지 않는다.

순수 변환은 owned/adopted 양쪽에서 사용자 env와 무관한 TOML bytes를 보존하고
binding 이름만 병합한다. byte-identical이면 inode/mtime/backup을 건드리지 않는다.
변경 시 before bytes/mode/identity, 계산한 after bytes/hash, temp/backup identity를 private journal에 기록한다.
기존 first-wiring 복구의 quarantine/no-clobber 방식을 Codex 한 파일에 한정해 재사용한다.
source 검사 뒤 live 경로에 rename으로 덮어쓰는 방식은 사용하지 않는다. 구체적 게시 순서는 다음과 같다.

1. 동일 filesystem의 private transaction directory에 before preimage와 after temp를 만들고 fsync한다.
   journal 상태 prepared에는 원본의 no-follow identity/bytes/mode와 temp identity/hash를 기록한다.
2. quarantine_intent를 durable하게 쓴 뒤 원본 경로를 그 transaction의 비어 있는 quarantine 경로로
   이동한다. 이동된 객체를 열어 검사한 before와 같은 객체·내용인지 재검증한 뒤 quarantined를 기록한다.
   검사 직후 외부 editor가 교체한 객체가 이동됐다면 그 객체를 보존하고 실패 처리한다.
3. publish_intent를 기록하고 검증된 temp를 live 경로에 **no-clobber hard link**로 게시한다.
   누군가 live 경로를 다시 점유했으면 EEXIST로 중단한다. live 경로에 rename-overwrite하지 않는다.
4. live/temp가 같은 inode이며 after bytes/mode가 맞는지 검증하고 published를 기록한다.
   자기 temp link만 제거하고 parent fsync 후 live nlink=1과 최종 bytes/identity를 재검증한다.
   wiring 검증을 통과하면 verified -> complete와 retention 증거를 기록한다.

정지 window에서는 2~3 사이 live 경로가 잠시 없는 것을 허용한다. 외부 editor와의 완전한 CAS를
주장하지 않으며 이미 열린 FD의 비협조 쓰기를 잠금으로 막았다고 보지 않는다. before/after 변경을
발견하면 pending과 원본/외부 객체를 보존한다. 정확한 자기 객체만 삭제·복구할 수 있다.
temp/live의 nlink=2는 위 트랜잭션의 정확히 증명된 게시 단계에서만 허용하고 일반 판독기는 완화하지 않는다.
민감한 config bytes는 private preimage 저장 규칙 안에서만 취급하며 로그/Issue에 출력하지 않는다.

중단 복구는 다음 표에 따른다. 상태값만 믿지 않고 private 경로·live·quarantine·temp의 실제
identity/bytes/link 수를 대조한다. 매 unlink/link/rename 뒤 crash도 같은 규칙으로 판정한다.

| Observed state | Recovery |
|---|---|
| Original before still live, no quarantine | unchanged failure; remove only proven private temp |
| Live absent, quarantine is exact before | restore before with no-clobber link, then retire its private link |
| Live is exact after, original before is quarantined | finish verification, or capture exact own after and restore before with no-clobber link |
| Live absent, quarantine contains a raced foreign object | restore that captured object only to an absent live path, preserve evidence, report failure |
| Live reoccupied, symlink/unknown inode, changed bytes, or ambiguous private state | preserve all evidence; pending; no overwrite/unlink of foreign objects |

quarantine 이동 직후 journal이 끊긴 경우에도 actual object가 before와 일치하는지 먼저 판정한다.
foreign 객체를 자동으로 원본이라 명명하거나 삭제하지 않는다. 복원 직전 경합도 no-clobber가 거부한다.
실패 복구는 원본 설정 파일에 한정하며 activation/router를 역전하지 않는다. 재실행은 기존 pending을
먼저 복구하고, 판정 불가한 상태에서 새 migration을 겹치지 않는다.
검증은 생성된 env_vars whitelist를 적용하는 모의 MCP launcher와 실제 대화형 C5로 수행한다.
C5 호출 승인 정책 때문에 실행 전 차단된 경우를 runtime 실패나 성공으로 계산하지 않는다.

## 10. 검증과 완료 기준

| Area | Required evidence |
|---|---|
| Pair pin | different helper bytes; old/new sessions keep their pair |
| Registration | simultaneous roots/children, parent exits first, orphan, forged token, index contention |
| Publication | real dependencies + at least 3 live bound sessions; zero denied calls |
| Integrity | in-place edit, same-size edit, inode/dir/symlink replacement after preparation |
| Rollback | v2 pair rollback, catalog rebuild, incompatible refusal, stopped v1 restoration via anchor |
| Recovery | crash before/after every durable intent and pointer step |
| Prune | current/live/pending roots retained; unreferenced copy removed safely |
| Journals | successful/rejected/interrupted compatible variants and receipts |
| Wiring | preserve user env, duplicate/malformed refusal, raced capture/reoccupation/open-FD edit recovery |
| Compatibility | retained v1 reader failure-closed; two distinct v2 helper versions |
| Current schema | exact v1/v2 union, first migration priorCurrent=null, Guard/recovery/prune reject mixed keys |

기존 runtime safety/store/entry/deploy/coexist/sessions/prune 시험을 확장한다.
프로세스 생존을 무중단 증거로 대신하지 않고 모든 hook event/control/MCP 호출의 실제 결과와
시작~종료 시간을 기록한다. payload에 제품 경로를 우회하는 테스트 환경변수를 넣지 않는다.
control 시험은 bound managed control entry의 비변경 fixture로 수행하고 실제 Task/Claim을 조작하지 않는다.
secure host/SSH가 binding을 전달하지 않는 기존 제한은 별도 실패 증거로 명시한다.
generation2 golden에는 Project Control의 기존 영속 shape와 v2 runtime pair/lease/lock/토큰 계약을 넣는다.

구현 완료 시 typecheck/build/npm test, 관련 runtime 전체 시험, 스킬 계약/sync,
hook preflight/install safety를 실행한다. 각 대상의 pass/fail/skip와 실제 종료코드를 기록한다.
Task worktree mode 때문에 필요한 격리 022 checkout 검증은 source commit/diff를 묶어 기록한다.
live activate/refresh/migration/prune apply는 사용자 별도 승인 전 실행하지 않는다.
배포 후 #253 item12의 image-only UserPromptSubmit 확인을 수행한다.

## 11. 구현 계획으로 넘길 경계

계획은 다음 순서를 유지한다: 닫힌 v2 형식·golden과 reader 경계 -> stable router/세대 저장 ->
root/child 등록 잠금 분리 -> 준비 증거·pair publication -> rollback/recovery/prune ->
Codex 한 파일 migration -> 실제 의존성/다중 세션/대화형 통합 검증.
세부 함수명과 테스트 fixture 배치는 구현자가 정할 수 있다. 위 삭제·권한·호환성·잠금·실패 경계는
구현 편의를 이유로 생략하지 않는다. 구현 중 이 증명을 충족하지 못하면 검증 기준을 낮추지 않고
설계 분기를 다시 검토한다.
