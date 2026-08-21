# 보드 락 설계 (Board Lock v1)

작성: 2026-08-22. 상태: 설계 개정 3판 (구현 전, 리뷰 조건부 APPROVE의 조건 반영 완료).
개정 이력: 초안 → critic 리뷰(CRITICAL 3·MAJOR 10·MINOR 7) 반영 전면 개정(2판)
→ 재검증 지적(N1~N6·MINOR 7) 반영(3판): 타인 예약 정의·acquire 평가 순서·bearer
한계 정정(`--cross-session`)·`with --use-holder`·consume 세부·pilot-journal 제외
분기·읽기 락 프리 등.

---

## 1. 배경과 목표

여러 세션이 같은 호스트에서 네트워크로 연결된 타겟보드를 공유한다. 지금은 조율 수단이
없어 사람이 기억과 확인으로 충돌을 피한다. 이 설계는 다음 셋을 제공한다.

1. **점유 락** — 한 세션이 보드를 배타적으로 잡는다.
2. **공유 모드** — 서로 영향이 없는 테스트는 같은 보드를 동시에 쓴다.
3. **시간 예약** — 미래 구간을 예약해 두면 그 시간까지 남이 잠식하지 못하므로,
   보드가 비기를 모니터링하지 않아도 된다.

Claim/Registry와는 **완전히 분리**한다. 보드 락의 정본은 호스트 로컬 상태 파일이고
git Registry에는 아무것도 쓰지 않는다. Task와의 연결은 `purpose` 자유 기입과
board journal 기록으로만 남긴다.

## 2. 전제 (확정)

- 호스트는 1대(빌드 서버). 경합 주체는 이 호스트 위의 다중 세션이다.
- 보드는 이 호스트와 네트워크로 연결된다. 락이 물리 접근을 차단하지 못하므로
  **advisory lock**이다. 강제력은 테스트 진입점을 `board with` 래퍼로 통일하는
  규율에서 나온다.
- 단일 호스트이므로 시계는 하나다. 예약·만료 판정에 시계 동기화 문제가 없다.
- Phase 1A trial과 병행한다. Registry·Claim 불변식을 건드리지 않고, board 기록은
  **별도 스트림**(§10 board-journal)에만 남으므로 `pilot-journal.jsonl` 기반 trial
  감사 집합(runbook의 command·elapsed·ok/error 감사)에 board 행이 섞이지 않는다.

### 소유권 모델 (핵심 결정)

세션 ID는 컨텍스트 사망·재시작으로 수시로 바뀌므로 **소유권의 키가 될 수 없다.**
홀더·예약의 조작 권한은 Claim의 `task recover --expect <claim-id>`와 동형인
**좌표 제시(bearer) 모델**로 한다: `holder_id`/`reservation_id`를 제시하는 호출자가
곧 권한자다. `session`은 관측 정보로만 기록한다.
좌표는 `board status`로도 공개되므로 이 모델은 접근 제어가 아니라 **오타 방지
장치**이며 권한 분리는 제공하지 않는다(advisory 시스템의 위협 모델과 일치).
사고성 해제만 추가로 막는다: 기록된 session과 다른 session이 **살아 있는(만료 전)**
홀더·예약을 조작할 때는 `--cross-session` 명시 플래그를 요구하고(없으면
`HOLDER_MISMATCH` reason `cross_session_flag_required`로 거부 + 좌표 반환),
만료·pid 사망 홀더에는 요구하지 않는다. cross-session 조작은 board journal에
`cross_session: true`로 남긴다.

## 3. 비목표 (v1에서 하지 않는 것)

- cross-host 보드 공유 — 보드가 여러 호스트로 분산되면 자체 확장 대신 labgrid류
  기존 보드팜 도구 평가를 먼저 한다 (§11).
- 실행 중 프로세스의 강제 종료(자동 kill) — 회수는 락만 회수하며 테스트 프로세스를
  죽이지 않는다.
- 반복(cron식) 예약, 보드 풀 자동 배정, 대기열 우선순위.
- Claim/Task 스키마와의 결합. Registry 기록.
- heartbeat 데몬. 상주 프로세스는 두지 않는다 — 모든 판정은 커맨드 실행 시점에 한다.
- `board with`의 중첩 재진입(테스트 안에서 같은 보드에 다시 `with`) — 자기 자신과
  `BOARD_BUSY`로 충돌한다. 지원하지 않음을 명시한다.

