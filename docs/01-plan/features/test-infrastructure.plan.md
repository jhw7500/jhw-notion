# test-infrastructure Plan

- **작성일**: 2026-04-09
- **Feature**: test-infrastructure
- **Phase**: Plan

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | 테스트가 전혀 없어 리팩토링/기능 추가 시 회귀 검증이 불가능하다 |
| **Solution** | Vitest + Notion API 모킹으로 9개 MCP 도구 + 코어 모듈 단위 테스트 구축 |
| **Function UX Effect** | 코드 변경 후 `npm test` 한 줄로 전체 검증 가능 |
| **Core Value** | 안전한 리팩토링과 새 기능 추가를 위한 회귀 방지망 확보 |

## Context Anchor

| 축 | 내용 |
|----|------|
| **WHY** | 테스트 부재로 코드 변경 시 회귀 버그 위험이 높음 |
| **WHO** | jhw-notion MCP 서버 개발자/유지보수자 |
| **RISK** | Notion API 모킹이 실제 API 동작과 괴리될 수 있음 |
| **SUCCESS** | 전체 도구에 대한 단위 테스트 존재, `npm test`로 실행 가능, CI 연동 가능 |
| **SCOPE** | mcp-server/src/ 내 12개 파일 (코어 3 + 도구 9) |

---

## 1. 배경

jhw-notion MCP 서버는 9개 도구 핸들러와 3개 코어 모듈로 구성되어 있다. 현재 테스트가 전혀 없어서:
- 도구 로직 수정 시 다른 도구에 미치는 영향을 검증할 수 없다
- Notion API 응답 구조가 변경될 때 어느 도구가 깨지는지 알 수 없다
- `npm run build`(타입 체크)만으로는 런타임 동작 검증이 불가능하다

## 2. 요구사항

### 2.1 필수 (Must Have)

| ID | 요구사항 | 검증 방법 |
|----|----------|-----------|
| R1 | Vitest 테스트 프레임워크 설치 및 설정 | `npx vitest --version` 실행 |
| R2 | `npm test` 스크립트로 전체 테스트 실행 | `npm test` exit code 0 |
| R3 | Notion API 클라이언트 모킹 유틸리티 | 모킹 헬퍼로 API 호출 없이 테스트 통과 |
| R4 | 코어 모듈 테스트 (config, notion-client, server) | 3개 파일에 대한 테스트 존재 |
| R5 | 9개 도구 핸들러 각각에 대한 단위 테스트 | 9개 테스트 파일 존재 |

### 2.2 권장 (Should Have)

| ID | 요구사항 | 검증 방법 |
|----|----------|-----------|
| R6 | 커버리지 리포트 설정 | `npm run test:coverage` 실행 |
| R7 | 에러 케이스 테스트 (API 키 미설정, 잘못된 DB명 등) | 에러 경로 테스트 존재 |

### 2.3 제외 (Out of Scope)

- Notion API 실제 호출 테스트 (E2E)
- install.sh 테스트
- 스킬 마크다운 파일 검증
- CI/CD 파이프라인 구축 (별도 feature)

## 3. 기술 결정

### 3.1 테스트 프레임워크: Vitest

**선택 근거**: ESM 네이티브 지원, TypeScript 바로 실행, Jest 호환 API, 빠른 속도.

이 프로젝트가 `"type": "module"` + TypeScript + ES2022 타겟이므로 Jest의 ESM 설정 복잡성을 피할 수 있다.

### 3.2 모킹 전략: vi.mock + 헬퍼 팩토리

Notion API 호출을 모킹하는 방법:

```typescript
// mcp-server/src/__tests__/helpers/mock-notion.ts
// getNotionClient()를 모킹하여 가짜 Client 반환
// 각 테스트에서 원하는 API 응답을 설정
```

핵심 모킹 대상:
- `@notionhq/client`의 `Client` — `databases.query()`, `pages.create()`, `pages.update()`, `search()`, `blocks.children.append()`
- `dotenv`의 `config()` — 환경변수 로딩

### 3.3 테스트 파일 구조

