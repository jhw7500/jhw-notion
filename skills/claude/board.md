---
description: Use when the user explicitly requests target-board occupancy, sharing, reservation, waiting, release, or board registry maintenance
argument-hint: "(register | update | unregister | list | status | acquire | release | extend | share | reserve | unreserve | wait | with | recover) <board-id>"
---

# /jhw:board — 타겟보드 점유·공유·예약

사용자가 보드 락 동작을 **명시적으로 요청했을 때만** 사용한다. 락은 advisory다 —
물리 접근을 차단하지 않으며, 강제력은 테스트 진입점을 `board with`로 통일하는
규율에서 나온다. 설계 정본: `docs/superpowers/specs/2026-08-22-board-lock-design.md`.

## 소유권 모델

`hld-`/`rsv-` 좌표 제시가 곧 권한이다(bearer). session은 관측 정보다. 좌표는
`board status`로도 공개되므로 이 모델은 접근 제어가 아니라 오타 방지 장치다.
**살아 있는(만료 전) 타 session 홀더·예약을 조작할 때만** `--cross-session true`를
명시해야 하며, 없으면 `HOLDER_MISMATCH` + `cross_session_flag_required`로 멈춘다.
만료·pid 사망 홀더에는 필요 없다.

boolean 옵션은 전부 **exact literal `true`**를 값으로 받는다
(`--claim-expired true`, `--accept-shortened true`, `--long-lease true`,
`--exclusive true`, `--cross-session true`).

## 등록·조회

```bash
jhw-control board register <board-id> [--description <text>] \
  [--interface serial=/dev/ttyUSB0] [--interface ethernet=<ip>] --session <session-id>
jhw-control board update <board-id> [--description <text>] [--interface <type>=<address>] --session <session-id>
jhw-control board unregister <board-id> --session <session-id>
jhw-control board list
jhw-control board status [<board-id>]
```

interface type은 `ethernet|wireless|serial`. address는 표시용이며 자격증명을 넣지
않는다. `update`의 `--interface`는 목록 전체 교체다. `unregister`는 홀더·예약이
0일 때만 성공한다(`BOARD_NOT_EMPTY`). status의 생존·overstay 표시는 읽기 시점
계산이며 파일을 바꾸지 않는다. **상세(홀더·예약 좌표)는 단일 보드 조회
(`board status <board-id>`)만 반환**하고 전체 조회는 카운트 요약이다 — 상세의
예약 표시는 12개까지(`truncated`), session/purpose는 64자 표시 절단이며 좌표는
절단되지 않는다.

## 점유·해제

```bash
jhw-control board acquire <board-id> --mode exclusive|shared \
  (--for <90m|2h> | --until <offset-datetime>) --session <session-id> --purpose <text> \
  [--pid <n>] [--consume <rsv-id>] [--claim-expired true] [--accept-shortened true] [--long-lease true]
jhw-control board release <board-id> [--holder <hld-id>] --session <session-id>
jhw-control board extend <board-id> --holder <hld-id> --for <duration> --session <session-id> [--long-lease true]
jhw-control board share <board-id> --holder <hld-id> [--exclusive true] --session <session-id>
```

- exclusive는 단독, shared끼리 공존. 공존 안전 판단은 사람이 하고 `--purpose`가
  그 근거 자료다.
- lease는 12h 상한, `--long-lease true`로 72h까지(`BOARD_LIMIT_EXCEEDED` +
  `lease_too_long`). 예약 상한: 길이 24h(`reservation_too_long`), 시작 7일
  지평(`reservation_horizon`), 보드당 32건(`reservation_count`), 홀더
  16개(`holder_count`).
- `release`에 `--holder` 생략 시 자기 session 홀더가 정확히 1개일 때만 해제
  (0개 `HOLDER_NOT_FOUND`, 2개 이상 `HOLDER_AMBIGUOUS`).
- `extend`는 `max(now, granted_until)` 기준 가산이며 절대 단축하지 않는다. 예약과
  충돌하면 기존 grant를 보존한 채 `RESERVATION_CONFLICT` + `overlaps_reservation`으로
  멈춘다. 만료 후 연장은 허용되지만 `extended_after_expiry`로 표시·누적된다.
- `share --exclusive true`는 다른 홀더가 없고 남은 구간이 exclusive 기준 재펜싱을
  통과할 때만 성공한다. 소비 중인 예약이 shared면 `mode_mismatch`로 거부된다.
- bare acquire는 CLI가 즉시 종료되므로 `--pid`로 장수 프로세스를 명시하지 않으면
  생존 기반 자동 회수 대상이 아니다. 자동 회수가 확실한 경로는 `board with`뿐이다.

## 예약

```bash
jhw-control board reserve <board-id> --mode exclusive|shared \
  --from <offset-datetime> --to <offset-datetime> --session <session-id> --purpose <text>
jhw-control board unreserve <board-id> --reservation <rsv-id> --session <session-id>
```