## 4. 상태 모델

정본: `${JHW_CONTROL_STATE_DIR}/boards.yaml`. 갱신 락: `${JHW_CONTROL_STATE_DIR}/boards.lock`.
하위 디렉터리를 쓰지 않는다 — 기존 `AnchoredStateDirectory`/`safeStateFileName`이
`/` 포함 이름을 거부하므로 state dir 바로 아래에 평탄하게 둔다.

```yaml
version: 1
boards:
  <board-id>:                     # ids.ts와 동일 패턴: ^[a-z0-9][a-z0-9-]{1,62}$ — 예: pim, wlan-01
    description: <자유 텍스트>
    interfaces:                   # 접속 경로 (0..8). 표시용 메타데이터 — 락 판정에 불참
      - type: ethernet | wireless | serial
        address: <ip·host 또는 /dev/tty...>  # 자격증명(비밀번호·키)은 절대 넣지 않는다
    registered_at: <offset-datetime>
    holders:                      # 현재 점유 (0..16)
      - holder_id: hld-<UUIDv7>
        session: <session-id>     # 관측 정보. 권한 키가 아님 (§2 소유권 모델)
        pid: <number|null>        # null이면 생존 기반 자동 회수 대상이 아님
        pid_start_time: <string|null>   # /proc/<pid>/stat 22번 필드. pid와 함께만
        boot_id: <string|null>          # /proc/sys/kernel/random/boot_id. pid와 함께만
        mode: exclusive | shared
        purpose: <자유 텍스트>     # 무슨 테스트인지. tsk-id 기입 권장(강제 아님)
        acquired_at: <offset-datetime>
        granted_until: <offset-datetime>
        extended_after_expiry: <number>  # overstay 중 extend 횟수 (§8 extend)
    reservations:                 # 예약 (0..32)
      - reservation_id: rsv-<UUIDv7>
        session: <session-id>     # 관측 정보
        mode: exclusive | shared
        from: <offset-datetime>
        to: <offset-datetime>
        purpose: <자유 텍스트>
        created_at: <offset-datetime>
        consumed_by: <holder_id|null>   # 소비돼도 to까지 삭제하지 않음 (§6)
```

- 시각 값은 전부 기존 `OffsetDateTimeSchema`(offset 필수, 64자 상한) 형식이다.
- 스키마는 zod `.strict()`로 검증하고, 손상 시 fail-closed한다 (`BOARD_STATE_CORRUPT`).
  **파일 부재(ENOENT)는 손상이 아니라 빈 상태다.** 손상 복구는 §8 `board recover`.
- 모든 mutation: `boards.lock` flock 획득 → 읽기 → 검증 → 변경 → temp write →
  **temp fsync** → `renameWithin` → **디렉터리 fsync** → flock 해제.
  파일 열기는 기존 하드닝 API(O_NOFOLLOW·nlink==1·0600) 경유.
- flock은 blocking + 5s timeout(`flock -w 5 -E 75`)이다. 상태 갱신은 ms 단위라
  경합이 실질적으로 없고, timeout 시 `LOCK_CONTENDED` + reason `board_state_lock`
  (registry.lock의 `LOCK_CONTENDED`와 reason 축으로 구분). 기존 `MutationLock`은
  락 파일명이 `registry.lock` 하드코딩 + `-n` 논블로킹이므로, 파일명·대기 모드를
  파라미터화해 재사용한다 (§10).
- 읽기 전용 커맨드(`list`/`status`)는 **락 없이** 읽는다 — rename이 원자적이므로
  스냅숏은 항상 일관된 커밋 상태이고, 경합 중에도 status가 `LOCK_CONTENDED`로
  죽지 않는다(정보가 가장 필요한 순간이 경합 순간이다). 파일은 고치지 않되
  생존·만료는 **읽기 시점에 계산해 표시**한다 — 죽은 홀더를 살아있다고 보여주지
  않는다(실제 제거는 다음 mutation의 reap이 한다).
