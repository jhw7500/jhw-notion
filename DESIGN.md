# jhw-notion 설계 문서

- **작성일**: 2026-04-07
- **저장소**: https://github.com/jhw7500/jhw-notion.git
- **목적**: Notion AI Workspace를 여러 AI TUI(Claude Code, Gemini CLI, Codex CLI 등)에서 통합 사용

## 1. 배경

현재 `/jhw:*` 커맨드 10개가 Claude Code 전용 마크다운 스킬로 구현되어 있다.
로직(DB ID, 절차, 규칙)이 스킬 파일에 분산되어 있어 다른 TUI에서 재사용이 불가능하다.

### 현재 구조

```
사용자 → /jhw:record → Claude Code 스킬(.md) → LLM 해석 → Notion MCP 도구 호출
```

- 스킬 파일: `~/.claude/commands/jhw/*.md` (10개)
- Notion MCP: 범용 도구(notion-search, notion-create-pages 등)
- 문제: 로직이 LLM 프롬프트 안에 있어 TUI 종속

## 2. 목표 구조

```
사용자 → TUI 스킬(얇은 가이드) → LLM → jhw-notion MCP 서버 → Notion REST API
```

- **MCP 서버**: Notion API 직접 호출. 9개 고수준 도구 제공
- **TUI 스킬**: LLM에게 "어떤 MCP 도구를 호출하라"만 안내 (얇은 레이어)
- **review만 예외**: 세션 대화 분석은 LLM 역할이므로 각 TUI 스킬에 로직 유지

## 3. 저장소 구조

```
jhw-notion/
├── mcp-server/                  # TypeScript MCP 서버
│   ├── src/
│   │   ├── index.ts             # 엔트리포인트
│   │   ├── server.ts            # MCP 서버 설정
│   │   ├── notion-client.ts     # Notion REST API 클라이언트
│   │   ├── config.ts            # DB ID, 페이지 ID 설정
│   │   └── tools/               # 도구별 핸들러
│   │       ├── record.ts
│   │       ├── note.ts
│   │       ├── delete.ts
│   │       ├── search.ts
│   │       ├── context.ts
│   │       ├── history.ts
│   │       ├── status.ts
│   │       ├── start.ts
│   │       └── close.ts
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── skills/                      # TUI별 스킬 파일
│   ├── claude/                  # → ~/.claude/commands/jhw/
│   │   ├── record.md
│   │   ├── note.md
│   │   ├── review.md            # 유일하게 로직 포함 (세션 분석)
│   │   ├── delete.md
│   │   ├── search.md
│   │   ├── context.md
│   │   ├── history.md
│   │   ├── status.md
│   │   ├── start.md
│   │   └── close.md
│   ├── gemini/                  # → ~/.gemini/commands/jhw/
│   │   └── (동일 구조, Gemini 형식)
│   └── codex/                   # → Codex 에이전트 설정
│       └── (동일 구조, Codex 형식)
├── install.sh                   # 원클릭 설치
├── .env.example
└── README.md
```

## 4. MCP 서버 설계

### 4.1 기술 스택

- **런타임**: Node.js (TypeScript)
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Notion API**: `@notionhq/client` (공식 SDK)
- **전송**: stdio (모든 TUI에서 지원)

### 4.2 설정 (config.ts)

```typescript
export const NOTION_CONFIG = {
  databases: {
    projects: "4430fcd4-bfba-4a46-9a1b-4520db86e883",
    preferences: "4e5ba7f0-b9cc-4171-84a7-f4e430abaf57",
    decisionLog: "6c9fbc24-c5fb-4ca9-aa61-781cacc7ecfd",
  },
  pages: {
    references: "3398a230-a04e-81cc-b3a3-d408355fee9f",
    knowledgeBase: "3398a230-a04e-817d-b04a-d0180abec592",
  },
};
```

### 4.3 MCP 도구 정의 (9개)

#### 읽기 도구 (4개)