```
mcp-server/
├── src/
│   ├── __tests__/
│   │   ├── helpers/
│   │   │   └── mock-notion.ts      # Notion 클라이언트 모킹 헬퍼
│   │   ├── config.test.ts           # config.ts 테스트
│   │   ├── notion-client.test.ts    # notion-client.ts 테스트
│   │   └── server.test.ts           # server.ts 테스트
│   └── tools/
│       └── __tests__/
│           ├── search.test.ts
│           ├── status.test.ts
│           ├── context.test.ts
│           ├── history.test.ts
│           ├── record.test.ts
│           ├── note.test.ts
│           ├── delete.test.ts
│           ├── start.test.ts
│           └── close.test.ts
├── vitest.config.ts
└── package.json                     # test, test:coverage 스크립트 추가
```

## 4. 구현 계획

### Step 1: Vitest 설치 및 설정
- [ ] `vitest` devDependency 추가
- [ ] `vitest.config.ts` 생성 (ESM, TypeScript, 커버리지 설정)
- [ ] `package.json`에 `test`, `test:coverage` 스크립트 추가
- [ ] `tsconfig.json`의 `exclude`에 테스트 파일 추가 (빌드 제외)

### Step 2: 모킹 헬퍼 작성
- [ ] `src/__tests__/helpers/mock-notion.ts` — Notion Client 모킹 팩토리
- [ ] `databases.query()`, `pages.create()`, `pages.update()`, `search()`, `blocks.children.append()` 모킹 지원

### Step 3: 코어 모듈 테스트
- [ ] `config.test.ts` — NOTION_CONFIG 구조 검증, DatabaseName 타입 확인
- [ ] `notion-client.test.ts` — 싱글턴 동작, API 키 미설정 에러
- [ ] `server.test.ts` — createServer()가 McpServer 반환, 9개 도구 등록 확인

### Step 4: 도구 핸들러 테스트 (읽기 도구 4개)
- [ ] `search.test.ts` — 키워드 검색 → 결과 포맷팅
- [ ] `status.test.ts` — DB 쿼리 → 요약 텍스트
- [ ] `context.test.ts` — 프로젝트명 → 관련 정보 집계
- [ ] `history.test.ts` — 프로젝트명 → 시간순 타임라인

### Step 5: 도구 핸들러 테스트 (쓰기 도구 5개)
- [ ] `record.test.ts` — DB별 레코드 생성 + 잘못된 DB명 에러
- [ ] `note.test.ts` — Knowledge Base 블록 추가
- [ ] `delete.test.ts` — 페이지 archived 처리
- [ ] `start.test.ts` — 프로젝트 생성 + Decision Log 초기 항목
- [ ] `close.test.ts` — 상태 변경 + 회고 기록

### Step 6: 검증
- [ ] `npm test` — 전체 테스트 통과
- [ ] `npm run build` — 테스트 파일이 빌드에 포함되지 않음 확인
- [ ] 커버리지 확인

## 5. 성공 기준

| 기준 | 목표 |
|------|------|
| 테스트 파일 수 | 12개 (코어 3 + 도구 9) |
| `npm test` 통과 | exit code 0 |
| 빌드 영향 없음 | `npm run build` 기존과 동일하게 성공 |
| 모킹 완전성 | 실제 Notion API 호출 0건 |
| 에러 경로 커버 | API 키 미설정, 잘못된 DB명 등 최소 3개 에러 케이스 |

## 6. 리스크

| 리스크 | 영향 | 대응 |
|--------|------|------|
| Notion API 응답 구조가 바뀌면 모킹이 실제와 괴리 | 중 | 모킹 헬퍼에 실제 API 응답 샘플을 fixture로 보관 |
| ESM + Vitest + vi.mock 조합에서 모듈 모킹 이슈 | 중 | `vi.mock`의 factory 패턴 사용, 필요 시 dependency injection으로 전환 |
| 테스트 작성으로 인한 추가 유지보수 부담 | 저 | 최소한의 핵심 경로만 테스트. 과도한 모킹 회피 |

## 7. 의존성

### 추가할 devDependencies

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `vitest` | ^3.x | 테스트 프레임워크 |
| `@vitest/coverage-v8` | ^3.x | 커버리지 리포트 |