- `interfaces`는 사람이 접속처를 찾는 표시용이다: type은 닫힌 enum
  (`ethernet | wireless | serial`), address는 bounded 문자열로만 검증하고 파싱하지
  않는다(위반은 `INVALID_BOARD_INPUT`). `status`/`list`가 표시하며, IP·포트가
  바뀌면 `board update`로 갱신한다 — board-id가 아니라 메타데이터이므로 락·예약에
  영향이 없다.
- `pid`·`pid_start_time`·`boot_id`는 **셋을 원자적으로 함께 기록**한다. 하나라도
  취득 불가면 `pid: null`로 강등한다 — pid만 기록되면 §7 판정표의 재사용 펜스가
  무력화되기 때문이다.
- **registry.lock과 무관하다.** board 커맨드는 `requiresMutationLock` 목록에 넣지
  않고 자체 boards.lock만 잡는다.

### 상한 (전부 명시)

| 항목 | 상한 | 초과 시 |
|---|---|---|
| lease 길이 (`--for`/`--until`, extend 결과 포함) | 12h | `BOARD_LIMIT_EXCEEDED` reason `lease_too_long`. `--long-lease` 명시 시 72h까지 허용 + journal 기록 |
| 예약 길이 | 24h | reason `reservation_too_long` |
| 예약 미래 지평 (`from`) | 7일 | reason `reservation_horizon` |
| 보드당 예약 수 | 32 | reason `reservation_count` |
| 보드당 홀더 수 | 16 | reason `holder_count` |
| `status` 출력 | 상세(홀더·예약 좌표)는 **단일 보드 조회만** 반환하고, 전체 조회는 보드당 카운트 요약이다. 상세의 예약 표시는 12개 + `truncated: true`, session/purpose/description은 64자 표시 절단(좌표는 절단하지 않음). 관측 커맨드가 12KiB CLI 봉투를 넘지 않게 하는 구조적 상한이다 | — |

## 5. 점유·공유 규칙

허용 매트릭스 (현재 홀더 → 새 요청):

| 현재 홀더 | `exclusive` 요청 | `shared` 요청 |
|---|---|---|
| 없음 | 승인 | 승인 |
| shared 1..N | 거부 (`BOARD_BUSY`) | 승인 (공존) |
| exclusive 1 | 거부 (`BOARD_BUSY`) | 거부 (`BOARD_BUSY`) |

- "서로 영향이 없는 테스트"인지의 판단은 사람이 한다. shared는 공존을 **허용**할
  뿐 안전을 판정하지 않는다. `purpose`가 그 판단의 근거 자료다.
- 모드 전환(`board share`): exclusive → shared는 항상 가능(공유플래그 켜기).
  shared → exclusive는 (a) 다른 홀더가 없고, **(b) 남은 grant 구간이 §6 예약
  매트릭스를 exclusive 기준으로 다시 통과하며**, (c) 홀더가 예약을 소비 중이면
  그 예약의 mode가 exclusive일 때만 가능하다(§6 consume의 mode 불변식을 전환으로
  우회하지 못하게) — acquire 시점의 펜싱 판정은 그때의 mode 기준이므로, 전환이
  재펜싱 없이 이뤄지면 미소비 shared 예약을 조용히 무효화하는 우회로가 된다.
  통과 실패 시 충돌 좌표를 실어 거부한다(전환은 grant를 단축하지 않는다).
  exclusive → shared는 권한을 좁히는 방향이라 재펜싱이 필요 없다.

## 6. 예약과 펜싱

예약은 acquire 시점의 **펜싱**으로 실현된다. 스케줄러도 데몬도 없다.

**용어 — "타인 예약"**: 이 절의 "타인 예약"은 **이번 호출이 `--consume`으로
제시하지 않은 모든 예약**을 뜻한다. session은 판정에 쓰지 않는다(§2 bearer 모델).
따라서 `--consume` 없는 acquire가 자기가 만든 예약 구간에 들어가면 소비되지 않고
막히는 것이 **정상 동작**이다 — 예약을 쓰려면 좌표를 제시한다.