| 도구 | 입력 | 출력 | 설명 |
|------|------|------|------|
| `jhw_search` | `{ query: string }` | 검색 결과 (DB별 그룹) | 전체 DB + 페이지 통합 검색 |
| `jhw_status` | `{ db?: string }` | DB별 레코드 수, 최근 항목 | 워크스페이스 현황 |
| `jhw_context` | `{ project: string }` | 프로젝트 정보 + 관련 결정 + 페이지 본문 | 프로젝트 컨텍스트 로드 |
| `jhw_history` | `{ project: string }` | 시간순 활동 타임라인 | 프로젝트 히스토리 |

#### 쓰기 도구 (5개)

| 도구 | 입력 | 출력 | 설명 |
|------|------|------|------|
| `jhw_record` | `{ db: string, title: string, properties: object }` | 생성된 페이지 ID + URL | DB에 레코드 생성 |
| `jhw_note` | `{ title: string, content: string, project?: string }` | 생성된 페이지 ID + URL | Knowledge Base에 메모 |
| `jhw_delete` | `{ pageId: string, mode: "archive" \| "delete" }` | 처리 결과 | 레코드 삭제/폐기 |
| `jhw_start` | `{ name: string, repo?: string, stack?: string, description: string }` | 생성된 3건의 ID | 프로젝트 시작 (3단계) |
| `jhw_close` | `{ project: string, achievement?: string, lessons?: string }` | 처리 결과 | 프로젝트 종료 + 회고 |

#### review는 MCP 도구 없음

`/jhw:review`는 "세션 대화를 분석하여 저장 후보 추출"이 핵심이므로 LLM이 담당.
각 TUI 스킬에서 대화 분석 후 `jhw_record`를 호출하는 방식.

### 4.4 도구 상세

#### jhw_record

```typescript
// 입력
{
  db: "decisionLog" | "preferences" | "projects" | "references",
  title: string,
  properties: {
    // decisionLog
    status?: string,       // "확정" | "폐기" (기본: "확정")
    rationale?: string,    // 근거
    alternatives?: string, // 대안
    area?: string,         // 영역
    project?: string,      // 관련 프로젝트
    // preferences
    category?: string,     // 범주
    // projects
    repo?: string,         // 레포 경로
    stack?: string,        // 기술 스택
    description?: string,  // 설명
  }
}

// 동작
// 1. db에 해당하는 database_id를 config에서 조회
// 2. properties를 Notion 프로퍼티 형식으로 변환 (프로퍼티명은 한글)
// 3. notion.pages.create() 호출
// 4. 생성된 페이지 ID + URL 반환
```

#### jhw_search

```typescript
// 입력
{ query: string }

// 동작
// 1. notion.search({ query }) 실행
// 2. 결과를 DB별로 그룹화
// 3. 각 결과에서 제목, 날짜, 미리보기 추출
// 4. 구조화된 JSON 반환
```

#### jhw_start

```typescript
// 입력
{
  name: string,
  repo?: string,
  stack?: string,
  description: string
}

// 동작
// 1. Projects DB에 레코드 생성 (상태: 진행중, 시작일: 오늘)
// 2. Decision Log에 "프로젝트 시작" 기록
// 3. 프로젝트 페이지에 템플릿 콘텐츠 추가 (목표/범위/제약사항/메모)
// 4. 3건의 생성 결과 반환
```

#### jhw_close

```typescript
// 입력
{
  project: string,
  achievement?: string,  // 달성한 것
  lessons?: string       // 배운 점
}

// 동작
// 1. Projects DB에서 프로젝트 검색
// 2. 상태 → 완료, 완료일 → 오늘로 업데이트
// 3. 프로젝트 페이지에 회고 섹션 추가 (있는 경우)
// 4. lessons가 있으면 Knowledge Base에 별도 페이지 생성
```

### 4.5 Notion 프로퍼티 매핑

현재 live Notion DB의 프로퍼티 key는 **영문**이다. 과거 한글 스키마 문서는 stale이며, 실제 기준은 `mcp-server/src/config.ts`와 각 tool 구현이다.

#### Decision Log DB