예약은 acquire 시점의 펜싱으로 실현된다. "타인 예약"은 이번 호출이 `--consume`으로
제시하지 않은 모든 예약이다 — 자기가 만든 예약이라도 좌표 없이 acquire하면 막히는
것이 정상이다. 시작 시점이 충돌 예약 구간 안이면 `BOARD_RESERVED` +
`reservation_window_active`, 구간 도중 예약이 시작되면 기본 거부(`BOARD_RESERVED` +
`shortening_not_accepted`)이고 `--accept-shortened true`일 때만 그 시작 시각까지
단축 승인된다. 예약 등록 충돌은 `RESERVATION_CONFLICT`의 `overlaps_reservation` /
`overlaps_active_grant`로 갈린다.

`--consume <rsv-id>`는 예약 소비다: 요청 mode가 예약과 다르면 `mode_mismatch`,
`from` 이전이면 `reservation_not_started`, grant는 `min(now+for, 예약 to)`로
제한된다. 소비해도 예약은 `to`까지 남아 타인을 계속 펜싱하므로 일찍 release해도
같은 rsv-id로 재획득할 수 있다.

## 회수

자동 회수는 **pid 사망이 증거로 확정될 때만** 일어난다(reboot 경계는 boot_id로,
pid 재사용은 start_time으로 판정하고, 증거가 없으면 살아 있다고 본다). 만료는
overstay로 표시만 하며, 제거는 후속 acquire의 `--claim-expired true`가 **만료된
홀더만** 치우고 진입한다 — 충돌 오류의 `overstay_holder` reason이 그 판단 근거다
(`exclusive_holder` / `shared_holders_block_exclusive`는 만료 전 충돌).
`--claim-expired`는 홀더 충돌만 우회하며 **예약 펜싱은 절대 우회하지 못한다**.
`--consume`과의 병용이 예약자 본인의 정상 복구 경로다.

## 대기와 래퍼

```bash
jhw-control board wait <board-id> --mode exclusive|shared (--for <d> | --until <t>) \
  --session <session-id> --purpose <text> [--consume <rsv-id>] [--timeout <duration>]

jhw-control board with <board-id> --mode exclusive|shared (--for <d> | --until <t>) \
  --session <session-id> --purpose <text> [--consume <rsv-id>] [--long-lease true] -- <command...>
jhw-control board with <board-id> --use-holder <hld-id> --session <session-id> -- <command...>
```

- `wait`는 10초 간격 폴링으로 전 구간을 확보할 수 있을 때만 성공한다(단축 승인
  없음). BG로 실행하면 종료 시 task-notification으로 돌아온다.
- `with`는 **권장 진입점**이다: 래퍼 pid를 기록해 자동 회수가 확실하고, 자식의
  stdio·exit code를 그대로 전파하며(JSON 봉투 밖 실행), SIGINT/SIGTERM을 자식에
  전달하고 자식 종료 후에만 release한다. 락 좌표 JSON 1줄은 stderr로 나온다
  (기계 파싱은 `--json-fd <n>`). `--use-holder`는 bare acquire/wait로 잡은 홀더의
  pid를 래퍼로 갱신한다 — `acquire --claim-expired true`로 잡은 락 위에서 테스트를
  돌리는 경로가 이것이다. `--use-holder`는 기존 grant를 그대로 승계하므로
  `--mode`/`--for`/`--until`/`--purpose`/`--consume`을 받지 않는다(연장은
  `board extend`). 죽은 pid의 홀더는 sweep이 이미 회수했으므로 그 경우의 재개는
  adoption이 아니라 일반 재획득이다. 대상 홀더가 pid를 이미 기록하고 있으면
  `HOLDER_MISMATCH` + `live_pid_recorded`로 거부된다. 같은 보드에 대한 `with` 중첩
  재진입은 지원하지 않는다.

## 손상 복구

```bash
jhw-control board recover --action reset-state --confirm reset-state --session <session-id>
```

`BOARD_STATE_CORRUPT`일 때만 사용한다. 손상 파일을 타임스탬프 접미로 보존 이동한 뒤
빈 상태를 만든다. 파일 부재는 손상이 아니라 빈 상태다. 정상 상태에서 실행하면
`INVALID_BOARD_INPUT`으로 거부된다.

## 결과 해석

- 점유·예약·좌표 충돌 계열(`BOARD_BUSY`·`BOARD_RESERVED`·`RESERVATION_CONFLICT`·
  `HOLDER_MISMATCH`·`BOARD_LIMIT_EXCEEDED` 등)은 exit `4`이며 bounded 충돌
  좌표(`conflicting_board`)를 동봉한다 — 가득 찬 보드는 일시적 거부이지 크래시가
  아니다. 입력(`INVALID_BOARD_INPUT`)·손상(`BOARD_STATE_CORRUPT`) 계열은 exit `1`.
- exit `75` + reason `board_state_lock`: boards.lock 경합(5초 blocking 대기 초과).
  registry.lock 경합과 reason 축으로 구분된다. 잠시 후 재실행한다.
- board 커맨드는 pilot journal에 기록되지 않는다. 측정 스트림은
  `board-journal.jsonl`(event-typed: command / holder_reaped /
  holder_evicted_expired / reservation_lapsed / state_reset)이다.
- 서브커맨드 `--help`는 미지원 — `INVALID_CLI_ARGUMENT`로 응답한다(2026-08-22
  실측). 커맨드 규격의 정본은 이 문서와 설계 스펙이다.