**acquire 평가 순서 (고정)**: 입력 검증 → 예약 lapse sweep + 홀더 reap → 상한
검사 → 예약 펜싱(아래 매트릭스) → 홀더 충돌(§5, `--claim-expired`는 이 단계에서만
작용) → 승인. **`--claim-expired`는 홀더 충돌만 우회하며 예약 펜싱은 절대 우회하지
못한다** — 만료 홀더를 치워도 남의 예약 구간에는 들어갈 수 없다.

예약 매트릭스 (§5와 같은 모양, 시작 전·후 판정에 동일하게 적용):

| 타인 예약 | `exclusive` 요청 | `shared` 요청 |
|---|---|---|
| exclusive 예약 | 충돌 | 충돌 |
| shared 예약 | 충돌 | 공존 |

- **acquire 시작 시점 판정**: now가 위 매트릭스에서 충돌하는 타인 예약 구간 안이면
  거부 (`BOARD_RESERVED`).
- **acquire 구간 도중 판정**: [now, now+for) 도중에 충돌하는 타인 예약이 시작되면
  **기본은 거부**한다 (`BOARD_RESERVED`, 충돌 예약 좌표 동봉). `--accept-shortened`를
  명시한 경우에만 granted_until을 그 예약 시작 시각으로 단축해 승인하고
  `shortened: true`를 반환한다. 짧은 lease로 긴 테스트를 시작해 상시 overstay를
  만드는 경로(특히 `wait`·`with`)를 기본 정책으로 차단하기 위함이다.
  `board with`는 `--accept-shortened`를 지원하지 않는다 — 래퍼는 필요한 시간을
  정확히 아는 호출자다.
- **예약 소비(consume)**: 예약 구간을 실제로 쓰려면 `acquire --consume <rsv-id>`로
  좌표를 제시한다(§2 bearer 모델 — session 대조 없음). 이때:
  - `granted_until = min(now + for, reservation.to)`. `--for`/`--until`은 여전히
    필수이며 이 식으로만 해석된다(예약 `to`를 넘을 수 없다). lease 상한은 이
    클램프 **이후의 유효 grant**에 적용한다 — "--for 최대치"는 "내 예약 끝까지"를
    표현하는 정당한 입력이지 상한 위반이 아니다.
  - 예약은 삭제하지 않고 `consumed_by: <holder_id>`로 표시한다. `to`까지 타인
    acquire를 계속 펜싱하므로, 일찍 release해도 남은 예약 구간은 보존되고 같은
    rsv-id로 재획득(`--consume` 재사용)할 수 있다.
  - 요청 mode는 예약 mode와 같아야 한다 (`RESERVATION_CONFLICT` reason
    `mode_mismatch`).
  - `now < from`의 조기 consume은 `RESERVATION_CONFLICT` reason
    `reservation_not_started`로 거부한다. `wait --consume`은 이 오류를 폴링 계속
    조건으로 취급한다(예약 시작을 기다린다).
  - 소비 중 홀더가 release·reap·evict로 사라지면 `consumed_by`를 null로 되돌린다
    (예약은 `to`까지 유지 — 재소비 가능).
  - `--consume`과 `--claim-expired`의 병용은 예약자 본인의 정상 복구 경로다:
    자기 만료 홀더를 치우고 같은 예약으로 재획득한다.
- `reserve` 등록 충돌: (a) 타인 예약과 위 매트릭스로 충돌하면 거부
  (`RESERVATION_CONFLICT` reason `overlaps_reservation`), (b) 기존 홀더의
  granted_until과 겹치면 거부하고 그 시각을 반환한다 (reason
  `overlaps_active_grant`; 그 이후로 예약하라).
- `to`가 지난 예약은 다음 mutation 때 정리(sweep)하고 board journal에
  `reservation_lapsed`로 남긴다. 소비 여부와 무관하다.

입력 검증: `--for > 0`, `--until`은 미래, `reserve`는 `from < to`이고 `from`은
now 이전 불가. 위반은 `INVALID_BOARD_INPUT`이며, 이 검증은 CLI 파싱 단계가 아니라
**서비스 단계에서 수행**한다(exit 1, board journal에 기록됨 — 파싱 단계 exit 2는
journal 미기록이라 기록 여부가 갈리지 않게).

## 7. 회수 정책

