// 분류 필드(select / multi_select) 어휘 가드.
//
// 배경: report 필드만 config.ts의 REPORT_VALUES로 enum이 강제돼 5개 DB 전체에서
// 정확히 10개 옵션으로 깨끗하게 유지된 반면, status/area/category/tech_stack/tags/tool은
// 자유 문자열이 그대로 Notion API에 전달되어 옵션 폭발(KB tags 482개)·의미 드리프트가
// 누적됐다(운영중↔운용중 오타 중복, status에 PR 문장 침입 등). Notion은 모르는 옵션명을
// 받으면 조용히 새 옵션을 생성하기 때문이다.
//
// 이 모듈이 쓰기 choke point(property-builder / note)에서 report와 동일한 enum 가드를 제공한다.
//
// 정책:
//  - select(단일): 별칭 정규화 → 허용목록에 있으면 사용, 없으면 FieldValidationError throw.
//  - multi_select(다중): 별칭 정규화 + 중복제거 → 허용은 유지, 미허용은 drop(에러 없이 호출부에서 경고).
//
// 어휘 확장: 새 값이 정당하면 아래 해당 필드 allow에 한 줄 추가하면 된다(REPORT_VALUES 패턴과 동일).
// report는 zod REPORT_VALUES로 이미 가드되므로 여기에 중복 정의하지 않는다.
import type { DatabaseName } from "../config.js";

export interface FieldVocab {
  /** 허용 옵션(별칭 정규화 후 이 안에 있어야 함) */
  allow: readonly string[];
  /** 입력값 → 표준값 별칭(오타/중복/구버전/세분류 흡수) */
  alias?: Readonly<Record<string, string>>;
}

// projects.tech_stack 허용 — 실제 언어/프레임워크/도구만. 제품·프로젝트·스택문장은 제외(drop).
const TECH_STACK_ALLOW = [
  "C", "C++", "C99", "Python", "TypeScript", "javascript", "Node.js",
  "Next.js", "React", "HTML/CSS", "html", "bash", "cron", "git", "gh",
  "GitHub", "GitHub Actions", "GitHub App", "jq", "sed", "grep", "systemd",
  "systemd-networkd", "inotify", "Yocto", "dpkg", "aarch64", "i.MX93",
  "GLib", "GStreamer", "gst-rtsp-server", "UDP", "epoll", "signalfd",
  "timerfd", "paramiko", "FastAPI", "Plotly", "tshark", "playwright",
  "NXP mlan/moal",
] as const;

// knowledgeBase.tags 허용 — 482개 폭발에서 재사용 가치가 있는 도메인 태그만 추린 시드.
// drop+경고 정책이므로 미등록 태그는 버려진다. 정당한 신규 태그는 이 목록에 추가.
const KB_TAGS_ALLOW = [
  // 플랫폼/하드웨어
  "iMX8", "iMX93", "aarch64", "eMMC", "ext4", "임베디드", "GMSL", "max9296",
  "AP1302", "AR0234", "V4L2", "i2c",
  // 도메인
  "PIM", "WiFi", "WLAN", "802.11", "802.11ax", "802.11be", "HE", "MU-MIMO",
  "OFDMA", "WPA2", "WPA3", "EAPOL", "tshark", "pcap", "radiotap", "sniffer",
  "wpa_supplicant", "hostapd", "mgmt-frame", "host-mlme", "9098", "88Q9098",
  "mlan", "moal", "DBDC",
  "mlanutl", "hostcmd", "NXP", "0x008b", "thermal_mgmt", "debug.conf", // wlan-driver-v2 (§3 옵션A)
  // OS/인프라
  "Linux", "linux-kernel", "kernel-module", "BSP", "Yocto", "systemd", "cron",
  "netplan", "nftables", "iptables", "bridge", "dpkg", "deb", "packaging",
  "RTSP", "gstApp", "watchdog", "monitoring", "tailscale", "wsl", "rsync", "ssh",
  // 툴체인/언어
  "bash", "shell", "Python", "pytest", "venv", "git", "submodule", "jq",
  "sed", "grep", "TypeScript", "javascript", "playwright",
  // AI 워크플로우/도구
  "Claude Code", "opencode", "codex", "gemini", "MCP", "Notion", "notion-api",
  "hooks", "stop-hook", "slash-command", "skill", "automation", "GitHub Actions",
  "ci", "code-review", "ultrareview",
  // 패턴/개념
  "race-condition", "idempotent", "defense-in-depth", "encoding", "security",
  "causality", "deprecated", "pitfall", "verification",
] as const;

// references.tool 허용 — 범용 CLI/도구만. 특정 스크립트·프로젝트는 제외(drop).
const REF_TOOL_ALLOW = [
  "Claude Code", "Cursor", "Windsurf", "공통",
  "bash", "tcpdump", "mpstat", "jq", "awk", "git", "ssh", "scp", "dpkg",
  "mlanconfig", "mlanutl", "uaputl", // wlan-driver-v2 (§3 옵션A)
] as const;

