# Codex 사용량 한도 응답 정책

## 결정

Codex GitHub App이 현재 라운드에서 사용량 한도, quota, connector 또는 환경 생성 실패를
보고하면 그 실패 증거는 `FAILED`로 분류하고 머지를 차단한다. Codex는 이 사유로 자동 제외하지
않는다. 이 정책은 오류를 성공으로 간주하거나 리뷰어 수에서 빼는 대신, 사람이 확인할 수 있는
실패 상태로 남기는 fail-closed 정책이다.

같은 응답 본문에 `P0`/`P1`이 있어도 quota 실패 증거의 분류는 `FAILED`다. 현재 요청보다 엄격히
나중이고 현재 HEAD에 연결된 별도 review 또는 inline comment에 열린 `P0`/`P1` 지적이 있으면
collector는 그 블로커를 실제 현재 라운드 신호로 처리해 `FEEDBACK`을 표면화한다. 그 뒤 quota
댓글이 도착해도 열린 블로커가 우선한다. 반대로 현재 HEAD에 연결됐더라도 요청보다 이전인
`P0`/`P1`은 현재 라운드 신호가 아니므로, 뒤의 quota 댓글은 `FAILED`로 남는다. 두 경우 모두
머지 게이트를 열지 않으며 Codex를 expected 집합에서 excluded 집합으로 옮기지 않는다.

## 현재 GitHub API의 한계

현재 사용하는 GitHub review/comment API는 일반 PR 댓글에 작성자와 생성 시각은 주지만,
Codex 요청 댓글과 응답 사이의 귀속 정보를 제공하지 않는다. 일반 PR 댓글에는 응답이 어느 요청에
대한 것인지 또는 어느 HEAD를 검토한 것인지 나타내는 좌표도 없다. review와 inline comment에는
commit 좌표가 있지만, 그것만으로 특정 `@codex review` 요청에 대한 응답임을 증명할 수 없다.

따라서 현재 HEAD에 귀속할 수 없는 일반 PR 댓글은 다음과 같이 제한해서 사용한다.

- 성공적으로 기록한 요청 댓글보다 엄격히 나중에 같은 Codex App actor가 남긴 명시적 runtime
  실패 본문만 실패 증거로 받는다.
- 요청보다 이전이거나 같은 초의 일반 댓글은 현재 요청의 증거로 쓰지 않는다. 이후 다른 terminal
  신호가 없으면 `PENDING`, deadline 뒤에는 `TIMEOUT`이며 둘 다 머지를 차단한다.
- review는 요청 시각보다 엄격히 나중이고 `commit_id == 현재 HEAD`, inline comment는 요청
  시각보다 엄격히 나중이고 `commit_id == original_commit_id == 현재 HEAD`여야 한다. HEAD
  좌표만 맞는 요청 이전 review, 과거 HEAD, 재매핑된 지적은 현재 라운드의 증거가 아니다.
- 시각만으로 quota 응답을 특정 요청이나 HEAD의 성공 응답으로 추정하지 않는다. 늦게 도착한 명시적
  quota 응답은 `FAILED`로 남긴다.

## 자동 제외를 지원하지 않는 이유

Codex quota 자동 제외는 지원하지 않는다. managed workflow인 Gemini와 OpenCode의 제한된 제외는
현재 HEAD의 workflow run ID/attempt와 구조화된 실패 증거를 다시 검증할 수 있을 때만 허용된다.
Codex App의 일반 quota 댓글에는 그와 동등한 run-bound 요청/HEAD 귀속이 없으므로 같은 예외를
적용할 수 없다. `ROUND_EXPECTED_REVIEWERS`에서 Codex를 빼거나
`ROUND_UNAVAILABLE_REVIEWERS`에 Codex 행을 추가하면 계약 위반이며 머지를 거부한다.

`TIMEOUT`의 의미도 바꾸지 않는다. 요청 시작은 확인됐지만 deadline까지 terminal 신호가 없다는
뜻이며, quota 자동 제외나 성공의 대체 신호가 아니다. Gemini와 OpenCode workflow의 기존 제외
정책은 각 workflow의 run-bound 증거와 allowlist를 만족할 때만 적용되며 Codex로 확장되지 않는다.

## 재검토 조건

GitHub 또는 Codex App API가 응답에 검증 가능한 요청 ID와 reviewed HEAD를 함께 제공하거나,
Codex가 workflow run/attempt에 묶인 구조화된 실패 상태를 제공할 때만 자동 제외 설계를 다시
검토한다. 그 전에는 생성 시각 추정이나 오류 문구만으로 Codex를 제외하지 않는다.
