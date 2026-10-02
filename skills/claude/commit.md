---
description: "Change Evidence Contract v1에 맞는 Git commit 작성 · 직접 커밋과 PR 작업 공용"
argument-hint: "[변경 대상] [Issue 또는 PR URL]"
---

# /jhw:commit — 변경 증거가 담긴 커밋

직접 커밋과 PR용 커밋에 같은 메시지 구조를 사용한다. 정본은
[Change Evidence Contract v1](https://github.com/jhw7500/automation/blob/0d97a63891ba4473a3a189eae643f8059b76eb56/docs/change-evidence-contract-v1.md)이고,
이 스킬은 `v1`과 validator 구현 좌표 `0d97a63891ba4473a3a189eae643f8059b76eb56`을 고정한다.
Claude Code, Gemini CLI, OpenCode는 이 파일을 공유하고 Codex는 생성된 `jhw-commit`에서
이 파일을 참조한다. 모델마다 별도 계약을 만들지 않는다.

## 작성 순서

1. `git status --short`, staged diff, 관련 Issue·PR을 읽고 커밋에 포함할 파일을 확정한다.
   사용자가 커밋을 요청한 범위만 stage한다. 다른 사람의 변경이나 비밀 파일을 함께 넣지 않는다.
2. 변경 이유와 실제 결과를 확인한다. 검증은 **실제로 실행하고 출력을 읽은** 명령·결과만 기록한다.
   실행하지 않았다면 `Validation` 전체를 `Not run: <구체적 사유>`로 쓴다. 실행한 일부만
   적고 나머지를 수행한 것처럼 암시하지 않는다.
3. 확인된 Issue 또는 PR 번호/URL을 `References`에 넣는다. 직접 커밋은 Issue 참조만으로
   충분하며 PR을 새로 만들거나 존재하지 않는 PR 번호를 추측하지 않는다. PR용 커밋에서
   PR이 아직 생성되지 않았다면 Issue를 참조한다. 어느 쪽도 확인되지 않으면 유효한 `v1`
   커밋을 만들 수 없으므로 참조를 먼저 확인한다. 가능하면 전체 GitHub URL을 사용한다.
4. 결과 중심 제목을 72자 이내로 작성하고 빈 줄 뒤에 아래 필드를 정확한 순서로 채운다.
   추가 heading, 빈 필드, `TBD`·`미정` 같은 placeholder는 쓰지 않는다. `Changes`와
   검증을 수행한 `Validation`에는 실제 최상위 Markdown 목록 항목을 쓴다.
5. 커밋 전 메시지와 staged diff를 다시 읽는다. 저장소에 고정된 `v1` validator가 있다면
   완성한 메시지에 `--kind commit --expected-version v1` 검증을 실행한다. 실패하면 수정한다.

## 메시지 형식

아래 `<...>`는 작성 지시 자리이며 그대로 제출하지 않는다. 필드 heading의 맨 앞 ASCII
공백 **한 칸**은 Git의 기본 edited-message cleanup이 `#`로 시작하는 행을 지우지 않게 하는
정본 템플릿의 형식이다. 완성본에도 유지한다.

<!-- change-evidence-commit-template:begin -->
```text
<72자 이내의 결과 중심 제목>

 ### Contract version
v1

 ### Why
<확인한 작업 이유>

 ### Changes
- <실제로 반영한 주요 변경>

 ### Validation
- <실제로 실행한 명령과 관측 결과>

 ### References
- <확인된 Issue 또는 PR URL>
```
<!-- change-evidence-commit-template:end -->

`Validation`이 `Not run: <구체적 사유>`일 때는 그 필드의 목록을 없애고 한 줄만 쓴다.
`Unknown:`과 `Not applicable:`는 commit 필드에서 허용되지 않는다. 근거 없는 명령,
결과, 영향 또는 tracker 관계를 채우지 않는다.

## 실행 경계

- 커밋 메시지는 개인 임시 파일에 실제 줄바꿈으로 기록하고 `git commit --cleanup=verbatim
  --file <파일>`로 전달한다. 성공·실패 어느 경우든 임시 파일을 제거한다. 메시지를 단일
  `-m` 제목만으로 축약하지 않는다.
- 직접 커밋은 위 `References`에 Issue를 기록한 뒤 종료할 수 있다. `/jhw:pr`는 같은
  변경 증거로 PR을 만들되, PR의 `Related issue`에 실제 Issue를 연결한다.
- 과거 비정형 커밋은 새 필드를 추측해 `v1`로 표시하지 않는다. 후속 보고서에서 쓰면
  원래 출처를 표시한다.