| 프로퍼티 | 타입 | 비고 |
|---------|------|------|
| title | title | 제목 |
| status | select | 확정, 검토중, 폐기 |
| rationale | rich_text | |
| alternatives | rich_text | |
| area | select | |
| project | rich_text | |
| date | date | |
| result | rich_text | 선택 사항 |

#### Projects DB

| 프로퍼티 | 타입 | 비고 |
|---------|------|------|
| title | title | 제목 |
| status | select | 계획중, 진행중, 완료 |
| repo | rich_text | |
| tech_stack | multi_select | 기술 스택 배열 |
| description | rich_text | |
| start_date | date | |
| end_date | date | |
| created_at | created_time | Notion 자동 생성 |

#### Preferences DB

| 프로퍼티 | 타입 | 비고 |
|---------|------|------|
| title | title | 제목 |
| category | select | |
| content | rich_text | 본문 |
| tools | multi_select | 선호 도구 |
| priority | select | 우선순위 |
| created_at | created_time | Notion 자동 생성 |
| updated_at | last_edited_time | Notion 자동 갱신 |

## 5. TUI 스킬 설계

### 5.1 얇은 스킬 원칙

MCP 도구가 로직을 담당하므로 스킬은 다음만 포함:
- 사용자 입력 파싱 방법
- 미리보기 포맷
- 승인 흐름
- 어떤 MCP 도구를 호출할지

### 5.2 Claude Code 스킬 예시 (record.md)

```markdown
---
description: Notion AI Workspace에 확정된 정보를 즉시 저장
---

# /jhw:record — Notion 즉시 저장

1. 사용자 입력에서 저장할 내용과 대상 DB를 파악한다.
2. 미리보기를 보여주고 승인을 받는다.
3. 승인 후 `jhw_record` MCP 도구를 호출한다.
4. 결과 URL을 반환한다.

## DB 판별 기준
- 기술 결정 → db: "decisionLog"
- AI 사용 선호도 → db: "preferences"
- 프로젝트 등록 → db: "projects"
- 참조 문서 → db: "references"
- 기술 지식 → /jhw:note 안내

## 규칙
- 중간 결과나 미확정 정보는 저장하지 않는다.
- 저장 전 반드시 사용자 승인을 받는다.
```

### 5.3 review 스킬 (각 TUI에서 로직 유지)

```markdown
---
description: 세션 마무리 시 Notion 저장 후보 정리 및 승인 저장
---

# /jhw:review — 세션 마무리 리뷰

1. 현재 세션 대화를 분석하여 저장 후보를 추출한다:
   - 새로운 기술 결정 → decisionLog
   - AI 사용 피드백 → preferences
   - 프로젝트 상태 변경 → projects

2. 추출된 항목을 테이블로 보여준다.

3. 사용자 승인 후 각 항목에 대해 `jhw_record` MCP 도구를 호출한다.

## 규칙
- 실패한 시도나 중간 과정은 후보에서 제외한다.
- 이미 저장된 항목은 중복 제안하지 않는다.
```

## 6. 설치 시스템

### 6.1 install.sh 동작