**자동 회수는 pid 사망이 증거로 확정될 때만 한다.** 그 외는 전부 표시 + 명시 조작이다.

생존 판정 (pid가 기록된 홀더, 모든 mutation 진입 시):

| 관측 | 판정 |
|---|---|
| 기록된 `boot_id` ≠ 현재 boot_id | **사망 확정** (재부팅 경계 — pid 재사용 오판 차단) |
| `kill(pid, 0)` → ESRCH | 사망 |
| `/proc/<pid>/stat` start_time ≠ 기록값 | 사망 (pid 재사용) |
| `kill(pid, 0)` → EPERM | **생존** (타 uid로 살아 있음) |
| 그 외 errno | 생존 (fail-safe — 증거 없이 회수하지 않음) |

처리 규칙:

| 상황 | 처리 |
|---|---|
| 사망 확정 홀더 | mutation 진입 시 자동 제거(reap). board journal `holder_reaped` |
| granted_until 경과 + 생존 (또는 pid null) | **overstay 표시만.** status와 충돌 오류에 누가·무엇을·얼마나 초과했는지 노출 |
| overstay 홀더가 막고 있는 보드를 잡고 싶음 | `acquire --claim-expired` — **만료된** 홀더만 제거하고 진입. 만료 전 홀더는 이 플래그로도 제거 불가. journal `holder_evicted_expired` |
| 세션이 사라진 pid-null 홀더 (만료 전) | `release --holder <hld-id>` — 좌표 제시가 곧 권한(§2). 기록된 session과 다르면 journal `cross_session: true` |

- `--claim-expired`는 명시 플래그이므로 "stale 자동 추정 금지" 원칙과 충돌하지
  않는다. 만료는 본인이 약속한 시각이 지난 것이라 제거의 정당성이 기록에 있다.
- advisory이므로 evict가 실행 중 테스트를 죽이지는 않는다. 제거 판단은 표시된
  overstay 정보를 보고 사람이 한다.
- 좌표를 잃은 홀더(결과 JSON 유실)는 `board status`가 holder_id를 표시하므로
  거기서 복구한다 — 별도 recover 커맨드가 필요 없다.

## 8. 커맨드 명세

모두 `jhw-control board <sub>`이며 JSON 결과를 반환한다(`with` 제외, 아래).
`--session`은 모든 mutation 커맨드에서 필수인 관측 좌표다(권한 키 아님, §2).

