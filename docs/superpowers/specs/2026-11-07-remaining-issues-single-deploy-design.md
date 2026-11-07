# 남은 이슈 일괄 처리와 1회 배포 설계안

상태: 2026-11-07 사용자의 `진행`으로 권장 설계를 확정했다. 구현·검증을 진행하며
push·PR·머지·운영 배포·실제 삭제는 아래의 별도 실행 경계를 유지한다.
기준 main: `50c9fe70c30ad7d9859bd2b9f31c84144d4dd140`.
완료한 로컬 변경: `146cd19bd9f3810180306de4092384825b06fca3`.

## 목표와 완료 기준

남은 #220·#217·#206·#201·#196·#195를 처리한 뒤 운영 배포를 한 번만 한다.
이미 머지한 #222·#219·#210도 그 최종 릴리스에 포함한다.
각 이슈의 구현 또는 명시적으로 승인된 정책 결정을 끝내고, 격리 검증·리뷰·머지를
마친 다음 최종 revision 하나로 배포 스크립트를 준비한다. #195의 실제 live 배선과
새 세션 검증은 그 마지막 배포에 포함한다.

## #206: 기존 재획득 구현을 유지하고 판단 근거를 기록한다

5회·200 ms 재획득, consumer 즉시 거부, 실패 원인 journal 기록은 이미 있다.
기존 회귀 9개를 재실행해 모두 통과했다. 전체 PID 관측을 유지하고, 검증 성공을
증명하지 않는 `recovery_blocked`만 보고 finalize하는 경로는 추가하지 않는다.
현재 구현의 판단 근거를 문서화한 변경은 로컬 커밋에 보존했다.

## #217: 실측된 상한을 안내한다

기본 저장에서 `보안`·`claude-config`를 보존하는 수정은 이미 main에 있다.
테스트 전용 Notion DB에서 public API를 실측했다. 100개 전체 목록은 성공했지만,
실제 자동 등록 함수의 101개·102개 목록은 HTTP 400 `validation_error`로 거부됐다.
생성한 DB와 행은 모두 휴지통 이동을 확인했다.

확인된 오류에만 옵션 100개 상한과 Notion 화면에서 옵션 추가 후 `--force-tag`
재저장하는 방법을 안내한다. 다른 필드 제한·크기 제한·권한 오류를 같은 원인으로
분류하지 않는다. 수정·회귀·실측 문서는 로컬 커밋에 보존했다.

새 회귀는 수정 전에 2개 실패했고, 수정 뒤 관련 23개와 전체 2,216개(77개 파일)가
통과했다. typecheck·build·diff 검사는 종료 코드 0이며 독립 검토에 수정 요청이 없었다.
이슈에 게시할 실측 요약은 별도 초안으로 준비한다.

## #201 권고: 귀속을 증명하지 못하는 Codex 한도 응답은 FAILED로 유지한다

기존 구현 시도는 요청 이전의 현재 HEAD 지적을 놓치는 문제까지 세 차례 확인돼
현재 main에 들어가지 않았다. 과거 branch를 그대로 합치지 않는다.

현재 quota issue comment에는 이번 요청 ID·HEAD와 직접 연결하는 값이 없다.
새 요청 뒤에 응답이 왔다는 시간 순서만으로는 늦게 도착한 과거 응답을 구분할 수 없다.
따라서 **현재 API로 자동 제외를 안전하게 구현했다고 주장하지 않고 FAILED를 유지**하는
결정을 권고한다. 이 이슈의 결과는 사용량 제한이 해제되는 기능이 아니라 안전한
자동 제외의 지원 가능 여부에 관한 정책 결정이다.

향후 직접적인 귀속 증거가 제공되더라도 현재 HEAD의 Codex review/inline이 하나라도
있으면 제외를 허용하지 않는 보수적 조건을 권고한다. 요청 시각 이전의 지적도 포함한다.
실패 문구와 P0/P1이 함께 있거나 귀속이 불명확하면 계속 머지를 막는 회귀로 고정한다.
workflow reviewer 제외 규칙과 응답 없는 TIMEOUT의 의미는 유지한다.

## #196 권고: 명시적인 보존·정리 명령을 제공한다

- `--prune`은 파일·lock·metadata를 만들지 않는 advisory 계획이다.
- `--prune --apply`만 실제 정리하며, 운영 실행은 대상 계획을 확인한 별도 승인 후 한다.
- pending 또는 판정 불가능 journal 하나라도 있으면 전체 삭제 0건이다.
- 정상 성공 journal은 최소 30일·최근 32개를 보존한다. 실패·복구·불완전 실행·wiring
  preimage는 보존한다. 이름순과 directory mtime을 배포 순서로 쓰지 않는다.
- previous helper는 순서 증거가 있는 최신 1개 이상을 보존하며, 순서 불명 legacy와
  복구 기록이 참조한 사본은 전부 보존한다.
- 새 순서 영수증은 별도 파일에 두고 bootstrap exact 파일 집합·worker KEYS·phase를
  바꾸지 않는다. 영수증 실패로 이미 성공한 배포를 실패로 바꾸지 않는다.
- 기존 4096 제한과 분리된 bounded scanner로 4097개도 조사한다. 모든 항목이 보호
  대상인 경우까지 자동 정상화를 약속하지 않는다.