export const FIELD_VOCAB: Partial<
  Record<DatabaseName, Record<string, FieldVocab>>
> = {
  projects: {
    status: {
      allow: ["계획중", "진행중", "완료", "보류", "운용중", "검증 대기"],
      alias: {
        "운영중": "운용중", // 오타 중복(영↔용)
        "진행 중 (후속 3건)": "진행중",
        "Phase 0~5 완료": "완료",
        "달성": "완료",
      },
    },
    tech_stack: {
      allow: TECH_STACK_ALLOW,
      alias: { "gh-cli": "gh", "GitHub CLI": "gh" },
    },
  },
  decisionLog: {
    status: {
      allow: ["확정", "검토중", "폐기", "확정 (재평가 가능)"],
      alias: {
        // status에 침입했던 PR 서술 문장 → 표준값으로 흡수(서술은 result/rationale로)
        "확정 (PR #43 머지 → 1ca1b86)": "확정",
        "확정 (PR #49 startup check + PR #50 docs 우선순위)": "확정",
      },
    },
    area: {
      // 40종 혼재(추상화 레벨 섞임)를 상위 분류로 통제. 세분류는 별칭으로 흡수.
      allow: [
        "아키텍처", "인프라", "백엔드", "프론트엔드", "드라이버",
        "도구/플러그인", "자동화/인프라", "분석/진단", "테스트/CI", "문서",
        "설정", "검증", "MCP 서버", "WLAN", "사양", "기타",
      ],
      alias: {
        "tooling": "도구/플러그인",
        "docs": "문서",
        "docs/tools": "문서",
        "config": "설정",
        "CI": "테스트/CI",
        "Test Infrastructure": "테스트/CI",
        "진단 시스템": "분석/진단",
        "진단/웹": "분석/진단",
        "분석 알고리즘": "분석/진단",
        "wireless-analysis": "분석/진단",
      },
    },
  },
  preferences: {
    category: {
      allow: [
        "코딩 스타일", "응답 형식", "행동 피드백", "워크플로우",
        "AI 협업 패턴", "AI 사용 정책", "AI 운영", "분석/진단", "기타",
      ],
      alias: {
        "워크스타일": "워크플로우",
        "logging": "AI 운영",
        "reporting": "AI 운영",
        "워치독 설계": "기타",
      },
    },
  },
  knowledgeBase: {
    category: {
      allow: [
        "아키텍처", "문제해결", "베스트프랙티스", "드라이버",
        "빌드", "디버깅", "인프라", "기타",
      ],
    },
    tags: {
      allow: KB_TAGS_ALLOW,
    },
  },
  references: {
    category: {
      allow: [
        "가이드", "설정", "워크플로우", "MCP", "플러그인",
        "기타", "문서", "아키텍처", "인프라",
      ],
    },
    tool: {
      allow: REF_TOOL_ALLOW,
    },
  },
};

export class FieldValidationError extends Error {
  constructor(
    public db: DatabaseName,
    public field: string,
    public value: string,
    public allow: readonly string[]
  ) {
    super(`[${db}.${field}] 미허용 값 "${value}". 허용: ${allow.join(" / ")}`);
    this.name = "FieldValidationError";
  }
}

export function getFieldVocab(
  db: DatabaseName,
  field: string
): FieldVocab | undefined {
  return FIELD_VOCAB[db]?.[field];
}

function canon(value: string, vocab: FieldVocab): string {
  const t = value.trim();
  return vocab.alias?.[t] ?? t;
}

/**
 * 단일 select 값 검증. vocab이 없으면 trim만. 미허용이면 FieldValidationError throw.
 */
export function normalizeSelectValue(
  db: DatabaseName,
  field: string,
  value: string
): string {
  const vocab = getFieldVocab(db, field);
  if (!vocab) return value.trim();
  const c = canon(value, vocab);
  if (!vocab.allow.includes(c)) {
    throw new FieldValidationError(db, field, value, vocab.allow);
  }
  return c;
}

/**
 * 다중 multi_select 값 검증. vocab이 없으면 trim+중복제거만(전부 유지).
 * vocab이 있으면 별칭 정규화 + 중복제거 후, 허용은 kept / 미허용은 dropped로 분리.
 */
export function normalizeMultiSelectValues(
  db: DatabaseName,
  field: string,
  values: string[]
): { kept: string[]; dropped: string[] } {
  const vocab = getFieldVocab(db, field);
  const seen = new Set<string>();
  const kept: string[] = [];
  const dropped: string[] = [];

  for (const raw of values) {
    const t = raw.trim();
    if (!t) continue;
    const c = vocab ? vocab.alias?.[t] ?? t : t;
    if (vocab && !vocab.allow.includes(c)) {
      if (!dropped.includes(t)) dropped.push(t);
      continue;
    }
    if (seen.has(c)) continue;
    seen.add(c);
    kept.push(c);
  }

  return { kept, dropped };
}