```bash
# 보드 등록/갱신/해제/조회 — 등록된 board-id만 잠글 수 있다 (오타로 유령 보드 방지)
# --interface는 반복 가능: --interface serial=/dev/ttyUSB0 --interface ethernet=192.168.1.50
jhw-control board register <board-id> [--description <text>] \
  [--interface <type>=<address> ...] --session <session-id>
jhw-control board update <board-id> [--description <text>] \
  [--interface <type>=<address> ...] --session <session-id>   # interface 목록은 전체 교체. 홀더·예약 무관
jhw-control board unregister <board-id> --session <session-id>   # 홀더·예약 0일 때만
jhw-control board list
jhw-control board status [<board-id>]        # 홀더·예약·overstay 표시 (생존은 읽기 시점 계산)

# 점유 — --for(기간) 또는 --until(시각) 중 정확히 하나 필수. 기본값을 두지 않는다.
jhw-control board acquire <board-id> --mode exclusive|shared \
  (--for <90m|2h|...> | --until <offset-datetime>) \
  --session <session-id> --purpose <text> \
  [--pid <n>] [--consume <rsv-id>] [--claim-expired] [--accept-shortened] [--long-lease]

# 해제 — holder-id 제시가 권한(§2). 생략 시 자기 session의 홀더가 정확히 1개일 때만
# 그것을 해제하고, 0개면 HOLDER_NOT_FOUND, 2개 이상이면 HOLDER_AMBIGUOUS.
jhw-control board release <board-id> [--holder <hld-id>] --session <session-id>

# 연장/모드 전환 — 좌표 제시가 권한. 규칙은 아래.
jhw-control board extend <board-id> --holder <hld-id> --for <duration> --session <session-id>
jhw-control board share <board-id> --holder <hld-id> [--exclusive] --session <session-id>

# 예약 — 취소는 rsv-id 제시가 권한
jhw-control board reserve <board-id> --mode exclusive|shared \
  --from <offset-datetime> --to <offset-datetime> --session <session-id> --purpose <text>
jhw-control board unreserve <board-id> --reservation <rsv-id> --session <session-id>

# 대기 — acquire가 성공할 때까지 폴링(기본 10s 간격). BG 실행 + task-notification 조합 전제.
# 단축 승인 없음(전 구간을 받을 수 있을 때만 성공). --consume 지정 시 그 예약 시작을 기다린다.
jhw-control board wait <board-id> --mode exclusive|shared \
  (--for <duration> | --until <offset-datetime>) \
  --session <session-id> --purpose <text> [--pid <n>] [--consume <rsv-id>] [--timeout <duration>]

# 손상 복구 — BOARD_STATE_CORRUPT 시에만. 손상 파일을 타임스탬프 접미로 보존 이동 후
# 빈 상태를 생성하고 journal에 기록한다. 비대화형 CLI 계약이므로 사전 승인 대신
# exact literal 확인 인자를 요구한다 (--allow-public 선례와 동형).
jhw-control board recover --action reset-state --confirm reset-state --session <session-id>

# 래퍼 — 권장 진입점. acquire(pid=자기 자신) → 커맨드 실행 → 종료 시 release.
jhw-control board with <board-id> --mode exclusive|shared \
  (--for <duration> | --until <offset-datetime>) \
  --session <session-id> --purpose <text> [--consume <rsv-id>] [--long-lease] -- <command...>

# 기존 홀더로 실행 — bare acquire/wait로 잡은 홀더(pid null)의 pid 3필드를 래퍼
# 것으로 갱신하고 종료 시 release한다. `acquire --claim-expired`로 잡은 락 위에서
# 테스트를 돌리는 경로가 이것이므로, with 자체에는 --claim-expired를 두지 않는다.
# 대상 홀더에 살아 있는 pid가 이미 기록돼 있으면 거부한다
# (HOLDER_MISMATCH reason live_pid_recorded). mode·granted_until은 그대로 유지되며
# lease 연장이 필요하면 extend를 쓴다.
jhw-control board with <board-id> --use-holder <hld-id> --session <session-id> -- <command...>
```

### extend 규칙

- `--for`는 `max(now, granted_until)` 기준 **가산**이다. extend는 절대 grant를
  줄이지 않는다.
- 연장 결과 구간이 §6 예약 매트릭스와 충돌하면 충돌 좌표를 실은 **실패**이며 기존
  grant는 보존된다 (`--accept-shortened` 없음 — extend에 단축 개념을 두지 않는다).
- 연장 결과가 lease 상한(§4)을 넘으면 `BOARD_LIMIT_EXCEEDED`.
- **overstay 중 extend는 허용**하되 결과와 journal에 `extended_after_expiry`로
  표시하고 홀더의 누적 카운트를 올린다. status의 overstay 표시에 노출되며 §11
  자동-evict 게이트의 증거가 된다. (금지하면 초과 실행 중인 테스트가 스스로를
  정당화할 길이 없어 사람이 락 규율을 포기하게 된다.)

### pid 기록 규칙

- `board with`는 래퍼 자신의 pid + start_time + boot_id를 기록한다. 래퍼가 테스트
  동안 살아 있으므로 생존 판정이 정확하고, **자동 회수가 확실한 유일한 경로다.**
- bare `acquire`/`wait`는 CLI 프로세스가 즉시 종료되므로 자기 pid를 기록하지 않는다.
  `--pid <n>`(정수 > 1, acquire 시점 생존 확인 통과 필수)을 명시하지 않으면
  `pid: null`로 기록되고, 결과에 "생존 기반 자동 회수 대상 아님"을 명시한다.
- release 누락 방지: `board with` 사용을 권장 기본으로 문서화한다. bare acquire는
  release를 사람이 책임진다.

### `board with` 실행 계약

`with`는 다른 커맨드와 달리 **CLI JSON 봉투 밖에서 실행된다** (자식 출력이 12KiB
봉투 예산에 걸리면 안 되므로).