- 두 lease·quiescence·전체 preflight·identity 재검사 후 검증된 파일만 개별 삭제한다.
  중단된 capture와 남은 증거를 보존하며 자동 재개·전체 원자 삭제·복원 rollback을
  주장하지 않는다. release·activation·live bootstrap은 정리 대상이 아니다.

## #220 권고: 정확한 역사적 통합과 복구 백업을 결속한다

inactive·비-Handoff Task도 기존 status에서 exact released Claim generation과 mapping
대상 여부를 조회한다. 최신 동률·중복·다른 generation·alias는 추측하지 않는다.
mapping 초기화뿐 아니라 resolver의 fetch와 CLI journal append도 우회해 조회의 숨은
쓰기를 제거한다. readonly Git은 optional lock을 끈다.

기존 ancestor cleanup은 유지하고, `--cleanup-proof`로 다음 정책을 명시한 경우에만
별도 정리를 허용한다.

`historical-exact-patch-v1`은 모든 비통합 commit의 정확한 변경이 신뢰한 main 이력에
들어갔음을 뜻한다. **통합 이후 main이 수정되거나 revert한 경우도 허용**한다.
이는 기존 ancestor 정리와 같은 통합 이력의 의미이며, 현재 파일이 옛 작업본과
같다는 주장은 하지 않는다. 현재 내용 동일성을 요구하는 대안은 실제 사례를 처리하지 못한다.

전체 비통합 linear commit을 최대 32개로 제한하고 각 대응 commit의 경로·전후 blob·mode·type을
정확히 1:1 대조한다. patch-id만으로 허용하지 않는다. frozen source ref/SHA·worktree
HEAD·Task·Claim·host·mapping·active successor 부재·clean 상태와 외부 full Git bundle·
ignored 파일 전수 백업을 결속하고 제거 직전에 재검증한다.

실제 redmine 사례는 비통합 commit 1개와 통합 commit의 full diff 98,277바이트가
완전히 같고, 복구할 ignored 파일 6개도 모두 regular여서 제한된 구현 범위에 들어온다.
현재 파일은 24개 중 22개가 후속 변경됐으므로 현재 tree 동일성 조건으로는 처리할 수 없다.
실제 Claim·mapping·백업 검증은 배포한 도구로 다시 수행한다.

새 pending lifecycle은 구버전이 거부하도록 분리하고 동일 proof로만 재개한다.
일반 미통합·부분 일치·dirty·다른 host·alias·symlink·동시 변경은 계속 차단한다.
plain non-force `git worktree remove`만 사용하며 branch와 외부 백업을 남긴다.
실제 redmine 작업본 제거는 도구 배포 후 별도 승인하는 운영 작업이다.

## #195 권고: 명시적으로 opt-in한 관찰 모드부터 켠다

환경변수 없는 새 Claude·Codex 세션에서도 Guard 전용 정책과 안전한 data-only
coordinate reader로 같은 좌표를 해석한다. 일반 CLI와 credential launcher까지
fallback을 확대하지 않는다. 일부 명시 좌표 env와 파일을 섞지 않는다.

관찰 모드는 일반 Task/Claim 규칙 위반을 기록한다. 다만 protocol mismatch,
Guard unavailable, self-approval 등 안전 오류는 차단할 수 있음을 명시한다.
Guard request store·digest 준비를 검증하고, 읽기 전용 preflight가 암묵적으로
실제 상태를 초기화하지 않도록 한다. probe의 HOME도 격리해 운영 설정 접근을 막는다.

기존 SessionEnd-only managed wiring 검증과 새 정책의 목표 배선을 구분한다.
정책 파일과 Claude·Codex hook 설정을 같은 배선 transaction에 결속하며, 실패와
구버전 rollback에서 기존 정책·배선을 함께 복원한다. bootstrap refresh만으로
Guard 배선이 바뀐다고 가정하지 않는다. retained 혼합 버전 회귀를 포함한다.

최종 결과에서 `unprotected: false`, `runtime_mode: observe`, `enforced: false`를
구분한다. 전 이벤트 배선과 실제 무좌표 새 세션을 검증한 뒤 결과를 기록한다.
Registry 권한 원본 전환(cutover)은 이번 승인에 포함하지 않는다.

## 실행과 검증 순서

1. 이 설계의 미결 정책을 확정하고 구현 계획을 작성한다.
2. 격리 작업본에서 나머지를 구현하며 각 이슈를 검증 가능한 로컬 커밋으로 보존한다.
3. targeted 회귀 후 전체 typecheck·build·vitest, runtime 4종, 관련 skill 계약·sync,
   Guard/설치기 격리 검증과 혼합 버전 검증을 마친다. 실패·skip·실제 종료코드를 기록한다.
4. 완성한 snapshot을 리뷰하고, 기존 규정에 따라 push·PR 생성·머지를 각각 승인받는다.
5. 최종 revision의 릴리스와 실행 스크립트를 준비한다. 모든 세션을 닫은 마지막 window에서
   승인한 배포·필요한 배선 전환·bootstrap refresh·live 검증을 한 번에 수행한다.
6. 게시 승인 범위에 따라 검증 결과를 이슈에 남기고 실제 완료 여부를 정리한다.

이 설계 승인만으로 push·PR·머지·운영 배포·기록 삭제·작업본 삭제·Task/Claim 생성이나
Registry cutover를 실행하지 않는다. 같은 UID 외부 writer까지 원자 봉쇄하거나 전체
삭제 batch의 rollback을 보장한다고 표현하지 않는다.