```bash
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "jhw-notion 설치를 시작합니다..."

# [1/4] MCP 서버 빌드
echo "[1/4] MCP 서버 빌드"
cd "$SCRIPT_DIR/mcp-server"
npm install && npm run build

# [2/4] TUI 감지
echo "[2/4] TUI 감지"
CLAUDE_DIR="$HOME/.claude"
GEMINI_DIR="$HOME/.gemini"
OPENCODE_DIR="$HOME/.config/opencode"

# [3/4] 스킬 심링크
echo "[3/4] 스킬 심링크"
if [ -d "$CLAUDE_DIR" ]; then
  ln -sfn "$SCRIPT_DIR/skills/claude" "$CLAUDE_DIR/commands/jhw"
  echo "  Claude: $CLAUDE_DIR/commands/jhw → $SCRIPT_DIR/skills/claude ✅"
fi
if [ -d "$GEMINI_DIR" ]; then
  ln -sfn "$SCRIPT_DIR/skills/gemini" "$GEMINI_DIR/commands/jhw"
  echo "  Gemini: $GEMINI_DIR/commands/jhw → $SCRIPT_DIR/skills/gemini ✅"
fi
if [ -d "$OPENCODE_DIR" ]; then
  mkdir -p "$OPENCODE_DIR/skills"
  ln -sfn "$SCRIPT_DIR/skills/claude" "$OPENCODE_DIR/skills/jhw"
  echo "  OpenCode: $OPENCODE_DIR/skills/jhw → $SCRIPT_DIR/skills/claude ✅"
fi

# [4/4] MCP 서버 등록
echo "[4/4] MCP 서버 등록"
MCP_CMD="node"
MCP_ARGS="$SCRIPT_DIR/mcp-server/dist/index.js"

# Claude settings.json에 추가
if [ -d "$CLAUDE_DIR" ]; then
  node -e "
    const fs = require('fs');
    const p = '$CLAUDE_DIR/settings.json';
    const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)) : {};
    s.mcpServers = s.mcpServers || {};
    s.mcpServers['jhw-notion'] = {
      command: '$MCP_CMD',
      args: ['$MCP_ARGS']
    };
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  "
  echo "  Claude: settings.json에 jhw-notion 서버 추가 ✅"
fi

# Gemini settings.json에 추가
if [ -d "$GEMINI_DIR" ]; then
  node -e "
    const fs = require('fs');
    const p = '$GEMINI_DIR/settings.json';
    const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)) : {};
    s.mcpServers = s.mcpServers || {};
    s.mcpServers['jhw-notion'] = {
      command: '$MCP_CMD',
      args: ['$MCP_ARGS']
    };
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  "
  echo "  Gemini: settings.json에 jhw-notion 서버 추가 ✅"
fi

# OpenCode opencode.json에 추가
if [ -d "$OPENCODE_DIR" ]; then
  node -e "
    const fs = require('fs');
    const p = '$OPENCODE_DIR/opencode.json';
    const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    s['$schema'] = s['$schema'] || 'https://opencode.ai/config.json';
    s.mcp = s.mcp || {};
    s.mcp['jhw-notion'] = {
      type: 'local',
      command: ['node', '$SCRIPT_DIR/mcp-server/dist/index.js'],
      enabled: true,
    };
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  "
  echo "  OpenCode: opencode.json의 mcp에 jhw-notion 서버 추가 ✅"
fi

echo ""
echo "설치 완료!"
echo ""
echo "⚠️  .env 설정 필요:"
echo "  cp $SCRIPT_DIR/mcp-server/.env.example $SCRIPT_DIR/mcp-server/.env"
echo "  NOTION_API_KEY를 입력하세요"
```

### 6.2 업데이트

```bash
cd /path/to/jhw-notion
git pull
npm run build --prefix mcp-server
# 스킬은 심링크라 자동 반영
# MCP 서버는 TUI 재시작 시 반영
```

### 6.3 제거

```bash
./install.sh --uninstall
# 심링크 제거 + settings.json에서 jhw-notion 항목 삭제
```

## 7. 마이그레이션 계획

### 현재 → 새 구조

1. MCP 서버 구현 (9개 도구)
2. Claude 스킬을 얇은 버전으로 교체
3. 기존 `~/.claude/commands/jhw/` 를 심링크로 전환
4. Gemini, Codex 스킬 작성
5. install.sh 작성 및 테스트

### 호환성

- 기존 Notion DB/페이지는 변경 없음 (동일 ID 사용)
- 기존 Notion MCP 플러그인은 제거 가능 (jhw-notion이 대체)
  - 단, jhw 이외 용도로 Notion MCP를 쓰고 있다면 병존 가능

## 8. 제약사항

- **Notion API 키 필요**: Notion Integration 생성 후 토큰 발급
- **DB 접근 권한**: Integration에 각 DB 공유 필요
- **프로퍼티명 한글**: Notion DB 프로퍼티가 한글이므로 영문 사용 시 실패
- **review 스킬**: TUI마다 개별 유지보수 필요 (LLM 의존 로직)