- 자식의 stdin/stdout/stderr는 그대로 상속한다. 락 좌표(JSON 1줄)는 자식 실행 전
  stderr로 출력한다 — 자식 stderr와 섞이므로 기계 파싱이 필요한 호출자는
  `--json-fd <n>`으로 좌표 출력 fd를 분리한다.
- **exit code는 자식의 것을 그대로 전파한다** (`CliResult`의 `0|1|2|4|75|78`
  유니온 예외 — acquire 단계 실패 시에만 기존 code 체계 사용).
- SIGINT/SIGTERM은 자식에게 전달하고 **자식 종료를 기다린 뒤** release한다. 래퍼만
  죽고 자식이 남는 "홀더 없는 점유"를 만들지 않는다.
- 종료 시 release 실패(그 사이 reap/evict된 경우 포함)는 stderr 경고로만 싣고
  자식 exit code를 덮어쓰지 않는다 (`journal_warning` 선례와 같은 형태).

## 9. 에러 어휘

기존 원칙(닫힌 code + 같은 code 안을 가르는 reason 축)을 따른다. 신규 reason은
전부 `schemas.ts`의 `ERROR_REASONS`에 등록하고, `error-reasons.test.ts`의 문서
검증 경로를 `task.md` 단일 파일에서 스킬 문서 집합(`board.md` 포함)으로 확장한다.
**스킬 문안은 구현과 같은 커밋에 포함한다** — 그렇지 않으면 reason-문서 정합
테스트가 즉시 실패한다.

| code | exit | reason 축 | 의미 |
|---|---|---|---|
| `BOARD_NOT_FOUND` | 4 | — | 미등록 board-id |
| `BOARD_ALREADY_REGISTERED` | 4 | — | register 중복 |
| `BOARD_NOT_EMPTY` | 4 | — | 홀더/예약이 남은 보드 unregister |
| `BOARD_BUSY` | 4 | `exclusive_holder` \| `shared_holders_block_exclusive` \| `overstay_holder` | 홀더 충돌. overstay가 원인이면 reason으로 구분해 `--claim-expired` 판단 근거 제공 |
| `BOARD_RESERVED` | 4 | `reservation_window_active` \| `shortening_not_accepted` | 시작 시점이 충돌 예약 구간 안 / 도중 충돌인데 `--accept-shortened` 없음 |
| `RESERVATION_CONFLICT` | 4 | `overlaps_reservation` \| `overlaps_active_grant` \| `mode_mismatch` \| `reservation_not_started` | 예약 등록/소비 충돌 |
| `HOLDER_NOT_FOUND` / `RESERVATION_NOT_FOUND` | 4 | — | 좌표 불일치 |
| `HOLDER_MISMATCH` | 4 | `cross_session_flag_required` \| `live_pid_recorded` | 좌표는 맞지만 조작 조건 불충족 — 살아 있는 타 session 홀더에 `--cross-session` 누락 / `--use-holder` 대상에 살아 있는 pid 기록됨 |
| `HOLDER_AMBIGUOUS` | 4 | — | release에 `--holder` 생략 + 자기 session 홀더 2개 이상 |
| `BOARD_LIMIT_EXCEEDED` | 4 | `lease_too_long` \| `reservation_too_long` \| `reservation_horizon` \| `reservation_count` \| `holder_count` | §4 상한 초과 — 가득 찬 보드/예약 테이블은 일시적 점유 거부이지 크래시가 아니므로 충돌 계열로 매핑 |
| `INVALID_BOARD_INPUT` | 1 | — | 기간/시각/pid 검증 실패 |
| `BOARD_STATE_CORRUPT` | 1 | — | boards.yaml 파싱/검증 실패. fail-closed. 복구는 `board recover` |
| `LOCK_CONTENDED` | 75 | `board_state_lock` | boards.lock 획득 timeout (registry.lock 경합과 reason으로 구분) |

- 점유·예약·좌표 충돌 계열은 Claim 충돌과 같은 exit `4` 계열로 매핑한다 —
  스크립트가 "보드 사용 중"과 "크래시"를 구분할 수 있어야 한다.
- 충돌 오류는 bounded 좌표(holder_id/session/mode/purpose/granted_until 또는 예약
  구간)를 동봉한다 — Claim의 `conflicting_claim` 요약과 같은 패턴.

