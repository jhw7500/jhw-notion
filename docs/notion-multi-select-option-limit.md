# Notion multi_select 자동 등록의 옵션 개수 상한

[#217](https://github.com/jhw7500/jhw-notion/issues/217)의 public API 상한을
2026-11-07에 테스트 전용 임시 data source에서 실측했다. 기존 Knowledge Base와
테스트용 Knowledge Base의 스키마·행은 변경하지 않았다.

## 실측 결과

SDK `@notionhq/client` 5.20.0, `Notion-Version: 2025-09-03`으로 실행했다.
`appendMultiSelectOptions`는 main
`50c9fe70c30ad7d9859bd2b9f31c84144d4dd140`의 실제 빌드 함수를 호출했다.
함수가 선택한 운영 data source 경로는 전송 전에 임시 data source로 치환했고,
네트워크 경계에서 그 임시 DB·data source·행의 ID만 허용했다. SDK와 함수의
자동 재시도는 실측에서 차단했다.

| Existing options | Sent options | Method | Result |
|---|---|---|---|
| 100 | 100 | full-list PATCH | HTTP 200 |
| 100 | 101 | appendMultiSelectOptions | HTTP 400 validation_error |
| 101 | 101 | full-list PATCH | HTTP 400 validation_error |
| 101 | 102 | appendMultiSelectOptions | HTTP 400 validation_error |
| 102 | 102 | full-list PATCH | HTTP 400 validation_error |

101개를 보낸 응답 원문은 다음과 같다. 102개 전송에서는 마지막 숫자만 `102`였다.

```text
body failed validation: body.properties.tags.multi_select.options.length should be ≤ `100`, instead was `101`.
```

처음에는 옵션 100개로 생성했다. 101개 이상인 상태는 임시 행의 `multi_select` 값에
새 이름 하나만 넣어 만들었다. 실제 GET으로 옵션 101개·102개를 확인한 뒤 각각의
전체 목록 PATCH를 검사했다. 각 단계에서 기존 옵션의 ID·이름·색을 보존했는지도
확인했다. 페이지 값 100개 제한과 스키마 옵션 목록 제한을 혼동하지 않았다.

첫 실측은 101개 전체 목록 재전송의 거부를 확인하고 끝났다. 두 번째 실측은
위 표의 전체 경계를 확인했다. 두 실행 모두 생성한 임시 DB와 행을 휴지통으로
옮기고 GET의 `in_trash: true`를 확인했다. 두 번째 실행은 쓰기 10회·GET 11회였고,
불확실한 쓰기를 반복하거나 기존 DB에 옵션을 추가하지 않았다.

이 결과는 위 API 버전과 요청 형태에 대한 실측이다. 다른 버전이나 다른 오류까지
같은 상한이라고 판정하지 않는다.

## 사용자 안내와 유지하는 경계

실제 상한 오류를 받은 자동 등록은 기존대로 허용된 태그만 남기고 저장을 계속한다.
경고에는 옵션 100개 상한으로 등록하지 못했다는 사실과 다음 대응을 함께 표시한다.

1. Notion 화면에서 필요한 옵션을 직접 추가한다.
2. 같은 내용을 `--force-tag` 또는 `allowNewTags: true`로 다시 저장한다.

이미 Notion에 있는 이름은 자동 등록 함수가 조회한 canonical 이름으로 통과시키며,
신규 옵션이 없으면 스키마 PATCH를 하지 않는다. 전체 목록에서 기존 옵션을 빼거나
새 옵션만 보내는 방식은 기존 옵션 삭제를 일으킬 수 있으므로 사용하지 않는다.
임시 행을 만들어 옵션을 추가한 실측 방법도 제품의 자동 우회로 채택하지 않는다.

기본 저장에서 `보안`·`claude-config`를 보존하는 허용 목록 수정과 `jhw_note` 회귀
검증은 기존 커밋 `58c3613`에 있다. 기본 가드를 실제 스키마 조회 방식으로 바꾸거나
운영 태그를 삭제·병합하는 작업은 포함하지 않는다.

## 검증

상한 오류 안내를 추가하기 전에 새 회귀 2개가 예상대로 실패했다. 수정 뒤 태그
가드·`jhw_note` 테스트 23개와 MCP 전체 테스트 2,216개(77개 파일)가 통과했다.
타입 검사와 빌드도 종료 코드 0이었다. 다른 필드의 100개 제한, 스키마 크기 제한,
권한 거부는 옵션 개수 상한으로 안내하지 않는 회귀를 포함한다.

공식 API 계약은 [data source 속성 수정](https://developers.notion.com/reference/update-data-source-properties),
[요청 제한](https://developers.notion.com/reference/request-limits),
[페이지 multi-select 값](https://developers.notion.com/reference/page-property-values#multi-select)을
참조한다. 위 HTTP 결과는 이 문서의 별도 실측이며, 공식 문서만으로 추정한 결과가 아니다.