## 10. 구현 배치

- `mcp-server/src/control/board-service.ts` — 상태 모델·규칙 전부. 시계는
  `now()` 주입(기존 TaskService 관례), 생존 판정(`kill`/`/proc` 접근)도 주입으로
  테스트 가능하게 한다.
- 스키마는 `schemas.ts`에 `BoardStateSchema` 추가 (Claim 스키마와 결합하지 않음).
  신규 reason은 `ERROR_REASONS`에 등록 (§9).
- `cli.ts` — `commandNames`에 board 계열 추가, dispatch 분기 추가.
  `requiresMutationLock`(registry.lock)에는 **추가하지 않는다.** `with`는 봉투 밖
  실행 경로로 분리한다 (§8).
  **pilot-journal 제외 분기 필수**: `runCli`는 현재 모든 커맨드에 무조건
  pilot-journal 1줄을 append하므로(exit 2 조기 반환 제외), board 커맨드를
  `commandNames`에 넣는 것만으로 §2의 비오염 보장이 깨진다. journal append 분기에
  board 제외 조건을 추가하고(기록은 board journal로), 회귀 테스트로 고정한다
  (board mutation 실행 후 `pilot-journal.jsonl` 라인 수 불변). exit `4` 매핑
  하드코딩 집합(`cli.ts:400`)에 §9의 board 충돌 code들을 추가한다.
- `process.ts` — `MutationLock`을 락 파일명 파라미터화 + blocking(`-w`) 모드
  지원으로 확장해 boards.lock에 재사용한다.
- **board journal** — `${JHW_CONTROL_STATE_DIR}/board-journal.jsonl` 별도 스트림.
  event-typed 레코드(`command` \| `holder_reaped` \| `holder_evicted_expired` \|
  `reservation_lapsed` \| `state_reset`)이며, 기존 journal.ts의 라인 상한(4096B)·
  fsync·bounded 값 규율을 따른다. 값은 bounded id·code만 — `purpose` 등 자유
  텍스트는 넣지 않는다. 레코드에 `reason`이라는 **키 이름을 쓰지 않는다** —
  error-reasons 스윕 테스트가 `src/control/*.ts`의 `reason:` 리터럴을
  `ERROR_REASONS` 등록 대상으로 강제하므로, 이벤트의 원인 값(`boot_id_mismatch`
  등)은 `cause` 키로 적는다. **pilot-journal.jsonl에는 아무것도 쓰지 않는다** (Phase 1A
  감사 집합 비오염, §2). journal은 파생 측정 스트림이며 락 authority가 아니다.
- `sensitive-data.assertSafe`를 purpose/description 등 자유 텍스트 경계에 적용한다.
- 스킬 `/jhw:board` 문안(task.md와 같은 형식)은 **구현과 같은 커밋**으로 작성한다.

## 11. 확장 게이트 (증거 기반)

SSOT 스펙 §6.5의 방식을 따라, 아래는 실제 사건이 board journal 기록으로 2회
쌓이면 재검토한다.

| 후보 | 트리거 증거 |
|---|---|
| cross-host 공유 (labgrid류 평가 포함) | 다른 호스트에서 같은 보드를 써야 하는 실제 필요 2회 |
| 강제 회수(자동 evict) | overstay(`extended_after_expiry` 누적 포함)로 인한 실질 차단 2회 |
| 대기열 우선순위/공정성 | wait 기아(starvation) 관측 2회 |
| 반복 예약 | 같은 구간 수동 재예약 반복 2회 |

## 12. 열린 결정 (구현 전 확인)

1. **초기 등록 목록** — 실제 보드 인벤토리(board-id·interface·address 값들).
   식별 체계는 확정됨: board-id는 `pim`/`wlan-01`류 짧은 이름, 접속 정보는
   interfaces 메타데이터 (2026-08-22 사용자 결정). register 커맨드가 있으므로
   설계 차단 요소는 아님.
2. **상한 수치** — §4의 12h/72h/24h/7일/32/16/20은 제안 기본값. 실사용 패턴에
   맞게 조정 가능.
3. **wait 폴링 간격** — 기본 10s. 보드 회전율에 따라 조정.
